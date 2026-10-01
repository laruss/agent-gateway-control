import type {
	AgentConfig,
	AgentPatch,
	ChangeOperation,
	ChangeSet,
	ConfigDiff,
	ConsoleAgentDetailResponse,
	ConsoleAgentLastRun,
	ConsoleAgentListItem,
} from "@agent-gateway/contracts";
import { RuntimeAdapterIdSchema } from "@agent-gateway/contracts";
import { agentRuns, agents, configRevisions, gatewayControls } from "@agent-gateway/db";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { AdminError, inTransaction } from "./admin.ts";
import type { ControlPlaneDeps } from "./deps.ts";
import {
	activeConfigRevisionId,
	type ChangePreview,
	type CommitChangeResult,
	type ConfigDraftBundle,
	commitChange,
	configDiff,
	loadActiveBundle,
	ManagementConflictError,
	prepareChange,
} from "./management.ts";

// ---------------------------------------------------------------------------
// The Agents hub's own queries and change-set translation (ADR-024/ADR-025): read models for
// `GET /api/agents`/`GET /api/agents/:id`, and turning the editor's bounded `AgentPatch` DTO into
// the typed change operations `prepareChange`/`commitChange` already understand. The HTTP layer
// (`apps/controller/src/console-management.ts`) parses requests against the contracts' schemas
// and maps the result types below onto status codes; this module never touches `Request`/
// `Response`.
// ---------------------------------------------------------------------------

function toLastRun(
	row:
		| Readonly<{
				id: string;
				status: string;
				outcome: string | null;
				errorCode: string | null;
				finishedAt: Date | null;
		  }>
		| undefined,
): ConsoleAgentLastRun | null {
	if (row === undefined) {
		return null;
	}
	return {
		runId: row.id,
		status: row.status,
		outcome: row.outcome,
		errorCode: row.errorCode,
		finishedAt: row.finishedAt?.toISOString() ?? null,
	};
}

/** `GET /api/agents`: every agent, its runtime/model, channel count and its last run, newest
 * first by id (stable, matching every other admin listing in this package). */
export async function consoleListAgents(
	deps: ControlPlaneDeps,
): Promise<Readonly<ConsoleAgentListItem[]>> {
	return inTransaction(deps, async ({ tx }) => {
		const { db } = tx;
		const [controls] = await db
			.select({ revision: gatewayControls.activeConfigRevision })
			.from(gatewayControls)
			.where(eq(gatewayControls.id, 1));
		const activeRevisionId = controls?.revision ?? null;
		const rows = await db
			.select({
				id: agents.id,
				displayName: agents.displayName,
				enabled: agents.enabled,
				state: agents.state,
				runtimeAdapter: agents.runtimeAdapter,
				config: agents.config,
			})
			.from(agents)
			.orderBy(asc(agents.id));
		if (rows.length === 0) {
			return [];
		}
		// The agent's latest run of any status, one query for every agent: `agent_runs_agent`
		// (`agent_id, queued_at`) makes this an index scan per agent rather than a sequential one.
		const runs = await db
			.select({
				agentId: agentRuns.agentId,
				id: agentRuns.id,
				status: agentRuns.status,
				outcome: agentRuns.outcome,
				errorCode: agentRuns.errorCode,
				finishedAt: agentRuns.finishedAt,
				queuedAt: agentRuns.queuedAt,
			})
			.from(agentRuns)
			.where(
				inArray(
					agentRuns.agentId,
					rows.map((row) => row.id),
				),
			)
			.orderBy(desc(agentRuns.queuedAt));
		const lastRunByAgent = new Map<string, (typeof runs)[number]>();
		for (const run of runs) {
			if (!lastRunByAgent.has(run.agentId)) {
				lastRunByAgent.set(run.agentId, run);
			}
		}
		return rows.map((row) => ({
			id: row.id,
			displayName: row.displayName,
			enabled: row.enabled,
			state: row.state,
			runtimeAdapter: row.runtimeAdapter,
			model: row.config.runtime.model ?? null,
			channelCount: row.config.mattermost.allowed_channels.length,
			lastRun: toLastRun(lastRunByAgent.get(row.id)),
			activeRevisionId,
		}));
	});
}

/** The agent's definition in the active snapshot, the whole bundle it came from, and the
 * revision; null when no agent of this id exists in the active configuration (never found, or
 * since removed). */
