import { randomUUID } from "node:crypto";
import {
	type AgentConfig,
	type AgentCreateInput,
	type AgentId,
	type AgentLifecycleCheckpoints,
	type AgentLifecycleOperation,
	type AgentLifecycleOperationKind,
	type AgentLifecycleSource,
	type AgentLifecycleStatus,
	type ChangeSet,
	type ConfigRevisionSource,
	ConfigSnapshotBundleSchema,
	defaultAgentPermissions,
	type RequestAgentCreateInput,
	RequestAgentCreateInputSchema,
	type RequestAgentRestoreInput,
	RequestAgentRestoreInputSchema,
	type RequestAgentRetireInput,
	RequestAgentRetireInputSchema,
	type RuntimeAdapterId,
	type SecretFile,
} from "@agent-gateway/contracts";
import {
	agentLifecycle,
	agentLifecycleOperations,
	gatewayControls,
	mattermostIdentities,
	runtimeWorkers,
} from "@agent-gateway/db";
import { redactForStorage } from "@agent-gateway/logging";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import type { z } from "zod";
import {
	AdminError,
	type CancelledJob,
	ensureConfigHistoryIn,
	inTransaction,
	pauseInTransaction,
} from "./admin.ts";
import { sweepApprovals } from "./approvals.ts";
import { revokeAllActiveGrantsIn } from "./channel-grants.ts";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import {
	type CommitOutcome,
	commitChangeIn,
	loadActiveBundle,
	ManagementConflictError,
} from "./management.ts";
import { WORKER_STALE_MS } from "./runtime-health.ts";
import { scheduleAgent } from "./scheduler.ts";
import { audit, lifecycleOwnedAgentIds, lockAgent } from "./store.ts";

type Db = UnitOfWork["tx"]["db"];
type AgentLifecycleRow = typeof agentLifecycle.$inferSelect;
type AgentLifecycleOperationRow = typeof agentLifecycleOperations.$inferSelect;
type CommittedOutcome = Extract<CommitOutcome, { kind: "committed" }>;

/**
 * A lifecycle operation is no longer the one its agent's `agent_lifecycle` row is currently
 * pursuing (a later request superseded it: `operationId`, and the `generation` it was issued for,
 * have both moved on). A stale worker's own `markProvisioning`/`completeOperation`/`failOperation`
 * call is refused this way rather than silently applied to a request nobody is waiting on anymore.
 */
export class StaleLifecycleOperationError extends Error {
	constructor(readonly operationId: string) {
		super(`lifecycle operation '${operationId}' is no longer its agent's current operation`);
		this.name = "StaleLifecycleOperationError";
	}
}

/** The three surfaces a lifecycle request can come from, mapped to the configuration journal's
 * own, longer-standing vocabulary (ADR-024): `cli` commits as `cli_apply`, the same source
 * `gateway agent enable|disable` already uses; `console`/`agent` are identical in both. */
function configRevisionSourceOf(source: AgentLifecycleSource): ConfigRevisionSource {
	return source === "cli" ? "cli_apply" : source;
}

/** Adapters with at least one fresh, ready worker: "installed and qualified on this deployment"
 * (`runtime_workers`, migration 0007 / `runtime-health.ts`), read inside the caller's own
 * transaction rather than through `runtimeHealth`'s own pooled transaction. */
async function readyRuntimeAdapters(db: Db, now: Date): Promise<ReadonlySet<RuntimeAdapterId>> {
	const rows = await db
		.select({ adapter: runtimeWorkers.adapter, status: runtimeWorkers.status })
		.from(runtimeWorkers)
		.where(gt(runtimeWorkers.lastSeenAt, new Date(now.getTime() - WORKER_STALE_MS)));
	return new Set(rows.filter((row) => row.status === "ready").map((row) => row.adapter));
}

const DEFAULT_CREATE_ADAPTER: RuntimeAdapterId = "codex";
const DEFAULT_CREATE_SESSION_POLICY = "resumable-if-available" as const;
const DEFAULT_CREATE_TIMEOUT_SECONDS = 1800;

/**
 * The runtime a new agent gets when `input` leaves fields unset: the deployment's Codex settings.
 * `adapter` defaults to `codex`; `model` then defaults to the one model every enabled Codex agent
 * in `existingAgents` already shares (`undefined` when none do, or they disagree — the runtime
 * adapter's own default model applies, exactly as an existing agent's own unset `model` already
 * behaves). `profile`/`session_policy`/`timeout_seconds` default the same way regardless of
 * adapter. An explicit `input.adapter` other than `codex` never looks at existing agents' models.
 * Pure and deterministic: `requestAgentCreate` validates the result's availability separately.
 */
export function resolveCreateRuntime(
	existingAgents: Readonly<AgentConfig[]>,
	input: AgentCreateInput["runtime"],
): AgentConfig["runtime"] {
	const adapter = input?.adapter ?? DEFAULT_CREATE_ADAPTER;
	const profile = input?.profile ?? "default";
	const session_policy = input?.session_policy ?? DEFAULT_CREATE_SESSION_POLICY;
	const timeout_seconds = input?.timeout_seconds ?? DEFAULT_CREATE_TIMEOUT_SECONDS;
	let model = input?.model;
	if (model === undefined && adapter === "codex") {
		const codexModels = new Set(
			existingAgents
				.filter((agent) => agent.enabled && agent.runtime.adapter === "codex")
				.map((agent) => agent.runtime.model)
				.filter((value): value is string => value !== undefined),
		);
		model = codexModels.size === 1 ? [...codexModels][0] : undefined;
	}
	return model === undefined
		? { adapter, profile, session_policy, timeout_seconds }
		: { adapter, profile, session_policy, timeout_seconds, model };
}

