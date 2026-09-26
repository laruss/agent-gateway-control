import {
	type AgentConfig,
	AgentConfigSchema,
	type MattermostId,
	MattermostIdSchema,
	type OrganizationConfig,
	OrganizationConfigSchema,
	QUEUES,
	validateConfigBundle,
} from "@agent-gateway/contracts";
import {
	type AgentState,
	agentInbox,
	agentRuns,
	agents,
	approvalRequests,
	configVersions,
	type DirectoryKind,
	events,
	gatewayControls,
	mattermostDirectory,
	mattermostIdentities,
	type OutboxStatus,
	outbox,
	sourceCursors,
	waitSubscriptions,
	withTransaction,
} from "@agent-gateway/db";
import { canonicalHash } from "@agent-gateway/events";
import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { nextAgentState, requireTransition } from "../state-machine.ts";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import { type ScheduleResult, scheduleAgent } from "./scheduler.ts";
import {
	audit,
	loadActiveConfig,
	loadDirectory,
	lockAgent,
	setAgentState,
	toGatewayEvent,
} from "./store.ts";
import { cancelActiveWaits } from "./wait-store.ts";

async function inTransaction<T>(
	deps: ControlPlaneDeps,
	work: (uow: UnitOfWork) => Promise<T>,
): Promise<T> {
	return withTransaction(deps.pool, (tx) =>
		work({ deps, tx, jobs: deps.jobs(tx), now: deps.clock() }),
	);
}

export class AdminError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdminError";
	}
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** A configuration bundle as read from disk, with prompt files already resolved to text. */
export type ConfigApplyInput = Readonly<{
	organization: OrganizationConfig;
	agents: Readonly<AgentConfig[]>;
	constitution: string;
	rolePrompts: Readonly<Record<string, string>>;
}>;

export type ConfigApplyResult = Readonly<{
	version: string;
	created: Readonly<string[]>;
	updated: Readonly<string[]>;
	disabled: Readonly<string[]>;
}>;

/** Validation of a bundle before it touches the database; returns every problem found. */
export function configBundleProblems(input: ConfigApplyInput): Readonly<string[]> {
	const problems: string[] = [];
	const organization = OrganizationConfigSchema.safeParse(input.organization);
	if (!organization.success) {
		problems.push(
			...organization.error.issues.map((i) => `organization: ${i.path.join(".")}: ${i.message}`),
		);
	}
	for (const agent of input.agents) {
		const parsed = AgentConfigSchema.safeParse(agent);
		if (!parsed.success) {
			problems.push(
				...parsed.error.issues.map((i) => `agent ${agent.id}: ${i.path.join(".")}: ${i.message}`),
			);
		}
		if (agent.concurrency.max_active_runs !== 1) {
			problems.push(`agent ${agent.id}: max_active_runs other than 1 is not supported yet`);
		}
		if (!(agent.id in input.rolePrompts) || input.rolePrompts[agent.id]?.trim() === "") {
			problems.push(`agent ${agent.id}: role prompt is missing or empty`);
		}
	}
	if (input.constitution.trim() === "") {
		problems.push("organization: constitution is empty");
	}
	if (problems.length === 0) {
		problems.push(
			...validateConfigBundle({ organization: input.organization, agents: input.agents }).map(
				(issue) =>
					`${issue.agentId === null ? "bundle" : `agent ${issue.agentId}`}: ${issue.message}`,
			),
		);
	}
	return problems;
}

/**
 * Stores a validated configuration as the active version and upserts its agents. Agents that
 * left the configuration are disabled, never deleted: their history stays referenced. An agent
 * with a run in progress cannot be disabled by config; pause it first.
 */
