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
import { agents, configRevisions } from "@agent-gateway/db";
import { asc, eq } from "drizzle-orm";
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

/** One row of the per-agent latest-run lateral join below, snake_case as Postgres returns it. */
type LastRunRow = Readonly<{
	agent_id: string;
	id: string;
	status: string;
	outcome: string | null;
	error_code: string | null;
	finished_at: Date | null;
}>;

function toLastRun(row: LastRunRow | undefined): ConsoleAgentLastRun | null {
	if (row === undefined) {
		return null;
	}
	return {
		runId: row.id,
		status: row.status,
		outcome: row.outcome,
		errorCode: row.error_code,
		finishedAt: row.finished_at?.toISOString() ?? null,
	};
}

/** `GET /api/agents`: every agent *in the active configuration snapshot* (a row retained by
 * `set_agent_enabled`'s disable-with-fallback-to-`remove_agent` path, outside the snapshot but
 * still present in the `agents` projection table, is left out here — `GET /api/agents/:id` 404s
 * for it, `consoleShowAgent` reads the snapshot alone, so listing it would be a link to a page
 * that cannot open), its runtime/model, channel count and its last run, newest first by id
 * (stable, matching every other admin listing in this package). */
export async function consoleListAgents(
	deps: ControlPlaneDeps,
): Promise<Readonly<ConsoleAgentListItem[]>> {
	const activeRevisionId = await activeConfigRevisionId(deps);
	return inTransaction(deps, async ({ tx }) => {
		const { db, client } = tx;
		const { bundle } = await loadActiveBundle(db, activeRevisionId);
		const activeIds = new Set(bundle.agents.map((agent) => agent.id));
		const allRows = await db
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
		const rows = allRows.filter((row) => activeIds.has(row.id));
		if (rows.length === 0) {
			return [];
		}
		// The agent's latest run of any status, one row per agent in SQL (a lateral join, index-
		// backed by `agent_runs_agent` on `(agent_id, queued_at)`) rather than every historical run
		// fetched and reduced in JS.
		const runs = (
			await client.query<LastRunRow>(
				`select sel.agent_id, r.id, r.status, r.outcome, r.error_code, r.finished_at
				   from unnest($1::text[]) as sel(agent_id)
				   cross join lateral (
				        select * from agent_runs
				         where agent_id = sel.agent_id
				         order by queued_at desc, id desc limit 1) r`,
				[rows.map((row) => row.id)],
			)
		).rows;
		const lastRunByAgent = new Map(runs.map((run) => [run.agent_id, run]));
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

/** `agent.runtime`, with `patch` merged in: `model: undefined` (the field absent from the patch,
 * JSON drops an `undefined` value the same way) leaves it unchanged, `model: null` removes it (the
 * agent falls back to the runtime adapter's own default model), and any other value sets it. The
 * only field of the runtime patch with a distinct "remove" representation: every other field
 * either keeps its current value (an `AgentConfig`-required field is never optional, so there is
 * nothing to remove it to) or is replaced outright. */
function mergeRuntimePatch(
	runtime: AgentConfig["runtime"],
	patch: AgentPatch["runtime"],
): AgentConfig["runtime"] {
	if (patch === undefined) {
		return runtime;
	}
	const merged: AgentConfig["runtime"] = {
		...runtime,
		...(patch.adapter === undefined ? {} : { adapter: patch.adapter }),
		...(patch.profile === undefined ? {} : { profile: patch.profile }),
		...(patch.model === undefined || patch.model === null ? {} : { model: patch.model }),
		...(patch.session_policy === undefined ? {} : { session_policy: patch.session_policy }),
		...(patch.timeout_seconds === undefined ? {} : { timeout_seconds: patch.timeout_seconds }),
	};
	if (patch.model === null) {
		delete merged.model;
	}
	return merged;
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
			: { runtime: mergeRuntimePatch(agent.runtime, patch.runtime) }),
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
 * Destructive, authority-reducing *or authority-increasing* consequences of `before` → `after`,
 * for the UI's explicit confirmation (ADR-025): every one of these — a reduction or an increase
 * alike — requires the same acknowledgment before a commit proceeds, since an increase (a new
 * tool grant, a removed deny rule, a removed human-approval requirement, re-enabling the agent, a
 * new channel) is exactly as much a consequence the owner must notice as a reduction is. Derived
 * from the full agent definitions, not from the structural diff's `fieldPaths` (which names only
 * that a list changed, never what specifically left or joined it).
 */
export function agentPatchImpact(before: AgentConfig, after: AgentConfig): Readonly<string[]> {
	const impact: string[] = [];
	if (before.enabled && !after.enabled) {
		impact.push("disables the agent");
	}
	if (!before.enabled && after.enabled) {
		impact.push("enables the agent");
	}
	const beforeChannels = new Set(before.mattermost.allowed_channels);
	const afterChannels = new Set(after.mattermost.allowed_channels);
	for (const channel of before.mattermost.allowed_channels) {
		if (!afterChannels.has(channel)) {
			impact.push(`removes channel '${channel}'`);
		}
	}
	for (const channel of after.mattermost.allowed_channels) {
		if (!beforeChannels.has(channel)) {
			impact.push(`adds channel '${channel}'`);
		}
	}
	const beforeAllow = new Set(before.permissions.tools_allow);
	const afterAllow = new Set(after.permissions.tools_allow);
	for (const pattern of before.permissions.tools_allow) {
		if (!afterAllow.has(pattern)) {
			impact.push(`removes tool grant '${pattern}'`);
		}
	}
	for (const pattern of after.permissions.tools_allow) {
		if (!beforeAllow.has(pattern)) {
			impact.push(`grants tool '${pattern}'`);
		}
	}
	const afterDeny = new Set(after.permissions.tools_deny);
	for (const pattern of before.permissions.tools_deny) {
		if (!afterDeny.has(pattern)) {
			impact.push(`removes the deny rule for '${pattern}'`);
		}
	}
	const afterApproval = new Set(after.permissions.tools_require_human_approval);
	for (const pattern of before.permissions.tools_require_human_approval) {
		if (!afterApproval.has(pattern)) {
			// The most dangerous reduction this surface can make: a tool the agent could already
			// reach no longer needs a human to approve each action first.
			impact.push(`removes the human-approval requirement for '${pattern}'`);
		}
	}
	if (before.permissions.observe_system === true && after.permissions.observe_system !== true) {
		impact.push("removes observe_system");
	}
	if (before.permissions.observe_system !== true && after.permissions.observe_system === true) {
		impact.push("grants observe_system");
	}
	return impact;
}

// ---------------------------------------------------------------------------
// Preview / commit
// ---------------------------------------------------------------------------

export type ConsoleAgentPreviewResult =
	| Readonly<{ kind: "not-found" }>
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ kind: "ok"; preview: ChangePreview; impact: Readonly<string[]> }>;

/** For an enabled-only patch (`AgentPatchPlan.enabledOnly`): the change set that actually applies
 * — a plain `set_agent_enabled`, or, when disabling and the agent's own retained configuration no
 * longer validates under the active bundle's current rules, `remove_agent` instead (mirroring
 * `setAgentEnabled`'s own disable-with-fallback behavior, ADR-024). Enabling, or a disable that
 * already validates, never needs the fallback; a disable that is invalid for an unrelated reason
 * (removal does not fix it either) resolves to the plain disable, whose own refusal names the real
 * problem. Shared by `previewAgentPatch` (so the console sees the fallback's own diff and impact
 * before committing) and `commitAgentPatch`/`commitEnabledChange` (so the same resolution is what
 * actually gets committed) — the fallback must be reachable from both, not only from commit. */
async function resolveEnabledChangeSet(
	deps: ControlPlaneDeps,
	agentId: string,
	enabled: boolean,
): Promise<Readonly<{ changeSet: ChangeSet; preview: ChangePreview; usedFallback: boolean }>> {
	const disableChangeSet: ChangeSet = [{ type: "set_agent_enabled", agentId, enabled }];
	const preview = await prepareChange(deps, disableChangeSet);
	if (enabled || preview.problems.length === 0) {
		return { changeSet: disableChangeSet, preview, usedFallback: false };
	}
	const removeChangeSet: ChangeSet = [{ type: "remove_agent", agentId }];
	const removePreview = await prepareChange(deps, removeChangeSet);
	if (removePreview.problems.length > 0) {
		return { changeSet: disableChangeSet, preview, usedFallback: false };
	}
	return { changeSet: removeChangeSet, preview: removePreview, usedFallback: true };
}

/** `POST /api/agents/:id/preview`: `conflict` when `baseRevisionId` is not the revision actually
 * active right now — the editor's own loaded view, never silently previewed against the live
 * state in its place (see `commitAgentPatch` for why committing against a stale base must refuse
 * the same way). Otherwise built against the agent's current live definition, which is also what
 * `baseRevisionId` was just confirmed to match. An enabled-only disable whose own retained
 * configuration no longer validates resolves through `resolveEnabledChangeSet`'s fallback here
 * too, so the preview's diff and impact already show what committing it will actually do (removing
 * the agent from the configuration, not merely flipping its `enabled` flag in place). */
export async function previewAgentPatch(
	deps: ControlPlaneDeps,
	agentId: string,
	baseRevisionId: number | null,
	patch: AgentPatch,
): Promise<ConsoleAgentPreviewResult> {
	const current = await loadCurrentAgent(deps, agentId);
	if (current === null) {
		return { kind: "not-found" };
	}
	if (baseRevisionId !== current.revisionId) {
		return { kind: "conflict", currentRevisionId: current.revisionId };
	}
	const plan = planAgentPatch(current.agent, patch);
	if (plan.enabledOnly && patch.enabled === false) {
		const resolved = await resolveEnabledChangeSet(deps, agentId, false);
		const impact = [
			...agentPatchImpact(plan.before, plan.after),
			...(resolved.usedFallback ? ["removes the agent from the configuration"] : []),
		];
		return { kind: "ok", preview: resolved.preview, impact };
	}
	const preview = await prepareChange(deps, plan.changeSet);
	return { kind: "ok", preview, impact: agentPatchImpact(plan.before, plan.after) };
}

export type ConsoleAgentCommitResult =
	| Readonly<{ kind: "not-found" }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ kind: "ok"; result: CommitChangeResult }>;

