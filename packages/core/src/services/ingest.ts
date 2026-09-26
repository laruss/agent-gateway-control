import {
	type AgentId,
	type GatewayEvent,
	GatewayEventSchema,
	isReservedEventType,
	type Uuid,
	WaitTimeoutDataSchema,
} from "@agent-gateway/contracts";
import {
	agentInbox,
	eventRoutes,
	events,
	waitSubscriptions,
	withTransaction,
} from "@agent-gateway/db";
import {
	contentHash,
	eventSenderAgentId,
	GATEWAY_SOURCE,
	payloadHash,
} from "@agent-gateway/events";
import { and, eq } from "drizzle-orm";
import { type Route, type RoutingAgent, routeEvent, wakePriority } from "../routing.ts";
import type { ActiveWait } from "../waits.ts";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import { loopStats } from "./loop-stats.ts";
import { scheduleAgent } from "./scheduler.ts";
import {
	audit,
	loadActiveConfig,
	loadAgents,
	loadTeamChannels,
	lockAgent,
	lockCascade,
	lockConfigShared,
	raiseAlert,
	toRoutingAgent,
} from "./store.ts";
import { resolveWait } from "./wait-store.ts";

/**
 * Lifecycle, wait, approval, timer and control events, the Gateway source and the
 * `system-trusted` label belong to the controller only; external ingest refuses them.
 */
export class ReservedEventError extends Error {
	constructor(type: string) {
		super(`event type '${type}' is reserved for the Gateway and cannot be ingested`);
		this.name = "ReservedEventError";
	}
}

export type IngestStatus = "accepted" | "duplicate" | "conflict";

export type IngestResult = Readonly<{
	status: IngestStatus;
	eventId: Uuid;
	routes: Readonly<Route[]>;
}>;

/**
 * Durably accepts one event: dedupe on `(source, id)`, deterministic routing, inbox entries,
 * wait matches and run scheduling, all in one transaction. The source may be acknowledged only
 * after this resolves. A redelivery returns `duplicate` and changes nothing.
 */
export async function ingestEvent(
	deps: ControlPlaneDeps,
	event: GatewayEvent,
): Promise<IngestResult> {
	const valid = externalEvent(event);
	return withTransaction(deps.pool, (tx) =>
		ingestInTransaction({ deps, tx, jobs: deps.jobs(tx), now: deps.clock() }, valid),
	);
}

/** Whether an event may still be ingested, decided inside the ingest transaction. */
export type IngestAdmission = (uow: UnitOfWork) => Promise<boolean>;

/**
 * {@link ingestEvent}, but only if `admit` holds, checked in the same transaction under the
 * event's cascade lock and the configuration row in share mode (the order every ingest takes):
 * a config apply cannot change what `admit` reads between the check and the routing. Null when
 * the event was not admitted (nothing is stored).
 */
export async function ingestEventIf(
	deps: ControlPlaneDeps,
	event: GatewayEvent,
	admit: IngestAdmission,
): Promise<IngestResult | null> {
	const valid = externalEvent(event);
	return withTransaction(deps.pool, async (tx) => {
		const uow: UnitOfWork = { deps, tx, jobs: deps.jobs(tx), now: deps.clock() };
		await lockCascade(uow, valid.correlationid);
		await lockConfigShared(uow);
		if (!(await admit(uow))) {
			return null;
		}
		return ingestInTransaction(uow, valid);
	});
}

function externalEvent(event: GatewayEvent): GatewayEvent {
	const valid = GatewayEventSchema.parse(event);
	if (
		isReservedEventType(valid.type) ||
		valid.source === GATEWAY_SOURCE ||
		valid.trustlevel === "system-trusted"
	) {
		throw new ReservedEventError(valid.type);
	}
	return valid;
}

