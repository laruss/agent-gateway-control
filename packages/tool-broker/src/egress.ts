import * as https from "node:https";
import type { CustomHttpMethod } from "@agent-gateway/contracts";
import { customHttpMethodWrites } from "@agent-gateway/contracts";
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
}>;

export type EgressResponse = Readonly<{ status: number; contentType: string; body: string }>;

export type EgressOutcome =
	| Readonly<{ kind: "response"; response: EgressResponse }>
	| Readonly<{ kind: "failed"; error: string }>;

/**
 * Sends one HTTPS request through the pinned-address guard above, with a hard deadline and a
 * streamed, size-capped response read. Returns `failed` for anything refused or cleanly answered
 * badly (blocked address, an unreadable content type, a response that is too large) — nothing was
 * left uncertain by any of those. Throws for anything that leaves the outcome genuinely uncertain:
 * a timeout or connection error **after** the request was fully written (the destination may have
 * already acted on it) — the caller (`customHttpsExecutor`) reports those as `unknown`, exactly as
 * `@agent-gateway/tool-broker`'s own executor contract already requires of a crash it cannot
 * explain.
 */
export async function sendEgressRequest(
	request: EgressRequest,
	resolve: DnsResolver,
): Promise<EgressOutcome> {
	let pinned: ResolvedAddress;
	try {
		pinned = await resolvePinnedAddress(request.host, resolve);
	} catch (error) {
		return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
	}
	return sendPinnedRequest(pinned, request);
}

/**
 * The actual HTTPS call, to an address the caller already validated (`resolvePinnedAddress`) —
 * this function trusts `address` completely and makes no judgment of its own about where it may
 * point. Split out from `sendEgressRequest` so the guard (SSRF, DNS rebinding — no real server,
 * no real network, an injected resolver) and the call's own mechanics (timeout, streamed size cap,
 * content-type, redirects never followed — a real local HTTPS test server, a test CA, no guard in
 * the way) are each exercised directly, without one standing in front of the other.
 */
export async function sendPinnedRequest(
	address: ResolvedAddress,
	request: EgressRequest,
): Promise<EgressOutcome> {
	const pinned = address;
	const bodyBuffer = request.body === null ? null : Buffer.from(request.body, "utf8");
	const headers: Record<string, string> = { ...request.headers, host: request.host };
	if (bodyBuffer !== null) {
		headers["content-type"] = "application/json";
		headers["content-length"] = String(bodyBuffer.byteLength);
	}
	return new Promise<EgressOutcome>((settle, fail) => {
		let settled = false;
		let sentFully = false;
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
		const req = https.request(
			{
				host: pinned.address,
				family: pinned.family,
				port: request.port ?? 443,
				method: request.method,
				path: request.path,
				servername: request.host,
				headers,
				timeout: request.timeoutMs,
				ca: request.ca as string[] | Buffer[] | undefined,
			},
			(res) => {
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
						res.destroy();
						return;
					}
					chunks.push(chunk);
				});
				res.on("end", () => {
					if (oversized) {
						// The request may already have been fully sent and acted on; only a read-only
						// call (never a write) can call this a clean, known failure.
						if (customHttpMethodWrites(request.method) && sentFully) {
							uncertain(
								new Error("the response exceeded its size limit after the request was sent"),
							);
						} else {
							succeed({ kind: "failed", error: "the response exceeded its size limit" });
						}
						return;
					}
					if (!allowed) {
						succeed({
							kind: "failed",
							error: `unexpected content type '${contentType || "(none)"}'`,
						});
						return;
					}
					succeed({
						kind: "response",
						response: {
							status: res.statusCode ?? 0,
							contentType,
							body: Buffer.concat(chunks).toString("utf8"),
						},
					});
				});
				res.on("error", (error) => uncertain(error));
			},
		);
		req.on("timeout", () => req.destroy(new Error("timed out")));
		req.on("finish", () => {
			sentFully = true;
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
