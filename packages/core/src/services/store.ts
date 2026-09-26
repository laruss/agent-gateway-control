import {
	type GatewayEvent,
	GatewayEventSchema,
	type JsonObject,
	type MattermostAlertPayload,
	type MattermostId,
	type OrganizationConfig,
	QUEUES,
} from "@agent-gateway/contracts";
import {
	type AgentState,
	agents,
	auditLog,
	configVersions,
	type DirectoryKind,
	eventRoutes,
	events,
	gatewayControls,
	mattermostDirectory,
	type OutboxKind,
	outbox,
} from "@agent-gateway/db";
import { and, asc, count, eq, inArray, isNull, max } from "drizzle-orm";
import type { RoutingAgent } from "../routing.ts";
import type { AgentRecord } from "../turn-context.ts";
import type { UnitOfWork } from "./deps.ts";

/** Event types of new posts, as opposed to edits, deletions and recovered posts. */
export const NEW_POST_EVENT_TYPES = [
	"mattermost.post.created",
	"mattermost.agent.mentioned",
	"mattermost.thread.reply",
] as const;

export type ActiveConfig = Readonly<{
	version: string;
	organization: OrganizationConfig;
	constitution: string;
}>;

type Db = UnitOfWork["tx"]["db"];

export async function loadActiveConfig(db: Db): Promise<ActiveConfig | null> {
	const rows = await db
		.select({
			version: configVersions.version,
			organization: configVersions.organization,
			constitution: configVersions.constitution,
		})
		.from(gatewayControls)
		.innerJoin(configVersions, eq(configVersions.version, gatewayControls.activeConfigVersion))
		.where(eq(gatewayControls.id, 1));
	return rows[0] ?? null;
}

export async function isKillSwitchOn(db: Db): Promise<boolean> {
	const rows = await db
		.select({ killSwitch: gatewayControls.killSwitch })
		.from(gatewayControls)
		.where(eq(gatewayControls.id, 1));
	return rows[0]?.killSwitch ?? false;
}

type AgentRow = typeof agents.$inferSelect;

export function toAgentRecord(row: AgentRow): AgentRecord {
	return {
		id: row.id,
		displayName: row.displayName,
		state: row.state,
		config: row.config,
		rolePrompt: row.rolePrompt,
		configVersion: row.configVersion,
	};
}

export async function loadAgents(db: Db): Promise<AgentRecord[]> {
	const rows = await db.select().from(agents).orderBy(asc(agents.id));
	return rows.map(toAgentRecord);
}

/** The current cascade of a correlation and the wake-ups it has granted. */
export type CascadeBudget = Readonly<{ anchor: number | null; spent: number }>;

/**
 * A cascade starts with the latest new human post of the correlation (a new human instruction
 * or answer is a new cascade; `anchor` is that post's `seq`, null before any). Edits, deletions
 * and recovered posts are no new words and start nothing. Every granted `wake` or
 * `wait-match` route records the anchor it was granted under, so the budget counts exactly the
 * wake-ups of the current cascade, whenever and for whichever event they were granted.
 */
export async function cascadeBudget(db: Db, correlationId: string): Promise<CascadeBudget> {
	const [start] = await db
		.select({ seq: max(events.seq) })
		.from(events)
		.where(
			and(
				eq(events.correlationId, correlationId),
				eq(events.trustLevel, "human-trusted"),
				eq(events.hop, 0),
				inArray(events.type, [...NEW_POST_EVENT_TYPES]),
			),
		);
	const anchor = start?.seq ?? null;
	const [spent] = await db
		.select({ n: count() })
		.from(eventRoutes)
		.innerJoin(events, eq(events.id, eventRoutes.eventId))
		.where(
			and(
				eq(events.correlationId, correlationId),
				inArray(eventRoutes.decision, ["wake", "wait-match"]),
				anchor === null ? isNull(eventRoutes.cascadeAnchor) : eq(eventRoutes.cascadeAnchor, anchor),
			),
		);
	return { anchor, spent: spent?.n ?? 0 };
}

/**
 * Transaction-scoped lock of one cascade (correlation). Taken before any agent row lock, so it
 * never inverts the agent -> wait lock order.
 */
export async function lockCascade(uow: UnitOfWork, correlationId: string): Promise<void> {
	await uow.tx.client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
		`cascade:${correlationId}`,
	]);
}

/**
 * Holds the global controls row in share mode: configuration (and kill-all) cannot change
 * until the transaction ends. Taken after cascade locks and before any agent lock.
 */
export async function lockConfigShared(uow: UnitOfWork): Promise<void> {
	await uow.tx.db
		.select({ id: gatewayControls.id })
		.from(gatewayControls)
		.where(eq(gatewayControls.id, 1))
		.for("share");
}

/**
 * Locks the agent row for the rest of the transaction; every state change goes through it.
 * `FOR NO KEY UPDATE` does not conflict with the `FOR KEY SHARE` locks that inserting inbox or
 * route rows takes through their foreign keys, so two ingests for one agent do not deadlock.
 */
export async function lockAgent(db: Db, agentId: string): Promise<AgentRow | null> {
	const rows = await db.select().from(agents).where(eq(agents.id, agentId)).for("no key update");
	return rows[0] ?? null;
}

