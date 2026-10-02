// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsListPage } from "./agents-list-page.tsx";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("AgentsListPage", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("lists every agent with a link to its detail page", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					agents: [
						{
							id: "director",
							displayName: "Director",
							enabled: true,
							state: "idle",
							runtimeAdapter: "mock",
							model: null,
							channelCount: 3,
							lastRun: null,
							activeRevisionId: 1,
							lifecycleStatus: "ready",
						},
					],
					knownChannels: ["hq"],
					knownRuntimeAdapters: ["mock"],
				}),
			),
		);

		render(
			<MemoryRouter>
				<AgentsListPage />
			</MemoryRouter>,
		);

		const link = await screen.findByRole("link", { name: /director/i });
		expect(link).toHaveAttribute("href", "/agents/director");
		expect(screen.getByText("idle")).toBeInTheDocument();
	});

	it("hides a retired agent behind 'Show retired' by default, revealing its own Restore button", async () => {
		const user = userEvent.setup();
		const calls: Array<{ path: string; method: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const path = typeof input === "string" ? input : input.toString();
				const method = init?.method ?? "GET";
				calls.push({ path, method });
				if (method === "POST") {
					return jsonResponse({
						operationId: "55555555-5555-4555-8555-555555555555",
						revisionId: 3,
					});
				}
				return jsonResponse({
					agents: [
						{
							id: "director",
							displayName: "Director",
							enabled: true,
							state: "idle",
							runtimeAdapter: "mock",
							model: null,
							channelCount: 3,
							lastRun: null,
							activeRevisionId: 1,
							lifecycleStatus: "ready",
						},
						{
							id: "old-agent",
							displayName: "Old Agent",
							enabled: false,
							state: "disabled",
							runtimeAdapter: "mock",
							model: null,
							channelCount: 0,
							lastRun: null,
							activeRevisionId: null,
							lifecycleStatus: "retired",
						},
					],
					knownChannels: ["hq"],
					knownRuntimeAdapters: ["mock"],
				});
			}),
		);

		render(
			<MemoryRouter>
				<AgentsListPage />
			</MemoryRouter>,
		);
		await screen.findByRole("link", { name: /director/i });

		// Retired by default: not in the list, only the switch naming it.
		expect(screen.queryByText(/old agent/i)).not.toBeInTheDocument();
		expect(screen.getByText(/show 1 retired agent/i)).toBeInTheDocument();

		await user.click(screen.getByRole("switch", { name: /show 1 retired agent/i }));
		expect(await screen.findByText(/old agent/i)).toBeInTheDocument();
		const restore = screen.getByRole("button", { name: /^restore$/i });
		expect(restore).toBeInTheDocument();

		await user.click(restore);
		const call = calls.find((c) => c.path === "/api/agents/old-agent/restore");
		expect(call).toBeDefined();
	});

	it("shows an error banner when the list cannot be loaded", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("server error", { status: 500 })),
		);

		render(
			<MemoryRouter>
				<AgentsListPage />
			</MemoryRouter>,
		);

		expect(await screen.findByText(/could not load the agents list/i)).toBeInTheDocument();
	});
});
