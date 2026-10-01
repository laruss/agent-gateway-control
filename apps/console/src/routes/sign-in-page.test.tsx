// @vitest-environment happy-dom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "@/lib/session-context";
import { SignInPage } from "./sign-in-page.tsx";

// ---------------------------------------------------------------------------
// The sign-in page, end to end against a mocked `fetch`: a successful sign-in replaces the form
// (the session flips to "signed-in" and `SignInPage` renders a `<Navigate>` instead), a wrong
// password shows an inline error without losing the form, and a rate-limited response shows the
// server's own `Retry-After` seconds.
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function renderSignIn(): ReturnType<typeof render> {
	return render(
		<MemoryRouter initialEntries={["/sign-in"]}>
			<SessionProvider>
				<SignInPage />
			</SessionProvider>
		</MemoryRouter>,
	);
}

async function fillAndSubmit(password: string): Promise<void> {
	const user = userEvent.setup();
	await waitFor(() => expect(screen.getByLabelText(/password/i)).toBeInTheDocument());
	await user.type(screen.getByLabelText(/password/i), password);
	await user.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("SignInPage", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("replaces the form with a redirect once sign-in succeeds", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				if (method === "GET") {
					return jsonResponse({ authenticated: false });
				}
				return jsonResponse({
					csrfToken: "t",
					expiresAt: "2031-01-01T00:00:00.000Z",
				});
			}),
		);

		renderSignIn();
		await fillAndSubmit("correct horse battery staple");

		await waitFor(() => expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument());
	});

	it("shows an inline error for a wrong password and keeps the form", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				if (method === "GET") {
					return jsonResponse({ authenticated: false });
				}
				return jsonResponse({ error: "invalid credentials" }, 401);
			}),
		);

		renderSignIn();
		await fillAndSubmit("wrong password");

		expect(await screen.findByText(/wrong password/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
	});

	it("shows the server's Retry-After seconds when the login endpoint is rate-limited", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				if (method === "GET") {
					return jsonResponse({ authenticated: false });
				}
				return new Response("too many attempts", {
					status: 429,
					headers: { "retry-after": "12" },
				});
			}),
		);

		renderSignIn();
		await fillAndSubmit("whatever");

		expect(await screen.findByText(/12s/)).toBeInTheDocument();
	});
});