async function loadCurrentAgent(
	deps: ControlPlaneDeps,
	agentId: string,
): Promise<Readonly<{
	revisionId: number | null;
	bundle: ConfigDraftBundle;
	agent: AgentConfig;
}> | null> {
	const revisionId = await activeConfigRevisionId(deps);
	const { bundle } = await inTransaction(deps, ({ tx }) => loadActiveBundle(tx.db, revisionId));
	const agent = bundle.agents.find((candidate) => candidate.id === agentId);
	return agent === undefined ? null : { revisionId, bundle, agent };
}

/** `GET /api/agents/:id`: null when the agent does not exist in the active configuration. */
export async function consoleShowAgent(
	deps: ControlPlaneDeps,
	agentId: string,
): Promise<ConsoleAgentDetailResponse | null> {
	const current = await loadCurrentAgent(deps, agentId);
	if (current === null) {
		return null;
	}
	const { bundle, agent } = current;
	const organization = bundle.organization;
	return {
		agent: {
			id: agent.id,
			activeRevisionId: current.revisionId,
			displayName: agent.display_name,
			enabled: agent.enabled,
			mattermost: {
				username: agent.mattermost.username,
				tokenSecretFile: agent.mattermost.token_secret_file,
				allowedChannels: agent.mattermost.allowed_channels,
			},
			runtime: agent.runtime,
			rolePrompt: bundle.rolePrompts[agent.id] ?? "",
			wakeRules: agent.wake_rules,
			permissions: agent.permissions,
			memory: {
				privateNamespace: agent.memory.private_namespace,
				sharedNamespaces: agent.memory.shared_namespaces,
			},
			concurrency: {
				maxActiveRuns: agent.concurrency.max_active_runs,
				whileRunning: agent.concurrency.while_running,
			},
		},
		knownChannels: organization === null ? [] : organization.mattermost.channels,
		knownRuntimeAdapters: [...RuntimeAdapterIdSchema.options],
	};
}

// ---------------------------------------------------------------------------
// Translating a patch into a change set
// ---------------------------------------------------------------------------

/** Whether `patch` touches any field of the agent's own definition (as opposed to only its role
 * prompt, which is a separate `set_role_prompt` operation, unaffected by `update_agent`). */
function touchesDefinition(patch: AgentPatch): boolean {
	return (
		patch.displayName !== undefined ||
		patch.enabled !== undefined ||
		patch.runtime !== undefined ||
		patch.wakeRules !== undefined ||
		patch.allowedChannels !== undefined ||
		patch.permissions !== undefined
	);
}

/** `agent`, with every field `patch` sets merged in; fields the patch leaves out are unchanged.
 * Never touches the role prompt (stored separately) or any field the patch DTO does not expose
 * (the Mattermost identity, memory, concurrency, the schema version). */
function mergeAgentPatch(agent: AgentConfig, patch: AgentPatch): AgentConfig {
	return {
		...agent,
		...(patch.displayName === undefined ? {} : { display_name: patch.displayName }),
		...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
		...(patch.runtime === undefined
			? {}
			: {
					runtime: {
						...agent.runtime,
						...(patch.runtime.adapter === undefined ? {} : { adapter: patch.runtime.adapter }),
						...(patch.runtime.profile === undefined ? {} : { profile: patch.runtime.profile }),
						...(patch.runtime.model === undefined ? {} : { model: patch.runtime.model }),
						...(patch.runtime.session_policy === undefined
							? {}
							: { session_policy: patch.runtime.session_policy }),
						...(patch.runtime.timeout_seconds === undefined
							? {}
							: { timeout_seconds: patch.runtime.timeout_seconds }),
					},
				}),
		...(patch.wakeRules === undefined ? {} : { wake_rules: patch.wakeRules }),
		...(patch.allowedChannels === undefined
			? {}
			: { mattermost: { ...agent.mattermost, allowed_channels: patch.allowedChannels } }),
		...(patch.permissions === undefined
			? {}
			: {
					permissions: {
						...agent.permissions,
						...(patch.permissions.tools_allow === undefined
							? {}
							: { tools_allow: patch.permissions.tools_allow }),
						...(patch.permissions.tools_require_human_approval === undefined
							? {}
							: {
									tools_require_human_approval: patch.permissions.tools_require_human_approval,
								}),
						...(patch.permissions.tools_deny === undefined
							? {}
							: { tools_deny: patch.permissions.tools_deny }),
						...(patch.permissions.observe_system === undefined
							? {}
							: { observe_system: patch.permissions.observe_system }),
					},
				}),
	};
}