/**
 * The bot token file a lifecycle-created agent gets when its create request leaves
 * `mattermost.token_secret_file` unset: `/run/bot-secrets/mm_<id>_token`, the agent id's hyphens
 * replaced by underscores (`SecretFileSchema` allows only `[a-z0-9_]` after the mount). Clients
 * never choose this path (see `AgentCreateMattermostInputSchema`); the controller's own
 * provisioner is the only writer of the file it names, in the read-write directory the controller
 * mounts for exactly this (ADR-026) — distinct from the read-only `/run/secrets/` an operator
 * manages for bootstrap-created agents.
 */
export function defaultBotSecretFile(agentId: AgentId): SecretFile {
	return `/run/bot-secrets/mm_${agentId.replace(/-/g, "_")}_token`;
}

/** Attempts a lifecycle request's own configuration commit may need: see `commitWithinLock`. */
const MAX_LIFECYCLE_COMMIT_ATTEMPTS = 2;

/**
 * Commits `changeSet` through {@link commitChangeIn}, in the caller's already-open `uow` and under
 * the `gateway_controls` lock it already holds. A true conflict — another transaction moving the
 * active revision — cannot happen while that lock is held; the only way `commitChangeIn` still
 * reports one is its own internal backfill discovering, on its very first commit since, a drift
 * that predates this transaction entirely (see `ensureConfigHistoryIn`). Retrying once more
 * against the revision it just recorded always succeeds, since nothing else can move it for the
 * rest of this transaction.
 */
async function commitWithinLock(
	uow: UnitOfWork,
	baseRevisionId: number | null,
	changeSet: ChangeSet,
	actor: string,
	source: ConfigRevisionSource,
	reason?: string,
	/** `requestAgentCreate`'s own agent id: trusted to claim `/run/bot-secrets/` even though its
	 * `agent_lifecycle` row does not exist yet this same transaction (see `commitChangeIn`). */
	trustedBotSecretAgentIds?: ReadonlySet<AgentId>,
): Promise<CommittedOutcome> {
	let base = baseRevisionId;
	for (let attempt = 1; attempt <= MAX_LIFECYCLE_COMMIT_ATTEMPTS; attempt += 1) {
		const outcome = await commitChangeIn(
			uow,
			{
				changeSet,
				baseRevisionId: base,
				actor,
				source,
				...(reason === undefined ? {} : { reason }),
			},
			changeSet,
			trustedBotSecretAgentIds,
		);
		if (outcome.kind === "committed") {
			return outcome;
		}
		base = outcome.currentRevisionId;
	}
	throw new ManagementConflictError(base);
}

/** A `z.strictObject(...).safeParse(input)` result, refused as `AdminError` rather than left as a
 * raw `ZodError` — every other validation failure in this service surfaces the same way. */
function parseOrRefuse<T>(result: z.ZodSafeParseResult<T>, what: string): T {
	if (result.success) {
		return result.data;
	}
	throw new AdminError(
		`${what} is invalid:\n- ${result.error.issues
			.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
			.join("\n- ")}`,
	);
}

async function lockGatewayControls(db: Db): Promise<number | null> {
	await db.insert(gatewayControls).values({ id: 1 }).onConflictDoNothing();
	const [controls] = await db
		.select({ revision: gatewayControls.activeConfigRevision })
		.from(gatewayControls)
		.where(eq(gatewayControls.id, 1))
		.for("update");
	return controls?.revision ?? null;
}

/**
 * Cancels every `pending`/`running` operation `agentId` still has, right before a new operation
 * replaces `agent_lifecycle.operation_id`: a create or restore that never finished provisioning
 * would otherwise be stranded exactly where it was, forever matching `listRunningLifecycleOperations`
 * (if `running`) although nothing its agent's lifecycle row does from here on is ever waiting on it
 * again. Called with the agent's own `agent_lifecycle` row already locked (`for("update")`) by the
 * caller, so lock order stays `gateway_controls` -> lifecycle row -> operation rows throughout.
 */