export async function applyConfig(
	deps: ControlPlaneDeps,
	input: ConfigApplyInput,
	actor: string,
): Promise<ConfigApplyResult> {
	const problems = configBundleProblems(input);
	if (problems.length > 0) {
		throw new AdminError(`configuration is invalid:\n- ${problems.join("\n- ")}`);
	}
	const version = canonicalHash({
		organization: input.organization,
		agents: [...input.agents].sort((a, b) => (a.id < b.id ? -1 : 1)),
		constitution: input.constitution,
		rolePrompts: input.rolePrompts,
	});
	return inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		// The configuration row first, for update: applies are serialized, and `previous` is the
		// configuration this apply really replaces. The row is made sure to exist before it is
		// locked (a missing row would lock nothing).
		await db.insert(gatewayControls).values({ id: 1 }).onConflictDoNothing();
		const [controls] = await db
			.select({ generation: gatewayControls.configGeneration })
			.from(gatewayControls)
			.where(eq(gatewayControls.id, 1))
			.for("update");
		const generation = (controls?.generation ?? 0) + 1;
		const previous = await loadActiveConfig(db);
		if (
			previous !== null &&
			previous.organization.mattermost.team !== input.organization.mattermost.team
		) {
			// Another team: every channel's catch-up starts afresh once bootstrap resolves it, so
			// switching away and back never replays the interval in between. The marker voids any
			// start scanned before this generation.
			await uow.tx.client.query(
				"delete from source_cursors where source_id ~ '^mattermost:channel(-floor|-floor-posts)?:'",
			);
			await markChannelsLeft(uow, [TEAM_CHANGE_MARKER], generation);
		} else if (previous !== null) {
			// A channel leaving the configuration loses its catch-up at once: re-added later, it
			// starts afresh instead of replaying what was posted while it was unmanaged.
			const kept = new Set(input.organization.mattermost.channels);
			const resolved = await loadDirectory(db, "channel");
			const ids = previous.organization.mattermost.channels
				.filter((name) => !kept.has(name))
				.flatMap((name) => {
					const id = resolved.get(name);
					return id === undefined ? [] : [id];
				});
			if (ids.length > 0) {
				await uow.tx.client.query(
					`delete from source_cursors
					  where regexp_replace(source_id, '^mattermost:channel(-floor|-floor-posts)?:', '') = any($1::text[])
					    and source_id ~ '^mattermost:channel(-floor|-floor-posts)?:'`,
					[ids],
				);
				await markChannelsLeft(
					uow,
					ids.map((id) => `mattermost:channel-left:${id}`),
					generation,
				);
			}
		}
		await db
			.insert(configVersions)
			.values({
				version,
				organization: input.organization,
				constitution: input.constitution,
				appliedAt: uow.now,
			})
			.onConflictDoNothing();
		await db
			.insert(gatewayControls)
			.values({
				id: 1,
				activeConfigVersion: version,
				configGeneration: generation,
				updatedAt: uow.now,
			})
			.onConflictDoUpdate({
				target: gatewayControls.id,
				set: { activeConfigVersion: version, configGeneration: generation, updatedAt: uow.now },
			});

		// Every existing agent row, locked in id order up front: the apply touches most of them.
		await db.select({ id: agents.id }).from(agents).orderBy(asc(agents.id)).for("no key update");
		const created: string[] = [];
		const updated: string[] = [];
		const disabled: string[] = [];
		const configured = new Set(input.agents.map((a) => a.id));
		for (const agent of [...input.agents].sort((a, b) => (a.id < b.id ? -1 : 1))) {
			const values = {
				displayName: agent.display_name,
				runtimeAdapter: agent.runtime.adapter,
				runtimeProfile: agent.runtime.profile,
				configVersion: version,
				maxActiveRuns: agent.concurrency.max_active_runs,
				config: agent,
				rolePrompt: input.rolePrompts[agent.id] ?? "",
				updatedAt: uow.now,
			};
			const existing = await lockAgent(db, agent.id);
			if (existing === null) {
				const state: AgentState = agent.enabled ? "idle" : "disabled";
				await db.insert(agents).values({
					id: agent.id,
					...values,
					enabled: agent.enabled,
					state,
					stateChangedAt: uow.now,
					createdAt: uow.now,
				});
				created.push(agent.id);
			} else {
				await db.update(agents).set(values).where(eq(agents.id, agent.id));
				await applyEnabled(uow, existing.id, existing.state, agent.enabled, actor);
				updated.push(agent.id);
			}
			await db
				.insert(mattermostIdentities)
				.values({
					agentId: agent.id,
					username: agent.mattermost.username,
					tokenSecretRef: agent.mattermost.token_secret_file,
				})
				.onConflictDoUpdate({
					target: mattermostIdentities.agentId,
					set: {
						username: agent.mattermost.username,
						tokenSecretRef: agent.mattermost.token_secret_file,
					},
				});
		}
		const known = await db.select({ id: agents.id }).from(agents).orderBy(asc(agents.id));
		for (const { id } of known.filter((row) => !configured.has(row.id))) {
			const row = await lockAgent(db, id);
			if (row !== null && row.state !== "disabled") {
				await applyEnabled(uow, id, row.state, false, actor);
				disabled.push(id);
			}
		}
		// An agent enabled by this config may already have work waiting in its inbox.
		for (const id of [...configured].sort()) {
			await scheduleAgent(uow, id);
		}
		await audit(uow, actor, "config.apply", "config", version, {
			created: created.length,
			updated: updated.length,
			disabled: disabled.length,
		});
		return { version, created, updated, disabled };
	});
}

