import { randomUUID } from "node:crypto";
import {
	type JsonObject,
	QUEUES,
	type ResolvedWait,
	type RuntimeAdapterId,
	runQueue,
	type WaitCondition,
} from "@agent-gateway/contracts";
import {
	agentInbox,
	agentRuns,
	contextSnapshots,
	events,
	waitSubscriptions,
	withTransaction,
} from "@agent-gateway/db";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, ne, type SQL } from "drizzle-orm";
import { requireTransition } from "../state-machine.ts";
import { buildTurnContext } from "../turn-context.ts";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import {
	audit,
	isKillSwitchOn,
	loadActiveConfig,
	loadAgents,
	loadDirectory,
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
	if (agent.state === "waiting") {
		await matchMissedAnswers(uow, agentId);
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
	const [previous] = await db
		.select({ id: agentRuns.id, summary: agentRuns.publicSummary })
		.from(agentRuns)
		.where(and(eq(agentRuns.agentId, agentId), isNotNull(agentRuns.publicSummary)))
		.orderBy(desc(agentRuns.finishedAt))
		.limit(1);
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

	const runId = randomUUID();
	const triggerEvent = toGatewayEvent(trigger.event);
	const built = buildTurnContext({
		runId,
		agent,
		organization: config.organization,
		constitution: config.constitution,
		agents: await loadAgents(db),
		channelIds: await loadDirectory(db, "channel"),
		trigger: triggerEvent,
		pendingInbox: claimed.slice(1).map((row) => toGatewayEvent(row.event)),
		previousRun: previous === undefined ? null : { id: previous.id, summary: previous.summary },
		resolvedWaits,
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
		threadRef: null,
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
	input: JsonObject;
	timeoutSeconds: number;
	startAfter: Date | null;
}>;

/**
 * Enqueues one attempt of a run for its worker. The deadline starts when the worker starts the
 * run (`started` report); the check enqueued here only alerts when no worker picks the attempt
 * up within its time budget.
 */
export async function enqueueAttempt(uow: UnitOfWork, init: AttemptInit): Promise<void> {
	const start = init.startAfter ?? uow.now;
	const jobId = await uow.jobs.send(
		runQueue(init.adapter),
		{
			runId: init.runId,
			attempt: init.attempt,
			timeoutSeconds: init.timeoutSeconds,
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
