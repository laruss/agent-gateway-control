// @vitest-environment happy-dom
import type { ConsoleSnapshot } from "@agent-gateway/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "@/lib/session-context";
import { buildConsoleStatusFixture } from "./overview/fixtures.ts";
import { OverviewPage } from "./overview-page.tsx";

// ---------------------------------------------------------------------------
// The overview page against a fixture `ConsoleStatus` covering every section it renders
// (ADR-023), plus the stale and unavailable snapshot states a real collection can be in.
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function stubSignedInAnd(snapshot: ConsoleSnapshot, statusCode = 200): void {
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
			return jsonResponse(snapshot, statusCode);
		}),
	);
}

function renderOverview(): ReturnType<typeof render> {
	const queryClient = new QueryClient();
	return render(
		<QueryClientProvider client={queryClient}>
			<SessionProvider>
				<OverviewPage />
			</SessionProvider>
		</QueryClientProvider>,
	);
}

describe("OverviewPage", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("renders every section from a full fixture status payload", async () => {
		stubSignedInAnd({
			state: "ok",
			asOf: "2031-06-01T12:00:00.000Z",
			status: buildConsoleStatusFixture(),
		});
		renderOverview();

		// Top summary.
		expect(await screen.findByText(/Kill switch: off/)).toBeInTheDocument();
		expect(screen.getByText("4")).toBeInTheDocument(); // approvals pending

		// Alerts.
		expect(screen.getByText("queue_backlog")).toBeInTheDocument();
		expect(screen.getByText(/agent\.turn has waited over 10 minutes/)).toBeInTheDocument();

		// Agent cards: the busy one and the idle one.
		expect(screen.getByText(/Director/)).toBeInTheDocument();
		expect(screen.getByText(/\(director\)/)).toBeInTheDocument();
		expect(screen.getByText(/Librarian/)).toBeInTheDocument();
		expect(screen.getByText("No current task.")).toBeInTheDocument();
		expect(screen.getByText(/mattermost\.thread\.reply until/)).toBeInTheDocument();
		expect(screen.getByText(/Last attempt input tokens/)).toBeInTheDocument();
		expect(screen.getByText("5,000")).toBeInTheDocument();

		// Recent runs table.
		expect(screen.getByText("replied")).toBeInTheDocument();
		expect(screen.getByText("runtime_error")).toBeInTheDocument();

		// Queues table, including the DLQ pill.
		expect(screen.getByText("agent.turn")).toBeInTheDocument();
		expect(screen.getByText("dlq.agent.turn")).toBeInTheDocument();
		expect(screen.getByText("DLQ")).toBeInTheDocument();

		// Footer.
		expect(screen.getByText(/codex: available/)).toBeInTheDocument();
		expect(screen.getByText(/claude-code: unavailable/)).toBeInTheDocument();
		expect(screen.getByText(/retention: never/)).toBeInTheDocument();
	});

	it("shows the stale banner with the last-known timestamp and the refresh error", async () => {
		stubSignedInAnd({
			state: "stale",
			asOf: "2031-06-01T11:00:00.000Z",
			status: buildConsoleStatusFixture(),
			error: "connection reset",
		});
		renderOverview();

		expect(await screen.findByText(/stale/)).toBeInTheDocument();
		expect(screen.getByText(/connection reset/)).toBeInTheDocument();
		// The stale snapshot's own data is still shown underneath the banner.
		expect(screen.getByText(/Director/)).toBeInTheDocument();
	});

	it("shows the unavailable state with no fabricated data underneath it", async () => {
		stubSignedInAnd({ state: "unavailable", error: "no collection has ever succeeded" }, 503);
		renderOverview();

		expect(await screen.findByText(/unavailable/i)).toBeInTheDocument();
		expect(screen.getByText(/no collection has ever succeeded/)).toBeInTheDocument();
		expect(screen.queryByText(/Director/)).not.toBeInTheDocument();
	});
});