async function cancelNonterminalOperations(db: Db, agentId: AgentId, now: Date): Promise<void> {
	await db
		.update(agentLifecycleOperations)
		.set({ state: "cancelled", updatedAt: now, finishedAt: now })
		.where(
			and(
				eq(agentLifecycleOperations.agentId, agentId),
				inArray(agentLifecycleOperations.state, ["pending", "running"]),
			),
		);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type RequestAgentCreateResult = Readonly<{
	operationId: string;
	agentId: AgentId;
	revisionId: number;
}>;

/**
 * Creates a new agent: validates the request, then, in one transaction, commits an `add_agent`
 * change set (`enabled: true`) and records the agent as `pending` with a `create` operation
 * `pending` — a failure anywhere in that transaction (an invalid configuration, a stale backfill
 * that still cannot resolve, a duplicate id discovered under the lock) rolls back both the
 * configuration change and the lifecycle rows together. No Mattermost call is made here; actually
 * provisioning the agent's bot is later work, which resumes through `markProvisioning` and
 * completes through `completeOperation`/`failOperation` using the operation id this returns.
 *
 * Refused, before anything is written: the agent id already exists in `agent_lifecycle` in any
 * status, including `retired` (ids are never reused); the Mattermost username is already used by
 * another agent's identity (adopted or not); the resolved runtime adapter has no fresh, ready
 * worker on this deployment. A repeat with the same `idempotencyKey` replays the first call's
 * result instead of re-validating.
 */
export async function requestAgentCreate(
	deps: ControlPlaneDeps,
	input: RequestAgentCreateInput,
): Promise<RequestAgentCreateResult> {
	const parsed = parseOrRefuse(
		RequestAgentCreateInputSchema.safeParse(input),
		"agent create request",
	);
	return inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		const baseRevisionId = await lockGatewayControls(db);

		if (parsed.idempotencyKey !== undefined) {
			const [existing] = await db
				.select()
				.from(agentLifecycleOperations)
				.where(eq(agentLifecycleOperations.idempotencyKey, parsed.idempotencyKey));
			if (existing !== undefined) {
				if (existing.kind !== "create" || existing.agentId !== parsed.agent.id) {
					throw new AdminError(
						`idempotency key '${parsed.idempotencyKey}' was already used for a different request`,
					);
				}
				if (existing.configRevisionId === null) {
					throw new AdminError(`operation '${existing.id}' has no recorded configuration revision`);
				}
				return {
					operationId: existing.id,
					agentId: existing.agentId,
					revisionId: existing.configRevisionId,
				};
			}
		}

		const [existingLifecycle] = await db
			.select({ status: agentLifecycle.status })
			.from(agentLifecycle)
			.where(eq(agentLifecycle.agentId, parsed.agent.id));
		if (existingLifecycle !== undefined) {
			throw new AdminError(
				`agent id '${parsed.agent.id}' was already created (status '${existingLifecycle.status}'); agent ids are never reused`,
			);
		}

		const [existingIdentity] = await db
			.select({ agentId: mattermostIdentities.agentId })
			.from(mattermostIdentities)
			.where(eq(mattermostIdentities.username, parsed.agent.mattermost.username));
		if (existingIdentity !== undefined) {
			throw new AdminError(
				`Mattermost username '${parsed.agent.mattermost.username}' is already used by agent '${existingIdentity.agentId}'`,
			);
		}

		const { bundle: base } = await loadActiveBundle(db, baseRevisionId);
		const runtime = resolveCreateRuntime(base.agents, parsed.agent.runtime);
		const ready = await readyRuntimeAdapters(db, uow.now);
		if (!ready.has(runtime.adapter)) {
			throw new AdminError(
				`runtime adapter '${runtime.adapter}' is not installed and qualified on this deployment`,
			);
		}

		// Never a client's choice (`AgentCreateMattermostInputSchema` already drops the field): a
		// lifecycle-created agent's bot token path is always this one, generated server-side.
		const mattermost: AgentConfig["mattermost"] = {
			...parsed.agent.mattermost,
			token_secret_file: defaultBotSecretFile(parsed.agent.id),
		};
		const permissions: AgentConfig["permissions"] =
			parsed.agent.permissions ??
			defaultAgentPermissions(
				parsed.agent.id,
				base.organization?.organization.finance_agent_id ?? null,
			);
		const agent: AgentConfig = {
			...parsed.agent,
			schema_version: 1,
			enabled: true,
			runtime,
			mattermost,
			permissions,
		};
		const changeSet: ChangeSet = [{ type: "add_agent", agent, rolePrompt: parsed.rolePrompt }];
		const commit = await commitWithinLock(
			uow,
			baseRevisionId,
			changeSet,
			parsed.actor,
			configRevisionSourceOf(parsed.source),
			undefined,
			new Set([agent.id]),
		);

		const operationId = randomUUID();
		// `agents.id` (and so `agent_lifecycle.agent_id`'s own foreign key) already exists: the
		// commit above upserted it as part of writing the `add_agent` revision.
		await db.insert(agentLifecycle).values({
			agentId: agent.id,
			status: "pending",
			generation: 1,
			operationId,
			statusChangedAt: uow.now,
			createdAt: uow.now,
		});
		await db.insert(agentLifecycleOperations).values({
			id: operationId,
			agentId: agent.id,
			kind: "create",
			requestedBy: parsed.actor,
			source: parsed.source,
			idempotencyKey: parsed.idempotencyKey ?? null,
			configRevisionId: commit.result.revisionId,
			generation: 1,
			state: "pending",
			checkpoints: {},
			createdAt: uow.now,
			updatedAt: uow.now,
		});
		await audit(uow, parsed.actor, "agent_lifecycle.create", "agent", agent.id, {
			operation_id: operationId,
			revision_id: commit.result.revisionId,
		});
		return { operationId, agentId: agent.id, revisionId: commit.result.revisionId };
	});
}

// ---------------------------------------------------------------------------
// Retire
// ---------------------------------------------------------------------------

export type RequestAgentRetireResult = Readonly<{
	operationId: string;
	agentId: AgentId;
	revisionId: number;
	/** pg-boss jobs an active run's own cancellation made obsolete (the same convention
	 * `pauseAgent`/`killAll` use): the worker already stops a cancelled run's turn on its own
	 * (`agent_runs.status`), so a caller cancelling these too is an optimization, never a
	 * correctness requirement. Empty when the agent had no active run to cancel. */
	cancelledJobs: Readonly<CancelledJob[]>;
}>;

/**
 * Retires an agent: the retired agent can never act again. In one transaction: a run in progress
 * is cancelled first (the same cancellation `pauseAgent` performs — the state machine only allows
 * `disable` from `idle`/`waiting`/`failed`/`paused`, never `queued`/`running`); a `remove_agent`
 * change set is committed (which, through the same path any agent leaving the configuration
 * already takes, cancels its waits and withdraws its pending approvals, queued tool actions and
 * running tool actions' own cancellation request); every channel it was ever granted is
 * tombstoned (ADR-022); its own pending outbox deliveries are blocked, never sent as a retired
 * agent; and the lifecycle row moves to `retiring` with a `retire` operation `pending`, for the
 * provisioner to resume and complete through `markProvisioning`/`completeOperation`/
 * `failOperation` (deactivating the bot, revoking its tokens, leaving its channels).
 *
 * Refused, before anything is written, when `agentId` is the organization's own
 * `finance_agent_id` and the request does not also name `reassignFinanceTo` (a different,
 * currently configured agent): retiring the finance agent would otherwise leave the configuration
 * naming one that no longer exists. When given, the reassignment commits as a `set_finance_agent`
 * operation in the very same change set.
 *
 * Kept, by design: audit entries, identity rows, run history and already-sent messages. Left to
 * the existing retention to expire on its own schedule: the agent's private memory, now
 * unreadable (no turn can load it, and it is excluded from memory listings) but not deleted here —
 * shared memory it wrote and that was accepted stays, organization-owned.
 */
