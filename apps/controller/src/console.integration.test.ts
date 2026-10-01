import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@agent-gateway/logging";
import { hashConsolePassword, writeSecretFile } from "@agent-gateway/service";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	type ConsoleServerOptions,
	resolveConsolePasswordHash,
	startConsoleServer,
} from "./console-server.ts";
import { collectConsoleStatus, createConsoleStatusCache } from "./console-status.ts";
import { startTestGateway, type TestGateway } from "./test-gateway.ts";

const PASSWORD = "integration test console password";
const ORIGIN = "https://gateway.local";
const FOREIGN_ORIGIN = "https://attacker.example";

type LoginOutcome = Readonly<{
	status: number;
	setCookie: string | null;
	body: Readonly<Record<string, unknown>>;
}>;

async function loginJson(
	base: string,
	password: string,
	headers: Readonly<Record<string, string>> = {},
): Promise<LoginOutcome> {
	const res = await fetch(`${base}/api/session`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
		body: JSON.stringify({ password }),
	});
	const setCookie = res.headers.get("set-cookie");
	const body = res.headers.get("content-type")?.includes("application/json")
		? ((await res.json()) as Record<string, unknown>)
		: {};
	return { status: res.status, setCookie, body };
}

/** The `name=value` pair a `Set-Cookie` response header carries, usable directly as a request's
 * own `Cookie` header. */
function cookiePair(setCookie: string | null): string {
	return (setCookie ?? "").split(";")[0] ?? "";
}

