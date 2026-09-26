import { randomUUID } from "node:crypto";
import type { FoldedThread } from "@agent-gateway/context";
import {
	type GatewayEvent,
	type JsonObject,
	type MattermostId,
	type MemoryItem,
	QUEUES,
	type ResolvedWait,
	type RunRuntime,
	type RuntimeAdapterId,
	type RuntimeSessionHandle,
	RuntimeSessionHandleSchema,
	runQueue,
	type SessionPolicy,
	type WaitCondition,
	type WorkingSummary,
} from "@agent-gateway/contracts";
import {
	agentInbox,
	agentRuns,
	contextSnapshots,
	events,
	runtimeSessions,
	waitSubscriptions,
	withTransaction,
} from "@agent-gateway/db";
import { mattermostPost } from "@agent-gateway/events";
import {
	and,
	asc,
	count,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { requireTransition } from "../state-machine.ts";
import { type AgentRecord, buildTurnContext } from "../turn-context.ts";
import {
	assembleThread,
	formatThreadRef,
	loadMemories,
	type ResolvedWaitOrigin,
	retireInbox,
	type ThreadRef,
	threadHumans,
	threadOfWaitCreator,
	threadsOf,
	withCurrentPosts,
} from "./context-store.ts";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import {
	audit,
	isKillSwitchOn,
	loadActiveConfig,
	loadAgents,
	loadOwnerUserIds,
	loadTeamChannels,
	lockAgent,
	raiseAlert,
	setAgentState,
	toAgentRecord,
	toGatewayEvent,
} from "./store.ts";
import { matchMissedAnswers } from "./wait-store.ts";

async function hourlyQuotaReached(uow: UnitOfWork, agentId: string): Promise<boolean> {
	const config = await loadActiveConfig(uow.tx.db);
	if (config === null) {
		return false;
	}
	const [recent] = await uow.tx.db
		.select({ n: count() })
		.from(agentRuns)
		.where(
			and(
				eq(agentRuns.agentId, agentId),
				gt(agentRuns.queuedAt, new Date(uow.now.getTime() - 3600_000)),
			),
		);
	return (
		(recent?.n ?? 0) >= config.organization.organization.default_limits.max_runs_per_agent_per_hour
	);
}

type PreviousRun = Readonly<{ id: string; summary: WorkingSummary | null }>;

/**
 * The run whose public summary the turn continues from: the run that created the wait being
 * resolved, else the agent's latest run in the same conversation. Only a run whose thread is in
 * a channel the agent may still read counts: a summary never carries a channel the agent has
 * lost into its turn (and on into a thread summary).
 */
async function previousRun(
	uow: UnitOfWork,
	agentId: string,
	waitCreatorRunId: string | null,
	correlationId: string,
	allowed: ReadonlySet<MattermostId>,
): Promise<PreviousRun | null> {
	const latest = async (which: SQL) => {
		const [row] = await uow.tx.db
			.select({ id: agentRuns.id, summary: agentRuns.publicSummary })
			.from(agentRuns)
			.innerJoin(contextSnapshots, eq(contextSnapshots.runId, agentRuns.id))
			.where(
				and(
					eq(agentRuns.agentId, agentId),
					isNotNull(agentRuns.publicSummary),
					which,
					// `channel/<id>/thread/<root>`: only threads of channels the agent may still read.
					or(
						isNull(contextSnapshots.threadRef),
						inArray(sql<string>`split_part(${contextSnapshots.threadRef}, '/', 2)`, [...allowed]),
					),
				),
			)
			.orderBy(desc(agentRuns.finishedAt))
			.limit(1);
		return row ?? null;
	};
	return (
		(waitCreatorRunId === null ? null : await latest(eq(agentRuns.id, waitCreatorRunId))) ??
		(await latest(eq(agentRuns.correlationId, correlationId)))
	);
}

type TurnContextInit = Readonly<{
	agent: AgentRecord;
	/** The agent's allowed channels, resolved to ids. */
	allowed: ReadonlySet<MattermostId>;
	/** The trigger first, then the claimed inbox events. */
	turnEvents: Readonly<GatewayEvent[]>;
	/** The wait the trigger resolved, if it resolved one. */
	resolvedWait: ResolvedWaitOrigin | null;
}>;

type AssembledContext = Readonly<{
	threadRef: ThreadRef | null;
	thread: FoldedThread | null;
	memories: Readonly<MemoryItem[]>;
	waitableUserIds: Readonly<MattermostId[]>;
}>;

/**
 * The stored context of a turn: the thread of its trigger post (for a trigger without a post,
 * such as a wait timeout, the thread of the run that created the wait; else the first inbox
 * post's), the agent's memory, and the humans its waits may name. A thread outside the agent's
 * allowed channels is never included.
 */
async function assembleTurnContext(
	uow: UnitOfWork,
	init: TurnContextInit,
): Promise<AssembledContext> {
	const { db } = uow.tx;
	const { agent, allowed } = init;
	const posted = threadsOf(init.turnEvents).filter((ref) => allowed.has(ref.channelId));
	const [triggerThread] = threadsOf(init.turnEvents.slice(0, 1));
	const resumedIn =
		triggerThread === undefined && init.resolvedWait !== null
			? await threadOfWaitCreator(db, init.resolvedWait)
			: null;
	const threadRef =
		(triggerThread !== undefined && allowed.has(triggerThread.channelId) ? triggerThread : null) ??
		(resumedIn !== null && allowed.has(resumedIn.channelId) ? resumedIn : null) ??
		posted[0] ??
		null;
	const carried = new Set(
		init.turnEvents.flatMap((event) => {
			const post = mattermostPost(event);
			return post === null ? [] : [post.post_id];
		}),
	);
	const thread = threadRef === null ? null : await assembleThread(db, threadRef, carried);
	// The humans the run may wait on: authors in the turn's own thread (already folded), in the
	// threads of its other posts, and the humans whose posts it carries.
	const own = threadRef === null ? null : formatThreadRef(threadRef);
	const otherThreads = posted.filter((ref) => formatThreadRef(ref) !== own);
	const carriedHumans = init.turnEvents.flatMap((event) => {
		const post = mattermostPost(event);
		return post !== null && event.trustlevel === "human-trusted" ? [post.user_id] : [];
	});
	const waitableUserIds = [
		...(thread?.humanUserIds ?? []),
		...(await threadHumans(db, otherThreads)),
		...carriedHumans,
		...(await loadOwnerUserIds(db)),
	];
	const memories = await loadMemories(db, {
		private: agent.config.memory.private_namespace,
		shared: agent.config.memory.shared_namespaces,
	});
	return { threadRef: thread === null ? null : threadRef, thread, memories, waitableUserIds };
}

/** Attempts per run: the first plus two controller retries of retryable failures. */
export const MAX_RUN_ATTEMPTS = 3;
/** Most inbox events one run takes when the agent coalesces. */
const MAX_COALESCED_EVENTS = 20;
/** pg-boss caps job expiration at 24 hours. */
const MAX_JOB_EXPIRATION_SECONDS = 86_400;
/** Grace after the deadline before the controller declares the run timed out. */
const TIMEOUT_GRACE_SECONDS = 30;

export type ScheduleOptions = Readonly<{
	/** Redrive of a failed run: FAILED -> QUEUED with exactly that run's trigger. */
	redrive?: Readonly<{ runId: string; triggerEventId: string }>;
}>;

export type ScheduleResult = Readonly<{ runId: string } | { skipped: string }>;

/**
 * Starts the agent's next run if its state and inbox allow it: an idle agent takes its pending
 * inbox, a waiting agent only an entry that resolved one of its waits, a failed agent only on
 * redrive. Claims the inbox entries, assembles the turn, and enqueues the run in the same
 * transaction. Idempotent: a second call with nothing new to do is a no-op.
 */
export async function scheduleAgent(
	uow: UnitOfWork,
	agentId: string,
	options: ScheduleOptions = {},
): Promise<ScheduleResult> {
	const { redrive } = options;
	const { db } = uow.tx;
	const agentRow = await lockAgent(db, agentId);
	if (agentRow === null) {
		return { skipped: "unknown_agent" };
	}
	const agent = toAgentRecord(agentRow);
	const transition =
		agent.state === "idle"
			? "schedule"
			: agent.state === "waiting"
				? "wait_resolved"
				: agent.state === "failed" && redrive !== undefined
					? "redrive"
					: null;
	if (transition === null) {
		return { skipped: `state_${agent.state}` };
	}
	if (await isKillSwitchOn(db)) {
		return { skipped: "kill_switch" };
	}
	const channelIds = await loadTeamChannels(db);
	const allowed = new Set(
		agent.config.mattermost.allowed_channels.flatMap((name) => {
			const id = channelIds.get(name);
			return id === undefined ? [] : [id];
		}),
	);
	// Before any match or claim: stale entries neither resume nor wake. With no channel resolved
	// (no configuration, or a team change before bootstrap) nothing is decided; the context check
	// below defers the run instead.
	if (allowed.size > 0) {
		const dropped = await retireInbox(uow, agentId, [...allowed]);
		if (dropped.length > 0) {
			await audit(uow, "system", "inbox.dropped", "agent", agentId, {
				reason: "deleted post or channel no longer allowed",
				event_ids: dropped.slice(0, 50),
			});
		}
		if (agent.state === "waiting") {
			await matchMissedAnswers(uow, agentId, allowed);
		}
	}
	// The hourly quota holds for runs started from the inbox too, not only for the wake-up that
	// put the event there; excess work stays pending and the sweep starts it once eligible. An
	// operator's redrive is exempt.
	if (redrive === undefined && (await hourlyQuotaReached(uow, agentId))) {
		return { skipped: "rate_limited" };
	}

	const pendingRows = (condition: SQL | undefined, limit: number) =>
		db
			.select({ inbox: agentInbox, event: events })
			.from(agentInbox)
			.innerJoin(events, eq(events.id, agentInbox.eventId))
			.where(and(eq(agentInbox.agentId, agentId), eq(agentInbox.status, "pending"), condition))
			.orderBy(desc(agentInbox.priority), asc(agentInbox.createdAt), asc(agentInbox.id))
			.limit(limit);
	// The trigger is looked up on its own, so a long inbox cannot hide it.
	const [trigger] = await pendingRows(
		redrive !== undefined
			? eq(agentInbox.eventId, redrive.triggerEventId)
			: agent.state === "waiting"
				? isNotNull(agentInbox.waitId)
				: undefined,
		1,
	);
	if (trigger === undefined) {
		return { skipped: "nothing_pending" };
	}
	const coalesce = agent.config.concurrency.while_running === "enqueue-and-coalesce";
	const others = coalesce
		? await pendingRows(ne(agentInbox.id, trigger.inbox.id), MAX_COALESCED_EVENTS - 1)
		: [];
	const claimed = [trigger, ...others];

	const config = await loadActiveConfig(db);
	if (config === null) {
		return { skipped: "no_active_config" };
	}
	const waitIds = claimed.flatMap((row) => (row.inbox.waitId === null ? [] : [row.inbox.waitId]));
	const resolved =
		waitIds.length === 0
			? []
			: await db.select().from(waitSubscriptions).where(inArray(waitSubscriptions.id, waitIds));
	const resolvedWaits: ResolvedWait[] = resolved.map((wait) => ({
		waitId: wait.id,
		outcome: wait.status === "timed_out" ? "timeout" : "matched",
		condition: wait.condition satisfies WaitCondition,
	}));

	const turnEvents = await withCurrentPosts(
		db,
		claimed.map((row) => toGatewayEvent(row.event)),
		allowed,
	);
	const [triggerEvent, ...inboxEvents] = turnEvents;
	if (triggerEvent === undefined) {
		throw new Error("claimed inbox without a trigger");
	}
	const triggerWait = resolved.find((wait) => wait.id === trigger.inbox.waitId);
	const waitCreatorRunId = triggerWait?.createdByRunId ?? null;
	const previous = await previousRun(
		uow,
		agentId,
		waitCreatorRunId,
		triggerEvent.correlationid,
		allowed,
	);
	const context = await assembleTurnContext(uow, {
		agent,
		allowed,
		turnEvents,
		resolvedWait:
			triggerWait === undefined
				? null
				: {
						runId: triggerWait.createdByRunId,
						agentId: triggerWait.agentId,
						correlationId: triggerWait.correlationId,
					},
	});

	const runId = randomUUID();
	const built = buildTurnContext({
		runId,
		agent,
		organization: config.organization,
		constitution: config.constitution,
		agents: await loadAgents(db),
		channelIds,
		trigger: triggerEvent,
		pendingInbox: inboxEvents,
		previousRun: previous,
		resolvedWaits,
		threadContext: context.thread?.context ?? null,
		memories: context.memories,
		waitableUserIds: context.waitableUserIds,
		now: uow.now,
	});
	if (!built.ok) {
		await raiseAlert(
			uow,
			`context:${agentId}:${trigger.event.id}`,
			`Cannot start a run of @${agentId}: ${built.reason}`,
		);
		return { skipped: "context_unavailable" };
	}

	const [{ generation } = { generation: 0 }] = await db
		.select({ generation: count() })
		.from(agentRuns)
		.where(and(eq(agentRuns.agentId, agentId), eq(agentRuns.triggerEventId, trigger.event.id)));
	const adapter: RuntimeAdapterId = agent.config.runtime.adapter;
	const deadline = new Date(built.context.input.deadline);
	await db.insert(agentRuns).values({
		id: runId,
		agentId,
		triggerEventId: trigger.event.id,
		idempotencyKey: `agent-run:${agentId}:${trigger.event.id}:${generation}`,
		status: "queued",
		attempt: 1,
		maxAttempts: MAX_RUN_ATTEMPTS,
		runtimeAdapter: adapter,
		model: agent.config.runtime.model ?? null,
		correlationId: triggerEvent.correlationid,
		hop: triggerEvent.hop,
		queuedAt: uow.now,
		timeoutAt: deadline,
		timeoutSeconds: agent.config.runtime.timeout_seconds,
		parentRunId: redrive?.runId ?? null,
	});
	const input = built.context.input;
	await db.insert(contextSnapshots).values({
		agentId,
		runId,
		configVersion: agent.configVersion,
		threadRef: context.threadRef === null ? null : formatThreadRef(context.threadRef),
		input,
		authority: built.context.authority,
		sizeBytes: JSON.stringify(input).length,
		createdAt: uow.now,
	});
	await db
		.update(agentInbox)
		.set({ status: "claimed", runId })
		.where(
			inArray(
				agentInbox.id,
				claimed.map((row) => row.inbox.id),
			),
		);
	await setAgentState(
		uow,
		agentId,
		agent.state,
		requireTransition(agentId, agent.state, transition),
		`run ${runId}`,
	);
	await enqueueAttempt(uow, {
		runId,
		attempt: 1,
		adapter,
		agentId,
		model: agent.config.runtime.model ?? null,
		sessionPolicy: agent.config.runtime.session_policy,
		sessionScope: sessionScope(agent.configVersion, input),
		input,
		timeoutSeconds: agent.config.runtime.timeout_seconds,
		startAfter: null,
	});
	await audit(uow, "system", "run.scheduled", "run", runId, {
		agent_id: agentId,
		trigger_event_id: trigger.event.id,
		inbox_events: claimed.length,
		redrive_of: redrive?.runId ?? null,
	});
	return { runId };
}

export type AttemptInit = Readonly<{
	runId: string;
	attempt: number;
	adapter: RuntimeAdapterId;
	agentId: string;
	model: string | null;
	sessionPolicy: SessionPolicy;
	/** See `sessionScope`; only a session stored under the same scope is offered. */
	sessionScope: string;
	input: JsonObject;
	timeoutSeconds: number;
	startAfter: Date | null;
}>;

/**
 * What a provider session may be resumed for: the same configuration version (role, policy,
 * channels) and the same conversations, those of the trigger and of every carried inbox event.
 * A session's transcript holds everything its earlier turns saw, so resuming it elsewhere would
 * show a run more than its own context allows.
 */
export function sessionScope(
	configVersion: string,
	input: Readonly<{ trigger: GatewayEvent; pendingInbox: Readonly<GatewayEvent[]> }>,
): string {
	const correlations = [
		...new Set([input.trigger, ...input.pendingInbox].map((event) => event.correlationid)),
	].sort();
	// JSON keeps ids containing separators apart.
	return JSON.stringify([configVersion, correlations]);
}

/**
 * The agent's stored provider session for this adapter, if active, unexpired and stored under
 * the same scope. Only an offer: the worker checks the runtime version and falls back to a
 * fresh start.
 */
async function storedSession(
	uow: UnitOfWork,
	agentId: string,
	adapter: RuntimeAdapterId,
	scope: string,
): Promise<RuntimeSessionHandle | null> {
	const [row] = await uow.tx.db
		.select()
		.from(runtimeSessions)
		.where(
			and(
				eq(runtimeSessions.agentId, agentId),
				eq(runtimeSessions.adapter, adapter),
				eq(runtimeSessions.status, "active"),
				or(isNull(runtimeSessions.expiresAt), gt(runtimeSessions.expiresAt, uow.now)),
			),
		);
	if (row === undefined || row.resumeMetadata.scope !== scope) {
		return null;
	}
	const handle = RuntimeSessionHandleSchema.safeParse({
		adapter: row.adapter,
		providerSessionId: row.providerSessionRef,
		runtimeVersion: row.runtimeVersion,
		expiresAt: row.expiresAt?.toISOString() ?? null,
	});
	return handle.success ? handle.data : null;
}

/**
 * Enqueues one attempt of a run for its worker. The deadline starts when the worker starts the
 * run (`started` report); the check enqueued here only alerts when no worker picks the attempt
 * up within its time budget.
 */
export async function enqueueAttempt(uow: UnitOfWork, init: AttemptInit): Promise<void> {
	const start = init.startAfter ?? uow.now;
	const runtime: RunRuntime = {
		model: init.model,
		sessionPolicy: init.sessionPolicy,
		session:
			init.sessionPolicy === "resumable-if-available"
				? await storedSession(uow, init.agentId, init.adapter, init.sessionScope)
				: null,
	};
	const jobId = await uow.jobs.send(
		runQueue(init.adapter),
		{
			runId: init.runId,
			attempt: init.attempt,
			timeoutSeconds: init.timeoutSeconds,
			runtime,
			input: init.input,
		},
		{
			...(init.startAfter === null ? {} : { startAfter: init.startAfter }),
			// pg-boss caps expiration at 24 hours; the controller's timeout job is the backstop.
			expireInSeconds: Math.min(MAX_JOB_EXPIRATION_SECONDS, init.timeoutSeconds + 60),
		},
	);
	await uow.tx.db.update(agentRuns).set({ jobId }).where(eq(agentRuns.id, init.runId));
	await uow.jobs.send(
		QUEUES.agentTimeout,
		{ runId: init.runId, attempt: init.attempt },
		{
			startAfter: new Date(start.getTime() + (init.timeoutSeconds + TIMEOUT_GRACE_SECONDS) * 1000),
		},
	);
}

/** The backstop of a started attempt: fails it if no report arrives by the deadline. */
export async function enqueueRunDeadline(
	uow: UnitOfWork,
	runId: string,
	attempt: number,
	deadline: Date,
): Promise<void> {
	await uow.jobs.send(
		QUEUES.agentTimeout,
		{ runId, attempt },
		{ startAfter: new Date(deadline.getTime() + TIMEOUT_GRACE_SECONDS * 1000) },
	);
}

/**
 * Safety net for work that no event will trigger again: an agent that became schedulable
 * (kill switch released, context resolvable again, enabled) while its inbox waited. Each agent
 * is scheduled in its own transaction. Returns the number of runs started.
 */
export async function sweepSchedules(deps: ControlPlaneDeps): Promise<number> {
	const candidates = await deps.pool.query<{ agent_id: string }>(
		`select distinct i.agent_id from agent_inbox i join agents a on a.id = i.agent_id
		  where i.status = 'pending'
		    and (a.state = 'idle' or (a.state = 'waiting' and i.wait_id is not null))
		  order by i.agent_id`,
	);
	let started = 0;
	for (const { agent_id: agentId } of candidates.rows) {
		const result = await withTransaction(deps.pool, (tx) =>
			scheduleAgent({ deps, tx, jobs: deps.jobs(tx), now: deps.clock() }, agentId),
		);
		if ("runId" in result) {
			started += 1;
		}
	}
	return started;
}
