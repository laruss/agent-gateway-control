import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsoleStatus } from "@agent-gateway/core";
import { type Logger, silentLogger } from "@agent-gateway/logging";
import { CONSOLE_PASSWORD_MAX_LENGTH, hashConsolePassword } from "@agent-gateway/service";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConsolePasswordHash, startConsoleServer } from "./console-server.ts";
import type { ConsoleSnapshot, ConsoleStatusCache } from "./console-status.ts";

const PASSWORD = "correct horse battery staple 42";

function okStatus(): ConsoleStatus {
	return {
		system: {
			asOf: "2031-01-01T00:00:00.000Z",
			killSwitch: false,
			agents: [],
			omittedAgents: 0,
			runtimes: [],
			queues: [],
			outbox: { pending: 0, dead: 0 },
			approvalsPending: 0,
			toolActionsUnknown: 0,
			alerts: [],
			maintenance: [],
		},
		agents: [],
		recentRuns: [],
		alerts: [],
	};
}

function fixedCache(snapshot: ConsoleSnapshot): ConsoleStatusCache {
	return { get: async () => snapshot };
}

function basicAuthHeader(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/** Every test starts and always stops its own server instance, so ports never linger. */
const servers: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function withServer(
	overrides: Partial<Parameters<typeof startConsoleServer>[0]> = {},
): Promise<{ base: string }> {
	const passwordHash = overrides.passwordHash ?? (await hashConsolePassword(PASSWORD));
	const server = startConsoleServer({
		port: 0,
		hostname: "127.0.0.1",
		passwordHash,
		cache: fixedCache({ state: "ok", asOf: okStatus().system.asOf, status: okStatus() }),
		log: silentLogger,
		...overrides,
	});
	servers.push(server);
	return { base: `http://127.0.0.1:${server.port}` };
}

describe("console server authentication", () => {
	it("refuses a request with no credentials, with the Basic challenge and security headers", async () => {
		const { base } = await withServer();
		const res = await fetch(`${base}/`);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe(
			'Basic realm="Agent Gateway", charset="UTF-8"',
		);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
		expect(res.headers.get("x-frame-options")).toBe("DENY");
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("refuses a wrong password", async () => {
		const { base } = await withServer();
		const res = await fetch(`${base}/`, {
			headers: { authorization: basicAuthHeader("owner", "not the password") },
		});
		expect(res.status).toBe(401);
	});

	it("refuses a wrong username even with the correct password (still verifies the hash)", async () => {
		const { base } = await withServer();
		const res = await fetch(`${base}/`, {
			headers: { authorization: basicAuthHeader("not-owner", PASSWORD) },
		});
		expect(res.status).toBe(401);
	});

	it("accepts the correct owner credentials on both routes", async () => {
		const { base } = await withServer();
		const auth = { authorization: basicAuthHeader("owner", PASSWORD) };
		const page = await fetch(`${base}/`, { headers: auth });
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toContain("text/html");
		expect(await page.text()).toContain("Agent Gateway Console");

		const api = await fetch(`${base}/api/status`, { headers: auth });
		expect(api.status).toBe(200);
		expect(api.headers.get("content-type")).toContain("application/json");
		const body = (await api.json()) as ConsoleSnapshot;
		expect(body.state).toBe("ok");
	});

	it.each([
		["not-basic-at-all", "wrong scheme"],
		["Basic not-valid-base64!!!", "invalid base64 characters"],
		[`Basic ${Buffer.from("no-colon-here").toString("base64")}`, "no colon after decoding"],
	])("rejects a malformed Authorization header: %s (%s)", async (header) => {
		const { base } = await withServer();
		const res = await fetch(`${base}/`, { headers: { authorization: header } });
		expect(res.status).toBe(401);
	});

	it("accepts the longest password the CLI accepts, even in three-byte characters", async () => {
		const longest = "漢".repeat(CONSOLE_PASSWORD_MAX_LENGTH);
		const { base } = await withServer({ passwordHash: await hashConsolePassword(longest) });
		const res = await fetch(`${base}/`, {
			headers: { authorization: basicAuthHeader("owner", longest) },
		});
		expect(res.status).toBe(200);
	});

	it("rejects an oversize Authorization header with 400, before any verification", async () => {
		const { base } = await withServer();
		const oversized = `Basic ${"A".repeat(2048)}`;
		const res = await fetch(`${base}/`, { headers: { authorization: oversized } });
		expect(res.status).toBe(400);
	});

	it("rate-limits failed logins behind one global counter, with Retry-After", async () => {
		let now = 0;
		const clock = () => new Date(now);
		const { base } = await withServer({ clock });
		const wrong = { authorization: basicAuthHeader("owner", "nope") };
		for (let i = 0; i < 10; i++) {
			const res = await fetch(`${base}/`, { headers: wrong });
			expect(res.status).toBe(401);
		}
		// The 11th failure-shaped attempt is rate-limited, even with the right credentials.
		const right = { authorization: basicAuthHeader("owner", PASSWORD) };
		const limited = await fetch(`${base}/`, { headers: right });
		expect(limited.status).toBe(429);
		expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);

		now += 60_001; // past the window
		const recovered = await fetch(`${base}/`, { headers: right });
		expect(recovered.status).toBe(200);
	});

	it("bounds concurrent Argon2 verifications, answering the excess with 503", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const verifyPassword = async (): Promise<boolean> => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 30));
			inFlight -= 1;
			return true;
		};
		const { base } = await withServer({ maxConcurrentVerifications: 1, verifyPassword });
		const auth = { authorization: basicAuthHeader("owner", PASSWORD) };
		const responses = await Promise.all(
			Array.from({ length: 5 }, () => fetch(`${base}/`, { headers: auth })),
		);
		const statuses = responses.map((r) => r.status).sort();
		expect(statuses).toContain(503);
		expect(statuses).toContain(200);
		for (const res of responses) {
			expect(res.headers.get("cache-control")).toBe("no-store");
		}
	});

	it("returns 404 for an unknown path and 405 for an unsupported method, once authenticated", async () => {
		const { base } = await withServer();
		const auth = { authorization: basicAuthHeader("owner", PASSWORD) };
		const missing = await fetch(`${base}/nope`, { headers: auth });
		expect(missing.status).toBe(404);

		const wrongMethod = await fetch(`${base}/`, { method: "POST", headers: auth });
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.get("allow")).toBe("GET");

		const head = await fetch(`${base}/`, { method: "HEAD", headers: auth });
		expect(head.status).toBe(405);
	});

	it("carries the security headers on every response, including 404/405/429 errors", async () => {
		const { base } = await withServer();
		const auth = { authorization: basicAuthHeader("owner", PASSWORD) };
		const responses = await Promise.all([
			fetch(`${base}/nope`, { headers: auth }),
			fetch(`${base}/`, { method: "POST", headers: auth }),
			fetch(`${base}/`),
		]);
		for (const res of responses) {
			expect(res.headers.get("cache-control")).toBe("no-store");
			expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
			expect(res.headers.get("x-frame-options")).toBe("DENY");
			expect(res.headers.get("access-control-allow-origin")).toBeNull();
		}
	});

	it("renders a stale page with 200 and an unavailable page with 503 from the cache's own state", async () => {
		const status = okStatus();
		const stale = await withServer({
			cache: {
				get: async () => ({ state: "stale", asOf: status.system.asOf, status, error: "boom" }),
			},
		});
		const staleRes = await fetch(`${stale.base}/`, {
			headers: { authorization: basicAuthHeader("owner", PASSWORD) },
		});
		expect(staleRes.status).toBe(200);
		expect(await staleRes.text()).toContain("stale");

		const unavailable = await withServer({
			cache: { get: async () => ({ state: "unavailable", error: "no connection" }) },
		});
		const unavailableRes = await fetch(`${unavailable.base}/`, {
			headers: { authorization: basicAuthHeader("owner", PASSWORD) },
		});
		expect(unavailableRes.status).toBe(503);
		expect(await unavailableRes.text()).toContain("unavailable");
	});

	it("never logs the Authorization header or the password", async () => {
		const lines: string[] = [];
		const logger: Logger = {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: (message, fields) => lines.push(JSON.stringify({ message, fields })),
			child: () => logger,
		};
		const passwordHash = await hashConsolePassword(PASSWORD);
		const server = startConsoleServer({
			port: 0,
			hostname: "127.0.0.1",
			passwordHash,
			cache: {
				get: async () => {
					throw new Error("forced failure to exercise the top-level error log");
				},
			},
			log: logger,
		});
		servers.push(server);
		const secretHeader = basicAuthHeader("owner", PASSWORD);
		await fetch(`http://127.0.0.1:${server.port}/`, { headers: { authorization: secretHeader } });
		for (const line of lines) {
			expect(line).not.toContain(PASSWORD);
			expect(line).not.toContain(secretHeader);
		}
	});
});

describe("resolveConsolePasswordHash", () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir !== null) {
			rmSync(dir, { recursive: true, force: true });
			dir = null;
		}
	});

	it("fails closed when the hash file is missing", () => {
		const created = mkdtempSync(join(tmpdir(), "console-hash-"));
		dir = created;
		expect(() => resolveConsolePasswordHash(created)).toThrow(/missing/);
	});

	it("fails closed when the hash file is exposed (not private)", async () => {
		const created = mkdtempSync(join(tmpdir(), "console-hash-"));
		dir = created;
		const path = join(created, "console_password_hash");
		await Bun.write(path, "$argon2id$not-really-checked-here");
		chmodSync(path, 0o644); // group/world readable: intentionally not private.
		expect(() => resolveConsolePasswordHash(created)).toThrow(/private/);
	});

	it("reads the hash once it is written privately", async () => {
		const created = mkdtempSync(join(tmpdir(), "console-hash-"));
		dir = created;
		const path = join(created, "console_password_hash");
		const hash = await hashConsolePassword(PASSWORD);
		await Bun.write(path, hash);
		chmodSync(path, 0o600);
		expect(resolveConsolePasswordHash(created)).toBe(hash);
	});
});