describe("the owner's console, wired against a real gateway (ADR-025)", () => {
	let gateway: TestGateway;
	let secretsDir: string;
	let passwordHash: string;

	beforeAll(async () => {
		gateway = await startTestGateway();
		secretsDir = mkdtempSync(join(tmpdir(), "console-integration-"));
		passwordHash = await hashConsolePassword(PASSWORD);
		writeSecretFile(join(secretsDir, "console_password_hash"), passwordHash);
	});

	afterAll(async () => {
		await gateway?.stop();
		rmSync(secretsDir, { recursive: true, force: true });
	});

	// Sessions are a single, global table (ADR-025: one owner); every test starts from an empty
	// one so an earlier test's still-active session never counts toward another's active cap or
	// answers a lookup it has no business answering.
	beforeEach(async () => {
		await gateway.pool.query("delete from console_sessions");
	});

	const servers: Array<{ stop: () => Promise<void> }> = [];
	afterEach(async () => {
		await Promise.all(servers.splice(0).map((s) => s.stop()));
	});

	async function withServer(
		overrides: Partial<ConsoleServerOptions> = {},
	): Promise<{ base: string }> {
		const server = startConsoleServer({
			port: 0,
			hostname: "127.0.0.1",
			passwordHash,
			origin: ORIGIN,
			pool: gateway.pool,
			cache: createConsoleStatusCache((now) => collectConsoleStatus(gateway.pool, now)),
			log: silentLogger,
			...overrides,
		});
		servers.push(server);
		return { base: `http://127.0.0.1:${server.port}` };
	}

	it("fails closed when the hash secret is missing, before anything is served", () => {
		const emptyDir = mkdtempSync(join(tmpdir(), "console-integration-empty-"));
		try {
			expect(() => resolveConsolePasswordHash(emptyDir)).toThrow();
		} finally {
			rmSync(emptyDir, { recursive: true, force: true });
		}
	});

	it("logs in, authenticates the dashboard and the JSON status, and logs out", async () => {
		const { base } = await withServer();

		const unauthenticatedPage = await fetch(`${base}/`);
		expect(unauthenticatedPage.status).toBe(200);
		expect(await unauthenticatedPage.text()).toContain("Sign in");

		const unauthenticatedApi = await fetch(`${base}/api/status`);
		expect(unauthenticatedApi.status).toBe(401);

		const login = await loginJson(base, PASSWORD);
		expect(login.status).toBe(200);
		expect(typeof login.body.csrfToken).toBe("string");
		expect(typeof login.body.expiresAt).toBe("string");
		const cookie = cookiePair(login.setCookie);

		const page = await fetch(`${base}/`, { headers: { cookie } });
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain("Agent Gateway Console");
		// One of the example agents, seeded by `startTestGateway`, shows up on the real page.
		expect(html).toContain("director");

		const api = await fetch(`${base}/api/status`, { headers: { cookie } });
		expect(api.status).toBe(200);
		const body = (await api.json()) as {
			state: string;
			status?: { agents: Array<{ status: { agentId: string } }> };
		};
		expect(body.state).toBe("ok");
		expect(body.status?.agents.some((a) => a.status.agentId === "director")).toBe(true);

		const sessionCheck = await fetch(`${base}/api/session`, { headers: { cookie } });
		expect(sessionCheck.status).toBe(200);
		const sessionBody = (await sessionCheck.json()) as {
			authenticated: boolean;
			csrfToken: string;
		};
		expect(sessionBody.authenticated).toBe(true);

		const logout = await fetch(`${base}/api/session`, {
			method: "DELETE",
			headers: { cookie, origin: ORIGIN, "x-csrf-token": sessionBody.csrfToken },
		});
		expect(logout.status).toBe(204);
		expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");

		expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(401);
	});

	it("refuses a wrong password without setting a cookie", async () => {
		const { base } = await withServer();
		const login = await loginJson(base, "not the password");
		expect(login.status).toBe(401);
		expect(login.setCookie).toBeNull();
	});

	it("rate-limits failed logins behind one global counter, with Retry-After", async () => {
		let now = new Date("2031-03-01T00:00:00.000Z");
		const { base } = await withServer({ clock: () => now });
		for (let i = 0; i < 10; i += 1) {
			expect((await loginJson(base, "nope")).status).toBe(401);
		}
		const limited = await loginJson(base, PASSWORD);
		expect(limited.status).toBe(429);

		now = new Date(now.getTime() + 60_001); // past the window
		const recovered = await loginJson(base, PASSWORD);
		expect(recovered.status).toBe(200);
	});

	it("sets the session cookie host-only, HttpOnly, Secure, SameSite=Strict and never Domain", async () => {
		const { base } = await withServer();
		const login = await loginJson(base, PASSWORD);
		const setCookie = login.setCookie ?? "";
		expect(setCookie).toContain("__Host-gw_session=");
		expect(setCookie).toContain("Path=/");
		expect(setCookie).toContain("Secure");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Strict");
		expect(setCookie).not.toContain("Domain=");
	});

	it("never accepts a client-supplied session cookie: login always mints a fresh one (fixation)", async () => {
		const { base } = await withServer();
		const presetCookie = "__Host-gw_session=attacker-chosen-value";
		const login = await loginJson(base, PASSWORD, { cookie: presetCookie });
		expect(login.status).toBe(200);
		const mintedCookie = cookiePair(login.setCookie);
		expect(mintedCookie).not.toBe(presetCookie);

		// The attacker-chosen value never became a valid session.
		expect((await fetch(`${base}/api/status`, { headers: { cookie: presetCookie } })).status).toBe(
			401,
		);
		// The one actually minted by login did.
		expect((await fetch(`${base}/api/status`, { headers: { cookie: mintedCookie } })).status).toBe(
			200,
		);
	});

	it("idle expiry: a session with no request for 30 minutes stops authenticating", async () => {
		let now = new Date("2031-03-02T00:00:00.000Z");
		const { base } = await withServer({ clock: () => now });
		const login = await loginJson(base, PASSWORD);
		const cookie = cookiePair(login.setCookie);
		expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(200);

		now = new Date(now.getTime() + 31 * 60 * 1000);
		expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(401);
	});

	it("absolute expiry: a session expires at 12 hours even with activity throughout", async () => {
		let now = new Date("2031-03-03T00:00:00.000Z");
		const { base } = await withServer({ clock: () => now });
		const login = await loginJson(base, PASSWORD);
		const cookie = cookiePair(login.setCookie);
		for (let i = 0; i < 23; i += 1) {
			now = new Date(now.getTime() + 29 * 60 * 1000);
			expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(200);
		}
		now = new Date(now.getTime() + 60 * 60 * 1000);
		expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(401);
	});

	it("a rotated password invalidates sessions bound to the old hash once the controller restarts", async () => {
		const firstPassword = "first password for the rotation test";
		const firstHash = await hashConsolePassword(firstPassword);
		const { base: baseA } = await withServer({ passwordHash: firstHash });
		const login = await loginJson(baseA, firstPassword);
		const cookie = cookiePair(login.setCookie);
		expect((await fetch(`${baseA}/api/status`, { headers: { cookie } })).status).toBe(200);

		const secondPassword = "second password for the rotation test";
		const secondHash = await hashConsolePassword(secondPassword);
		const { base: baseB } = await withServer({ passwordHash: secondHash });
		expect((await fetch(`${baseB}/api/status`, { headers: { cookie } })).status).toBe(401);
		expect((await loginJson(baseB, secondPassword)).status).toBe(200);
	});

	it("rejects a missing or foreign Origin on login", async () => {
		const { base } = await withServer();
		const noOrigin = await fetch(`${base}/api/session`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: PASSWORD }),
		});
		expect(noOrigin.status).toBe(403);
		const foreignOrigin = await fetch(`${base}/api/session`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: FOREIGN_ORIGIN },
			body: JSON.stringify({ password: PASSWORD }),
		});
		expect(foreignOrigin.status).toBe(403);
	});

	it("rejects `Sec-Fetch-Site: cross-site` on login even with the exact Origin", async () => {
		const { base } = await withServer();
		const res = await fetch(`${base}/api/session`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: ORIGIN,
				"sec-fetch-site": "cross-site",
			},
			body: JSON.stringify({ password: PASSWORD }),
		});
		expect(res.status).toBe(403);
	});

	it("rejects a missing or foreign Origin on a mutation (logout)", async () => {
		const { base } = await withServer();
		const login = await loginJson(base, PASSWORD);
		const cookie = cookiePair(login.setCookie);
		const csrfToken = login.body.csrfToken as string;

		const noOrigin = await fetch(`${base}/api/session`, {
			method: "DELETE",
			headers: { cookie, "x-csrf-token": csrfToken },
		});
		expect(noOrigin.status).toBe(403);

		const foreignOrigin = await fetch(`${base}/api/session`, {
			method: "DELETE",
			headers: { cookie, origin: FOREIGN_ORIGIN, "x-csrf-token": csrfToken },
		});
		expect(foreignOrigin.status).toBe(403);

		// The session is still alive: both mutation attempts above were refused before anything
		// changed.
		expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(200);
	});

	it("rejects a missing or wrong CSRF token on a mutation", async () => {
		const { base } = await withServer();
		const login = await loginJson(base, PASSWORD);
		const cookie = cookiePair(login.setCookie);

		const missing = await fetch(`${base}/api/session`, {
			method: "DELETE",
			headers: { cookie, origin: ORIGIN },
		});
		expect(missing.status).toBe(403);

		const wrong = await fetch(`${base}/api/session`, {
			method: "DELETE",
			headers: { cookie, origin: ORIGIN, "x-csrf-token": "not-the-right-token" },
		});
		expect(wrong.status).toBe(403);

		expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(200);
	});

	it("rejects a CSRF token that belongs to another session", async () => {
		const { base } = await withServer();
		const sessionA = await loginJson(base, PASSWORD);
		const sessionB = await loginJson(base, PASSWORD);
		const cookieA = cookiePair(sessionA.setCookie);
		const csrfB = sessionB.body.csrfToken as string;

		const res = await fetch(`${base}/api/session`, {
			method: "DELETE",
			headers: { cookie: cookieA, origin: ORIGIN, "x-csrf-token": csrfB },
		});
		expect(res.status).toBe(403);
		// Session A is untouched; it was never actually logged out.
		expect((await fetch(`${base}/api/status`, { headers: { cookie: cookieA } })).status).toBe(200);
	});

	it("evicts the oldest sessions beyond a configured active cap", async () => {
		// An injected, strictly increasing clock avoids ties in `created_at` between logins that a
		// real clock could produce within the same millisecond.
		let now = new Date("2031-03-04T00:00:00.000Z");
		const { base } = await withServer({ maxActiveSessions: 2, clock: () => now });
		const first = cookiePair((await loginJson(base, PASSWORD)).setCookie);
		now = new Date(now.getTime() + 1_000);
		await loginJson(base, PASSWORD);
		now = new Date(now.getTime() + 1_000);
		const third = cookiePair((await loginJson(base, PASSWORD)).setCookie);

		expect((await fetch(`${base}/api/status`, { headers: { cookie: first } })).status).toBe(401);
		expect((await fetch(`${base}/api/status`, { headers: { cookie: third } })).status).toBe(200);
	});

	it("returns 404 for an unknown path and 405 for an unsupported method", async () => {
		const { base } = await withServer();
		const missing = await fetch(`${base}/nope`);
		expect(missing.status).toBe(404);

		const wrongMethod = await fetch(`${base}/`, { method: "PUT" });
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.get("allow")).toBe("GET, POST");
	});

	it("carries the security headers on every response, including error and login responses", async () => {
		const { base } = await withServer();
		const responses = await Promise.all([
			fetch(`${base}/nope`),
			fetch(`${base}/`),
			fetch(`${base}/api/status`),
		]);
		for (const res of responses) {
			expect(res.headers.get("cache-control")).toBe("no-store");
			expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
			expect(res.headers.get("x-frame-options")).toBe("DENY");
			expect(res.headers.get("referrer-policy")).toBe("same-origin");
		}
	});

	it("sets Referrer-Policy: same-origin (not no-referrer, which would null a same-origin POST's own Origin header) and still refuses a literal Origin: null", async () => {
		const { base } = await withServer();
		const page = await fetch(`${base}/`);
		// `no-referrer` and `same-origin` both withhold the `Referer` header from a cross-site
		// request; the difference that matters here is what a *same-origin* request sends. Per the
		// Fetch spec, a non-GET/HEAD, non-CORS-mode request (a plain HTML form POST, in particular)
		// carries `Origin: null` under `no-referrer`, which would make the console's own login form
		// fail its own exact-Origin check. `same-origin` does not null it for a same-origin request,
		// only for a cross-origin one.
		expect(page.headers.get("referrer-policy")).toBe("same-origin");

		// A request that actually carries the literal string "null" as its Origin — what a
		// sandboxed or opaque-origin cross-site request sends — is still refused: switching away
		// from `no-referrer` never widens what `originAllowed` accepts.
		const nullOrigin = await fetch(`${base}/api/session`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "null" },
			body: JSON.stringify({ password: PASSWORD }),
		});
		expect(nullOrigin.status).toBe(403);
	});

	it("rejects an oversized chunked body (no Content-Length) with 413, aborting well before reading it all", async () => {
		const { base } = await withServer();
		const chunk = new Uint8Array(1024);
		let bytesProduced = 0;
		// Never closes on its own: if the server read this to completion instead of aborting once
		// it exceeds the login body limit, this request would never finish.
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				bytesProduced += chunk.byteLength;
				controller.enqueue(chunk);
			},
		});
		const res = await fetch(`${base}/api/session`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: ORIGIN },
			body: stream,
			duplex: "half",
		});
		expect(res.status).toBe(413);
		// Well short of what "reading the whole (never-ending) body" would have produced: the
		// server stopped pulling from the stream once the running total crossed the limit.
		expect(bytesProduced).toBeLessThan(16 * 1024);
	});

	it("rejects an oversized body declared via Content-Length with 413", async () => {
		const { base } = await withServer();
		const res = await fetch(`${base}/api/session`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: ORIGIN },
			body: JSON.stringify({ password: "x".repeat(8192) }),
		});
		expect(res.status).toBe(413);
	});

	it("never logs the password, a session token or a cookie, even while erroring", async () => {
		const lines: string[] = [];
		const logger = {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: (message: string, fields?: Record<string, unknown>) =>
				lines.push(JSON.stringify({ message, fields })),
			child: () => logger,
		};
		const { base } = await withServer({
			log: logger,
			cache: { get: async () => Promise.reject(new Error("forced failure")) },
		});
		const login = await loginJson(base, PASSWORD);
		const cookie = cookiePair(login.setCookie);
		await fetch(`${base}/api/status`, { headers: { cookie } });
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(line).not.toContain(PASSWORD);
			expect(line).not.toContain(cookie);
		}
	});

	it("stops accepting connections once stopped", async () => {
		const { base } = await withServer();
		const server = servers.pop();
		await server?.stop();
		await expect(fetch(`${base}/`)).rejects.toThrow();
	});
});
