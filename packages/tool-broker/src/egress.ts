import * as https from "node:https";
import type { CustomHttpMethod } from "@agent-gateway/contracts";
import { customHttpMethodWrites, writeStatusIsAmbiguous } from "@agent-gateway/contracts";
import { blockedAddressReason, isPublicAddress, parseIpLiteral } from "@agent-gateway/policy";

/**
 * The egress guard a custom HTTPS tool's execution goes through (ADR-027): resolve the
 * definition's host exactly once, refuse anything but a public address, then connect to that
 * exact resolved address — never the hostname again — with the definition's own host as the TLS
 * SNI and HTTP `Host`. A second DNS answer (the destination's own resolver, a day later, or an
 * attacker racing the TTL) can never change what this call connects to: that is what defeats DNS
 * rebinding. Redirects are never followed (Node's client does not follow them on its own; this
 * module simply never looks).
 */

export type ResolvedAddress = Readonly<{ address: string; family: 4 | 6 }>;

/**
 * Resolves `hostname` to its candidate addresses. Swappable in tests for a scripted resolver (a
 * rebinding attempt: public on the first call, private on a second one that must never happen) or
 * a fixed address (a local test server with no real DNS at all). The production resolver is
 * `nodeDnsResolver` (`apps/tool-runner`'s own composition root), not duplicated here so this
 * module stays as easy to exercise without a network as everything else in `tool-broker`.
 */
export type DnsResolver = (hostname: string) => Promise<Readonly<ResolvedAddress[]>>;

export class EgressBlockedError extends Error {}

/**
 * Picks the one address this call will ever connect to: `hostname` parsed as a literal address in
 * any numeric form (dotted, decimal, octal, hex, IPv6, IPv4-mapped — `parseIpLiteral`), or else
 * the first public address `resolve` returns. Throws `EgressBlockedError` for a private, loopback,
 * link-local, CGNAT, multicast, reserved, documentation, unique-local or mapped address, and for a
 * hostname that resolved to nothing public at all.
 */
export async function resolvePinnedAddress(
	hostname: string,
	resolve: DnsResolver,
): Promise<ResolvedAddress> {
	const literal = parseIpLiteral(hostname);
	if (literal !== null) {
		const reason = blockedAddressReason(literal);
		if (reason !== null) {
			throw new EgressBlockedError(`'${hostname}' is a ${reason} address; refusing to connect`);
		}
		return literal;
	}
	const candidates = await resolve(hostname);
	const first = candidates.find((candidate) => isPublicAddress(candidate));
	if (first !== undefined) {
		return first;
	}
	throw new EgressBlockedError(
		candidates.length === 0
			? `'${hostname}' did not resolve to any address`
			: `'${hostname}' resolved only to non-public addresses (${candidates
					.map((c) => blockedAddressReason(c) ?? "unparseable")
					.join(", ")})`,
	);
}

export type EgressRequest = Readonly<{
	method: CustomHttpMethod;
	/** The definition's own hostname: never the resolved address — that is only ever a connection
	 * target, used as the TLS SNI and the HTTP `Host` header so the destination sees an ordinary
	 * request. */
	host: string;
	/** Path and query string, already built and encoded; never interpolated further here. */
	path: string;
	/** 443 when omitted (every real `https://` definition); overridden only by a local test server
	 * bound to an ephemeral port. */
	port?: number;
	headers: Readonly<Record<string, string>>;
	body: string | null;
	timeoutMs: number;
	maxResponseBytes: number;
	/** Matched against the response's `Content-Type` media type only (parameters ignored), case
	 * insensitively. */
	allowedContentTypes: Readonly<string[]>;
	/** Extra trusted CA certificates — a local test server's own, in tests; omitted in production
	 * (the platform's trust store). */
	ca?: Readonly<(string | Buffer)[]>;
	/** Aborted when the action is asked to stop (kill-all, the agent disabled, the runner
	 * shutting down) — the executor's own `ToolExecutionContext.signal`, forwarded here so a stop
	 * request can cancel a call still resolving its destination, not only one already connected.
	 * Combined with this call's own timeout into the one deadline every stage shares
	 * (`callDeadline`). */
	signal: AbortSignal;
}>;

export type EgressResponse = Readonly<{
	status: number;
	contentType: string;
	body: string;
	/** `true` when `body` is deliberately empty: a write whose request had already been fully sent
	 * got back a 2xx the destination paired with a content type this definition does not allow
	 * (often no body or `Content-Type` at all — a plain 201/204). The write still happened, so this
	 * stays `succeeded`, never `failed` (a clean failure here would make an owner retry the same
	 * write under a new idempotency key); the body is simply not trusted enough to preview. */
	bodyWithheld: boolean;
}>;

export type EgressOutcome =
	| Readonly<{ kind: "response"; response: EgressResponse }>
	| Readonly<{ kind: "failed"; error: string }>;

