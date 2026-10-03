// @vitest-environment happy-dom
import type { ConsoleToolCatalogEntryDetailResponse } from "@agent-gateway/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolDetailPage } from "./tool-detail-page.tsx";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function renderAt(entryId: string) {
	return render(
		<MemoryRouter initialEntries={[`/tools/${entryId}`]}>
			<Routes>
				<Route path="/tools/:entryId" element={<ToolDetailPage />} />
				<Route path="/tools" element={<div>Instruments list</div>} />
			</Routes>
		</MemoryRouter>,
	);
}

function builtinDetail(): ConsoleToolCatalogEntryDetailResponse {
	return {
		entry: {
			id: "native-repository-read",
			kind: "native",
			implementationKey: "repository.read",
			isBuiltin: true,
			createdAt: "2026-01-01T00:00:00Z",
			available: true,
			currentVersion: {
				id: 1,
				entryId: "native-repository-read",
				version: 1,
				kind: "native",
				implementationKey: "repository.read",
				name: "Read repository",
				description: "Read and search the run workspace's files.",
				configSchema: {},
				riskFloor: "allow",
				supportedAdapters: ["mock", "codex"],
				httpsDefinition: null,
				createdBy: "system",
				createdAt: "2026-01-01T00:00:00Z",
			},
		},
		versions: [
			{
				id: 1,
				entryId: "native-repository-read",
				version: 1,
				kind: "native",
				implementationKey: "repository.read",
				name: "Read repository",
				description: "Read and search the run workspace's files.",
				configSchema: {},
				riskFloor: "allow",
				supportedAdapters: ["mock", "codex"],
				httpsDefinition: null,
				createdBy: "system",
				createdAt: "2026-01-01T00:00:00Z",
			},
		],
		attachedAgents: [
			{ agentId: "developer", displayName: "Developer", mode: "allow", pinnedVersion: null },
		],
		legacyGrantingAgents: [],
		secretAliases: [],
	};
}

function customToolDetail(): ConsoleToolCatalogEntryDetailResponse {
	const builtin = builtinDetail();
	return {
		entry: {
			...builtin.entry,
			id: "demo-tool",
			kind: "custom_https",
			implementationKey: "custom.demo-tool",
			isBuiltin: false,
			currentVersion: {
				...builtin.entry.currentVersion,
				id: 2,
				entryId: "demo-tool",
				implementationKey: "custom.demo-tool",
				kind: "custom_https",
				name: "Demo tool",
				riskFloor: "require_approval",
				supportedAdapters: [],
				httpsDefinition: {
					host: "api.example.com",
					pathTemplate: "/items/{id}",
					method: "GET",
					parameters: [
						{
							name: "id",
							slot: "path",
							slotName: "id",
							type: "string",
							minLength: 1,
							maxLength: 20,
						},
					],
					secretSlots: [{ alias: "demo_secret", slot: "header", slotName: "x-api-key" }],
					idempotency: null,
					responseLimits: {
						maxResponseBytes: 65_536,
						allowedContentTypes: ["application/json"],
						timeoutMs: 5000,
						includeBodyPreview: true,
					},
				},
			},
		},
		versions: builtin.versions,
		attachedAgents: [],
		legacyGrantingAgents: [],
		secretAliases: [{ alias: "demo_secret", set: false }],
	};
}

