// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, useSession } from "@/lib/session-context";
import { useConsoleStatus } from "./use-console-status.ts";

// ---------------------------------------------------------------------------
// A 401 from `/api/status` is the one case `useConsoleStatus` itself reacts to (every other
// status is just a query error or a parsed snapshot): it tells the session layer the session is
// gone, which is what sends the whole app back to the sign-in screen.
// ---------------------------------------------------------------------------

function Probe(): React.ReactElement {
	const { state } = useSession();
	useConsoleStatus();
	return <div data-testid="status">{state.status}</div>;
}

function renderProbe() {
	const queryClient = new QueryClient();
	return render(
		<QueryClientProvider client={queryClient}>
			<SessionProvider>
				<Probe />
			</SessionProvider>
		</QueryClientProvider>,
	);
}

describe("useConsoleStatus", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("reports unauthorized and flips the session to signed-out when the status poll gets a 401", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				if (method !== "GET") {
					return new Response(null, { status: 204 });
				}
				if (input.endsWith("/api/session")) {
					return new Response(
						JSON.stringify({
							authenticated: true,
							csrfToken: "t",
							expiresAt: "2031-01-01T00:00:00.000Z",
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				return new Response("unauthorized", { status: 401 });
			}),
		);

		renderProbe();
		await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-in"));
		await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signed-out"));
	});
});
