import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	type DnsResolver,
	EgressBlockedError,
	type EgressRequest,
	type ResolvedAddress,
	resolvePinnedAddress,
	sendPinnedRequest,
} from "./egress.ts";
import {
	generateServerCert,
	generateTestCa,
	generateTestTls,
	type RunningTestServer,
	startTestHttpsServer,
	TEST_CUSTOM_TOOL_HOST,
	type TestTls,
} from "./testing-tls.ts";

function resolverOf(addresses: Readonly<ResolvedAddress[]>): Readonly<{
	resolve: DnsResolver;
	calls: () => number;
}> {
	let calls = 0;
	return {
		resolve: async () => {
			calls += 1;
			return addresses;
		},
		calls: () => calls,
	};
}

describe("resolvePinnedAddress: SSRF and DNS-rebinding guard", () => {
	it("blocks a literal private/loopback/link-local/CGNAT/multicast address outright", async () => {
		const neverResolves: DnsResolver = async () => {
			throw new Error("a literal address must never reach the resolver");
		};
		const blockedHosts = [
			"127.0.0.1",
			"10.0.0.5",
			"172.16.1.1",
			"192.168.1.1",
			"169.254.169.254",
			"100.64.0.1",
			"224.0.0.1",
			"0.0.0.0",
			"255.255.255.255",
			"2130706433", // decimal for 127.0.0.1
			"0x7f000001", // hex for 127.0.0.1
			"017700000001", // octal for 127.0.0.1
			"::1",
			"fe80::1",
			"fc00::1",
			"::ffff:127.0.0.1", // IPv4-mapped
		];
		for (const host of blockedHosts) {
			await expect(resolvePinnedAddress(host, neverResolves)).rejects.toThrow(EgressBlockedError);
		}
	});

	it("blocks a hostname that resolves only to non-public addresses", async () => {
		const { resolve } = resolverOf([{ address: "127.0.0.1", family: 4 }]);
		await expect(resolvePinnedAddress("evil.example.test", resolve)).rejects.toThrow(
			EgressBlockedError,
		);
	});

	it("blocks a hostname with no address at all", async () => {
		const { resolve } = resolverOf([]);
		await expect(resolvePinnedAddress("nowhere.example.test", resolve)).rejects.toThrow(
			EgressBlockedError,
		);
	});

	it("accepts a hostname that resolves to a public address, resolving exactly once", async () => {
		const { resolve, calls } = resolverOf([{ address: "8.8.8.8", family: 4 }]);
		const pinned = await resolvePinnedAddress("api.example.test", resolve);
		expect(pinned).toEqual({ address: "8.8.8.8", family: 4 });
		expect(calls()).toBe(1);
	});

	it("defeats DNS rebinding: the pinned address is reused, a second lookup never happens", async () => {
		// A resolver that would answer differently on a second call, if one were ever made.
		let callCount = 0;
		const rebinding: DnsResolver = async () => {
			callCount += 1;
			return callCount === 1
				? [{ address: "8.8.8.8", family: 4 }]
				: [{ address: "127.0.0.1", family: 4 }];
		};
		const first = await resolvePinnedAddress("rebinder.example.test", rebinding);
		expect(first.address).toBe("8.8.8.8");
		// `sendEgressRequest`/`customHttpsExecutor` call `resolvePinnedAddress` exactly once per
		// request and connect only to the address it returned — what a second call would have
		// answered (simulated above) never gets a chance to matter.
		expect(callCount).toBe(1);
	});
});