export async function requestAgentRetire(
	deps: ControlPlaneDeps,
	input: RequestAgentRetireInput,
): Promise<RequestAgentRetireResult> {
	const parsed = parseOrRefuse(
		RequestAgentRetireInputSchema.safeParse(input),
		"agent retire request",
	);
	const result = await inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		const baseRevisionId = await lockGatewayControls(db);

		if (parsed.idempotencyKey !== undefined) {
			const [existing] = await db
				.select()
				.from(agentLifecycleOperations)
				.where(eq(agentLifecycleOperations.idempotencyKey, parsed.idempotencyKey));
			if (existing !== undefined) {
				if (existing.kind !== "retire" || existing.agentId !== parsed.agentId) {
					throw new AdminError(
						`idempotency key '${parsed.idempotencyKey}' was already used for a different request`,
					);
				}
				if (existing.configRevisionId === null) {
					throw new AdminError(`operation '${existing.id}' has no recorded configuration revision`);
				}
				return {
					operationId: existing.id,
					agentId: existing.agentId,
					revisionId: existing.configRevisionId,
					cancelledJobs: [],
				};
			}
		}

		const [lifecycle] = await db
			.select()
			.from(agentLifecycle)
			.where(eq(agentLifecycle.agentId, parsed.agentId))
			.for("update");
		if (lifecycle === undefined) {
			throw new AdminError(`agent '${parsed.agentId}' has no lifecycle record`);
		}
		if (lifecycle.status === "retiring" || lifecycle.status === "retired") {
			throw new AdminError(`agent '${parsed.agentId}' is already '${lifecycle.status}'`);
		}

		const { bundle: base } = await loadActiveBundle(db, baseRevisionId);
		const financeAgentId = base.organization?.organization.finance_agent_id ?? null;
		const changeSet: ChangeSet = [{ type: "remove_agent", agentId: parsed.agentId }];
		if (financeAgentId === parsed.agentId) {
			if (parsed.reassignFinanceTo === undefined) {
				throw new AdminError(
					`agent '${parsed.agentId}' is the organization's finance agent; retiring it requires ` +
						"reassignFinanceTo naming another agent",
				);
			}
			if (parsed.reassignFinanceTo === parsed.agentId) {
				throw new AdminError("reassignFinanceTo must name a different agent");
			}
			if (!base.agents.some((agent) => agent.id === parsed.reassignFinanceTo)) {
				throw new AdminError(
					`reassignFinanceTo '${parsed.reassignFinanceTo}' is not a configured agent`,
				);
			}
			changeSet.push({ type: "set_finance_agent", agentId: parsed.reassignFinanceTo });
		} else if (parsed.reassignFinanceTo !== undefined) {
			throw new AdminError(
				`agent '${parsed.agentId}' is not the organization's finance agent; reassignFinanceTo must not be given`,
			);
		}

		// A run in progress is cancelled first, exactly like `pauseAgent`: the state machine only
		// allows `disable` (which the commit below drives, for any agent leaving the configuration)
		// from `idle`/`waiting`/`failed`/`paused`, never from `queued`/`running`.
		const agentRow = await lockAgent(db, parsed.agentId);
		const cancelledJobs =
			agentRow !== null && (agentRow.state === "queued" || agentRow.state === "running")
				? await pauseInTransaction(
						uow,
						parsed.agentId,
						parsed.actor,
						`agent '${parsed.agentId}' retired by ${parsed.actor}`,
					)
				: [];

		const commit = await commitWithinLock(
			uow,
			baseRevisionId,
			changeSet,
			parsed.actor,
			configRevisionSourceOf(parsed.source),
			parsed.reason,
		);

		// Every channel it was ever granted directly (ADR-022) is tombstoned: a retired agent can
		// never act again through one nobody thought to revoke by hand, and re-adding its bot to the
		// same channel later must never silently re-grant it.
		const revokedChannelIds = await revokeAllActiveGrantsIn(
			uow,
			parsed.agentId,
			`agent_retired:${parsed.agentId}`,
		);
		if (revokedChannelIds.length > 0) {
			await audit(uow, parsed.actor, "agent_lifecycle.grants_revoked", "agent", parsed.agentId, {
				channel_ids: [...revokedChannelIds],
			});
		}

		// Its own pending deliveries never go out as a retired agent: blocked here, rather than left
		// to fail or expire on their own schedule.
		const cancelledOutbox = await uow.tx.client.query(
			`update outbox
			    set status = 'cancelled', last_error_redacted = 'agent_retired'
			  where status in ('pending', 'sending')
			    and run_id in (select id from agent_runs where agent_id = $1)`,
			[parsed.agentId],
		);
		if ((cancelledOutbox.rowCount ?? 0) > 0) {
			await audit(uow, parsed.actor, "agent_lifecycle.outbox_cancelled", "agent", parsed.agentId, {
				count: cancelledOutbox.rowCount,
			});
		}

		// A create or restore still `pending`/`running` is superseded by this retire: it would
		// otherwise be stranded there forever once `operation_id` below moves past it.
		await cancelNonterminalOperations(db, parsed.agentId, uow.now);

		const operationId = randomUUID();
		const generation = lifecycle.generation + 1;
		await db.insert(agentLifecycleOperations).values({
			id: operationId,
			agentId: parsed.agentId,
			kind: "retire",
			requestedBy: parsed.actor,
			source: parsed.source,
			idempotencyKey: parsed.idempotencyKey ?? null,
			configRevisionId: commit.result.revisionId,
			generation,
			state: "pending",
			checkpoints: {},
			createdAt: uow.now,
			updatedAt: uow.now,
		});
		await db
			.update(agentLifecycle)
			.set({ status: "retiring", generation, operationId, statusChangedAt: uow.now })
			.where(eq(agentLifecycle.agentId, parsed.agentId));
		await audit(uow, parsed.actor, "agent_lifecycle.retire", "agent", parsed.agentId, {
			operation_id: operationId,
			revision_id: commit.result.revisionId,
		});
		return {
			operationId,
			agentId: parsed.agentId,
			revisionId: commit.result.revisionId,
			cancelledJobs,
		};
	});
	// Outside the transaction, like `killAll`'s own: the agent's approval cards are updated
	// (`sweepApprovals` posts "withdrawn" for whatever the commit above just cancelled) without
	// waiting for the periodic sweep.
	await sweepApprovals(deps).catch((error: unknown) => {
		deps.log.warn("approvals not resolved after a retire; the sweep retries", {
			error_message: error instanceof Error ? error.message : String(error),
		});
	});
	return result;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export type RequestAgentRestoreResult = Readonly<{
	operationId: string;
	agentId: AgentId;
	revisionId: number;
}>;