export async function ingestInTransaction(
	uow: UnitOfWork,
	event: GatewayEvent,
): Promise<IngestResult> {
	const { db } = uow.tx;
	const hash = payloadHash(event);
	// Serializes each cascade from before the event gets its sequence number: within a
	// correlation, sequence order is lock order, so guards that count earlier events (budget,
	// duplicates) see every concurrent one.
	await lockCascade(uow, event.correlationid);
	const inserted = await db
		.insert(events)
		.values({
			specversion: event.specversion,
			externalId: event.id,
			source: event.source,
			type: event.type,
			subject: event.subject ?? null,
			time: new Date(event.time),
			correlationId: event.correlationid,
			causationId: event.causationid,
			traceparent: event.traceparent ?? null,
			trustLevel: event.trustlevel,
			hop: event.hop,
			payload: event.data,
			payloadHash: hash,
			contentHash: contentHash(event),
			senderAgentId: eventSenderAgentId(event),
			receivedAt: uow.now,
		})
		.onConflictDoNothing({ target: [events.source, events.externalId] })
		.returning({ id: events.id, seq: events.seq, receivedAt: events.receivedAt });
	const position = inserted[0];
	if (position === undefined) {
		return duplicate(uow, event, hash);
	}
	const eventId = position.id;

	// Configuration cannot change while this event is routed (config apply takes this row).
	await lockConfigShared(uow);
	const config = await loadActiveConfig(db);
	if (config === null) {
		uow.deps.log.warn("no active configuration; event stored without routing", {
			event_id: eventId,
		});
		return { status: "accepted", eventId, routes: [] };
	}
	const channels = await loadTeamChannels(db);
	const toRouting = (list: Awaited<ReturnType<typeof loadAgents>>): RoutingAgent[] =>
		list.map((agent) => toRoutingAgent(agent, channels));
	// Every agent this event may wake is locked, in id order, before routing reads its state:
	// the lock order of every use case (cascade, then agents by id, then runs and waits), and no
	// concurrent disable or pause can slip between the decision and its effect.
	const waits = await candidateWaits(uow, event);
	const involved = new Set<AgentId>(waits.map((wait) => wait.agentId));
	for (const agent of toRouting(await loadAgents(db))) {
		if (wakePriority(agent, event) !== null) {
			involved.add(agent.id);
		}
	}
	for (const agentId of [...involved].sort()) {
		await lockAgent(db, agentId);
	}
	const routingAgents = toRouting(await loadAgents(db));
	const guards = await loopStats(uow, event, position);
	const routes = routeEvent({
		event,
		agents: routingAgents,
		waits,
		limits: config.organization.organization.default_limits,
		stats: guards.stats,
		now: uow.now,
	});

	const toSchedule = new Set<AgentId>();
	const recorded: Route[] = [];
	for (const route of routes) {
		const final = await applyRoute(uow, route, eventId, event, routingAgents);
		recorded.push(final);
		await db.insert(eventRoutes).values({
			eventId,
			agentId: final.agentId,
			decision: final.decision,
			reasonCode: final.reason,
			waitId: final.waitId,
			cascadeAnchor: guards.cascadeAnchor,
			policySnapshot: {
				config_version: config.version,
				hop: event.hop,
				limits: config.organization.organization.default_limits,
			},
			createdAt: uow.now,
		});
		if (final.decision === "wake" || final.decision === "wait-match") {
			toSchedule.add(final.agentId);
		} else if (final.decision === "blocked") {
			await raiseAlert(
				uow,
				`loop:${eventId}:${final.agentId}`,
				`Loop guard '${final.reason}' blocked a wake-up of @${final.agentId} in '${event.correlationid}'; the cascade is stopped.`,
				{ event_id: eventId, agent_id: final.agentId, reason: final.reason, hop: event.hop },
			);
		}
	}
	// Sorted: every transaction locks agent rows in the same order.
	for (const agentId of [...toSchedule].sort()) {
		await scheduleAgent(uow, agentId);
	}
	return { status: "accepted", eventId, routes: recorded };
}

/**
 * Applies one route and returns the decision that actually took effect, which is what gets
 * recorded (and spends cascade budget). A wait-match whose wait went to a concurrent event
 * becomes an ordinary wake-up if the event addresses the agent, otherwise it is ignored.
 */
async function applyRoute(
	uow: UnitOfWork,
	route: Route,
	eventId: Uuid,
	event: GatewayEvent,
	agents: Readonly<RoutingAgent[]>,
): Promise<Route> {
	if (route.decision === "wake") {
		await addToInbox(uow, route, eventId, null);
		return route;
	}
	if (route.decision !== "wait-match" || route.waitId === null) {
		return route;
	}
	if (await resolveWait(uow, route.waitId, eventId, route.reason === "wait_timeout")) {
		await addToInbox(uow, route, eventId, route.waitId);
		return route;
	}
	const agent = agents.find((a) => a.id === route.agentId);
	const priority = agent === undefined ? null : wakePriority(agent, event);
	if (priority === null) {
		return { ...route, decision: "ignore", reason: "wait_lost", waitId: null };
	}
	const wake: Route = { ...route, decision: "wake", reason: "target", waitId: null, priority };
	await addToInbox(uow, wake, eventId, null);
	return wake;
}

async function duplicate(
	uow: UnitOfWork,
	event: GatewayEvent,
	hash: string,
): Promise<IngestResult> {
	const [existing] = await uow.tx.db
		.select({ id: events.id, payloadHash: events.payloadHash })
		.from(events)
		.where(and(eq(events.source, event.source), eq(events.externalId, event.id)));
	if (existing === undefined) {
		throw new Error(`event '${event.source}' '${event.id}' conflicted but was not found`);
	}
	if (existing.payloadHash === hash) {
		return { status: "duplicate", eventId: existing.id, routes: [] };
	}
	uow.deps.log.warn("redelivered event differs from the stored one", { event_id: existing.id });
	await audit(uow, "system", "event.conflict", "event", existing.id, {
		source: event.source,
		external_id: event.id,
	});
	return { status: "conflict", eventId: existing.id, routes: [] };
}

async function addToInbox(uow: UnitOfWork, route: Route, eventId: Uuid, waitId: Uuid | null) {
	await uow.tx.db
		.insert(agentInbox)
		.values({
			agentId: route.agentId,
			eventId,
			status: "pending",
			priority: route.priority,
			availableAt: uow.now,
			waitId,
			createdAt: uow.now,
		})
		.onConflictDoNothing({ target: [agentInbox.agentId, agentInbox.eventId] });
}

async function candidateWaits(uow: UnitOfWork, event: GatewayEvent): Promise<ActiveWait[]> {
	const timeout =
		event.type === "agent.wait.timeout" ? WaitTimeoutDataSchema.safeParse(event.data) : null;
	const rows = await uow.tx.db
		.select()
		.from(waitSubscriptions)
		.where(
			and(
				eq(waitSubscriptions.status, "active"),
				timeout?.success === true
					? eq(waitSubscriptions.id, timeout.data.wait_id)
					: eq(waitSubscriptions.correlationId, event.correlationid),
			),
		);
	return rows.map((row) => ({
		id: row.id,
		agentId: row.agentId,
		condition: row.condition,
		timeoutAt: row.timeoutAt,
	}));
}