export async function setAgentState(
	uow: UnitOfWork,
	agentId: string,
	from: AgentState,
	to: AgentState,
	reason: string,
): Promise<void> {
	if (from === to) {
		return;
	}
	await uow.tx.db
		.update(agents)
		.set({ state: to, enabled: to !== "disabled", stateChangedAt: uow.now, updatedAt: uow.now })
		.where(eq(agents.id, agentId));
	await audit(uow, "system", "agent.state", "agent", agentId, { from, to, reason });
}

export async function loadDirectory(
	db: Db,
	kind: DirectoryKind,
): Promise<Map<string, MattermostId>> {
	const rows = await db
		.select({ name: mattermostDirectory.name, id: mattermostDirectory.mattermostId })
		.from(mattermostDirectory)
		.where(eq(mattermostDirectory.kind, kind));
	return new Map(rows.map((row) => [row.name, row.id]));
}

/**
 * Channel ids by name within the configured team, as bootstrap resolved them. Until bootstrap
 * has resolved the configured team (after a team change), no channel is known: names recorded
 * for another team must not stand for this one's channels.
 */
export async function loadTeamChannels(db: Db): Promise<Map<string, MattermostId>> {
	const config = await loadActiveConfig(db);
	if (config === null) {
		return new Map();
	}
	const teams = await loadDirectory(db, "team");
	return teams.has(config.organization.mattermost.team) ? loadDirectory(db, "channel") : new Map();
}

/** The organization's owners resolved to Mattermost user ids; they decide approvals. */
export async function loadOwnerUserIds(db: Db): Promise<MattermostId[]> {
	const config = await loadActiveConfig(db);
	const users = await loadDirectory(db, "user");
	const ids = (config?.organization.organization.owner_mattermost_usernames ?? []).flatMap(
		(name) => {
			const id = users.get(name);
			return id === undefined ? [] : [id];
		},
	);
	return [...new Set(ids)];
}

type EventRow = typeof events.$inferSelect;

/** Rebuilds the envelope of a stored event; stored events were validated on ingest. */
export function toGatewayEvent(row: EventRow): GatewayEvent {
	return GatewayEventSchema.parse({
		specversion: row.specversion,
		id: row.externalId,
		source: row.source,
		type: row.type,
		time: row.time.toISOString(),
		...(row.subject === null ? {} : { subject: row.subject }),
		datacontenttype: "application/json",
		correlationid: row.correlationId,
		causationid: row.causationId,
		...(row.traceparent === null ? {} : { traceparent: row.traceparent }),
		trustlevel: row.trustLevel,
		hop: row.hop,
		data: row.payload,
	});
}

export async function audit(
	uow: UnitOfWork,
	actor: string,
	action: string,
	subjectType: string,
	subjectId: string,
	detail: JsonObject = {},
): Promise<void> {
	await uow.tx.db
		.insert(auditLog)
		.values({ at: uow.now, actor, action, subjectType, subjectId, detail });
}

export type OutboxDraft = Readonly<{
	kind: OutboxKind;
	destination: string;
	payload: JsonObject;
	idempotencyKey: string;
	runId?: string;
	maxAttempts?: number;
}>;

/**
 * Inserts an outbox item and enqueues its delivery in the same transaction. A second insert
 * with the same idempotency key is a no-op; returns the new item's id, or null for a duplicate.
 */
export async function enqueueOutbox(uow: UnitOfWork, draft: OutboxDraft): Promise<string | null> {
	const inserted = await uow.tx.db
		.insert(outbox)
		.values({
			kind: draft.kind,
			destination: draft.destination,
			payload: draft.payload,
			idempotencyKey: draft.idempotencyKey,
			runId: draft.runId ?? null,
			maxAttempts: draft.maxAttempts ?? 8,
			nextAttemptAt: uow.now,
			createdAt: uow.now,
		})
		.onConflictDoNothing({ target: outbox.idempotencyKey })
		.returning({ id: outbox.id });
	const item = inserted[0];
	if (item === undefined) {
		return null;
	}
	await uow.jobs.send(QUEUES.outboxDeliver, { outboxId: item.id });
	return item.id;
}

/** Posts a diagnostic to the alerts channel through the outbox, once per key. */
export async function raiseAlert(
	uow: UnitOfWork,
	key: string,
	message: string,
	detail: JsonObject = {},
): Promise<void> {
	uow.deps.log.warn(message, { alert_key: key });
	const config = await loadActiveConfig(uow.tx.db);
	const channelName = config?.organization.mattermost.alerts_channel ?? null;
	const channels = await loadTeamChannels(uow.tx.db);
	const payload: MattermostAlertPayload = {
		channelName,
		channelId: channelName === null ? null : (channels.get(channelName) ?? null),
		message,
		detail,
	};
	await enqueueOutbox(uow, {
		kind: "mattermost.alert",
		destination: `channel/${channelName ?? "unconfigured"}`,
		payload,
		idempotencyKey: `alert:${key}`,
	});
}

/** An agent as routing sees it, with its allowed channels resolved to ids. */
export function toRoutingAgent(
	agent: AgentRecord,
	channels: ReadonlyMap<string, MattermostId>,
): RoutingAgent {
	return {
		id: agent.id,
		state: agent.state,
		wakeRules: agent.config.wake_rules,
		channelIds: new Set(
			agent.config.mattermost.allowed_channels.flatMap((name) => {
				const id = channels.get(name);
				return id === undefined ? [] : [id];
			}),
		),
	};
}
