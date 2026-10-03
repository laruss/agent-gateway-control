// @vitest-environment happy-dom
import type { ConsoleAgentToolsResponse } from "@agent-gateway/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolsTab } from "./tools-tab.tsx";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function legacyResponse(): ConsoleAgentToolsResponse {
	return {
		agentId: "developer",
		hubManaged: false,
		requested: [
			{ entryId: "native-repository-read", pinnedVersion: null, mode: "allow", settings: {} },
		],
		unresolved: [{ list: "tools_deny", pattern: "deploy.*" }],
		effective: {
			allow: ["mattermost.post", "repository.read", "workspace.write"],
			requireApproval: [],
			deny: ["memory.write"],
		},
		capabilities: [
			{ name: "mattermost.post", description: "Reply or post.", mode: "allow" },
			{
				name: "workspace.write",
				description: "Create and edit files.",
				mode: "allow",
				impliedBy: ["tests.run"],
			},
		],
		missingPrerequisites: { "repository.read": ["tests.run"] },
		memoryWriteAllowed: false,
	};
}

function hubManagedResponse(): ConsoleAgentToolsResponse {
	return {
		...legacyResponse(),
		hubManaged: true,
		unresolved: [],
		requested: [
			{ entryId: "native-repository-read", pinnedVersion: null, mode: "allow", settings: {} },
			{
				entryId: "executor-finance-payment-create",
				pinnedVersion: null,
				mode: "require_approval",
				settings: {},
			},
		],
		capabilities: [
			...legacyResponse().capabilities,
			{
				name: "finance.payment.create",
				description: "Issue a payment.",
				mode: "require_approval",
			},
		],
	};
}

describe("ToolsTab", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("previews a legacy agent's converted permissions read-only, offering 'Adopt into the tools hub'", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(legacyResponse())),
		);
		render(<ToolsTab agentId="developer" />);
		expect(await screen.findByText(/not yet managed in the tools hub/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /adopt into the tools hub/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /attach a tool/i })).toBeDisabled();
		expect(screen.getByText(/deploy\.\*/)).toBeInTheDocument();
	});

	it("shows effective access, implied capabilities and a missing runtime prerequisite", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(legacyResponse())),
		);
		render(<ToolsTab agentId="developer" />);
		await screen.findByText(/not yet managed/i);
		expect(screen.getByText(/implied by tests\.run/i)).toBeInTheDocument();
		expect(screen.getByText(/missing runtime prerequisites/i)).toBeInTheDocument();
		expect(screen.getByText(/memory writes:/i).parentElement).toHaveTextContent("denied");
	});

	it("a hub-managed agent can detach an attachment directly", async () => {
		const user = userEvent.setup();
		const calls: Array<{ path: string; method: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const path = typeof input === "string" ? input : input.toString();
				const method = init?.method ?? "GET";
				calls.push({ path, method });
				if (path.endsWith("/tools/detach")) {
					return jsonResponse({
						revisionId: 5,
						hash: "a".repeat(64),
						noop: false,
						replayed: false,
						activeRevisionId: 5,
					});
				}
				return jsonResponse(hubManagedResponse());
			}),
		);
		render(<ToolsTab agentId="developer" />);
		await screen.findByText("native-repository-read");
		const row = screen.getByText("native-repository-read").closest("tr");
		expect(row).not.toBeNull();
		await user.click((row as HTMLElement).querySelector("button") as HTMLButtonElement);
		expect(calls.some((c) => c.path.endsWith("/tools/detach") && c.method === "POST")).toBe(true);
	});

	it("shows which capabilities require a human's approval", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(hubManagedResponse())),
		);
		render(<ToolsTab agentId="finance" />);
		await screen.findByText("finance.payment.create");
		const badge = screen.getByText("finance.payment.create").previousSibling;
		expect(badge).toHaveTextContent("require_approval");
	});

	it("opens 'Attach a tool', excluding entries already requested", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const path = typeof input === "string" ? input : input.toString();
				if (path === "/api/tools") {
					return jsonResponse({
						entries: [
							{
								id: "native-repository-read",
								kind: "native",
								name: "Read repository",
								description: "x",
								isBuiltin: true,
								riskFloor: "allow",
								supportedAdapters: [],
								available: true,
								attachedAgentCount: 1,
								deleted: false,
							},
							{
								id: "native-web-search",
								kind: "native",
								name: "Web search",
								description: "x",
								isBuiltin: true,
								riskFloor: "allow",
								supportedAdapters: [],
								available: true,
								attachedAgentCount: 0,
								deleted: false,
							},
						],
						knownRuntimeAdapters: ["mock"],
					});
				}
				return jsonResponse(hubManagedResponse());
			}),
		);
		render(<ToolsTab agentId="developer" />);
		await user.click(await screen.findByRole("button", { name: /attach a tool/i }));
		await user.click(screen.getByRole("combobox", { name: /entry/i }));
		expect(screen.queryByRole("option", { name: /read repository/i })).not.toBeInTheDocument();
		expect(screen.getByRole("option", { name: /web search/i })).toBeInTheDocument();
	});
});