/** Marker of the generation in which every channel left management (a team change). */
export const TEAM_CHANGE_MARKER = "mattermost:team-changed";

/**
 * Records the generation in which channels left management: a catch-up start scanned before it
 * is void for them (see `startManagedChannel`).
 */
async function markChannelsLeft(
	uow: UnitOfWork,
	markers: Readonly<string[]>,
	generation: number,
): Promise<void> {
	for (const sourceId of markers) {
		await uow.tx.db
			.insert(sourceCursors)
			.values({
				sourceId,
				cursorType: "generation",
				cursorValue: String(generation),
				updatedAt: uow.now,
			})
			.onConflictDoUpdate({
				target: sourceCursors.sourceId,
				set: { cursorValue: String(generation), updatedAt: uow.now },
			});
	}
}

/**
 * Enables or disables an agent. Disabling cancels the agent's waits and expires its pending
 * approvals, so nothing can resume it behind the operator's back. Enabling restores FAILED when
 * the agent's latest run failed: only a redrive clears a failure.
 */
async function applyEnabled(
	uow: UnitOfWork,
	agentId: string,
	state: AgentState,
	enabled: boolean,
	actor: string,
): Promise<void> {
	if (enabled === (state !== "disabled")) {
		return;
	}
	const reason = `${enabled ? "enabled" : "disabled"} by ${actor}`;
	if (!enabled) {
		const next = nextAgentState(state, "disable");
		if (next === null) {
			throw new AdminError(`agent '${agentId}' is '${state}'; pause it before disabling`);
		}
		const correlations = await cancelActiveWaits(uow, agentId);
		const approvalIds = correlations.flatMap((c) =>
			c.startsWith("approval:") ? [c.slice("approval:".length)] : [],
		);
		if (approvalIds.length > 0) {
			await uow.tx.db
				.update(approvalRequests)
				.set({ status: "expired" })
				.where(
					and(inArray(approvalRequests.id, approvalIds), eq(approvalRequests.status, "pending")),
				);
		}
		await setAgentState(uow, agentId, state, next, reason);
		return;
	}
	const [latest] = await uow.tx.db
		.select({ status: agentRuns.status })
		.from(agentRuns)
		.where(eq(agentRuns.agentId, agentId))
		.orderBy(desc(agentRuns.queuedAt))
		.limit(1);
	const transition = latest?.status === "failed" ? "enable_failed" : "enable";
	await setAgentState(uow, agentId, state, requireTransition(agentId, state, transition), reason);
}

/** Records a Mattermost id resolved for a configured name (bootstrap, or by hand in development). */
export async function setDirectoryEntry(
	deps: ControlPlaneDeps,
	kind: DirectoryKind,
	name: string,
	mattermostId: MattermostId,
	actor: string,
): Promise<void> {
	await inTransaction(deps, (uow) => setDirectoryEntryIn(uow, kind, name, mattermostId, actor));
}