describe("sendPinnedRequest: against a real local HTTPS server", () => {
	let tls: TestTls;
	let server: RunningTestServer | null = null;
	const address: ResolvedAddress = { address: "127.0.0.1", family: 4 };

	beforeAll(() => {
		tls = generateTestTls();
	});

	afterEach(async () => {
		await server?.close();
		server = null;
	});

	function baseRequest(overrides: Partial<EgressRequest> = {}): EgressRequest {
		if (server === null) {
			throw new Error("start the test server before building a request");
		}
		return {
			method: "GET",
			host: TEST_CUSTOM_TOOL_HOST,
			path: "/",
			port: server.port,
			headers: {},
			body: null,
			timeoutMs: 2000,
			maxResponseBytes: 1024,
			allowedContentTypes: ["application/json"],
			ca: [tls.caCert],
			signal: new AbortController().signal,
			...overrides,
		};
	}

	it("completes a request to the resolved address with the definition's own SNI/Host", async () => {
		let seenHost: string | undefined;
		server = await startTestHttpsServer(tls, (req, res) => {
			seenHost = req.headers.host;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
		const outcome = await sendPinnedRequest(address, baseRequest({ path: "/tickets" }));
		expect(outcome.kind).toBe("response");
		expect(seenHost).toBe(TEST_CUSTOM_TOOL_HOST);
		expect(server.requests()).toBe(1);
	});

	it("rejects an unexpected content type as a clean, known failure", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			res.writeHead(200, { "content-type": "text/html" });
			res.end("<html></html>");
		});
		const outcome = await sendPinnedRequest(address, baseRequest());
		expect(outcome).toMatchObject({ kind: "failed" });
	});

	it("aborts an oversized GET response as a clean, known failure", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			// Many small chunks, not one big write: the overflow must be caught mid-stream, the
			// same shape a chunked response from a real destination would take.
			for (let i = 0; i < 50; i += 1) {
				res.write("x".repeat(200));
			}
			res.end();
		});
		const started = Date.now();
		const outcome = await sendPinnedRequest(address, baseRequest({ maxResponseBytes: 32 }));
		expect(outcome).toMatchObject({ kind: "failed", error: expect.stringContaining("size limit") });
		// Settled as soon as the cap was exceeded, not merely bounded by some later deadline.
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("treats an oversized response to a write as unknown (throws)", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			for (let i = 0; i < 50; i += 1) {
				res.write("x".repeat(200));
			}
			res.end();
		});
		const started = Date.now();
		await expect(
			sendPinnedRequest(
				address,
				baseRequest({ method: "POST", body: JSON.stringify({ title: "x" }), maxResponseBytes: 32 }),
			),
		).rejects.toThrow(/size limit/);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("settles a connection that closes before the response finishes, never hanging", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.write('{"partial":tr');
			res.socket?.destroy();
		});
		let outcome: "threw" | Awaited<ReturnType<typeof sendPinnedRequest>> = "threw";
		try {
			outcome = await sendPinnedRequest(address, baseRequest());
		} catch {
			outcome = "threw";
		}
		// Either classification is a legitimate read of an abruptly closed socket; what matters is
		// that this resolved at all instead of hanging (vitest's own test timeout would otherwise
		// catch that, but the explicit assertion documents the actual guarantee).
		expect(outcome === "threw" || outcome.kind === "failed").toBe(true);
	});

	it("treats a timeout after the request was sent as unknown (throws)", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			// Never responds; the client's own deadline must fire.
			setTimeout(() => res.end(), 5000);
		});
		await expect(
			sendPinnedRequest(address, baseRequest({ method: "POST", body: "{}", timeoutMs: 100 })),
		).rejects.toThrow();
	});

	it("classifies a timed-out write as unknown even right after an earlier request to the same destination", async () => {
		let calls = 0;
		server = await startTestHttpsServer(tls, (_req, res) => {
			calls += 1;
			if (calls === 1) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end("{}");
				return;
			}
			// The second request reaches the server and is never answered within the deadline.
			setTimeout(() => res.end(), 5000);
		});
		const first = await sendPinnedRequest(address, baseRequest({ method: "POST", body: "{}" }));
		expect(first.kind).toBe("response");
		await expect(
			sendPinnedRequest(address, baseRequest({ method: "POST", body: "{}", timeoutMs: 200 })),
		).rejects.toThrow();
		expect(calls).toBe(2);
	});

	it("enforces one hard deadline even against a response that trickles just fast enough to never go idle", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			const drip = setInterval(() => res.write("x"), 40);
			res.on("close", () => clearInterval(drip));
		});
		const started = Date.now();
		await expect(
			sendPinnedRequest(address, baseRequest({ method: "POST", body: "{}", timeoutMs: 200 })),
		).rejects.toThrow();
		// A socket-idle timeout would never fire here (something arrives every 40ms); the hard
		// deadline must still cut this off close to `timeoutMs`, not run for seconds.
		expect(Date.now() - started).toBeLessThan(1500);
	});

	it("fails cleanly, before anything was sent, when the signal is already aborted", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
		const controller = new AbortController();
		controller.abort();
		const outcome = await sendPinnedRequest(address, baseRequest({ signal: controller.signal }));
		expect(outcome).toMatchObject({ kind: "failed" });
	});

	it("cancels an in-flight write after it was sent as unknown (throws)", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			setTimeout(() => res.end("{}"), 5000);
		});
		const controller = new AbortController();
		const promise = sendPinnedRequest(
			address,
			baseRequest({ method: "POST", body: "{}", signal: controller.signal, timeoutMs: 5000 }),
		);
		setTimeout(() => controller.abort(), 100);
		await expect(promise).rejects.toThrow();
	});

	it("treats a 2xx write answered with no usable content type as succeeded, body withheld", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			res.writeHead(204);
			res.end();
		});
		const outcome = await sendPinnedRequest(address, baseRequest({ method: "POST", body: "{}" }));
		expect(outcome).toMatchObject({
			kind: "response",
			response: { status: 204, bodyWithheld: true, body: "" },
		});
	});

	it("treats a non-2xx write with an unexpected content type as failed, not succeeded", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			res.writeHead(500, { "content-type": "text/plain" });
			res.end("boom");
		});
		const outcome = await sendPinnedRequest(address, baseRequest({ method: "POST", body: "{}" }));
		expect(outcome).toMatchObject({ kind: "failed" });
	});

	it("still fails a GET with an unexpected content type even on a 2xx (reads stay failed)", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			res.writeHead(200, { "content-type": "text/html" });
			res.end("<html></html>");
		});
		const outcome = await sendPinnedRequest(address, baseRequest());
		expect(outcome).toMatchObject({ kind: "failed" });
	});

	it("fails a GET answered with a redirect, before the (absent) content type is ever considered", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			// No `Content-Type` at all — the common shape of a redirect's own response, which the
			// content-type gate alone would otherwise call "unexpected content type" rather than what
			// it actually is.
			res.writeHead(302, { location: "https://elsewhere.example/" });
			res.end();
		});
		const outcome = await sendPinnedRequest(address, baseRequest());
		expect(outcome).toEqual({
			kind: "failed",
			error: "the destination answered 302 (a redirect); redirects are not followed",
		});
	});

	it("treats a redirect to a write already fully sent as unknown (throws): the destination may have acted on it", async () => {
		server = await startTestHttpsServer(tls, (req, res) => {
			req.on("data", () => undefined);
			req.on("end", () => {
				res.writeHead(303, { location: "https://elsewhere.example/result" });
				res.end();
			});
		});
		await expect(
			sendPinnedRequest(address, baseRequest({ method: "POST", body: "{}" })),
		).rejects.toThrow(/303 \(a redirect\).*unknown/);
	});

	it("fails cleanly (never unknown) when the server's CA is not trusted", async () => {
		const untrusted = generateTestTls();
		server = await startTestHttpsServer(untrusted, (_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
		// `tls.caCert`, not `untrusted`'s own CA: the handshake itself must fail before any data is
		// ever written — a pre-connect failure, never "sent".
		const outcome = await sendPinnedRequest(
			address,
			baseRequest({ method: "POST", body: "{}", ca: [tls.caCert] }),
		);
		expect(outcome).toMatchObject({ kind: "failed" });
	});

	it("fails cleanly (never unknown) on a hostname/certificate mismatch", async () => {
		const ca = generateTestCa();
		const mismatched = generateServerCert(ca, "other-host.test");
		server = await startTestHttpsServer(mismatched, (_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
		// The CA is trusted, but the certificate names a different host than the SNI/Host this call
		// sends (`TEST_CUSTOM_TOOL_HOST`, `baseRequest`'s own default) — a certificate validation
		// failure, same as an untrusted CA: still before anything was sent.
		const outcome = await sendPinnedRequest(
			address,
			baseRequest({ method: "POST", body: "{}", ca: [ca.certPem] }),
		);
		expect(outcome).toMatchObject({ kind: "failed" });
	});

	it("carries the idempotency header through to the server", async () => {
		let seenKey: string | undefined;
		server = await startTestHttpsServer(tls, (req, res) => {
			seenKey = req.headers["idempotency-key"] as string | undefined;
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
		await sendPinnedRequest(
			address,
			baseRequest({
				method: "POST",
				body: "{}",
				headers: { "idempotency-key": "tool-action:abc:def" },
			}),
		);
		expect(seenKey).toBe("tool-action:abc:def");
	});
});