/** Mirrors `setAgentEnabled`'s own disable-with-fallback-to-`remove_agent` behavior (through
 * `resolveEnabledChangeSet`), but keeps the caller's `baseRevisionId` (optimistic concurrency
 * against the client's own view) and `idempotencyKey`/`reason`, which `setAgentEnabled` itself
 * does not accept. */
async function commitEnabledChange(
	deps: ControlPlaneDeps,
	agentId: string,
	enabled: boolean,
	baseRevisionId: number | null,
	idempotencyKey: string,
	actor: string,
	reason: string | undefined,
): Promise<CommitChangeResult> {
	const { changeSet } = await resolveEnabledChangeSet(deps, agentId, enabled);
	return commitChange(deps, {
		changeSet,
		baseRevisionId,
		idempotencyKey,
		actor,
		source: "console",
		...(reason === undefined ? {} : { reason }),
	});
}

/**
 * `POST /api/agents/:id/commit`: builds the change set from the agent's definition in the
 * snapshot `baseRevisionId` itself names (see the determinism note below — not "whatever is live
 * right now", unlike `previewAgentPatch`, which has already confirmed the two agree by this
 * point). An enabled-only patch always routes through `commitEnabledChange`, which validates and
 * resolves its own fallback itself (`resolveEnabledChangeSet`) — bailing out here on the plain
 * disable's own `problems` first, before that fallback ever ran, is exactly what made the
 * fallback unreachable from the console. Every other patch is re-validated here first (so a patch
 * that became invalid between preview and commit is still reported as `invalid`, never attempted)
 * and then committed through `commitChange` directly. A stale `baseRevisionId` is a `conflict`; a
 * run-in-progress protection or any other business-rule refusal raised only at commit time is
 * reported the same way as an `invalid` preview problem, both meaning "422, with a message" to
 * the caller.
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
	try {
		// Built from the request's own claimed base — never "whatever is live right now"
		// (`loadCurrentAgent`, which `previewAgentPatch` uses once it has already confirmed the base
		// matches live). A snapshot is immutable and content-addressed, so recomputing this plan for
		// the same (`baseRevisionId`, `patch`) pair always produces the identical change set,
		// regardless of what has happened to the live configuration since. That determinism is what
		// lets a retry under the same idempotency key replay correctly — `commitChange`'s own
		// idempotency check (inside its transaction, before it ever compares `baseRevisionId`
		// against the current live revision) compares the two change sets' hashes, and a
		// live-state-dependent plan could disagree with its own first attempt purely because an
		// unrelated, intervening change had moved live state on by the time the retry ran, which
		// `commitChange` would otherwise see as "the same key, a different change set" and refuse.
		// A genuinely stale (non-retried) base is still refused: `commitChange`'s own lock-protected
		// conflict check runs regardless of where this plan's content came from.
		const { bundle } = await inTransaction(deps, ({ tx }) =>
			loadActiveBundle(tx.db, baseRevisionId),
		);
		const agent = bundle.agents.find((candidate) => candidate.id === agentId);
		if (agent === undefined) {
			return { kind: "not-found" };
		}
		const plan = planAgentPatch(agent, patch);
		if (plan.enabledOnly) {
			const result = await commitEnabledChange(
				deps,
				agentId,
				patch.enabled === true,
				baseRevisionId,
				idempotencyKey,
				actor,
				reason,
			);
			return { kind: "ok", result };
		}
		const preview = await prepareChange(deps, plan.changeSet);
		if (preview.problems.length > 0) {
			return { kind: "invalid", problems: preview.problems };
		}
		const result = await commitChange(deps, {
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