describe("ToolDetailPage", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("shows a built-in's overview, version history and attached agents", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(builtinDetail())),
		);
		renderAt("native-repository-read");
		expect(await screen.findByRole("heading", { name: /read repository/i })).toBeInTheDocument();
		expect(screen.getByText("Developer")).toBeInTheDocument();
		// Every native entry carries this caveat (ADR-027's own wording), not only `tests.run`.
		expect(screen.getByText(/general sandboxed command execution/i)).toBeInTheDocument();
	});

	it("a built-in's edit dialog offers only name/description, never a definition field", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(builtinDetail())),
		);
		renderAt("native-repository-read");
		await screen.findByRole("heading", { name: /read repository/i });
		await user.click(screen.getByRole("button", { name: /^edit$/i }));
		expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
		expect(screen.queryByLabelText(/destination host/i)).not.toBeInTheDocument();
	});

	it("shows a custom tool's own definition and its secret aliases, never a value", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(customToolDetail())),
		);
		renderAt("demo-tool");
		expect(
			await screen.findByText(/GET https:\/\/api\.example\.com\/items\/\{id\}/),
		).toBeInTheDocument();
		expect(screen.getByText("demo_secret")).toBeInTheDocument();
		expect(screen.getByText("not set")).toBeInTheDocument();
		expect(screen.getByText(/gateway tools secret set demo_secret/i)).toBeInTheDocument();
	});

	it("a custom tool's edit dialog exposes its full definition, including the destination host", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(customToolDetail())),
		);
		renderAt("demo-tool");
		await screen.findByText(/GET https/);
		await user.click(screen.getByRole("button", { name: /^edit$/i }));
		expect(screen.getByLabelText(/destination host/i)).toHaveValue("api.example.com");
	});

	it("opens the delete dialog naming every agent that would lose this entry", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(builtinDetail())),
		);
		renderAt("native-repository-read");
		await screen.findByRole("heading", { name: /read repository/i });
		await user.click(screen.getByRole("button", { name: /^delete$/i }));
		const dialog = screen.getByRole("dialog");
		expect(dialog).toHaveTextContent("developer");
	});

	it("shows a legacy agent that still grants this entry directly, outside the hub", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					...builtinDetail(),
					legacyGrantingAgents: [{ agentId: "operator", displayName: "Operator" }],
				}),
			),
		);
		renderAt("native-repository-read");
		expect(await screen.findByText(/also granted outside the hub/i)).toBeInTheDocument();
		expect(screen.getByText(/Operator/)).toBeInTheDocument();
		expect(screen.getByText(/gateway tools adopt/i)).toBeInTheDocument();
	});

	it("opens 'Attach to agent', fetching the agent list for its own picker", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const path = typeof input === "string" ? input : input.toString();
				if (path === "/api/agents") {
					const agent = (id: string) => ({
						id,
						displayName: id,
						enabled: true,
						state: "idle",
						runtimeAdapter: "mock",
						model: null,
						channelCount: 0,
						lastRun: null,
						activeRevisionId: 1,
						lifecycleStatus: "ready",
					});
					return jsonResponse({
						agents: [agent("director"), agent("finance")],
						knownChannels: [],
						knownRuntimeAdapters: [],
					});
				}
				return jsonResponse(builtinDetail());
			}),
		);
		renderAt("native-repository-read");
		await screen.findByRole("heading", { name: /read repository/i });
		await user.click(screen.getByRole("button", { name: /attach to agent/i }));
		await user.click(await screen.findByLabelText(/^agent$/i));
		expect(await screen.findByRole("option", { name: "director" })).toBeInTheDocument();
	});

	it("'Attach to agent' never offers a mode its entry's own kind cannot support", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const path = typeof input === "string" ? input : input.toString();
				if (path === "/api/agents") {
					return jsonResponse({ agents: [], knownChannels: [], knownRuntimeAdapters: [] });
				}
				return jsonResponse(builtinDetail());
			}),
		);
		// `native-repository-read`'s own risk floor is `allow` (no floor at all), so only its
		// `kind` — nothing can pause a turn mid-flight for a human on a native capability — can
		// explain `require_approval` never being offered; before this fix, the risk floor alone
		// would have offered it, and the backend would then have refused the attach with a 422.
		renderAt("native-repository-read");
		await screen.findByRole("heading", { name: /read repository/i });
		await user.click(screen.getByRole("button", { name: /attach to agent/i }));
		await user.click(await screen.findByLabelText(/^mode$/i));
		expect(await screen.findByRole("option", { name: "allow" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "disabled" })).toBeInTheDocument();
		expect(screen.queryByRole("option", { name: "require_approval" })).not.toBeInTheDocument();
	});

	it("shows a 'not found' message for an unknown entry id", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not found", { status: 404 })),
		);
		renderAt("no-such-entry");
		expect(await screen.findByText(/does not exist/i)).toBeInTheDocument();
	});
});