export type AgentPatchPlan = Readonly<{
	changeSet: ChangeSet;
	before: AgentConfig;
	/** The definition this patch implies, merged onto `before`; used for the diff and the impact
	 * list regardless of which operations `changeSet` actually carries. */
	after: AgentConfig;
	/**
	 * True when the only definition change is `enabled`, and nothing else (not even the role
	 * prompt) — the one case the commit path routes through `setAgentEnabled` instead of a plain
	 * `commitChange`, for its fallback to `remove_agent` when a retained agent's own stale
	 * configuration no longer validates (see `setAgentEnabled`).
	 */
	enabledOnly: boolean;
}>;

/** Translates `patch` against `agent`'s current definition into the change operations
 * `prepareChange`/`commitChange` apply. Pure and deterministic: the same `agent`/`patch` always
 * produce the same plan, which is what makes an idempotent commit replay safely. */
export function planAgentPatch(agent: AgentConfig, patch: AgentPatch): AgentPatchPlan {
	const after = mergeAgentPatch(agent, patch);
	const enabledOnly =
		patch.enabled !== undefined &&
		patch.rolePrompt === undefined &&
		patch.displayName === undefined &&
		patch.runtime === undefined &&
		patch.wakeRules === undefined &&
		patch.allowedChannels === undefined &&
		patch.permissions === undefined;
	const ops: ChangeOperation[] = [];
	if (enabledOnly) {
		ops.push({ type: "set_agent_enabled", agentId: agent.id, enabled: patch.enabled === true });
	} else if (touchesDefinition(patch)) {
		ops.push({ type: "update_agent", agent: after });
	}
	if (patch.rolePrompt !== undefined) {
		ops.push({ type: "set_role_prompt", agentId: agent.id, rolePrompt: patch.rolePrompt });
	}
	return { changeSet: ops, before: agent, after, enabledOnly };
}

/**
 * Destructive or authority-reducing consequences of `before` → `after`, for the UI's explicit
 * confirmation (ADR-025): disabling the agent, removing a channel, removing a tool grant, or
 * removing `observe_system`. Derived from the full agent definitions, not from the structural
 * diff's `fieldPaths` (which names only that a list changed, never what specifically left it).
 */
export function agentPatchImpact(before: AgentConfig, after: AgentConfig): Readonly<string[]> {
	const impact: string[] = [];
	if (before.enabled && !after.enabled) {
		impact.push("disables the agent");
	}
	const afterChannels = new Set(after.mattermost.allowed_channels);
	for (const channel of before.mattermost.allowed_channels) {
		if (!afterChannels.has(channel)) {
			impact.push(`removes channel '${channel}'`);
		}
	}
	const afterAllow = new Set(after.permissions.tools_allow);
	for (const pattern of before.permissions.tools_allow) {
		if (!afterAllow.has(pattern)) {
			impact.push(`removes tool grant '${pattern}'`);
		}
	}
	if (before.permissions.observe_system === true && after.permissions.observe_system !== true) {
		impact.push("removes observe_system");
	}
	return impact;
}

// ---------------------------------------------------------------------------
// Preview / commit
// ---------------------------------------------------------------------------

export type ConsoleAgentPreviewResult =
	| Readonly<{ kind: "not-found" }>
	| Readonly<{ kind: "ok"; preview: ChangePreview; impact: Readonly<string[]> }>;

/** `POST /api/agents/:id/preview`: always against the agent's current live definition, exactly
 * as `prepareChange` itself always previews against the live active revision (never the client's
 * possibly-stale view) — see `commitAgentPatch` for how a stale view is still caught at commit. */
export async function previewAgentPatch(
	deps: ControlPlaneDeps,
	agentId: string,
	patch: AgentPatch,
): Promise<ConsoleAgentPreviewResult> {
	const current = await loadCurrentAgent(deps, agentId);
	if (current === null) {
		return { kind: "not-found" };
	}
	const plan = planAgentPatch(current.agent, patch);
	const preview = await prepareChange(deps, plan.changeSet);
	return { kind: "ok", preview, impact: agentPatchImpact(plan.before, plan.after) };
}

export type ConsoleAgentCommitResult =
	| Readonly<{ kind: "not-found" }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ kind: "ok"; result: CommitChangeResult }>;

/** Mirrors `setAgentEnabled`'s own disable-with-fallback-to-`remove_agent` behavior, but keeps
 * the caller's `baseRevisionId` (optimistic concurrency against the client's own view) and
 * `idempotencyKey`/`reason`, which `setAgentEnabled` itself does not accept. */