/** {@link setDirectoryEntry} inside a caller's transaction. */
export async function setDirectoryEntryIn(
	uow: UnitOfWork,
	kind: DirectoryKind,
	name: string,
	mattermostId: MattermostId,
	actor: string,
): Promise<void> {
	const id = MattermostIdSchema.parse(mattermostId);
	// A renamed channel or user keeps its id: the old name gives way to the new one.
	await uow.tx.db
		.delete(mattermostDirectory)
		.where(
			and(
				eq(mattermostDirectory.kind, kind),
				eq(mattermostDirectory.mattermostId, id),
				ne(mattermostDirectory.name, name),
			),
		);
	await uow.tx.db
		.insert(mattermostDirectory)
		.values({ kind, name, mattermostId: id, resolvedAt: uow.now })
		.onConflictDoUpdate({
			target: [mattermostDirectory.kind, mattermostDirectory.name],
			set: { mattermostId: id, resolvedAt: uow.now },
		});
	await audit(uow, actor, "directory.set", kind, name, { mattermost_id: id });
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export async function listAgents(deps: ControlPlaneDeps) {
	return deps.pool.query<{
		id: string;
		state: string;
		runtime_adapter: string;
		pending: number;
		active_waits: number;
	}>(
		`select a.id, a.state, a.runtime_adapter,
		   (select count(*)::int from agent_inbox i where i.agent_id = a.id and i.status = 'pending') as pending,
		   (select count(*)::int from wait_subscriptions w where w.agent_id = a.id and w.status = 'active') as active_waits
		 from agents a order by a.id`,
	);
}

export async function showAgent(deps: ControlPlaneDeps, agentId: string) {
	return inTransaction(deps, async ({ tx }) => {
		const [agent] = await tx.db.select().from(agents).where(eq(agents.id, agentId));
		if (agent === undefined) {
			throw new AdminError(`agent '${agentId}' does not exist`);
		}
		const [identity] = await tx.db
			.select()
			.from(mattermostIdentities)
			.where(eq(mattermostIdentities.agentId, agentId));
		const runs = await tx.db
			.select({
				id: agentRuns.id,
				status: agentRuns.status,
				outcome: agentRuns.outcome,
				attempt: agentRuns.attempt,
				errorCode: agentRuns.errorCode,
				queuedAt: agentRuns.queuedAt,
			})
			.from(agentRuns)
			.where(eq(agentRuns.agentId, agentId))
			.orderBy(desc(agentRuns.queuedAt))
			.limit(10);
		const waits = await tx.db
			.select()
			.from(waitSubscriptions)
			.where(and(eq(waitSubscriptions.agentId, agentId), eq(waitSubscriptions.status, "active")));
		return { agent, identity: identity ?? null, runs, waits };
	});
}

export async function setAgentEnabled(
	deps: ControlPlaneDeps,
	agentId: string,
	enabled: boolean,
	actor: string,
): Promise<AgentState> {
	return inTransaction(deps, async (uow) => {
		const agent = await lockAgent(uow.tx.db, agentId);
		if (agent === null) {
			throw new AdminError(`agent '${agentId}' does not exist`);
		}
		await applyEnabled(uow, agentId, agent.state, enabled, actor);
		await audit(uow, actor, enabled ? "agent.enable" : "agent.disable", "agent", agentId);
		if (enabled) {
			await scheduleAgent(uow, agentId);
		}
		const after = await lockAgent(uow.tx.db, agentId);
		return after?.state ?? agent.state;
	});
}

/** pg-boss jobs an operation made obsolete; the caller cancels them (the domain has no boss). */
export type CancelledJob = Readonly<{ queue: string; jobId: string }>;

/**
 * Pauses an agent. A run in progress is cancelled and its inbox entries return to pending, so
 * no work is lost; the worker's late report is ignored because the run is no longer active.
 */
async function pauseInTransaction(
	uow: UnitOfWork,
	agentId: string,
	actor: string,
	reason: string,
): Promise<CancelledJob[]> {
	const { db } = uow.tx;
	const agent = await lockAgent(db, agentId);
	if (agent === null) {
		throw new AdminError(`agent '${agentId}' does not exist`);
	}
	// A FAILED agent runs nothing; it stays FAILED until redriven, even through kill-all.
	if (agent.state === "paused" || agent.state === "disabled" || agent.state === "failed") {
		return [];
	}
	const next = requireTransition(agentId, agent.state, "pause");
	const active = await db
		.update(agentRuns)
		.set({
			status: "cancelled",
			finishedAt: uow.now,
			errorCode: "cancelled",
			errorDetailRedacted: reason,
		})
		.where(and(eq(agentRuns.agentId, agentId), inArray(agentRuns.status, ["queued", "running"])))
		.returning({ id: agentRuns.id, jobId: agentRuns.jobId, adapter: agentRuns.runtimeAdapter });
	for (const run of active) {
		await db
			.update(agentInbox)
			.set({ status: "pending", runId: null })
			.where(and(eq(agentInbox.runId, run.id), eq(agentInbox.status, "claimed")));
		await audit(uow, actor, "run.cancel", "run", run.id, { reason });
	}
	await setAgentState(uow, agentId, agent.state, next, reason);
	await audit(uow, actor, "agent.pause", "agent", agentId, { reason });
	return active.flatMap((run) =>
		run.jobId === null ? [] : [{ queue: `agent.run.${run.adapter}`, jobId: run.jobId }],
	);
}

export async function pauseAgent(
	deps: ControlPlaneDeps,
	agentId: string,
	actor: string,
): Promise<CancelledJob[]> {
	return inTransaction(deps, (uow) =>
		pauseInTransaction(uow, agentId, actor, `paused by ${actor}`),
	);
}

/** Resumes a paused agent: back to waiting if it still holds active waits, otherwise idle. */
export async function resumeAgent(
	deps: ControlPlaneDeps,
	agentId: string,
	actor: string,
): Promise<AgentState> {
	return inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		const agent = await lockAgent(db, agentId);
		if (agent === null) {
			throw new AdminError(`agent '${agentId}' does not exist`);
		}
		if (agent.state !== "paused") {
			throw new AdminError(`agent '${agentId}' is '${agent.state}', not paused`);
		}
		const waits = await db
			.select({ id: waitSubscriptions.id })
			.from(waitSubscriptions)
			.where(and(eq(waitSubscriptions.agentId, agentId), eq(waitSubscriptions.status, "active")));
		const next = requireTransition(
			agentId,
			agent.state,
			waits.length > 0 ? "resume_waiting" : "resume_idle",
		);
		await setAgentState(uow, agentId, agent.state, next, `resumed by ${actor}`);
		await audit(uow, actor, "agent.resume", "agent", agentId);
		await scheduleAgent(uow, agentId);
		return (await lockAgent(db, agentId))?.state ?? next;
	});
}