/**
 * The one deadline every stage of a call shares — DNS, connect, TLS, send and the response body —
 * so a slow DNS answer leaves less, not a fresh budget, for everything after it: `AbortSignal.any`
 * combines this call's own `timeoutMs` with the executor's own cancellation signal
 * (`EgressRequest.signal`), so a kill-all or an agent disable aborts a call still resolving its
 * destination exactly the same way a deadline would. `sendEgressRequest` builds this once and
 * passes it on to `sendPinnedRequest`, so DNS and the request itself race against the identical
 * signal rather than each getting their own, independent `timeoutMs`; a caller of
 * `sendPinnedRequest` alone (every test that already knows its own resolved address, never
 * touching DNS) gets one built fresh from the same request.
 */
function callDeadline(request: EgressRequest): AbortSignal {
	return AbortSignal.any([AbortSignal.timeout(request.timeoutMs), request.signal]);
}

/** Rejects the moment `signal` aborts (or immediately, already aborted) — never resolves. Raced
 * against DNS resolution, which has no `AbortSignal` of its own to pass a deadline into. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		const onAbort = () => reject(new Error("aborted before the call could complete"));
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Sends one HTTPS request through the pinned-address guard above, with a hard deadline and a
 * streamed, size-capped response read. Returns `failed` for anything refused or cleanly answered
 * badly (blocked address, an unreadable content type, a response that is too large) — nothing was
 * left uncertain by any of those. Throws for anything that leaves the outcome genuinely uncertain:
 * a timeout, a cancellation or a connection error **after** the request was fully written (the
 * destination may have already acted on it) — the caller (`customHttpsExecutor`) reports those as
 * `unknown`, exactly as `@agent-gateway/tool-broker`'s own executor contract already requires of a
 * crash it cannot explain. The same abort before anything was sent — DNS still resolving, nothing
 * connected yet — is a clean `failed`: nothing happened for a retry to repeat.
 */
export async function sendEgressRequest(
	request: EgressRequest,
	resolve: DnsResolver,
): Promise<EgressOutcome> {
	const deadline = callDeadline(request);
	let pinned: ResolvedAddress;
	try {
		pinned = await Promise.race([
			resolvePinnedAddress(request.host, resolve),
			rejectOnAbort(deadline),
		]);
	} catch (error) {
		return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
	}
	return sendPinnedRequest(pinned, request, deadline);
}

/**
 * The actual HTTPS call, to an address the caller already validated (`resolvePinnedAddress`) —
 * this function trusts `address` completely and makes no judgment of its own about where it may
 * point. Split out from `sendEgressRequest` so the guard (SSRF, DNS rebinding — no real server,
 * no real network, an injected resolver) and the call's own mechanics (deadline, streamed size
 * cap, content-type, redirects never followed — a real local HTTPS test server, a test CA, no
 * guard in the way) are each exercised directly, without one standing in front of the other.
 * `deadline` is `sendEgressRequest`'s own, continuing a budget DNS resolution may have already
 * spent part of; omitted (every direct test, and any other caller with nothing of its own to
 * race DNS against), a fresh one is built from this same request.
 */