/**
 * The most recent recorded revision whose snapshot still names `agentId`, and that agent's own
 * definition and role prompt within it — searched with a jsonb containment check rather than
 * loaded and scanned bundle by bundle in application code, since the journal can be long. Null
 * when no recorded snapshot ever configured this agent (should not happen for an agent that was
 * ever `retiring`, whose own `remove_agent` commit is itself such a snapshot's parent — but an
 * upgrade from a release before configuration history existed may have lost it; see ADR-024), or
 * a found snapshot no longer parses (`ConfigSnapshotBundleSchema`).
 */
async function findLastConfiguredAgent(
	uow: UnitOfWork,
	agentId: string,
): Promise<Readonly<{ agent: AgentConfig; rolePrompt: string }> | null> {
	const result = await uow.tx.client.query<{ bundle: unknown }>(
		`select s.bundle
		   from config_revisions r
		   join config_snapshots s on s.hash = r.snapshot_hash
		  where s.bundle -> 'agents' @> $1::jsonb
		  order by r.id desc
		  limit 1`,
		[JSON.stringify([{ id: agentId }])],
	);
	const row = result.rows[0];
	if (row === undefined) {
		return null;
	}
	const parsed = ConfigSnapshotBundleSchema.safeParse(row.bundle);
	if (!parsed.success) {
		return null;
	}
	const agent = parsed.data.agents.find((candidate) => candidate.id === agentId);
	const rolePrompt = parsed.data.rolePrompts[agentId];
	return agent === undefined || rolePrompt === undefined ? null : { agent, rolePrompt };
}

/**
 * Restores a retired agent: re-adds its configuration from the last recorded snapshot that still
 * had it (re-enabled), moving the lifecycle row from `retired` back to `pending` with a `restore`
 * operation, in one transaction with the configuration commit exactly like `requestAgentCreate`.
 * Refused when the agent is not `retired`, or when no historical configuration for it is still
 * available (see `findLastConfiguredAgent`).
 */
export async function requestAgentRestore(
	deps: ControlPlaneDeps,
	input: RequestAgentRestoreInput,
): Promise<RequestAgentRestoreResult> {
	const parsed = parseOrRefuse(
		RequestAgentRestoreInputSchema.safeParse(input),
		"agent restore request",
	);
	return inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		const baseRevisionId = await lockGatewayControls(db);

		if (parsed.idempotencyKey !== undefined) {
			const [existing] = await db
				.select()
				.from(agentLifecycleOperations)
				.where(eq(agentLifecycleOperations.idempotencyKey, parsed.idempotencyKey));
			if (existing !== undefined) {
				if (existing.kind !== "restore" || existing.agentId !== parsed.agentId) {
					throw new AdminError(
						`idempotency key '${parsed.idempotencyKey}' was already used for a different request`,
					);
				}
				if (existing.configRevisionId === null) {
					throw new AdminError(`operation '${existing.id}' has no recorded configuration revision`);
				}
				return {
					operationId: existing.id,
					agentId: existing.agentId,
					revisionId: existing.configRevisionId,
				};
			}
		}

		const [lifecycle] = await db
			.select()
			.from(agentLifecycle)
			.where(eq(agentLifecycle.agentId, parsed.agentId))
			.for("update");
		if (lifecycle === undefined) {
			throw new AdminError(`agent '${parsed.agentId}' has no lifecycle record`);
		}
		if (lifecycle.status !== "retired") {
			throw new AdminError(`agent '${parsed.agentId}' is '${lifecycle.status}', not retired`);
		}

		const historical = await findLastConfiguredAgent(uow, parsed.agentId);
		if (historical === null) {
			throw new AdminError(
				`no historical configuration is still available for agent '${parsed.agentId}'`,
			);
		}

		const agent: AgentConfig = { ...historical.agent, enabled: true };
		const changeSet: ChangeSet = [{ type: "add_agent", agent, rolePrompt: historical.rolePrompt }];
		const commit = await commitWithinLock(
			uow,
			baseRevisionId,
			changeSet,
			parsed.actor,
			configRevisionSourceOf(parsed.source),
		);

		// Defensive, like `requestAgentRetire`'s own call: a `retired` agent's last operation (its
		// own `retire`) is already terminal in every reachable state, but a new operation supersedes
		// whatever came before it here too, so nothing stays `pending`/`running` behind it.
		await cancelNonterminalOperations(db, parsed.agentId, uow.now);

		const operationId = randomUUID();
		const generation = lifecycle.generation + 1;
		await db.insert(agentLifecycleOperations).values({
			id: operationId,
			agentId: parsed.agentId,
			kind: "restore",
			requestedBy: parsed.actor,
			source: parsed.source,
			idempotencyKey: parsed.idempotencyKey ?? null,
			configRevisionId: commit.result.revisionId,
			generation,
			state: "pending",
			checkpoints: {},
			createdAt: uow.now,
			updatedAt: uow.now,
		});
		await db
			.update(agentLifecycle)
			.set({
				status: "pending",
				generation,
				operationId,
				statusChangedAt: uow.now,
				retiredAt: null,
			})
			.where(eq(agentLifecycle.agentId, parsed.agentId));
		await audit(uow, parsed.actor, "agent_lifecycle.restore", "agent", parsed.agentId, {
			operation_id: operationId,
			revision_id: commit.result.revisionId,
		});
		return { operationId, agentId: parsed.agentId, revisionId: commit.result.revisionId };
	});
}

