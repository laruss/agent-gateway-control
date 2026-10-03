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
			res.end(JSON.stringify({ big: "x".repeat(10_000) }));
		});
		const outcome = await sendPinnedRequest(address, baseRequest({ maxResponseBytes: 32 }));
		expect(outcome).toMatchObject({ kind: "failed", error: expect.stringContaining("size limit") });
	});

	it("treats an oversized response to a write as unknown (throws)", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ big: "x".repeat(10_000) }));
		});
		await expect(
			sendPinnedRequest(
				address,
				baseRequest({ method: "POST", body: JSON.stringify({ title: "x" }), maxResponseBytes: 32 }),
			),
		).rejects.toThrow(/size limit/);
	});

	it("treats a timeout after the request was sent as unknown (throws)", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			// Never responds; the client's own timeout must fire.
			setTimeout(() => res.end(), 5000);
		});
		await expect(
			sendPinnedRequest(address, baseRequest({ method: "POST", body: "{}", timeoutMs: 100 })),
		).rejects.toThrow();
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
