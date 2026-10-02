// @vitest-environment happy-dom
import type {
	ConsoleAgentDetailResponse,
	ConsoleAgentListResponse,
	ConsoleSnapshot,
} from "@agent-gateway/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "@/lib/session-context";
import { AgentDetailPage } from "./agent-detail-page.tsx";
import { buildConsoleStatusFixture } from "./overview/fixtures.ts";

// ---------------------------------------------------------------------------
// The agent editor end to end against a mocked `fetch`: editing the role prompt accumulates a
// draft, "Review changes" fetches a preview and shows its diff, and "Apply" commits with the
// preview's base revision and a fresh idempotency key — covering the save flow's three documented
// outcomes (success, 409 conflict, 422 invalid) and the unsaved-changes navigation guard.
// ---------------------------------------------------------------------------

const AGENT_ID = "director";
const ORIGINAL_PROMPT = "You are the director.";

function detailFixture(): ConsoleAgentDetailResponse {
	return {
		agent: {
			id: AGENT_ID,
			activeRevisionId: 7,
			displayName: "Director",
			enabled: true,
			mattermost: {
				username: AGENT_ID,
				tokenSecretFile: "/run/secrets/mm_director_token",
				allowedChannels: ["hq", "research"],
			},
			runtime: {
				adapter: "claude-code",
				profile: "default",
				session_policy: "resumable-if-available",
				timeout_seconds: 1800,
			},
			rolePrompt: ORIGINAL_PROMPT,
			wakeRules: [{ event_type: "mattermost.agent.mentioned", target_agent_id: AGENT_ID }],
			permissions: {
				tools_allow: ["mattermost.post"],
				tools_require_human_approval: [],
				tools_deny: ["finance.*"],
			},
			memory: { privateNamespace: "agents/director", sharedNamespaces: [] },
			concurrency: { maxActiveRuns: 1, whileRunning: "enqueue-and-coalesce" },
		},
		knownChannels: ["hq", "research", "engineering"],
		knownRuntimeAdapters: ["mock", "codex", "claude-code"],
		financeAgentId: null,
	};
}

