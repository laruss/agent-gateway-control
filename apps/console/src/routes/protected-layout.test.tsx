// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import type * as React from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "@/lib/session-context";
import { ProtectedLayout } from "./protected-layout.tsx";

// ---------------------------------------------------------------------------
// A deep link visited while signed out must survive the round trip through `/sign-in`:
// `ProtectedLayout` carries the page the visitor actually asked for — its path and query, as one
// string — as `state.from`, for `SignInPage` to read back and return to once signed in.
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Stands in for `SignInPage`: shows exactly the `location.state.from` it would read. */
function SignInProbe(): React.ReactElement {
	const location = useLocation();
	const from = (location.state as { from?: string } | null)?.from;
	return <div data-testid="sign-in-from">{from ?? "(none)"}</div>;
}

function renderAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<SessionProvider>
				<Routes>
					<Route path="/sign-in" element={<SignInProbe />} />
					<Route element={<ProtectedLayout />}>
						<Route path="/agents/:agentId" element={<div>protected content</div>} />
					</Route>
				</Routes>
			</SessionProvider>
		</MemoryRouter>,
	);
}

describe("ProtectedLayout", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("redirects a signed-out visit to /sign-in carrying the deep-linked path and query as state.from", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ authenticated: false })),
		);

		renderAt("/agents/director?tab=runtime");

		expect(await screen.findByTestId("sign-in-from")).toHaveTextContent(
			"/agents/director?tab=runtime",
		);
	});
});
