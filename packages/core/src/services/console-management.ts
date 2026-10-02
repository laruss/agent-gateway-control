import type {
	AgentConfig,
	AgentId,
	AgentPatch,
	ChangeOperation,
	ChangeSet,
	ConfigDiff,
	ConsoleAgentChannelsResponse,
	ConsoleAgentCreateRequest,
	ConsoleAgentDetailResponse,
	ConsoleAgentLastRun,
	ConsoleAgentLifecycleResponse,
	ConsoleAgentListItem,
	ConsoleAgentRestoreRequest,
	ConsoleAgentRetireRequest,
	ConsoleAgentRetryRequest,
	ConsoleRevokeGrantResponse,
	MattermostId,
	RuntimeAdapterId,
} from "@agent-gateway/contracts";
import { RuntimeAdapterIdSchema } from "@agent-gateway/contracts";
import { agentLifecycle, agents, configRevisions } from "@agent-gateway/db";
import { asc, eq } from "drizzle-orm";
import { AdminError, inTransaction } from "./admin.ts";
import {
	listLifecycleOperations,
	loadAgentLifecycle,
	requestAgentCreate,
	requestAgentRestore,
	requestAgentRetire,
	requestOperationRetry,
} from "./agent-lifecycle.ts";
import { loadAgentChannelAssignments, revokeChannelGrant } from "./channel-grants.ts";
import type { ControlPlaneDeps } from "./deps.ts";
import {
	activeConfigRevisionId,
	applyChangeSet,
	type ChangePreview,
	type CommitChangeResult,
	type ConfigDraftBundle,
	commitChange,
	configDiff,
	draftBundleProblems,
	loadActiveBundle,
	ManagementConflictError,
	previewChangeSetAgainst,
} from "./management.ts";
import { runtimeHealth } from "./runtime-health.ts";

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
export type ConsoleAgentListResult = Readonly<{
	agents: Readonly<ConsoleAgentListItem[]>;
	knownChannels: Readonly<string[]>;
	knownRuntimeAdapters: Readonly<RuntimeAdapterId[]>;
}>;