// ---------------------------------------------------------------------------
// Runs, waits, events, approvals
// ---------------------------------------------------------------------------

export async function listRuns(deps: ControlPlaneDeps, agentId: string | null, limit = 20) {
	return inTransaction(deps, ({ tx }) =>
		tx.db
			.select({
				id: agentRuns.id,
				agentId: agentRuns.agentId,
				status: agentRuns.status,
				outcome: agentRuns.outcome,
				attempt: agentRuns.attempt,
				errorCode: agentRuns.errorCode,
				queuedAt: agentRuns.queuedAt,
				finishedAt: agentRuns.finishedAt,
			})
			.from(agentRuns)
			.where(agentId === null ? undefined : eq(agentRuns.agentId, agentId))
			.orderBy(desc(agentRuns.queuedAt))
			.limit(limit),
	);
}

export async function showRun(deps: ControlPlaneDeps, runId: string) {
	return inTransaction(deps, async ({ tx }) => {
		const [run] = await tx.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
		if (run === undefined) {
			throw new AdminError(`run '${runId}' does not exist`);
		}
		const inbox = await tx.db
			.select({ eventId: agentInbox.eventId, status: agentInbox.status, waitId: agentInbox.waitId })
			.from(agentInbox)
			.where(eq(agentInbox.runId, runId));
		return { run, inbox };
	});
}