export async function sendPinnedRequest(
	address: ResolvedAddress,
	request: EgressRequest,
	deadline: AbortSignal = callDeadline(request),
): Promise<EgressOutcome> {
	const pinned = address;
	const bodyBuffer = request.body === null ? null : Buffer.from(request.body, "utf8");
	const headers: Record<string, string> = { ...request.headers, host: request.host };
	if (bodyBuffer !== null) {
		headers["content-type"] = "application/json";
		headers["content-length"] = String(bodyBuffer.byteLength);
	}
	const isWrite = customHttpMethodWrites(request.method);
	return new Promise<EgressOutcome>((settle, fail) => {
		let settled = false;
		// Node's own `finish` can fire before `secureConnect` (observed under Bun): a pre-send
		// connect/TLS failure (an untrusted CA, a hostname/certificate mismatch) must never look
		// sent just because the request body happened to be written into a socket buffer first.
		// Only once both have fired is the request genuinely on the wire and possibly acted on.
		let secureConnected = false;
		let finished = false;
		let sentFully = false;
		const markSentIfReady = () => {
			if (secureConnected && finished) {
				sentFully = true;
			}
		};
		const succeed = (outcome: EgressOutcome) => {
			if (!settled) {
				settled = true;
				settle(outcome);
			}
		};
		const uncertain = (error: unknown) => {
			if (!settled) {
				settled = true;
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		};
		const req = https.request({
			host: pinned.address,
			family: pinned.family,
			port: request.port ?? 443,
			method: request.method,
			path: request.path,
			servername: request.host,
			headers,
			signal: deadline,
			// A fresh connection every time: a reused keep-alive socket never emits `secureConnect` again,
			// which would misclassify a request that did reach the destination as never sent.
			agent: false,
			ca: request.ca as string[] | Buffer[] | undefined,
		});
		// `secureConnect` is a `tls.TLSSocket` event, never re-emitted on the request itself: it has
		// to be attached to the actual socket, once assigned (`req`'s own `'socket'` event — the one
		// ClientRequest event this really is).
		req.on("socket", (socket) => {
			socket.once("secureConnect", () => {
				secureConnected = true;
				markSentIfReady();
			});
		});
		req.on("finish", () => {
			finished = true;
			markSentIfReady();
		});
		req.on("response", (res) => {
			const contentType = (String(res.headers["content-type"] ?? "").split(";")[0] ?? "")
				.trim()
				.toLowerCase();
			const allowed = request.allowedContentTypes.some(
				(type) => type.toLowerCase() === contentType,
			);
			let total = 0;
			let oversized = false;
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => {
				if (oversized) {
					return;
				}
				total += chunk.byteLength;
				if (total > request.maxResponseBytes) {
					oversized = true;
					// Settled now, at the moment the overflow is actually detected: `res.destroy()`
					// below may end the stream with only a `close` event, never `end` — waiting for
					// `end` to decide the outcome would then hang forever instead of settling.
					if (isWrite && sentFully) {
						uncertain(new Error("the response exceeded its size limit after the request was sent"));
					} else {
						// Nothing but a read was ever at stake, or nothing was sent yet: a clean,
						// known failure, never retried under a new idempotency key.
						succeed({ kind: "failed", error: "the response exceeded its size limit" });
					}
					res.destroy();
					return;
				}
				chunks.push(chunk);
			});
			res.on("end", () => {
				if (oversized) {
					// Already settled above; a stream that still manages to fire `end` after
					// `destroy()` changes nothing further.
					return;
				}
				const status = res.statusCode;
				// Redirects are never followed (this module's own header comment) — a 3xx is never a
				// success, decided before the content-type gate below even runs: a redirect commonly
				// carries neither a body nor a `Content-Type` at all, which the gate alone would
				// otherwise misclassify as "unexpected content type" rather than "a redirect". A `GET`
				// (or a write whose own request never finished sending) is a clean `failed` — nothing
				// but a read was ever at stake, the same way an oversized `GET` response already is. A
				// write already fully sent is left genuinely ambiguous: a 3xx commonly means the
				// destination *did* act on it (a `303 See Other` pointing at a result is the classic
				// post-redirect-get shape), and this response alone cannot prove it did not — `unknown`,
				// settled by hand, exactly like any other write an answer left ambiguous after sending.
				if (typeof status === "number" && status >= 300 && status < 400) {
					const message = `the destination answered ${status} (a redirect); redirects are not followed`;
					if (!isWrite || !sentFully) {
						succeed({ kind: "failed", error: message });
					} else {
						uncertain(new Error(`${message}, so whether it acted on the write is unknown`));
					}
					return;
				}
				if (allowed) {
					succeed({
						kind: "response",
						response: {
							status: status ?? 0,
							contentType,
							body: Buffer.concat(chunks).toString("utf8"),
							bodyWithheld: false,
						},
					});
					return;
				}
				const unexpected = `unexpected content type '${contentType || "(none)"}'`;
				if (!isWrite || !sentFully) {
					// A read, or a write whose own request never finished sending: nothing of its
					// own was ever at stake in the destination's answer either way.
					succeed({ kind: "failed", error: unexpected });
					return;
				}
				if (typeof status !== "number") {
					// Genuinely ambiguous: the request was sent, but there is no status to tell a
					// destination's acceptance from its refusal.
					uncertain(new Error(`the response had no status and an ${unexpected}`));
					return;
				}
				if (status >= 200 && status < 300) {
					// The destination accepted the write (a 2xx with no body or `Content-Type` at
					// all, e.g. 201/204, is the common case) — a clean failure here is exactly what
					// would make an owner retry an already-done write under a new idempotency key.
					succeed({
						kind: "response",
						response: { status, contentType, body: "", bodyWithheld: true },
					});
					return;
				}
				if (writeStatusIsAmbiguous(status)) {
					// A 5xx or 408 already fully sent may have been acted on before the destination's
					// own answer failed — the same ambiguity a matching content type already carries at
					// `custom-https-executor.ts`'s own status check; an unreadable content type here must
					// not make this case look more certain than that one.
					uncertain(
						new Error(
							`the destination answered ${status} with an ${unexpected}, so whether it acted on the write is unknown`,
						),
					);
					return;
				}
				succeed({
					kind: "failed",
					error: `the destination answered ${status} with an ${unexpected}`,
				});
			});
			res.on("error", (error) => uncertain(error));
			// A stream destroyed with no error and no `end` (the overflow path above already
			// settled; anything else reaching here is a connection that closed mid-read for some
			// other reason) must still settle, never hang.
			res.on("close", () => {
				if (isWrite && sentFully) {
					uncertain(new Error("the connection closed before the response finished"));
				} else {
					succeed({ kind: "failed", error: "the connection closed before the response finished" });
				}
			});
		});
		req.on("error", (error) => {
			if (sentFully) {
				uncertain(error);
			} else {
				succeed({
					kind: "failed",
					error: `the request was never sent: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		});
		if (bodyBuffer !== null) {
			req.write(bodyBuffer);
		}
		req.end();
	});
}
