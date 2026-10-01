import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApiError,
	checkSession,
	fetchConsoleStatus,
	setCsrfToken,
	signIn,
	signOut,
} from "./api-client.ts";

// ---------------------------------------------------------------------------
// The console's typed fetch wrapper, exercised against a mocked `fetch`: every documented
// `POST /api/session` outcome (ADR-025), the CSRF header added on mutations once a token is
// held, and a 401 from `/api/status` becoming the specific `ApiError` the session layer reacts
// to.
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

describe("api-client", () => {
	beforeEach(() => {
		setCsrfToken(null);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe("signIn", () => {
		it("returns ok and captures the CSRF token on success", async () => {
			const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) =>
				jsonResponse({
					csrfToken: "fresh-token",
					expiresAt: "2031-01-01T00:00:00.000Z",
				}),
			);
			vi.stubGlobal("fetch", fetchMock);

			const outcome = await signIn("correct horse battery staple");
			expect(outcome).toEqual({
				kind: "ok",
				expiresAt: "2031-01-01T00:00:00.000Z",
			});

			const init = fetchMock.mock.calls[0]?.[1];
			expect(init?.credentials).toBe("same-origin");
			expect(init?.method).toBe("POST");
		});

		it("reports a wrong password as 'invalid', not an error", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response("invalid credentials", { status: 401 })),
			);
			expect(await signIn("wrong")).toEqual({ kind: "invalid" });
		});

		it("reports 429 as 'rate-limited' with the Retry-After seconds", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response("too many attempts", {
							status: 429,
							headers: { "retry-after": "17" },
						}),
				),
			);
			expect(await signIn("wrong")).toEqual({
				kind: "rate-limited",
				retryAfterSeconds: 17,
			});
		});

		it("reports 503 as 'busy'", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response("busy", { status: 503 })),
			);
			expect(await signIn("x")).toEqual({ kind: "busy" });
		});
	});

	describe("CSRF header", () => {
		it("adds X-CSRF-Token on a mutation once a token is held, and never on a GET", async () => {
			const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				if (method === "GET") {
					return jsonResponse({ authenticated: false });
				}
				return new Response(null, { status: 204 });
			});
			vi.stubGlobal("fetch", fetchMock);

			await checkSession(); // authenticated: false, no token captured
			setCsrfToken("held-token");
			await signOut();

			const signOutInit = fetchMock.mock.calls[1]?.[1];
			const headers = new Headers(signOutInit?.headers);
			expect(headers.get("X-CSRF-Token")).toBe("held-token");

			const checkInit = fetchMock.mock.calls[0]?.[1];
			expect(new Headers(checkInit?.headers).get("X-CSRF-Token")).toBeNull();
		});

		it("captures a fresh token from GET /api/session when authenticated", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					jsonResponse({
						authenticated: true,
						csrfToken: "rotated-token",
						expiresAt: "2031-01-01T00:00:00.000Z",
					}),
				),
			);
			const check = await checkSession();
			expect(check).toEqual({
				authenticated: true,
				csrfToken: "rotated-token",
				expiresAt: "2031-01-01T00:00:00.000Z",
			});

			const fetchMock = vi.fn(
				async (_input: string, _init?: RequestInit) => new Response(null, { status: 204 }),
			);
			vi.stubGlobal("fetch", fetchMock);
			await signOut();
			const init = fetchMock.mock.calls[0]?.[1];
			expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("rotated-token");
		});
	});

	describe("fetchConsoleStatus", () => {
		it("throws a 401 ApiError, which the session layer treats as 'sign out'", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response("unauthorized", { status: 401 })),
			);
			await expect(fetchConsoleStatus()).rejects.toMatchObject({
				name: "ApiError",
				status: 401,
				kind: "unauthorized",
			});
		});

		it("parses a 503 'unavailable' snapshot instead of treating it as a transport failure", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => jsonResponse({ state: "unavailable", error: "no data yet" }, 503)),
			);
			const snapshot = await fetchConsoleStatus();
			expect(snapshot).toEqual({ state: "unavailable", error: "no data yet" });
		});

		it("rejects a response that fails schema validation rather than returning it as-is", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => jsonResponse({ state: "not-a-real-state" })),
			);
			await expect(fetchConsoleStatus()).rejects.toBeInstanceOf(Error);
			await expect(fetchConsoleStatus()).rejects.not.toBeInstanceOf(ApiError);
		});
	});
});
