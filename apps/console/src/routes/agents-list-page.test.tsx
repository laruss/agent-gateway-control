// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
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
						},
					],
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