function listFixture(): ConsoleAgentListResponse {
	return {
		agents: [
			{
				id: AGENT_ID,
				displayName: "Director",
				enabled: true,
				state: "idle",
				runtimeAdapter: "claude-code",
				model: null,
				channelCount: 2,
				lastRun: null,
				activeRevisionId: 7,
				lifecycleStatus: "ready",
			},
		],
		knownChannels: ["hq", "research", "engineering"],
		knownRuntimeAdapters: ["mock", "codex", "claude-code"],
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const statusSnapshot: ConsoleSnapshot = {
	state: "ok",
	asOf: "2031-06-01T12:00:00.000Z",
	status: buildConsoleStatusFixture(),
};

type CommitOutcome = "ok" | "conflict" | "invalid";

function stubFetch(commitOutcome: CommitOutcome): {
	commitCalls: Array<{ baseRevisionId: number | null; idempotencyKey: string }>;
} {
	const commitCalls: Array<{ baseRevisionId: number | null; idempotencyKey: string }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			const path = new URL(input, "http://localhost").pathname;

			if (path === "/api/session") {
				return jsonResponse({
					authenticated: true,
					csrfToken: "t",
					expiresAt: "2031-01-01T00:00:00.000Z",
				});
			}
			if (path === "/api/status") {
				return jsonResponse(statusSnapshot);
			}
			if (path === "/api/agents" && method === "GET") {
				return jsonResponse(listFixture());
			}
			if (path === `/api/agents/${AGENT_ID}` && method === "GET") {
				return jsonResponse(detailFixture());
			}
			if (path === `/api/agents/${AGENT_ID}/preview` && method === "POST") {
				const body = JSON.parse(String(init?.body)) as { changes: { rolePrompt?: string } };
				return jsonResponse({
					// Deliberately not 7 (the agent's own loaded `activeRevisionId`): a real server
					// only ever reports its own live revision here, which always equals what the
					// request's own `baseRevisionId` already was by the time a preview succeeds (a
					// mismatch is a 409 instead, see `console-management.integration.test.ts`'s own
					// coverage of that). This value is deliberately different purely so this fixture
					// can tell apart "the editor's own loaded revision" from "whatever the preview
					// response happened to carry" at the commit call below.
					baseRevisionId: 42,
					baseHash: "a".repeat(64),
					newHash: "b".repeat(64),
					noop: false,
					problems: [],
					impact: [],
					diff: {
						agents: [
							{
								kind: "changed",
								agentId: AGENT_ID,
								fieldPaths: [],
								rolePrompt: {
									changed: body.changes.rolePrompt !== undefined,
									beforeSize: ORIGINAL_PROMPT.length,
									afterSize: body.changes.rolePrompt?.length ?? ORIGINAL_PROMPT.length,
								},
							},
						],
						organizationFieldPaths: [],
						constitution: { changed: false, beforeSize: 0, afterSize: 0 },
						toolAttachmentsChangedAgentIds: [],
					},
				});
			}
			if (path === `/api/agents/${AGENT_ID}/commit` && method === "POST") {
				const body = JSON.parse(String(init?.body)) as {
					baseRevisionId: number | null;
					idempotencyKey: string;
				};
				commitCalls.push({
					baseRevisionId: body.baseRevisionId,
					idempotencyKey: body.idempotencyKey,
				});
				if (commitOutcome === "conflict") {
					return jsonResponse(
						{ error: "the active configuration changed", currentRevisionId: 9 },
						409,
					);
				}
				if (commitOutcome === "invalid") {
					return jsonResponse(
						{ error: "the change is invalid", problems: ["agent 'director' is 'running'"] },
						422,
					);
				}
				return jsonResponse({
					revisionId: 8,
					hash: "c".repeat(64),
					noop: false,
					replayed: false,
					activeRevisionId: 8,
				});
			}
			throw new Error(`unexpected request: ${method} ${path}`);
		}),
	);
	return { commitCalls };
}

/** Radix `Tabs.Content` does not mount an inactive tab's content at all; every test that edits
 * the role prompt switches to the Instructions tab first. */
async function openInstructionsTab(user: ReturnType<typeof userEvent.setup>): Promise<void> {
	await user.click(await screen.findByRole("tab", { name: /instructions/i }));
}

function renderDetail(): ReturnType<typeof render> {
	const queryClient = new QueryClient();
	return render(
		<QueryClientProvider client={queryClient}>
			<SessionProvider>
				<MemoryRouter initialEntries={[`/agents/${AGENT_ID}`]}>
					<Routes>
						<Route path="/agents/:agentId" element={<AgentDetailPage />} />
					</Routes>
				</MemoryRouter>
			</SessionProvider>
		</QueryClientProvider>,
	);
}

