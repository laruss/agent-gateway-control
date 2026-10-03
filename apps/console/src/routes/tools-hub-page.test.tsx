// @vitest-environment happy-dom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolsHubPage } from "./tools-hub-page.tsx";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const ENTRIES = [
	{
		id: "native-repository-read",
		kind: "native" as const,
		name: "Read repository",
		description: "Read and search the run workspace's files.",
		isBuiltin: true,
		riskFloor: "allow" as const,
		supportedAdapters: ["mock"],
		available: true,
		attachedAgentCount: 2,
		deleted: false,
	},
	{
		id: "gateway-mattermost-post",
		kind: "gateway" as const,
		name: "Post to Mattermost",
		description: "Reply or post in the agent's own Mattermost channels.",
		isBuiltin: true,
		riskFloor: "allow" as const,
		supportedAdapters: [],
		available: true,
		attachedAgentCount: 5,
		deleted: false,
	},
	{
		id: "demo-tool",
		kind: "custom_https" as const,
		name: "Demo tool",
		description: "An owner-defined HTTPS tool.",
		isBuiltin: false,
		riskFloor: "require_approval" as const,
		supportedAdapters: [],
		available: false,
		attachedAgentCount: 0,
		deleted: false,
	},
];

describe("ToolsHubPage", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function stubList() {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({ entries: ENTRIES, knownRuntimeAdapters: ["mock", "codex"] }),
			),
		);
	}

	it("groups entries by kind, each one linking to its own detail page", async () => {
		stubList();
		render(
			<MemoryRouter>
				<ToolsHubPage />
			</MemoryRouter>,
		);
		expect(await screen.findByText("Native")).toBeInTheDocument();
		expect(screen.getByText("Gateway")).toBeInTheDocument();
		expect(screen.getByText("Custom HTTPS")).toBeInTheDocument();
		const link = screen.getByRole("link", { name: /read repository/i });
		expect(link).toHaveAttribute("href", "/tools/native-repository-read");
	});

	it("filters by search text across id, name and description", async () => {
		const user = userEvent.setup();
		stubList();
		render(
			<MemoryRouter>
				<ToolsHubPage />
			</MemoryRouter>,
		);
		await screen.findByText("Native");
		await user.type(screen.getByLabelText(/search the tool catalog/i), "mattermost");
		expect(screen.queryByText("Native")).not.toBeInTheDocument();
		expect(screen.getByText("Gateway")).toBeInTheDocument();
		expect(
			within(screen.getByText("Gateway").parentElement as HTMLElement).getByText(
				/post to mattermost/i,
			),
		).toBeInTheDocument();
	});

	it("shows an availability badge per entry", async () => {
		stubList();
		render(
			<MemoryRouter>
				<ToolsHubPage />
			</MemoryRouter>,
		);
		await screen.findByText("Native");
		expect(screen.getAllByText("available").length).toBeGreaterThan(0);
		expect(screen.getByText("unavailable")).toBeInTheDocument();
	});

	it("shows an error banner when the catalog cannot be loaded", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("server error", { status: 500 })),
		);
		render(
			<MemoryRouter>
				<ToolsHubPage />
			</MemoryRouter>,
		);
		expect(await screen.findByText(/could not load the tool catalog/i)).toBeInTheDocument();
	});

	it("opens the create-custom-tool dialog from its own button", async () => {
		const user = userEvent.setup();
		stubList();
		render(
			<MemoryRouter>
				<ToolsHubPage />
			</MemoryRouter>,
		);
		await screen.findByText("Native");
		await user.click(screen.getByRole("button", { name: /new custom https tool/i }));
		expect(screen.getByRole("dialog", { name: /new custom https tool/i })).toBeInTheDocument();
	});
});
