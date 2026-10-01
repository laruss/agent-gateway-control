// @vitest-environment happy-dom
import { render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, useSession } from "./session-context.tsx";

// ---------------------------------------------------------------------------
// Two review findings fixed together (both would fail without their fix):
// - Logout only moves to signed-out after a 2xx or 401 from `DELETE /api/session`; a 403/500/
//   network failure keeps the session and lets the caller see the error.
// - A direct `/sign-in` load's startup `GET /api/session` can still be in flight when a sign-in
//   submitted in the meantime already won; the late, now-stale "unauthenticated" result must not
//   overwrite the fresh "signed-in" state once it resolves.
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Exposes every `useSession` field a test needs to poke at and observe. */
function Probe(): React.ReactElement {
	const { state, signIn, signOut } = useSession();
	return (
		<div>
			<div data-testid="status">{state.status}</div>
			<button
				type="button"
				onClick={() => {
					void signOut().catch(() => {
						// The test observes the rejection itself; swallowing it here only keeps the
						// probe component from crashing on an unhandled rejection.
					});
				}}
			>
				sign out
			</button>
			<button type="button" onClick={() => void signIn("the-password")}>
				sign in
			</button>
		</div>
	);
}

function renderProbe() {
	return render(
		<SessionProvider>
			<Probe />
		</SessionProvider>,
	);
}

describe("SessionProvider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps the session signed-in when DELETE /api/session fails (403), rather than signing out locally", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				if (method === "GET" && input.endsWith("/api/session")) {
					return jsonResponse({
						authenticated: true,
						csrfToken: "t",
						expiresAt: "2031-01-01T00:00:00.000Z",
					});
				}
				if (method === "DELETE") {
					return new Response("missing or invalid CSRF token", { status: 403 });
				}
				throw new Error(`unexpected request: ${method} ${input}`);
			}),
		);

		renderProbe();
		await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-in"));

		screen.getByRole("button", { name: "sign out" }).click();

		// The server refused the logout: the cookie is still valid, so the session must still say
		// signed-in a moment later, never flip to signed-out on the strength of the local call alone.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(screen.getByTestId("status").textContent).toBe("signed-in");
	});

	it("a sign-in that wins the race supersedes a startup session check that resolves 'unauthenticated' after it", async () => {
		let resolveStartupCheck: ((response: Response) => void) | undefined;
		const startupCheck = new Promise<Response>((resolve) => {
			resolveStartupCheck = resolve;
		});

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				if (method === "GET" && input.endsWith("/api/session")) {
					// The very first call is the startup check; it is held open deliberately, so the
					// test controls exactly when it resolves relative to the sign-in below.
					return startupCheck;
				}
				if (method === "POST" && input.endsWith("/api/session")) {
					return jsonResponse({ csrfToken: "t", expiresAt: "2031-01-01T00:00:00.000Z" });
				}
				throw new Error(`unexpected request: ${method} ${input}`);
			}),
		);

		renderProbe();
		expect(screen.getByTestId("status").textContent).toBe("loading");

		// Sign-in happens, and wins, while the startup check is still pending.
		screen.getByRole("button", { name: "sign in" }).click();
		await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-in"));

		// The startup check finally resolves, unauthenticated (as it genuinely was, at the moment
		// it was sent, before the sign-in above ever happened) — it must not undo the sign-in.
		resolveStartupCheck?.(jsonResponse({ authenticated: false }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(screen.getByTestId("status").textContent).toBe("signed-in");
	});
});