// ---------------------------------------------------------------------------
// Operation state machine: markProvisioning / completeOperation / failOperation
// ---------------------------------------------------------------------------

/**
 * Locks the agent's lifecycle row, then the operation row — the same order every other writer
 * here takes (`gateway_controls` if held, then the lifecycle row, then operation rows):
 * `requestAgentRetire`/`requestAgentRestore` already lock the lifecycle row before
 * `cancelNonterminalOperations` touches operation rows, and this function used to lock the
 * operation first instead, which could deadlock (Postgres 40P01) against a concurrent retire of
 * the same agent. The initial, unlocked lookup only finds which agent's lifecycle row to lock
 * first; the operation itself is locked and rechecked afterwards. Refuses a stale call: one whose
 * operation is no longer the one its agent's lifecycle row is currently pursuing, by id and by the
 * generation it was issued for alike.
 */
async function lockCurrentOperation(
	db: Db,
	operationId: string,
): Promise<Readonly<{ operation: AgentLifecycleOperationRow; lifecycle: AgentLifecycleRow }>> {
	const [found] = await db
		.select({ agentId: agentLifecycleOperations.agentId })
		.from(agentLifecycleOperations)
		.where(eq(agentLifecycleOperations.id, operationId));
	if (found === undefined) {
		throw new AdminError(`lifecycle operation '${operationId}' does not exist`);
	}
	const [lifecycle] = await db
		.select()
		.from(agentLifecycle)
		.where(eq(agentLifecycle.agentId, found.agentId))
		.for("update");
	if (lifecycle === undefined) {
		throw new AdminError(`agent '${found.agentId}' has no lifecycle record`);
	}
	const [operation] = await db
		.select()
		.from(agentLifecycleOperations)
		.where(eq(agentLifecycleOperations.id, operationId))
		.for("update");
	if (operation === undefined) {
		throw new AdminError(`lifecycle operation '${operationId}' does not exist`);
	}
	if (lifecycle.operationId !== operation.id || lifecycle.generation !== operation.generation) {
		throw new StaleLifecycleOperationError(operationId);
	}
	return { operation, lifecycle };
}

function isTerminalOperationState(state: AgentLifecycleOperationRow["state"]): boolean {
	return state === "succeeded" || state === "failed" || state === "cancelled";
}

/** The lifecycle status an operation's kind settles on once it succeeds. */
function readyStatusOf(kind: AgentLifecycleOperationKind): AgentLifecycleStatus {
	return kind === "retire" ? "retired" : "ready";
}

/**
 * Marks a `pending` operation `running` and its agent `reconciling` (a `retire` operation leaves
 * the agent `retiring`, already set by `requestAgentRetire`; a `reprovision` operation — queued for
 * a committed membership change alone, ADR-026 — leaves it `ready`: reconciling a lifecycle-owned
 * agent's channels never makes it unschedulable). Refused for an operation that is not its agent's
 * current one (superseded), or not `pending`.
 */
export async function markProvisioning(
	deps: ControlPlaneDeps,
	operationId: string,
	actor: string,
): Promise<void> {
	await inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		const { operation } = await lockCurrentOperation(db, operationId);
		if (operation.state !== "pending") {
			throw new AdminError(
				`lifecycle operation '${operationId}' is '${operation.state}', not pending`,
			);
		}
		await db
			.update(agentLifecycleOperations)
			.set({ state: "running", updatedAt: uow.now })
			.where(eq(agentLifecycleOperations.id, operationId));
		if (operation.kind !== "retire" && operation.kind !== "reprovision") {
			await db
				.update(agentLifecycle)
				.set({ status: "reconciling", statusChangedAt: uow.now })
				.where(eq(agentLifecycle.agentId, operation.agentId));
		}
		await audit(uow, actor, "agent_lifecycle.provisioning", "agent", operation.agentId, {
			operation_id: operationId,
		});
	});
}

/**
 * Merges `checkpoints` into a `running` operation's own, without changing its state: the
 * provisioner's own record of one external step it just completed, written right after that step
 * and before the next one — never inside the same transaction as the Mattermost call that step
 * made — so a crash is resumed from exactly where it left off (ADR-026). Refused for a stale
 * operation (superseded) or one that is not `running`, like every other writer of this row.
 */
export async function checkpointOperation(
	deps: ControlPlaneDeps,
	operationId: string,
	checkpoints: AgentLifecycleCheckpoints,
): Promise<void> {
	await inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		const { operation } = await lockCurrentOperation(db, operationId);
		if (operation.state !== "running") {
			throw new AdminError(
				`lifecycle operation '${operationId}' is '${operation.state}', not running`,
			);
		}
		await db
			.update(agentLifecycleOperations)
			.set({ checkpoints: { ...operation.checkpoints, ...checkpoints }, updatedAt: uow.now })
			.where(eq(agentLifecycleOperations.id, operationId));
	});
}

