import type { AgentId, GatewayEvent, Uuid } from "@agent-gateway/contracts";
import { agentRuns, eventRoutes, events } from "@agent-gateway/db";
import { contentHash, eventSenderAgentId } from "@agent-gateway/events";
import { and, count, eq, gt, inArray, lt } from "drizzle-orm";
import type { LoopStats } from "../routing.ts";
import type { UnitOfWork } from "./deps.ts";
import { cascadeBudget } from "./store.ts";

/** Window of the duplicate-payload and pairwise loop guards. */
const LOOP_WINDOW_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Where the event stands in acceptance order; guards count only what came before it. */
export type StoredEventPosition = Readonly<{ id: Uuid; seq: number; receivedAt: Date }>;

export type EventLoopStats = Readonly<{ stats: LoopStats; cascadeAnchor: number | null }>;

/**
 * The counters the loop guards need for one stored event, as of its acceptance: duplicates and
 * pairwise messages are counted among earlier events inside the window before it, so checking
 * an old event later (a late wait match) is not skewed by what arrived after it. The cascade
 * budget is the current one. Read inside the event's cascade lock.
 */
export async function loopStats(
	uow: UnitOfWork,
	event: GatewayEvent,
	position: StoredEventPosition,
): Promise<EventLoopStats> {
	const { db } = uow.tx;
	const windowStart = new Date(position.receivedAt.getTime() - LOOP_WINDOW_MS);
	const earlier = and(lt(events.seq, position.seq), gt(events.receivedAt, windowStart));
	const cascade = await cascadeBudget(db, event.correlationid);
	const hourly = await db
		.select({ agentId: agentRuns.agentId, n: count() })
		.from(agentRuns)
		.where(gt(agentRuns.queuedAt, new Date(uow.now.getTime() - HOUR_MS)))
		.groupBy(agentRuns.agentId);

	const hash = contentHash(event);
	const [duplicates] =
		hash === null
			? [{ n: 0 }]
			: await db
					.select({ n: count() })
					.from(events)
					.where(and(eq(events.contentHash, hash), earlier));

	// Pairwise: wake-ups this sender already caused per recipient (wake or wait-match routes,
	// addressed or not), so untargeted answers to open waits count as well.
	const sender = eventSenderAgentId(event);
	const pairs =
		sender === null
			? []
			: await db
					.select({ agentId: eventRoutes.agentId, n: count() })
					.from(eventRoutes)
					.innerJoin(events, eq(events.id, eventRoutes.eventId))
					.where(
						and(
							eq(events.senderAgentId, sender),
							earlier,
							inArray(eventRoutes.decision, ["wake", "wait-match"]),
						),
					)
					.groupBy(eventRoutes.agentId);
	const pairwiseMessages: Record<AgentId, number> = Object.fromEntries(
		pairs.map((row) => [row.agentId, row.n]),
	);
	const [thread] = await db
		.select({ n: count() })
		.from(eventRoutes)
		.innerJoin(events, eq(events.id, eventRoutes.eventId))
		.where(
			and(
				eq(events.correlationId, event.correlationid),
				earlier,
				inArray(eventRoutes.decision, ["wake", "wait-match"]),
			),
		);
	return {
		cascadeAnchor: cascade.anchor,
		stats: {
			cascadeWakes: cascade.spent,
			runsLastHour: Object.fromEntries(hourly.map((row) => [row.agentId, row.n])),
			duplicateContent: duplicates?.n ?? 0,
			pairwiseMessages,
			threadWakes: thread?.n ?? 0,
		},
	};
}