async function commitEnabledChange(
	deps: ControlPlaneDeps,
	agentId: string,
	enabled: boolean,
	baseRevisionId: number | null,
	idempotencyKey: string,
	actor: string,
	reason: string | undefined,
): Promise<CommitChangeResult> {
	const disableChangeSet: ChangeSet = [{ type: "set_agent_enabled", agentId, enabled }];
	const commit = (changeSet: ChangeSet) =>
		commitChange(deps, {
			changeSet,
			baseRevisionId,
			idempotencyKey,
			actor,
			source: "console",
			...(reason === undefined ? {} : { reason }),
		});
	if (enabled) {
		return commit(disableChangeSet);
	}
	const preview = await prepareChange(deps, disableChangeSet);
	if (preview.problems.length === 0) {
		return commit(disableChangeSet);
	}
	const removeChangeSet: ChangeSet = [{ type: "remove_agent", agentId }];
	const removePreview = await prepareChange(deps, removeChangeSet);
	if (removePreview.problems.length > 0) {
		// Not fixable by removal either: commit the original disable, whose own refusal (thrown as
		// `AdminError` from inside `commitChange`) names the real problem.
		return commit(disableChangeSet);
	}
	return commit(removeChangeSet);
}

/**
 * `POST /api/agents/:id/commit`: builds the change set fresh from the agent's current live
 * definition (as `previewAgentPatch` does), re-validates it (so a patch that became invalid
 * between preview and commit is still reported as `invalid`, never attempted), then commits
 * through `commitChange` (or, for an enabled-only patch, `commitEnabledChange`'s
 * `setAgentEnabled`-equivalent fallback). A stale `baseRevisionId` is a `conflict`; a run-in-
 * progress protection or any other business-rule refusal raised only at commit time is reported
 * the same way as an `invalid` preview problem, both meaning "422, with a message" to the caller.
 */
export async function commitAgentPatch(
	deps: ControlPlaneDeps,
	agentId: string,
	baseRevisionId: number | null,
	patch: AgentPatch,
	idempotencyKey: string,
	actor: string,
	reason: string | undefined,
): Promise<ConsoleAgentCommitResult> {
	const current = await loadCurrentAgent(deps, agentId);
	if (current === null) {
		return { kind: "not-found" };
	}
	const plan = planAgentPatch(current.agent, patch);
	const preview = await prepareChange(deps, plan.changeSet);
	if (preview.problems.length > 0) {
		return { kind: "invalid", problems: preview.problems };
	}
	try {
		const result = plan.enabledOnly
			? await commitEnabledChange(
					deps,
					agentId,
					patch.enabled === true,
					baseRevisionId,
					idempotencyKey,
					actor,
					reason,
				)
			: await commitChange(deps, {
					changeSet: plan.changeSet,
					baseRevisionId,
					idempotencyKey,
					actor,
					source: "console",
					...(reason === undefined ? {} : { reason }),
				});
		return { kind: "ok", result };
	} catch (error) {
		if (error instanceof ManagementConflictError) {
			return { kind: "conflict", currentRevisionId: error.currentRevisionId };
		}
		if (error instanceof AdminError) {
			return { kind: "invalid", problems: [error.message] };
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export type ConsoleRevisionDiffResult = Readonly<{
	parentRevisionId: number | null;
	diff: ConfigDiff;
}>;

/** `GET /api/config/revisions/:id/diff`: `revisionId`'s own snapshot against its parent's (the
 * empty bundle, for the very first revision ever recorded). Null when `revisionId` does not
 * exist. Works for any recorded revision, not only the currently active one — `loadActiveBundle`
 * reads a revision's snapshot by its own id, never only the one `gateway_controls` currently
 * names. */
export async function consoleRevisionDiff(
	deps: ControlPlaneDeps,
	revisionId: number,
): Promise<ConsoleRevisionDiffResult | null> {
	return inTransaction(deps, async ({ tx }) => {
		const { db } = tx;
		const [revision] = await db
			.select({ parentRevisionId: configRevisions.parentRevisionId })
			.from(configRevisions)
			.where(eq(configRevisions.id, revisionId));
		if (revision === undefined) {
			return null;
		}
		const { bundle: after } = await loadActiveBundle(db, revisionId);
		const { bundle: before } = await loadActiveBundle(db, revision.parentRevisionId);
		return { parentRevisionId: revision.parentRevisionId, diff: configDiff(before, after) };
	});
}