export async function consoleListAgents(deps: ControlPlaneDeps): Promise<ConsoleAgentListResult> {
	const activeRevisionId = await activeConfigRevisionId(deps);
	// A separate read, like `activeConfigRevisionId` above: the "New agent" dialog's own runtime
	// picker only offers an adapter `requestAgentCreate` would actually accept (a fresh, ready
	// worker on this deployment), never the full static enum `consoleShowAgent`'s own
	// `knownRuntimeAdapters` offers an *existing* agent's Runtime tab (which must still show
	// whatever adapter it is already configured with, ready or not).
	const health = await runtimeHealth(deps);
	const knownRuntimeAdapters = health.filter((h) => h.available).map((h) => h.adapter);
	return inTransaction(deps, async ({ tx }) => {
		const { db, client } = tx;
		const { bundle } = await loadActiveBundle(db, activeRevisionId);
		const knownChannels = bundle.organization?.mattermost.channels ?? [];
		const activeIds = new Set(bundle.agents.map((agent) => agent.id));
		const lifecycleRows = await db
			.select({ agentId: agentLifecycle.agentId, status: agentLifecycle.status })
			.from(agentLifecycle);
		const lifecycleByAgent = new Map(lifecycleRows.map((row) => [row.agentId, row.status]));
		// A retiring or retired agent's `remove_agent` commit already took it out of the active
		// bundle, but it stays listed (filterable, with its own Restore action) rather than
		// vanishing the moment its configuration change commits: an owner who just retired an agent
		// still needs to find it again to restore it.
		const retiredIds = new Set(
			lifecycleRows
				.filter((row) => row.status === "retiring" || row.status === "retired")
				.map((row) => row.agentId),
		);
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
		const rows = allRows.filter((row) => activeIds.has(row.id) || retiredIds.has(row.id));
		if (rows.length === 0) {
			return { agents: [], knownChannels, knownRuntimeAdapters };
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
		return {
			agents: rows.map((row) => ({
				id: row.id,
				displayName: row.displayName,
				enabled: row.enabled,
				state: row.state,
				runtimeAdapter: row.runtimeAdapter,
				model: row.config.runtime.model ?? null,
				channelCount: row.config.mattermost.allowed_channels.length,
				lastRun: toLastRun(lastRunByAgent.get(row.id)),
				activeRevisionId: activeIds.has(row.id) ? activeRevisionId : null,
				lifecycleStatus: lifecycleByAgent.get(row.id) ?? null,
			})),
			knownChannels,
			knownRuntimeAdapters,
		};
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
	hash: string | null;
	agent: AgentConfig;
}> | null> {
	const revisionId = await activeConfigRevisionId(deps);
	const { bundle, hash } = await inTransaction(deps, ({ tx }) =>
		loadActiveBundle(tx.db, revisionId),
	);
	const agent = bundle.agents.find((candidate) => candidate.id === agentId);
	return agent === undefined ? null : { revisionId, bundle, hash, agent };
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
		financeAgentId: organization?.organization.finance_agent_id ?? null,
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
	const beforeApproval = new Set(before.permissions.tools_require_human_approval);
	const afterApproval = new Set(after.permissions.tools_require_human_approval);
	for (const pattern of before.permissions.tools_require_human_approval) {
		if (!afterApproval.has(pattern)) {
			// The most dangerous reduction this surface can make: a tool the agent could already
			// reach no longer needs a human to approve each action first.
			impact.push(`removes the human-approval requirement for '${pattern}'`);
		}
	}
	for (const pattern of after.permissions.tools_require_human_approval) {
		if (!beforeApproval.has(pattern)) {
			// Added: an authority increase (denied, or merely deny-by-default, access becomes
			// approval-gated access) unless the pattern was already freely allowed, in which case
			// it is a reduction (a new approval gate on access the agent already had, without it) —
			// either way a behavior change the owner must notice before committing.
			impact.push(
				beforeAllow.has(pattern)
					? `now requires human approval for '${pattern}'`
					: `allows '${pattern}' with human approval`,
			);
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

/** Pure: the problems of applying `changeSet` to `base` alone — no DB access, no notion of
 * whatever is live right now. The same two checks `previewChangeSetAgainst` makes before its own,
 * separate (and DB-backed) noop computation; used on its own wherever only a change set's validity
 * against an already-loaded snapshot matters, never a preview's diff or noop — most importantly, a
 * commit's own planning step, which must be a pure function of (base snapshot, patch) for an
 * idempotent retry to replay rather than recompute. `changeSet` is already a typed `ChangeSet`
 * built internally (never raw, unparsed request input), so unlike `previewChangeSetAgainst` this
 * skips `ChangeSetSchema` shape-checking. */
function changeSetProblems(base: ConfigDraftBundle, changeSet: ChangeSet): Readonly<string[]> {
	const { draft, problems: opProblems } = applyChangeSet(base, changeSet);
	return [...opProblems, ...draftBundleProblems(draft)];
}

/** For an enabled-only patch (`AgentPatchPlan.enabledOnly`): the change set that actually applies
 * against `base` alone — a plain `set_agent_enabled`, or, when disabling and the agent's own
 * retained configuration no longer validates under `base`'s own rules, `remove_agent` instead
 * (mirroring `setAgentEnabled`'s own disable-with-fallback behavior, ADR-024). Enabling, or a
 * disable that already validates, never needs the fallback; a disable that is invalid for an
 * unrelated reason (removal does not fix it either) resolves to the plain disable, whose own
 * problems name the real one. Pure and deterministic in (`base`, `agentId`, `enabled`) alone — no
 * DB access — which is what lets `commitAgentPatch` build the identical change set on every retry
 * of the same request, the property an idempotent replay depends on. Shared with
 * `resolveEnabledChangeSet`, which wraps this with the DB-backed `ChangePreview` the console's own
 * preview endpoint needs (diff, noop) on top of the same decision.
 */
function planEnabledChangeSet(
	base: ConfigDraftBundle,
	agentId: string,
	enabled: boolean,
): Readonly<{ changeSet: ChangeSet; problems: Readonly<string[]>; usedFallback: boolean }> {
	const disableChangeSet: ChangeSet = [{ type: "set_agent_enabled", agentId, enabled }];
	const disableProblems = changeSetProblems(base, disableChangeSet);
	if (enabled || disableProblems.length === 0) {
		return { changeSet: disableChangeSet, problems: disableProblems, usedFallback: false };
	}
	const removeChangeSet: ChangeSet = [{ type: "remove_agent", agentId }];
	const removeProblems = changeSetProblems(base, removeChangeSet);
	if (removeProblems.length > 0) {
		return { changeSet: disableChangeSet, problems: disableProblems, usedFallback: false };
	}
	return { changeSet: removeChangeSet, problems: [], usedFallback: true };
}

/** `previewAgentPatch`'s own disable-with-fallback resolution: `planEnabledChangeSet` against
 * `base`, wrapped with the DB-backed `ChangePreview` (diff, noop) the console's UI needs on top of
 * the same decision. Never used by `commitAgentPatch`, which needs only the pure change set and
 * its problems (`planEnabledChangeSet` directly) — a commit has no diff or noop to show. Resolved
 * against `base` (the caller's own already-loaded snapshot, confirmed to be the active revision),
 * never by re-reading live state: the caller has already confirmed `base` is the active revision
 * by the time this runs, and validating against anything else would make the fallback's own choice
 * of change set depend on exactly when it happened to run, breaking the determinism an idempotent
 * retry relies on (see `previewChangeSetAgainst`).
 */
async function resolveEnabledChangeSet(
	deps: ControlPlaneDeps,
	base: ConfigDraftBundle,
	baseRevisionId: number | null,
	baseHash: string | null,
	agentId: string,
	enabled: boolean,
): Promise<Readonly<{ changeSet: ChangeSet; preview: ChangePreview; usedFallback: boolean }>> {
	const plan = planEnabledChangeSet(base, agentId, enabled);
	const preview = await previewChangeSetAgainst(
		deps,
		baseRevisionId,
		base,
		baseHash,
		plan.changeSet,
	);
	return { changeSet: plan.changeSet, preview, usedFallback: plan.usedFallback };
}

/** `POST /api/agents/:id/preview`: `conflict` when `baseRevisionId` is not the revision actually
 * active right now — the editor's own loaded view, never silently previewed against the live
 * state in its place (see `commitAgentPatch` for why committing against a stale base must refuse
 * the same way). Otherwise built against the agent's current live definition, which is also what
 * `baseRevisionId` was just confirmed to match, and validated against that same loaded snapshot
 * (`previewChangeSetAgainst`), never a fresh read of live state. An enabled-only disable whose own
 * retained configuration no longer validates resolves through `resolveEnabledChangeSet`'s fallback
 * here too, so the preview's diff and impact already show what committing it will actually do
 * (removing the agent from the configuration, not merely flipping its `enabled` flag in place). */
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
		const resolved = await resolveEnabledChangeSet(
			deps,
			current.bundle,
			current.revisionId,
			current.hash,
			agentId,
			false,
		);
		const impact = [
			...agentPatchImpact(plan.before, plan.after),
			...(resolved.usedFallback ? ["removes the agent from the configuration"] : []),
		];
		return { kind: "ok", preview: resolved.preview, impact };
	}
	const preview = await previewChangeSetAgainst(
		deps,
		current.revisionId,
		current.bundle,
		current.hash,
		plan.changeSet,
	);
	return { kind: "ok", preview, impact: agentPatchImpact(plan.before, plan.after) };
}

export type ConsoleAgentCommitResult =
	| Readonly<{ kind: "not-found" }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ kind: "ok"; result: CommitChangeResult }>;

/**
 * `POST /api/agents/:id/commit`: this function's only job is to turn `patch` into the one change
 * set `commitChange` applies — every replay, conflict and no-op decision is `commitChange`'s own,
 * made under its `gateway_controls` lock (see its doc comment), never pre-empted here. The change
 * set is planned purely from the snapshot `baseRevisionId` itself names, immutable regardless of
 * whatever has happened to the live configuration since (`loadActiveBundle` reads any recorded
 * revision, not only the currently active one): `not-found` when that snapshot does not have this
 * agent at all, `conflict` when `baseRevisionId` names no revision this database has ever
 * recorded — as stale a view as one that has since moved on, just discovered sooner, so reported
 * the same way (`409`, not a `422` problem with the patch) — and `invalid` when the resulting
 * change set does not validate against that snapshot on its own. Because the plan depends only on
 * (`baseRevisionId`, `patch`), a retried request always submits the identical change set to
 * `commitChange`, which is what lets it replay an already-recorded idempotency key rather than
 * refuse it as a conflict or recompute a plan that could disagree with its own first attempt —
 * even once the agent has since been removed from the live configuration by some unrelated change,
 * and even when two concurrent identical requests race each other (each is decided by
 * `commitChange`'s own lock, never by a check this function made ahead of it). An enabled-only
 * patch resolves its own disable-with-fallback-to-`remove_agent` first (`planEnabledChangeSet`,
 * mirroring `setAgentEnabled`'s CLI behavior); every other patch is validated directly
 * (`changeSetProblems`). A run-in-progress protection or any other business-rule refusal
 * `commitChange` raises only once it actually tries to write — never visible to this pre-check —
 * surfaces as `AdminError` and is reported the same way as a planning problem: both mean "422,
 * with a message" to the caller. The one exception is `commitChange`'s own refusal of an
 * idempotency key already used with a different change set (a reused key for a different patch,
 * or a different agent): also an `AdminError`, also reported as `422` here — the problem is the
 * request itself, not a base that has moved on, so `409` would be misleading.
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
	let bundle: ConfigDraftBundle;
	try {
		({ bundle } = await inTransaction(deps, ({ tx }) => loadActiveBundle(tx.db, baseRevisionId)));
	} catch (error) {
		if (error instanceof AdminError) {
			return { kind: "conflict", currentRevisionId: await activeConfigRevisionId(deps) };
		}
		throw error;
	}
	const agent = bundle.agents.find((candidate) => candidate.id === agentId);
	if (agent === undefined) {
		return { kind: "not-found" };
	}
	const plan = planAgentPatch(agent, patch);
	let changeSet: ChangeSet;
	let problems: Readonly<string[]>;
	if (plan.enabledOnly) {
		({ changeSet, problems } = planEnabledChangeSet(bundle, agentId, patch.enabled === true));
	} else {
		changeSet = plan.changeSet;
		problems = changeSetProblems(bundle, plan.changeSet);
	}
	if (problems.length > 0) {
		return { kind: "invalid", problems };
	}
	try {
		const result = await commitChange(deps, {
			changeSet,
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

// ---------------------------------------------------------------------------
// Lifecycle (ADR-026): create, retry, retire, restore; an agent's own status and operation
// journal, read fresh; its channel assignments with provenance, and revoking one directly. Unlike
// `commitAgentPatch`, none of these take a client-supplied `baseRevisionId` to check: they are
// never asked to apply against a specific, previously loaded configuration snapshot the way
// editing an agent's own definition is (they always act on whatever is live, the same way the
// CLI's own `gateway agents create|retire|restore|retry` already do) — a stale page is instead
// caught by each one's own business-rule refusal (`AdminError`, surfaced as `invalid`/422), which
// names the actual problem ("already retired", "not failed, nothing to retry") more specifically
// than a bare conflict would. `ManagementConflictError` is still mapped to `conflict`/409 — the
// rare case `commitWithinLock`'s own internal retry can still raise (a configuration-history
// backfill racing this very request) — never a raw thrown error reaching the HTTP layer either
// way.
// ---------------------------------------------------------------------------

export type ConsoleCreateAgentResult =
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>
	| Readonly<{ kind: "ok"; result: Awaited<ReturnType<typeof requestAgentCreate>> }>;

/**
 * `POST /api/agents`: builds the full `requestAgentCreate` input from the console's own narrower
 * DTO, the same way `gateway agents create` already does (`buildAgentCreateRequest`) — the bot
 * username (always the agent id), its wake rule (a mention in any allowed channel), concurrency
 * and private memory namespace, never a client-chosen value beyond what the console DTO actually
 * exposes. The server-generated bot token path is `requestAgentCreate`'s own job
 * (`defaultBotSecretFile`); nothing here ever names one.
 */
export async function consoleCreateAgent(
	deps: ControlPlaneDeps,
	request: ConsoleAgentCreateRequest,
	actor: string,
): Promise<ConsoleCreateAgentResult> {
	try {
		const result = await requestAgentCreate(deps, {
			agent: {
				id: request.id,
				display_name: request.displayName,
				mattermost: { username: request.id, allowed_channels: [...request.allowedChannels] },
				...(request.runtime === undefined ? {} : { runtime: request.runtime }),
				prompts: { role_file: `prompts/agents/${request.id}.md` },
				wake_rules: [{ event_type: "mattermost.agent.mentioned", target_agent_id: request.id }],
				concurrency: { while_running: "enqueue" },
				memory: { private_namespace: `agents/${request.id}`, shared_namespaces: [] },
			},
			rolePrompt: request.rolePrompt,
			actor,
			source: "console",
			idempotencyKey: request.idempotencyKey,
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

export type ConsoleRetireAgentResult =
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>
	| Readonly<{ kind: "ok"; result: Awaited<ReturnType<typeof requestAgentRetire>> }>;

/** `POST /api/agents/:id/retire`. `request.reassignFinanceTo` is required by `requestAgentRetire`
 * itself when `agentId` is the organization's finance agent; refusing it otherwise surfaces as
 * `invalid`, the same as any other business-rule problem. */
export async function consoleRetireAgent(
	deps: ControlPlaneDeps,
	agentId: AgentId,
	request: ConsoleAgentRetireRequest,
	actor: string,
): Promise<ConsoleRetireAgentResult> {
	try {
		const result = await requestAgentRetire(deps, {
			agentId,
			actor,
			source: "console",
			idempotencyKey: request.idempotencyKey,
			...(request.reason === undefined ? {} : { reason: request.reason }),
			...(request.reassignFinanceTo === undefined
				? {}
				: { reassignFinanceTo: request.reassignFinanceTo }),
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

export type ConsoleRestoreAgentResult =
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>
	| Readonly<{ kind: "ok"; result: Awaited<ReturnType<typeof requestAgentRestore>> }>;

/** `POST /api/agents/:id/restore`. */
export async function consoleRestoreAgent(
	deps: ControlPlaneDeps,
	agentId: AgentId,
	request: ConsoleAgentRestoreRequest,
	actor: string,
): Promise<ConsoleRestoreAgentResult> {
	try {
		const result = await requestAgentRestore(deps, {
			agentId,
			actor,
			source: "console",
			idempotencyKey: request.idempotencyKey,
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

export type ConsoleRetryOperationResult =
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>
	| Readonly<{ kind: "ok"; result: Awaited<ReturnType<typeof requestOperationRetry>> }>;

/** `POST /api/agents/:id/retry`: refused (`invalid`) unless the agent's current operation is
 * actually `failed` (`requestOperationRetry`). */
export async function consoleRetryOperation(
	deps: ControlPlaneDeps,
	agentId: AgentId,
	request: ConsoleAgentRetryRequest,
	actor: string,
): Promise<ConsoleRetryOperationResult> {
	try {
		const result = await requestOperationRetry(deps, {
			agentId,
			actor,
			source: "console",
			idempotencyKey: request.idempotencyKey,
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

/** `GET /api/agents/:id/lifecycle`: null when the agent has no `agent_lifecycle` row at all (only
 * possible before the startup adoption backfill has run). */
export async function consoleAgentLifecycle(
	deps: ControlPlaneDeps,
	agentId: AgentId,
): Promise<ConsoleAgentLifecycleResponse | null> {
	const lifecycle = await loadAgentLifecycle(deps, agentId);
	if (lifecycle === null) {
		return null;
	}
	const operations = await listLifecycleOperations(deps, agentId);
	return {
		status: lifecycle.status,
		generation: lifecycle.generation,
		lastError: lifecycle.lastError,
		statusChangedAt: lifecycle.statusChangedAt,
		retiredAt: lifecycle.retiredAt,
		operations: operations.map((operation) => ({
			id: operation.id,
			kind: operation.kind,
			state: operation.state,
			checkpoints: operation.checkpoints,
			error: operation.error,
			createdAt: operation.createdAt,
			updatedAt: operation.updatedAt,
			finishedAt: operation.finishedAt,
		})),
	};
}

/** `GET /api/agents/:id/channels`: configured vs granted, the same read model `gateway agents
 * channels` prints (`loadAgentChannelAssignments`) — database-only, never the live
 * `member-unauthorized` check `gateway mattermost reconcile` performs. */
export async function consoleAgentChannels(
	deps: ControlPlaneDeps,
	agentId: AgentId,
): Promise<ConsoleAgentChannelsResponse> {
	const assignments = await loadAgentChannelAssignments(deps, agentId);
	return {
		channels: assignments.map((assignment) => ({
			channelId: assignment.channelId,
			channelName: assignment.channelName,
			provenance: assignment.provenance,
			grantedByUserId: assignment.grantedByUserId,
			grantedAt: assignment.grantedAt,
			evidencePostId: assignment.evidencePostId,
		})),
	};
}

/** `POST /api/agents/:id/channels/revoke`: tombstones a directly granted channel the same way
 * `gateway agents revoke-grant` does (looked up by id among the agent's own assignments, for the
 * channel name the response reports — `revokeChannelGrant` itself only reports whether the
 * channel is still followed for someone else). A channel the agent has no active grant for at all
 * (already revoked, or never granted — `channelName: null`) is not an error: revoking is
 * idempotent, the same as the CLI command. */
export async function consoleRevokeGrant(
	deps: ControlPlaneDeps,
	agentId: AgentId,
	channelId: MattermostId,
	actor: string,
): Promise<ConsoleRevokeGrantResponse> {
	const assignments = await loadAgentChannelAssignments(deps, agentId);
	const match = assignments.find((assignment) => assignment.channelId === channelId);
	const stillFollowed = await revokeChannelGrant(deps, { agentId, channelId, actor });
	return { channelId, channelName: match?.channelName ?? null, stillFollowed };
}