/** Cancels the agent's run in progress; the agent is paused (RUNNING -> PAUSED). */
export async function cancelRun(
	deps: ControlPlaneDeps,
	runId: string,
	actor: string,
): Promise<CancelledJob[]> {
	return inTransaction(deps, async (uow) => {
		const [peek] = await uow.tx.db
			.select({ agentId: agentRuns.agentId })
			.from(agentRuns)
			.where(eq(agentRuns.id, runId));
		if (peek === undefined) {
			throw new AdminError(`run '${runId}' does not exist`);
		}
		// Checked under the agent lock: the run may have finished since it was looked up.
		await lockAgent(uow.tx.db, peek.agentId);
		const [run] = await uow.tx.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
		if (run === undefined || (run.status !== "queued" && run.status !== "running")) {
			throw new AdminError(`run '${runId}' is '${run?.status}', not in progress`);
		}
		return pauseInTransaction(uow, run.agentId, actor, `run ${runId} cancelled by ${actor}`);
	});
}

/**
 * Re-runs the latest failed run of a FAILED agent (FAILED -> QUEUED). Its inbox entries go back
 * to pending and a new run with the same trigger is scheduled; the old run keeps its record.
 */
export async function redriveRun(
	deps: ControlPlaneDeps,
	runId: string,
	actor: string,
): Promise<ScheduleResult> {
	return inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
		if (run === undefined) {
			throw new AdminError(`run '${runId}' does not exist`);
		}
		const agent = await lockAgent(db, run.agentId);
		if (agent?.state !== "failed") {
			throw new AdminError(`agent '${run.agentId}' is '${agent?.state}', not failed`);
		}
		const [latest] = await db
			.select({ id: agentRuns.id })
			.from(agentRuns)
			.where(eq(agentRuns.agentId, run.agentId))
			.orderBy(desc(agentRuns.queuedAt))
			.limit(1);
		if (run.status !== "failed" || latest?.id !== run.id) {
			throw new AdminError(`run '${runId}' is not the agent's latest failed run`);
		}
		await db
			.update(agentInbox)
			.set({ status: "pending", runId: null })
			.where(
				and(eq(agentInbox.runId, run.id), inArray(agentInbox.status, ["claimed", "consumed"])),
			);
		await audit(uow, actor, "run.redrive", "run", runId);
		const result = await scheduleAgent(uow, run.agentId, {
			redrive: { runId: run.id, triggerEventId: run.triggerEventId },
		});
		if ("skipped" in result) {
			throw new AdminError(`redrive of '${runId}' did not start a run: ${result.skipped}`);
		}
		return result;
	});
}

export async function listWaits(deps: ControlPlaneDeps) {
	return inTransaction(deps, ({ tx }) =>
		tx.db
			.select({
				id: waitSubscriptions.id,
				agentId: waitSubscriptions.agentId,
				eventType: waitSubscriptions.eventType,
				correlationId: waitSubscriptions.correlationId,
				timeoutAt: waitSubscriptions.timeoutAt,
			})
			.from(waitSubscriptions)
			.where(eq(waitSubscriptions.status, "active"))
			.orderBy(waitSubscriptions.timeoutAt),
	);
}

/** An event by internal UUID or by its external id. */
export async function showEvent(deps: ControlPlaneDeps, id: string) {
	return inTransaction(deps, async ({ tx }) => {
		const isUuid = /^[0-9a-f-]{36}$/i.test(id);
		const rows = await tx.db
			.select()
			.from(events)
			.where(isUuid ? or(eq(events.id, id), eq(events.externalId, id)) : eq(events.externalId, id));
		return rows.map((row) => ({
			id: row.id,
			receivedAt: row.receivedAt,
			event: toGatewayEvent(row),
		}));
	});
}