describe("AgentDetailPage", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("edits the role prompt, previews a diff, and applies it with the editor's own loaded base revision (never the preview response's) and a fresh idempotency key", async () => {
		const { commitCalls } = stubFetch("ok");
		renderDetail();
		const user = userEvent.setup();
		await openInstructionsTab(user);

		const textarea = await screen.findByLabelText(/role prompt/i);
		await user.clear(textarea);
		await user.type(textarea, "Updated instructions.");

		expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /review changes/i }));

		expect(await screen.findByText(/director · changed/i)).toBeInTheDocument();
		expect(screen.getByText(/role prompt:/i)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /^apply$/i }));

		await waitFor(() => expect(commitCalls).toHaveLength(1));
		// 7 is `detailFixture()`'s own `activeRevisionId` — the revision the editor actually loaded.
		// The preview fixture above deliberately reports 42: committing with that value instead (as
		// `state.preview.baseRevisionId`) is exactly the optimistic-concurrency defeat this covers.
		expect(commitCalls[0]?.baseRevisionId).toBe(7);
		expect(commitCalls[0]?.idempotencyKey).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));

		// The dialog closes and the unsaved-changes badge clears once applied.
		await waitFor(() => expect(screen.queryByText(/unsaved changes/i)).not.toBeInTheDocument());
	});

	it("shows a conflict message and a reload option on a 409", async () => {
		stubFetch("conflict");
		renderDetail();
		const user = userEvent.setup();
		await openInstructionsTab(user);

		const textarea = await screen.findByLabelText(/role prompt/i);
		await user.type(textarea, " more");
		await user.click(screen.getByRole("button", { name: /review changes/i }));
		await user.click(await screen.findByRole("button", { name: /^apply$/i }));

		expect(await screen.findByText(/configuration changed elsewhere/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /reload and try again/i })).toBeInTheDocument();
	});

	it("shows the server's problems inline on a 422 and does not close the dialog", async () => {
		stubFetch("invalid");
		renderDetail();
		const user = userEvent.setup();
		await openInstructionsTab(user);

		const textarea = await screen.findByLabelText(/role prompt/i);
		await user.type(textarea, " more");
		await user.click(screen.getByRole("button", { name: /review changes/i }));
		await user.click(await screen.findByRole("button", { name: /^apply$/i }));

		expect(await screen.findByText(/this change is invalid/i)).toBeInTheDocument();
		expect(screen.getByText(/agent 'director' is 'running'/i)).toBeInTheDocument();
	});

	it("blocks in-app navigation while there are unsaved changes", async () => {
		stubFetch("ok");
		const queryClient = new QueryClient();
		const user = userEvent.setup();
		render(
			<QueryClientProvider client={queryClient}>
				<SessionProvider>
					<MemoryRouter initialEntries={[`/agents/${AGENT_ID}`]}>
						<Routes>
							<Route path="/agents/:agentId" element={<AgentDetailPage />} />
							<Route path="/agents" element={<div>Agents list</div>} />
						</Routes>
					</MemoryRouter>
				</SessionProvider>
			</QueryClientProvider>,
		);

		await openInstructionsTab(user);
		const textarea = await screen.findByLabelText(/role prompt/i);
		await user.type(textarea, " more");

		await user.click(screen.getByRole("button", { name: /agents/i }));

		expect(await screen.findByText(/leave without saving\?/i)).toBeInTheDocument();
		// Still on the detail page: the navigation was blocked, not merely confirmed later.
		expect(screen.getByLabelText(/role prompt/i)).toBeInTheDocument();
	});

	it("shows the retired header and Restore once the live lifecycle query reports the retire finished, without a manual reload", async () => {
		let retired = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				const path = new URL(input, "http://localhost").pathname;
				if (path === "/api/session") {
					return jsonResponse({
						authenticated: true,
						csrfToken: "t",
						expiresAt: "2031-01-01T00:00:00.000Z",
					});
				}
				if (path === "/api/status") {
					return jsonResponse(statusSnapshot);
				}
				if (path === "/api/agents" && method === "GET") {
					return jsonResponse(listFixture());
				}
				// Outside the active configuration snapshot: a retiring/retired agent's own detail 404s
				// (`consoleShowAgent`), which is what sends `AgentDetailPage` to its lifecycle fallback.
				if (path === `/api/agents/${AGENT_ID}` && method === "GET") {
					return jsonResponse({ error: "not found" }, 404);
				}
				if (path === `/api/agents/${AGENT_ID}/lifecycle` && method === "GET") {
					return jsonResponse({
						status: retired ? "retired" : "retiring",
						generation: 2,
						lastError: null,
						statusChangedAt: new Date().toISOString(),
						retiredAt: retired ? new Date().toISOString() : null,
						operations: [
							{
								id: "11111111-1111-4111-8111-111111111111",
								kind: "retire",
								state: retired ? "succeeded" : "running",
								checkpoints: {},
								error: null,
								createdAt: new Date().toISOString(),
								updatedAt: new Date().toISOString(),
								finishedAt: retired ? new Date().toISOString() : null,
							},
						],
					});
				}
				if (path === `/api/agents/${AGENT_ID}/channels` && method === "GET") {
					return jsonResponse({ channels: [] });
				}
				throw new Error(`unexpected request: ${method} ${path}`);
			}),
		);

		const queryClient = new QueryClient();
		render(
			<QueryClientProvider client={queryClient}>
				<SessionProvider>
					<MemoryRouter initialEntries={[`/agents/${AGENT_ID}`]}>
						<Routes>
							<Route path="/agents/:agentId" element={<AgentDetailPage />} />
						</Routes>
					</MemoryRouter>
				</SessionProvider>
			</QueryClientProvider>,
		);

		expect(await screen.findByText("retiring")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /restore/i })).not.toBeInTheDocument();

		// The retire finishes in the background (another session, or the provisioner catching up) —
		// nothing in this tab ever calls `onReload`. Only the lifecycle query's own refetch (shared
		// with `LifecyclePanel`, per `useAgentLifecycle`'s query key) picks this up.
		retired = true;
		await queryClient.refetchQueries({ queryKey: ["agent-lifecycle", AGENT_ID] });

		expect(await screen.findByText("retired")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /restore/i })).toBeInTheDocument();
	});

	it("offers only agents still active in the configuration as a finance reassignment target, never a retiring or retired one", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				const path = new URL(input, "http://localhost").pathname;
				if (path === "/api/session") {
					return jsonResponse({
						authenticated: true,
						csrfToken: "t",
						expiresAt: "2031-01-01T00:00:00.000Z",
					});
				}
				if (path === "/api/status") {
					return jsonResponse(statusSnapshot);
				}
				if (path === "/api/agents" && method === "GET") {
					const list: ConsoleAgentListResponse = {
						agents: [
							{
								id: AGENT_ID,
								displayName: "Director",
								enabled: true,
								state: "idle",
								runtimeAdapter: "claude-code",
								model: null,
								channelCount: 2,
								lastRun: null,
								activeRevisionId: 7,
								lifecycleStatus: "ready",
							},
							{
								id: "scribe",
								displayName: "Scribe",
								enabled: true,
								state: "idle",
								runtimeAdapter: "claude-code",
								model: null,
								channelCount: 1,
								lastRun: null,
								activeRevisionId: 9,
								lifecycleStatus: "ready",
							},
							{
								id: "archivist",
								displayName: "Archivist",
								enabled: false,
								state: "idle",
								runtimeAdapter: "claude-code",
								model: null,
								channelCount: 0,
								lastRun: null,
								// Outside the active configuration snapshot (`requestAgentRetire` would refuse
								// it as a `reassignFinanceTo` target): retiring/retired agents are still listed
								// here (so they stay reachable for Restore), but must never be offered below.
								activeRevisionId: null,
								lifecycleStatus: "retiring",
							},
						],
						knownChannels: ["hq", "research", "engineering"],
						knownRuntimeAdapters: ["mock", "codex", "claude-code"],
					};
					return jsonResponse(list);
				}
				if (path === `/api/agents/${AGENT_ID}` && method === "GET") {
					return jsonResponse({ ...detailFixture(), financeAgentId: AGENT_ID });
				}
				throw new Error(`unexpected request: ${method} ${path}`);
			}),
		);
		renderDetail();
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: /^retire$/i }));
		expect(screen.getByText(/reassign the finance role to/i)).toBeInTheDocument();
		// The retire dialog's own select for `reassignFinanceTo` is the only combobox it renders.
		await user.click(screen.getByRole("combobox"));

		expect(await screen.findByRole("option", { name: "scribe" })).toBeInTheDocument();
		expect(screen.queryByRole("option", { name: "archivist" })).not.toBeInTheDocument();
		// The agent being retired is never offered as its own reassignment target either.
		expect(screen.queryByRole("option", { name: AGENT_ID })).not.toBeInTheDocument();
	});

	it("invalidates the lifecycle query once a commit applies: a reprovision it queues (ADR-026) shows its own progress without a manual reload", async () => {
		const commitCalls: Array<{ baseRevisionId: number | null }> = [];
		// Flips once the commit below lands: before it, the lifecycle query reports an already
		// `succeeded` operation (polling has already stopped, `shouldPollLifecycle`), so only an
		// explicit invalidate — never the interval — can surface the `reprovision` a committed
		// `allowedChannels`/`enabled` edit queues for a lifecycle-owned, `ready` agent.
		let committed = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				const path = new URL(input, "http://localhost").pathname;
				if (path === "/api/session") {
					return jsonResponse({
						authenticated: true,
						csrfToken: "t",
						expiresAt: "2031-01-01T00:00:00.000Z",
					});
				}
				if (path === "/api/status") {
					return jsonResponse(statusSnapshot);
				}
				if (path === "/api/agents" && method === "GET") {
					return jsonResponse(listFixture());
				}
				if (path === `/api/agents/${AGENT_ID}` && method === "GET") {
					return jsonResponse(detailFixture());
				}
				if (path === `/api/agents/${AGENT_ID}/lifecycle` && method === "GET") {
					return jsonResponse({
						status: "ready",
						generation: committed ? 2 : 1,
						lastError: null,
						statusChangedAt: new Date().toISOString(),
						retiredAt: null,
						operations: [
							{
								id: "55555555-5555-4555-8555-555555555555",
								kind: committed ? "reprovision" : "create",
								state: committed ? "running" : "succeeded",
								checkpoints: {},
								error: null,
								createdAt: new Date().toISOString(),
								updatedAt: new Date().toISOString(),
								finishedAt: committed ? null : new Date().toISOString(),
							},
						],
					});
				}
				if (path === `/api/agents/${AGENT_ID}/preview` && method === "POST") {
					return jsonResponse({
						baseRevisionId: 7,
						baseHash: "a".repeat(64),
						newHash: "b".repeat(64),
						noop: false,
						problems: [],
						impact: [],
						diff: {
							agents: [
								{
									kind: "changed",
									agentId: AGENT_ID,
									fieldPaths: [],
									rolePrompt: {
										changed: true,
										beforeSize: ORIGINAL_PROMPT.length,
										afterSize: ORIGINAL_PROMPT.length + 5,
									},
								},
							],
							organizationFieldPaths: [],
							constitution: { changed: false, beforeSize: 0, afterSize: 0 },
							toolAttachmentsChangedAgentIds: [],
						},
					});
				}
				if (path === `/api/agents/${AGENT_ID}/commit` && method === "POST") {
					const body = JSON.parse(String(init?.body)) as { baseRevisionId: number | null };
					commitCalls.push({ baseRevisionId: body.baseRevisionId });
					committed = true;
					return jsonResponse({
						revisionId: 8,
						hash: "c".repeat(64),
						noop: false,
						replayed: false,
						activeRevisionId: 8,
					});
				}
				throw new Error(`unexpected request: ${method} ${path}`);
			}),
		);
		renderDetail();
		const user = userEvent.setup();
		await openInstructionsTab(user);

		const textarea = await screen.findByLabelText(/role prompt/i);
		await user.type(textarea, " more");
		// Before the commit: the last known operation is already terminal, so there is nothing to
		// show and nothing left polling.
		expect(screen.queryByText(/provisioning/i)).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /review changes/i }));
		await user.click(await screen.findByRole("button", { name: /^apply$/i }));

		await waitFor(() => expect(commitCalls).toHaveLength(1));
		expect(await screen.findByText(/provisioning/i)).toBeInTheDocument();
	});
});
