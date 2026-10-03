// @vitest-environment happy-dom
import type { ConsoleAgentToolsResponse } from "@agent-gateway/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolsTab } from "./tools-tab.tsx";

// No `<Toaster />` is mounted in these tests (this app's own tests never assert on toast content
// elsewhere either), so a `would_widen` refusal's own confirm action is verified by mocking
// `sonner` directly and invoking the warning toast's own `action.onClick` by hand, rather than by
// querying rendered toast DOM that nothing here actually mounts.
vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));

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
		baseRevisionId: 1,
		conversionHash: "a".repeat(64),
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
		conversionHash: null,
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

	it("a detach that would widen effective permissions warns instead of detaching, then detaches anyway once confirmed", async () => {
		const user = userEvent.setup();
		const detachBodies: Array<{ confirmWidening?: boolean }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const path = typeof input === "string" ? input : input.toString();
				if (path.endsWith("/tools/detach")) {
					const body = JSON.parse((init?.body as string) ?? "{}") as { confirmWidening?: boolean };
					detachBodies.push(body);
					if (body.confirmWidening !== true) {
						return jsonResponse(
							{
								error: "detaching this entry would widen the agent's effective permissions",
								widenings: [{ agentId: "developer", tools: ["workspace.write"] }],
							},
							422,
						);
					}
					return jsonResponse({
						revisionId: 6,
						hash: "b".repeat(64),
						noop: false,
						replayed: false,
						activeRevisionId: 6,
					});
				}
				return jsonResponse(hubManagedResponse());
			}),
		);
		render(<ToolsTab agentId="developer" />);
		await screen.findByText("native-repository-read");
		const row = screen.getByText("native-repository-read").closest("tr");
		await user.click((row as HTMLElement).querySelector("button") as HTMLButtonElement);

		// First call refused: no `confirmWidening` sent, and the warning names the agent and tool.
		expect(detachBodies[0]?.confirmWidening).toBeUndefined();
		const warningCall = vi.mocked(toast.warning).mock.calls[0];
		expect(warningCall?.[0]).toMatch(
			/would widen effective permissions.*developer.*workspace\.write/,
		);
		const action = warningCall?.[1]?.action as { onClick: () => void } | undefined;
		expect(action).toBeDefined();

		// Invoking the toast's own "Detach anyway" action retries with `confirmWidening: true`.
		action?.onClick();
		await waitFor(() => expect(detachBodies).toHaveLength(2));
		expect(detachBodies[1]?.confirmWidening).toBe(true);
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

	it("offers only the modes a selected entry's own kind actually supports", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const path = typeof input === "string" ? input : input.toString();
				if (path === "/api/tools") {
					return jsonResponse({
						entries: [
							{
								// Unrequested entry ids, distinct from `hubManagedResponse()`'s own `requested`
								// list below — a requested entry is excluded from this picker entirely
								// (re-attaching is `updateAttachment`'s job, not this dialog's), so reusing
								// one of those ids here would leave the picker with nothing to select.
								id: "native-web-fetch",
								kind: "native",
								name: "Fetch a URL",
								description: "x",
								isBuiltin: true,
								riskFloor: "allow",
								supportedAdapters: [],
								available: true,
								attachedAgentCount: 1,
								deleted: false,
							},
							{
								id: "executor-other-action",
								kind: "executor",
								name: "Issue a payment",
								description: "x",
								isBuiltin: true,
								riskFloor: "require_approval",
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
		await user.click(await screen.findByRole("option", { name: /fetch a url/i }));
		// `native`: nothing can pause a turn mid-flight for a human, so `require_approval` is never
		// offered for it — only `allow`/`disabled`.
		await user.click(screen.getByRole("combobox", { name: /mode/i }));
		expect(await screen.findByRole("option", { name: "allow" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "disabled" })).toBeInTheDocument();
		expect(screen.queryByRole("option", { name: "require_approval" })).not.toBeInTheDocument();
		await user.keyboard("{Escape}");
		await user.click(screen.getByRole("combobox", { name: /entry/i }));
		await user.click(await screen.findByRole("option", { name: /issue a payment/i }));
		// `executor`: the broker has no approval-free execution path, so `allow` is never offered
		// for it — and the mode must reset off of `allow`, left over from the previous selection,
		// rather than stay stale and only be refused once the backend sees the attach (a 422).
		expect(screen.getByRole("combobox", { name: /mode/i })).not.toHaveTextContent("allow");
		await user.click(screen.getByRole("combobox", { name: /mode/i }));
		expect(await screen.findByRole("option", { name: "require_approval" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "disabled" })).toBeInTheDocument();
		expect(screen.queryByRole("option", { name: "allow" })).not.toBeInTheDocument();
	});
});
