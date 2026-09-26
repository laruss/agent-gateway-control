import type { GatewayEvent, Uuid } from "@agent-gateway/contracts";
import { agentInbox, agentRuns, eventRoutes, events, waitSubscriptions } from "@agent-gateway/db";
import { mattermostPost } from "@agent-gateway/events";
import { and, eq, gte, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { routeEvent } from "../routing.ts";
import { type ActiveWait, waitMatches } from "../waits.ts";
import { deletedPosts } from "./context-store.ts";
import type { UnitOfWork } from "./deps.ts";
import { loopStats, type StoredEventPosition } from "./loop-stats.ts";
import {
	loadActiveConfig,
	loadAgents,
	loadTeamChannels,
	raiseAlert,
	toGatewayEvent,
	toRoutingAgent,
} from "./store.ts";

/** Inbox priority of an entry that resolved a wait. */
export const WAIT_PRIORITY = 10;

type WaitRow = typeof waitSubscriptions.$inferSelect;
type Db = UnitOfWork["tx"]["db"];

/**
 * Waits as the matcher sees them. A thread-bound wait admits replies in the threads it was
 * asked in, and in threads its run started (root posts the run published, found by causation):
 * those roots exist only after delivery, so they are looked up each time.
 */
export async function toActiveWaits(db: Db, rows: Readonly<WaitRow[]>): Promise<ActiveWait[]> {
	const runIds = [
		...new Set(rows.filter((row) => row.threadRootIds !== null).map((r) => r.createdByRunId)),
	];
	const started = new Map<string, string[]>();
	if (runIds.length > 0) {
		const roots = await db
			.select({
				causationId: events.causationId,
				senderAgentId: events.senderAgentId,
				postId: sql<string>`${events.payload}->>'post_id'`,
			})
			.from(events)
			.where(
				and(
					inArray(
						events.causationId,
						runIds.map((id) => `run:${id}`),
					),
					// Only a new Mattermost root post by an agent: the signed post of the run's own bot.
					inArray(events.type, ["mattermost.post.created", "mattermost.agent.mentioned"]),
					isNotNull(events.senderAgentId),
					sql`${events.payload} ? 'post_id'`,
					sql`(${events.payload}->>'root_id') is null`,
				),
			);
		const runAgent = new Map(rows.map((row) => [`run:${row.createdByRunId}`, row.agentId]));
		for (const root of roots) {
			const key = root.causationId ?? "";
			if (runAgent.get(key) === root.senderAgentId) {
				started.set(key, [...(started.get(key) ?? []), root.postId]);
			}
		}
	}
	return rows.map((row) => ({
		id: row.id,
		agentId: row.agentId,
		condition: row.condition,
		timeoutAt: row.timeoutAt,
		threadRootIds:
			row.threadRootIds === null
				? null
				: new Set([...row.threadRootIds, ...(started.get(`run:${row.createdByRunId}`) ?? [])]),
	}));
}

/**
 * Consumes a wait atomically: only an active wait changes, so two events racing for the same
 * wait resolve it once. Sibling waits of the same run are cancelled. Returns whether this
 * event resolved it.
 */
export async function resolveWait(
	uow: UnitOfWork,
	waitId: Uuid,
	eventId: Uuid,
	timedOut: boolean,
): Promise<boolean> {
	const { db } = uow.tx;
	const [wait] = await db
		.update(waitSubscriptions)
		.set({
			status: timedOut ? "timed_out" : "matched",
			matchedEventId: eventId,
			resolvedAt: uow.now,
		})
		.where(and(eq(waitSubscriptions.id, waitId), eq(waitSubscriptions.status, "active")))
		.returning({ runId: waitSubscriptions.createdByRunId });
	if (wait === undefined) {
		return false;
	}
	await db
		.update(waitSubscriptions)
		.set({ status: "cancelled", resolvedAt: uow.now })
		.where(
			and(
				eq(waitSubscriptions.createdByRunId, wait.runId),
				eq(waitSubscriptions.status, "active"),
				ne(waitSubscriptions.id, waitId),
			),
		);
	return true;
}

/**
 * The loop guards of normal routing, applied to a wait match found after the fact (hop,
 * cascade, rate, duplicate payload, pairwise, self-post). Records the decision as a route, so
 * the budget is spent and a refusal is not retried.
 */
async function lateMatchAllowed(
	uow: UnitOfWork,
	agentId: string,
	event: GatewayEvent,
	position: StoredEventPosition,
	wait: ActiveWait,
): Promise<boolean> {
	const eventId = position.id;
	const { db } = uow.tx;
	const config = await loadActiveConfig(db);
	const agent = (await loadAgents(db)).find((a) => a.id === agentId);
	if (config === null || agent === undefined) {
		return false;
	}
	const limits = config.organization.organization.default_limits;
	const guards = await loopStats(uow, event, position);
	const [route] = routeEvent({
		event,
		agents: [toRoutingAgent(agent, await loadTeamChannels(db))],
		waits: [wait],
		limits,
		stats: guards.stats,
		now: uow.now,
	});
	const allowed = route?.decision === "wait-match";
	await db
		.insert(eventRoutes)
		.values({
			eventId,
			agentId,
			decision: allowed ? "wait-match" : (route?.decision ?? "ignore"),
			reasonCode: allowed ? "wait_matched_late" : (route?.reason ?? "no_match"),
			waitId: wait.id,
			cascadeAnchor: guards.cascadeAnchor,
			policySnapshot: { config_version: config.version, hop: event.hop, limits },
			createdAt: uow.now,
		})
		.onConflictDoNothing();
	if (route?.decision === "blocked") {
		await raiseAlert(
			uow,
			`loop:${eventId}:${agentId}`,
			`Loop guard '${route.reason}' kept a late answer from resuming @${agentId} in '${event.correlationid}'.`,
			{ event_id: eventId, agent_id: agentId, reason: route.reason, hop: event.hop },
		);
	}
	return allowed;
}

/** Cancels every active wait of an agent, e.g. when it is disabled. Returns the cancelled ids. */
export async function cancelActiveWaits(uow: UnitOfWork, agentId: string): Promise<string[]> {
	const rows = await uow.tx.db
		.update(waitSubscriptions)
		.set({ status: "cancelled", resolvedAt: uow.now })
		.where(and(eq(waitSubscriptions.agentId, agentId), eq(waitSubscriptions.status, "active")))
		.returning({ id: waitSubscriptions.id, correlationId: waitSubscriptions.correlationId });
	return rows.map((row) => row.correlationId);
}

/**
 * Catches answers that arrived before the agent's wait existed, or while the wait was being
 * committed: pending inbox entries of the agent, and every event of a waited-on correlation
 * received since the waiting run was queued (an untargeted thread reply is stored without an
 * inbox entry). The first match resolves its wait and becomes the resuming inbox entry. Posts of
 * channels outside `allowed` (the agent's channels now) answer nothing.
 * Call with the agent row locked. Returns whether a wait was resolved.
 */
export async function matchMissedAnswers(
	uow: UnitOfWork,
	agentId: string,
	allowed: ReadonlySet<string>,
): Promise<boolean> {
	const { db } = uow.tx;
	const waitRows = await db
		.select({ wait: waitSubscriptions, runQueuedAt: agentRuns.queuedAt })
		.from(waitSubscriptions)
		.innerJoin(agentRuns, eq(agentRuns.id, waitSubscriptions.createdByRunId))
		.where(and(eq(waitSubscriptions.agentId, agentId), eq(waitSubscriptions.status, "active")));
	if (waitRows.length === 0) {
		return false;
	}
	const waits = await toActiveWaits(
		db,
		waitRows.map(({ wait }) => wait),
	);
	const since = new Date(Math.min(...waitRows.map((row) => row.runQueuedAt.getTime())));
	const correlations = [...new Set(waitRows.map(({ wait }) => wait.correlationId))];

	const pendingEventIds = db
		.select({ id: agentInbox.eventId })
		.from(agentInbox)
		.where(and(eq(agentInbox.agentId, agentId), eq(agentInbox.status, "pending")));
	const routed = new Set(
		(
			await db
				.select({ eventId: agentInbox.eventId })
				.from(agentInbox)
				.where(and(eq(agentInbox.agentId, agentId), eq(agentInbox.status, "pending")))
		).map((row) => row.eventId),
	);
	const candidates = await db
		.select()
		.from(events)
		.where(
			or(
				inArray(events.id, pendingEventIds),
				and(inArray(events.correlationId, correlations), gte(events.receivedAt, since)),
			),
		)
		.orderBy(events.receivedAt, events.id);

	if (candidates.length === 0) {
		return false;
	}
	const candidateIds = candidates.map((row) => row.id);
	// Events the agent already handled in a run are not answers to a wait created afterwards.
	const handled = await db
		.select({ eventId: agentInbox.eventId })
		.from(agentInbox)
		.where(
			and(
				eq(agentInbox.agentId, agentId),
				ne(agentInbox.status, "pending"),
				inArray(agentInbox.eventId, candidateIds),
			),
		);
	// Events routing refused for this agent (loop guards, self-posts) cannot resume it either.
	const refused = await db
		.select({ eventId: eventRoutes.eventId })
		.from(eventRoutes)
		.where(
			and(
				eq(eventRoutes.agentId, agentId),
				inArray(eventRoutes.decision, ["blocked", "ignore"]),
				inArray(eventRoutes.eventId, candidateIds),
			),
		);
	const seen = new Set([...handled, ...refused].map((row) => row.eventId));
	// A post deleted before the wait saw it answers nothing.
	const deleted = await deletedPosts(db, candidates.map(toGatewayEvent));

	for (const row of candidates) {
		if (seen.has(row.id)) {
			continue;
		}
		const event = toGatewayEvent(row);
		const post = mattermostPost(event);
		if (post !== null && (deleted.has(post.post_id) || !allowed.has(post.channel_id))) {
			continue;
		}
		const wait = waits.find((w) => waitMatches(w, event, uow.now));
		if (wait === undefined) {
			continue;
		}
		// A pending inbox entry already passed the loop guards as a wake-up. A stored-only event
		// was never routed to this agent: it gets the guards and spends budget now.
		if (!routed.has(row.id) && !(await lateMatchAllowed(uow, agentId, event, row, wait))) {
			continue;
		}
		if (!(await resolveWait(uow, wait.id, row.id, false))) {
			continue;
		}
		await db
			.insert(agentInbox)
			.values({
				agentId,
				eventId: row.id,
				status: "pending",
				priority: WAIT_PRIORITY,
				availableAt: uow.now,
				waitId: wait.id,
				createdAt: uow.now,
			})
			.onConflictDoUpdate({
				target: [agentInbox.agentId, agentInbox.eventId],
				set: { waitId: wait.id, priority: WAIT_PRIORITY },
			});
		return true;
	}
	return false;
}