export async function listApprovals(deps: ControlPlaneDeps, status: string | null) {
	return inTransaction(deps, ({ tx }) =>
		tx.db
			.select({
				id: approvalRequests.id,
				agentId: approvalRequests.requestedByAgentId,
				actionType: approvalRequests.actionType,
				riskLevel: approvalRequests.riskLevel,
				status: approvalRequests.status,
				expiresAt: approvalRequests.expiresAt,
			})
			.from(approvalRequests)
			.where(status === null ? undefined : eq(approvalRequests.status, status))
			.orderBy(desc(approvalRequests.createdAt)),
	);
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

/**
 * Emergency stop: no run starts while the switch is on, and every agent that is not disabled
 * is paused, cancelling runs in progress. Releasing the switch does not resume agents.
 */
export async function killAll(deps: ControlPlaneDeps, actor: string): Promise<CancelledJob[]> {
	return inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		await db
			.insert(gatewayControls)
			.values({ id: 1, killSwitch: true, updatedAt: uow.now })
			.onConflictDoUpdate({
				target: gatewayControls.id,
				set: { killSwitch: true, updatedAt: uow.now },
			});
		await audit(uow, actor, "gateway.kill_all", "gateway", "controls");
		const cancelled: CancelledJob[] = [];
		const rows = await db.select({ id: agents.id }).from(agents).orderBy(agents.id);
		for (const row of rows) {
			cancelled.push(...(await pauseInTransaction(uow, row.id, actor, `kill-all by ${actor}`)));
		}
		return cancelled;
	});
}

export async function releaseKillSwitch(deps: ControlPlaneDeps, actor: string): Promise<void> {
	await inTransaction(deps, async (uow) => {
		await uow.tx.db
			.update(gatewayControls)
			.set({ killSwitch: false, updatedAt: uow.now })
			.where(eq(gatewayControls.id, 1));
		await audit(uow, actor, "gateway.kill_all_release", "gateway", "controls");
	});
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export async function listOutbox(deps: ControlPlaneDeps, status: OutboxStatus | null) {
	return inTransaction(deps, ({ tx }) =>
		tx.db
			.select({
				id: outbox.id,
				kind: outbox.kind,
				destination: outbox.destination,
				status: outbox.status,
				attempts: outbox.attempts,
				lastError: outbox.lastErrorRedacted,
				createdAt: outbox.createdAt,
			})
			.from(outbox)
			.where(status === null ? undefined : eq(outbox.status, status))
			.orderBy(desc(outbox.createdAt))
			.limit(100),
	);
}

/** Attempts a redriven outbox item gets on top of the ones it used. */
const OUTBOX_REDRIVE_ATTEMPTS = 8;

/**
 * Gives a dead outbox item a fresh set of attempts. The idempotency key is unchanged, so a
 * deliverer that already performed the effect returns its receipt instead of repeating it.
 */
export async function redriveOutbox(
	deps: ControlPlaneDeps,
	outboxId: string,
	actor: string,
): Promise<void> {
	await inTransaction(deps, async (uow) => {
		const [item] = await uow.tx.db
			.update(outbox)
			// `attempts` keeps counting: it is the fencing token of claims, so it never goes back.
			.set({
				status: "pending",
				maxAttempts: sql`${outbox.attempts} + ${OUTBOX_REDRIVE_ATTEMPTS}`,
				nextAttemptAt: uow.now,
				lockedUntil: null,
			})
			.where(and(eq(outbox.id, outboxId), eq(outbox.status, "dead")))
			.returning({ id: outbox.id });
		if (item === undefined) {
			throw new AdminError(`outbox item '${outboxId}' does not exist or is not dead`);
		}
		await uow.jobs.send(QUEUES.outboxDeliver, { outboxId });
		await audit(uow, actor, "outbox.redrive", "outbox", outboxId);
	});
}
