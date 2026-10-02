// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RetiredAgentView } from "./retired-agent-view.tsx";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function stubFetch() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL) => {
			const path = typeof input === "string" ? input : input.toString();
			if (path.endsWith("/lifecycle")) {
				return jsonResponse({
					status: "retiring",
					generation: 2,
					lastError: null,
					statusChangedAt: new Date().toISOString(),
					retiredAt: null,
					operations: [],
				});
			}
			if (path.endsWith("/channels")) {
				return jsonResponse({ channels: [] });
			}
			return jsonResponse({ error: "not found" }, 404);
		}),
	);
}

function renderView(status: "retiring" | "retired") {
	const queryClient = new QueryClient();
	return render(
		<QueryClientProvider client={queryClient}>
			<MemoryRouter>
				<RetiredAgentView
					agentId="old-agent"
					lifecycle={{
						status,
						generation: 2,
						lastError: null,
						statusChangedAt: new Date().toISOString(),
						retiredAt: status === "retired" ? new Date().toISOString() : null,
						operations: [],
					}}
					onReload={() => {}}
				/>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("RetiredAgentView", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("shows no Restore button while only retiring (not retired yet)", () => {
		stubFetch();
		renderView("retiring");
		expect(screen.getByText("retiring")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /restore/i })).not.toBeInTheDocument();
	});

	it("shows Restore once the agent has actually reached retired", () => {
		stubFetch();
		renderView("retired");
		expect(screen.getByText("retired")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /restore/i })).toBeInTheDocument();
	});
});