/**
 * Marks an operation `succeeded` and its agent `ready` (`retired` for a `retire` operation),
 * clearing `last_error`, and wakes the agent (`scheduleAgent`) so inbox work that arrived while it
 * was not yet ready runs without waiting for the periodic sweep. Refused for a stale or already
 * terminal operation.
 */
export async function completeOperation(
	deps: ControlPlaneDeps,
	operationId: string,
	actor: string,
	checkpoints?: AgentLifecycleCheckpoints,
): Promise<void> {
	await inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		const { operation, lifecycle } = await lockCurrentOperation(db, operationId);
		if (isTerminalOperationState(operation.state)) {
			throw new AdminError(`lifecycle operation '${operationId}' is already '${operation.state}'`);
		}
		await db
			.update(agentLifecycleOperations)
			.set({
				state: "succeeded",
				checkpoints: checkpoints ?? operation.checkpoints,
				updatedAt: uow.now,
				finishedAt: uow.now,
			})
			.where(eq(agentLifecycleOperations.id, operationId));
		const status = readyStatusOf(operation.kind);
		await db
			.update(agentLifecycle)
			.set({
				status,
				statusChangedAt: uow.now,
				lastError: null,
				retiredAt: status === "retired" ? uow.now : lifecycle.retiredAt,
			})
			.where(eq(agentLifecycle.agentId, operation.agentId));
		await audit(uow, actor, "agent_lifecycle.completed", "agent", operation.agentId, {
			operation_id: operationId,
			kind: operation.kind,
		});
		if (status === "ready") {
			await scheduleAgent(uow, operation.agentId);
		}
	});
}

/** Bounded, like every other stored lifecycle error (see `AgentLifecycleErrorSchema`). */
const MAX_LIFECYCLE_ERROR_LENGTH = 2000;

/**
 * Marks an operation `failed`, recording `error` on it and on its agent's `agent_lifecycle` row.
 * `error` is redacted (`redactForStorage`, the same helper runtime-health and approval failures
 * already use) before it is bounded and persisted: a provisioner's own error text may quote a
 * request or response that still carries a credential. The agent itself moves to `failed` — except
 * for a `retire` operation, which leaves it `retiring`: a retired agent's desired state never
 * changes because its cleanup hit a permanent snag, and `retiring` is what names the specific
 * attention it still needs (resume the cleanup by hand, or fix the underlying Mattermost problem),
 * never the generic `failed` a stuck `create`/`restore`/`reprovision` already means. Refused for a
 * stale or already terminal operation.
 */
export async function failOperation(
	deps: ControlPlaneDeps,
	operationId: string,
	actor: string,
	error: string,
): Promise<void> {
	const bounded = redactForStorage(error, MAX_LIFECYCLE_ERROR_LENGTH);
	await inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		const { operation } = await lockCurrentOperation(db, operationId);
		if (isTerminalOperationState(operation.state)) {
			throw new AdminError(`lifecycle operation '${operationId}' is already '${operation.state}'`);
		}
		await db
			.update(agentLifecycleOperations)
			.set({ state: "failed", error: bounded, updatedAt: uow.now, finishedAt: uow.now })
			.where(eq(agentLifecycleOperations.id, operationId));
		const status: AgentLifecycleStatus = operation.kind === "retire" ? "retiring" : "failed";
		await db
			.update(agentLifecycle)
			.set({ status, statusChangedAt: uow.now, lastError: bounded })
			.where(eq(agentLifecycle.agentId, operation.agentId));
		await audit(uow, actor, "agent_lifecycle.failed", "agent", operation.agentId, {
			operation_id: operationId,
			kind: operation.kind,
		});
	});
}

/**
 * Operations still `running`: a controller restarting resumes exactly these, since a provisioner
 * that was midway through one when the process died leaves it here rather than `pending` or
 * terminal.
 */
export async function listRunningLifecycleOperations(
	deps: ControlPlaneDeps,
): Promise<Readonly<AgentLifecycleOperationRow[]>> {
	return inTransaction(deps, ({ tx }) =>
		tx.db
			.select()
			.from(agentLifecycleOperations)
			.where(eq(agentLifecycleOperations.state, "running"))
			.orderBy(asc(agentLifecycleOperations.createdAt)),
	);
}

/**
 * Operations of `kinds` still `pending`, oldest first: new work a provisioner has not started yet
 * (`listRunningLifecycleOperations` is its own counterpart for resuming work interrupted mid-way).
 * Restricted to `kinds` because not every operation that is ever `pending` is that provisioner's
 * to pursue — a Mattermost provisioner takes `create`/`restore`/`reprovision`, never `retire`
 * (whose cleanup is other work's own) or `adopt` (written only `succeeded`, by the startup
 * backfill, never left `pending`).
 */
export async function listPendingLifecycleOperations(
	deps: ControlPlaneDeps,
	kinds: Readonly<AgentLifecycleOperationKind[]>,
): Promise<Readonly<AgentLifecycleOperationRow[]>> {
	return inTransaction(deps, ({ tx }) =>
		tx.db
			.select()
			.from(agentLifecycleOperations)
			.where(
				and(
					eq(agentLifecycleOperations.state, "pending"),
					inArray(agentLifecycleOperations.kind, kinds),
				),
			)
			.orderBy(asc(agentLifecycleOperations.createdAt)),
	);
}

/** Bounds `gateway agents operations`' own listing; the journal itself keeps every row. */
const MAX_LISTED_OPERATIONS = 100;

/**
 * Lifecycle operations, newest first, for an owner to read (`gateway agents operations`):
 * every kind and state, not only what a provisioner still has to act on. Scoped to `agentId` when
 * given.
 */
export async function listLifecycleOperations(
	deps: ControlPlaneDeps,
	agentId?: AgentId,
): Promise<Readonly<AgentLifecycleOperation[]>> {
	const rows = await inTransaction(deps, ({ tx }) =>
		tx.db
			.select()
			.from(agentLifecycleOperations)
			.where(agentId === undefined ? undefined : eq(agentLifecycleOperations.agentId, agentId))
			.orderBy(desc(agentLifecycleOperations.createdAt))
			.limit(MAX_LISTED_OPERATIONS),
	);
	return rows.map((row) => ({
		id: row.id,
		agentId: row.agentId,
		kind: row.kind,
		requestedBy: row.requestedBy,
		source: row.source,
		idempotencyKey: row.idempotencyKey,
		configRevisionId: row.configRevisionId,
		generation: row.generation,
		state: row.state,
		checkpoints: row.checkpoints,
		error: row.error,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
	}));
}

/**
 * Every agent id created or restored through the lifecycle (see {@link lifecycleOwnedAgentIds}):
 * `mattermostPlan`'s caller uses this to decide which agents `gateway mattermost
 * bootstrap`/`reconcile` leave entirely to the lifecycle provisioner (ADR-026) — the database,
 * never a `token_secret_file` prefix, is lifecycle ownership's one source of truth.
 */
export async function loadLifecycleOwnedAgentIds(
	deps: ControlPlaneDeps,
): Promise<ReadonlySet<AgentId>> {
	return inTransaction(deps, ({ tx }) => lifecycleOwnedAgentIds(tx.db));
}

// ---------------------------------------------------------------------------
// Adoption backfill
// ---------------------------------------------------------------------------

/**
 * Adopts every agent in the active configuration snapshot that has no `agent_lifecycle` row yet:
 * `ready` when bootstrap already resolved its Mattermost identity (`mattermost_identities.mattermost_user_id`
 * is set), `pending` otherwise — each with a `succeeded` `adopt` operation recording the active
 * revision at adoption time. Idempotent and safe to call at every controller/CLI startup, exactly
 * like `ensureConfigHistory`: an agent already adopted (including one later retired) is left
 * untouched, and a database with no active configuration at all does nothing.
 *
 * Takes the same `gateway_controls` row lock `commitChangeIn` takes (inserting the row first if
 * missing), and backfills configuration history under it exactly like `ensureConfigHistory` does,
 * before reading the active revision or any existing lifecycle row: two controllers or CLI
 * sessions adopting at the same startup serialize on that lock rather than both seeing the same
 * missing rows and racing each other's insert. The lifecycle insert is `on conflict do nothing`
 * regardless, and only the rows it actually inserts get an `adopt` operation and an audit entry —
 * belt and braces alongside the lock, not a substitute for it.
 */
export async function ensureAgentLifecycleAdoption(
	deps: ControlPlaneDeps,
	actor: string,
): Promise<void> {
	await inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		await db.insert(gatewayControls).values({ id: 1 }).onConflictDoNothing();
		const [controls] = await db
			.select({
				version: gatewayControls.activeConfigVersion,
				generation: gatewayControls.configGeneration,
				revision: gatewayControls.activeConfigRevision,
			})
			.from(gatewayControls)
			.where(eq(gatewayControls.id, 1))
			.for("update");
		if (controls === undefined) {
			return;
		}
		const revisionId = await ensureConfigHistoryIn(uow, controls, actor);
		if (revisionId !== controls.revision) {
			await db
				.update(gatewayControls)
				.set({ activeConfigRevision: revisionId, updatedAt: uow.now })
				.where(eq(gatewayControls.id, 1));
		}

		const { bundle } = await loadActiveBundle(db, revisionId);
		if (bundle.agents.length === 0) {
			return;
		}
		const ids = bundle.agents.map((agent) => agent.id);
		const already = new Set(
			(
				await db
					.select({ agentId: agentLifecycle.agentId })
					.from(agentLifecycle)
					.where(inArray(agentLifecycle.agentId, ids))
			).map((row) => row.agentId),
		);
		const toAdopt = bundle.agents.filter((agent) => !already.has(agent.id));
		if (toAdopt.length === 0) {
			return;
		}

		// Adopted agents keep running exactly as they do now: their identity, if any, is still
		// `mattermost bootstrap`'s to provision. Only an agent created through the lifecycle starts
		// `pending`, waiting for the provisioning that create requested.
		const status: AgentLifecycleStatus = "ready";
		const inserted = await db
			.insert(agentLifecycle)
			.values(
				toAdopt.map((agent) => ({
					agentId: agent.id,
					status,
					generation: 1,
					operationId: null,
					statusChangedAt: uow.now,
					createdAt: uow.now,
				})),
			)
			.onConflictDoNothing()
			.returning({ agentId: agentLifecycle.agentId });

		for (const { agentId } of inserted) {
			const operationId = randomUUID();
			await db.insert(agentLifecycleOperations).values({
				id: operationId,
				agentId,
				kind: "adopt",
				requestedBy: actor,
				source: "cli",
				configRevisionId: revisionId,
				generation: 1,
				state: "succeeded",
				checkpoints: {},
				createdAt: uow.now,
				updatedAt: uow.now,
				finishedAt: uow.now,
			});
			await db
				.update(agentLifecycle)
				.set({ operationId })
				.where(eq(agentLifecycle.agentId, agentId));
			await audit(uow, actor, "agent_lifecycle.adopt", "agent", agentId, {
				status,
				operation_id: operationId,
			});
		}
	});
}
