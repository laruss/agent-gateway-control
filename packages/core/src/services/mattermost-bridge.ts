import type {
	AgentConfig,
	AgentId,
	MattermostId,
	OrganizationConfig,
} from "@agent-gateway/contracts";
import {
	agents,
	auditLog,
	createDatabase,
	type DirectoryKind,
	events,
	gatewayControls,
	mattermostDirectory,
	mattermostIdentities,
	outbox,
	sourceCursors,
	withTransaction,
} from "@agent-gateway/db";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { setDirectoryEntry, setDirectoryEntryIn, TEAM_CHANGE_MARKER } from "./admin.ts";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import type { IngestAdmission } from "./ingest.ts";
import {
	audit,
	loadActiveConfig,
	loadDirectory,
	loadTeamChannels,
	lockConfigShared,
	NEW_POST_EVENT_TYPES,
	raiseAlert,
} from "./store.ts";

/**
 * Control-plane data the Mattermost bridge reads and writes. The bridge's transport (REST,
 * WebSocket) lives outside core; this is only the state behind it.
 */

async function inTransaction<T>(
	deps: ControlPlaneDeps,
	work: (uow: UnitOfWork) => Promise<T>,
): Promise<T> {
	return withTransaction(deps.pool, (tx) =>
		work({ deps, tx, jobs: deps.jobs(tx), now: deps.clock() }),
	);
}

export type BridgeAgentRecord = Readonly<{
	id: AgentId;
	userId: MattermostId | null;
	channelIds: ReadonlySet<MattermostId>;
}>;

/** The managed channels and agent bots as the active configuration and bootstrap define them. */
export type MattermostSnapshot = Readonly<{
	organization: OrganizationConfig;
	/** Resolved managed channels, id to name; unresolved names are missing. */
	channels: ReadonlyMap<MattermostId, string>;
	agents: Readonly<BridgeAgentRecord[]>;
}>;

/**
 * A transaction that reads one consistent configuration: it holds the configuration row in
 * share mode, so a config apply (which takes that row) cannot commit between its reads.
 */
async function withConfigRead<T>(
	deps: ControlPlaneDeps,
	work: (uow: UnitOfWork) => Promise<T>,
): Promise<T> {
	return inTransaction(deps, async (uow) => {
		await lockConfigShared(uow);
		return work(uow);
	});
}

/** Null while no configuration is active. */
export async function loadMattermostSnapshot(
	deps: ControlPlaneDeps,
): Promise<MattermostSnapshot | null> {
	return withConfigRead(deps, (uow) => snapshotIn(uow));
}

async function snapshotIn({ tx }: UnitOfWork): Promise<MattermostSnapshot | null> {
	{
		const config = await loadActiveConfig(tx.db);
		if (config === null) {
			return null;
		}
		// Channel names resolve within the team bootstrap resolved; until the configured team is
		// resolved (after a team change, before bootstrap) nothing is managed.
		const resolved = await loadTeamChannels(tx.db);
		const managed = new Map<MattermostId, string>();
		for (const name of config.organization.mattermost.channels) {
			const id = resolved.get(name);
			if (id !== undefined) {
				managed.set(id, name);
			}
		}
		const rows = await tx.db
			.select({
				id: agents.id,
				config: agents.config,
				userId: mattermostIdentities.mattermostUserId,
			})
			.from(agents)
			.leftJoin(mattermostIdentities, eq(mattermostIdentities.agentId, agents.id))
			// Agents removed from the configuration are no agents any more: their bots are inert.
			.where(eq(agents.configVersion, config.version))
			.orderBy(asc(agents.id));
		return {
			organization: config.organization,
			channels: managed,
			agents: rows.map((row) => ({
				id: row.id,
				userId: row.userId ?? null,
				channelIds: new Set(
					row.config.mattermost.allowed_channels.flatMap((name) => {
						const id = resolved.get(name);
						return id === undefined ? [] : [id];
					}),
				),
			})),
		};
	}
}

/**
 * Runs `post` only while the active configuration has `agentId` and allows it in `channelId`,
 * holding the configuration row in share mode until `post` returns: a config apply that revokes
 * the permission waits for a post already authorized, and never overtakes it.
 */
export async function whileAgentMayPost<T>(
	deps: ControlPlaneDeps,
	agentId: AgentId,
	channelId: MattermostId,
	post: (userId: MattermostId | null, tokenSecretRef: string) => Promise<T>,
): Promise<Readonly<{ allowed: true; value: T }> | Readonly<{ allowed: false }>> {
	return withConfigRead(deps, async (uow) => {
		const snapshot = await snapshotIn(uow);
		const agent = snapshot?.agents.find((candidate) => candidate.id === agentId);
		if (agent === undefined || !agent.channelIds.has(channelId)) {
			return { allowed: false };
		}
		const [identity] = await uow.tx.db
			.select()
			.from(mattermostIdentities)
			.where(eq(mattermostIdentities.agentId, agentId));
		if (identity === undefined) {
			return { allowed: false };
		}
		return {
			allowed: true,
			value: await post(identity.mattermostUserId, identity.tokenSecretRef),
		};
	});
}

/** What the listener bot posts: alerts or approval cards, each in its configured channel. */
export type ListenerPurpose = "alerts" | "approvals";

/**
 * Runs `post` for the listener bot in the channel the active configuration names for `purpose`,
 * holding the configuration row in share mode until `post` returns. The channel comes from the
 * configuration now, never from when the post was decided: a moved or unmanaged channel gets
 * nothing. `channelId` and `userId` are null while bootstrap has not resolved them.
 */
export async function whileListenerMayPost<T>(
	deps: ControlPlaneDeps,
	purpose: ListenerPurpose,
	post: (
		userId: MattermostId | null,
		tokenSecretRef: string,
		channelId: MattermostId | null,
	) => Promise<T>,
): Promise<T | null> {
	return withConfigRead(deps, async (uow) => {
		const snapshot = await snapshotIn(uow);
		if (snapshot === null) {
			return null;
		}
		const { mattermost } = snapshot.organization;
		const name = purpose === "alerts" ? mattermost.alerts_channel : mattermost.approvals_channel;
		const channelId =
			[...snapshot.channels].find(([, channelName]) => channelName === name)?.[0] ?? null;
		const users = await loadDirectory(uow.tx.db, "user");
		return post(
			users.get(mattermost.listener.username) ?? null,
			mattermost.listener.token_secret_file,
			channelId,
		);
	});
}

/** The configuration bootstrap and reconcile work from: the organization and every agent. */
/** A bot whose agent the active configuration no longer has: it must lose all access. */
export type RetiredBot = Readonly<{ agentId: AgentId; username: string; userId: MattermostId }>;

export type MattermostPlanSource = Readonly<{
	/** The configuration version the plan was read from. */
	version: string;
	organization: OrganizationConfig;
	agents: Readonly<AgentConfig[]>;
	retired: Readonly<RetiredBot[]>;
}>;

export async function loadMattermostPlanSource(
	deps: ControlPlaneDeps,
): Promise<MattermostPlanSource | null> {
	return withConfigRead(deps, async ({ tx }) => planSourceIn(tx.db));
}

async function planSourceIn(db: UnitOfWork["tx"]["db"]): Promise<MattermostPlanSource | null> {
	const config = await loadActiveConfig(db);
	if (config === null) {
		return null;
	}
	const rows = await db
		.select({
			config: agents.config,
			version: agents.configVersion,
			username: mattermostIdentities.username,
			userId: mattermostIdentities.mattermostUserId,
		})
		.from(agents)
		.leftJoin(mattermostIdentities, eq(mattermostIdentities.agentId, agents.id))
		.orderBy(asc(agents.id));
	return {
		version: config.version,
		organization: config.organization,
		agents: rows.filter((row) => row.version === config.version).map((row) => row.config),
		retired: rows.flatMap((row) =>
			row.version !== config.version && row.userId !== null && row.username !== null
				? [{ agentId: row.config.id, username: row.username, userId: row.userId }]
				: [],
		),
	};
}

/** Drizzle on the pool (autocommit), for single statements. */
function poolDb(deps: ControlPlaneDeps) {
	return createDatabase(deps.pool);
}

export type MattermostIdentity = Readonly<{
	agentId: AgentId;
	userId: MattermostId | null;
	tokenSecretRef: string;
}>;

export async function loadMattermostIdentity(
	deps: ControlPlaneDeps,
	agentId: AgentId,
): Promise<MattermostIdentity | null> {
	const [row] = await poolDb(deps)
		.select()
		.from(mattermostIdentities)
		.where(eq(mattermostIdentities.agentId, agentId));
	return row === undefined
		? null
		: { agentId: row.agentId, userId: row.mattermostUserId, tokenSecretRef: row.tokenSecretRef };
}

/** Records the bot account bootstrap resolved for an agent. */
export async function setAgentBotUser(
	deps: ControlPlaneDeps,
	agentId: AgentId,
	userId: MattermostId,
	actor: string,
): Promise<void> {
	await inTransaction(deps, async (uow) => {
		const updated = await uow.tx.db
			.update(mattermostIdentities)
			.set({ mattermostUserId: userId, lastVerifiedAt: uow.now })
			.where(eq(mattermostIdentities.agentId, agentId))
			.returning({ agentId: mattermostIdentities.agentId });
		if (updated.length === 0) {
			throw new Error(`agent '${agentId}' has no Mattermost identity; apply the config first`);
		}
		await audit(uow, actor, "mattermost.bot.resolved", "agent", agentId, { user_id: userId });
	});
}

export async function markIdentityVerified(
	deps: ControlPlaneDeps,
	agentId: AgentId,
): Promise<void> {
	await poolDb(deps)
		.update(mattermostIdentities)
		.set({ lastVerifiedAt: deps.clock() })
		.where(eq(mattermostIdentities.agentId, agentId));
}

/** True when the creation of the post with this `subject` (or its recovery) is stored. */
export async function postCreationExists(
	deps: ControlPlaneDeps,
	source: string,
	subject: string,
): Promise<boolean> {
	const rows = await poolDb(deps)
		.select({ id: events.id })
		.from(events)
		.where(
			and(
				eq(events.source, source),
				eq(events.subject, subject),
				inArray(events.type, [...NEW_POST_EVENT_TYPES, "mattermost.post.recovered"]),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/**
 * The correlation of a thread, as its root post's stored creation says, or null when the root
 * is not stored. An agent's root post carries its run's cascade; replies in that thread join it.
 */
export async function threadCorrelation(
	deps: ControlPlaneDeps,
	source: string,
	rootSubject: string,
): Promise<string | null> {
	const [row] = await poolDb(deps)
		.select({ correlationId: events.correlationId })
		.from(events)
		.where(
			and(
				eq(events.source, source),
				eq(events.subject, rootSubject),
				inArray(events.type, [...NEW_POST_EVENT_TYPES, "mattermost.post.recovered"]),
			),
		)
		.limit(1);
	return row?.correlationId ?? null;
}

/** A numeric progress marker of an event source, e.g. a channel's newest synced `update_at`. */
export async function readNumericCursor(
	deps: ControlPlaneDeps,
	sourceId: string,
): Promise<number | null> {
	const [row] = await poolDb(deps)
		.select({ value: sourceCursors.cursorValue })
		.from(sourceCursors)
		.where(eq(sourceCursors.sourceId, sourceId));
	if (row === undefined) {
		return null;
	}
	const value = Number(row.value);
	return Number.isSafeInteger(value) ? value : null;
}

/** Creates a numeric cursor unless one exists; an existing cursor is kept as it is. */
export async function initNumericCursor(
	deps: ControlPlaneDeps,
	sourceId: string,
	cursorType: string,
	value: number,
): Promise<void> {
	await poolDb(deps)
		.insert(sourceCursors)
		.values({ sourceId, cursorType, cursorValue: String(value), updatedAt: deps.clock() })
		.onConflictDoNothing({ target: sourceCursors.sourceId });
}

/**
 * Moves an existing numeric cursor forward; an older value never moves it back, and a missing
 * cursor is not created (only its initialization decides where a source starts).
 */
export async function advanceNumericCursor(
	deps: ControlPlaneDeps,
	sourceId: string,
	value: number,
): Promise<void> {
	await poolDb(deps)
		.update(sourceCursors)
		.set({ cursorValue: String(value), updatedAt: deps.clock() })
		.where(
			and(
				eq(sourceCursors.sourceId, sourceId),
				sql`${sourceCursors.cursorValue}::bigint < ${value}`,
			),
		);
}

/**
 * The outbox item a signed key names: whether the Gateway made it, its status, and the post id
 * its receipt recorded (null until delivered).
 */
export type OutboxReceiptLookup = Readonly<{
	exists: boolean;
	status: string | null;
	postId: string | null;
}>;

export async function outboxReceiptPostId(
	deps: ControlPlaneDeps,
	idempotencyKey: string,
): Promise<OutboxReceiptLookup> {
	const [row] = await poolDb(deps)
		.select({ receipt: outbox.receipt, status: outbox.status })
		.from(outbox)
		.where(eq(outbox.idempotencyKey, idempotencyKey));
	if (row === undefined) {
		return { exists: false, status: null, postId: null };
	}
	const receipt = row.receipt;
	const postId =
		typeof receipt === "object" && receipt !== null && !Array.isArray(receipt)
			? receipt.postId
			: undefined;
	return { exists: true, status: row.status, postId: typeof postId === "string" ? postId : null };
}

/** Every recorded user entry (owners and the listener bot), name to id. */
export async function loadDirectoryUsers(
	deps: ControlPlaneDeps,
): Promise<ReadonlyMap<string, MattermostId>> {
	return inTransaction(deps, ({ tx }) => loadDirectory(tx.db, "user"));
}

/** Every recorded channel entry, name to id. */
export async function loadDirectoryChannels(
	deps: ControlPlaneDeps,
): Promise<ReadonlyMap<string, MattermostId>> {
	return inTransaction(deps, ({ tx }) => loadDirectory(tx.db, "channel"));
}

/** Deletes a directory entry only while it still maps `name` to `mattermostId`. */
export async function deleteDirectoryEntry(
	deps: ControlPlaneDeps,
	kind: DirectoryKind,
	name: string,
	mattermostId: MattermostId,
	actor: string,
): Promise<void> {
	await inTransaction(deps, async (uow) => {
		const deleted = await uow.tx.db
			.delete(mattermostDirectory)
			.where(
				and(
					eq(mattermostDirectory.kind, kind),
					eq(mattermostDirectory.name, name),
					eq(mattermostDirectory.mattermostId, mattermostId),
				),
			)
			.returning({ name: mattermostDirectory.name });
		if (deleted.length > 0) {
			await audit(uow, actor, "directory.delete", kind, name, { mattermost_id: mattermostId });
		}
	});
}

/**
 * Deletes the catch-up state of every channel that is not managed right now (not in the active
 * configuration, or not resolved). A team change deletes all channel state in the config apply
 * itself, so starts bootstrap stages for the new team (before recording it) are kept. One statement: it cannot race a bootstrap that starts and
 * publishes a channel in one transaction.
 */
export async function deleteUnmanagedChannelCursors(deps: ControlPlaneDeps): Promise<void> {
	await deps.pool.query(
		`delete from source_cursors s
		  where s.source_id ~ '^mattermost:channel(-floor|-floor-posts)?:'
		    and regexp_replace(s.source_id, '^mattermost:channel(-floor|-floor-posts)?:', '') not in (
		      select d.mattermost_id
		        from mattermost_directory d
		        join gateway_controls g on g.id = 1
		        join config_versions c on c.version = g.active_config_version
		       where d.kind = 'channel'
		         and (c.organization -> 'mattermost' -> 'channels') ? d.name)`,
	);
}

export type ImpersonationReport = Readonly<{
	agentId: AgentId;
	postId: MattermostId;
	channelId: MattermostId;
	reason: string;
}>;

/**
 * A post by an agent's bot that the Gateway did not sign: its token is used elsewhere. The post
 * is not routed; the attempt is audited and alerted once.
 */
export async function recordImpersonation(
	deps: ControlPlaneDeps,
	report: ImpersonationReport,
): Promise<void> {
	await inTransaction(deps, async (uow) => {
		// Sync reads a post again and again; one record per post is enough.
		const [seen] = await uow.tx.db
			.select({ id: auditLog.id })
			.from(auditLog)
			.where(
				and(
					eq(auditLog.action, "mattermost.post.rejected"),
					eq(auditLog.subjectType, "mattermost_post"),
					eq(auditLog.subjectId, report.postId),
				),
			)
			.limit(1);
		if (seen !== undefined) {
			return;
		}
		await audit(uow, "system", "mattermost.post.rejected", "mattermost_post", report.postId, {
			agent_id: report.agentId,
			channel_id: report.channelId,
			reason: report.reason,
		});
		await raiseAlert(
			uow,
			`impersonation:${report.postId}`,
			report.reason === "replayed_agent_post"
				? `A post by the bot of @${report.agentId} repeats the signed routing of an earlier post; it was not routed. Check who else holds that bot's token.`
				: `A post by the bot of @${report.agentId} carries no valid Gateway signature; it was not routed. Check who else holds that bot's token.`,
			{ agent_id: report.agentId, post_id: report.postId, channel_id: report.channelId },
		);
	});
}

/** The Mattermost id bootstrap recorded for a configured name, or null. */
export async function loadDirectoryEntry(
	deps: ControlPlaneDeps,
	kind: DirectoryKind,
	name: string,
): Promise<MattermostId | null> {
	const [row] = await poolDb(deps)
		.select({ id: mattermostDirectory.mattermostId })
		.from(mattermostDirectory)
		.where(and(eq(mattermostDirectory.kind, kind), eq(mattermostDirectory.name, name)));
	return row?.id ?? null;
}

/** Cursor ids of one Mattermost channel's catch-up. */
export function channelCursorIds(channelId: MattermostId) {
	return {
		cursor: `mattermost:channel:${channelId}`,
		floor: `mattermost:channel-floor:${channelId}`,
		floorPosts: `mattermost:channel-floor-posts:${channelId}`,
	} as const;
}

/**
 * Where a channel's catch-up starts: nothing created before `floor`, nor the posts of that very
 * millisecond that already existed, is ever replayed.
 */
export type ChannelStartRecord = Readonly<{
	cursor: number;
	floor: number;
	floorPostIds: Readonly<MattermostId[]>;
}>;

export type ChannelFloor = Readonly<{ floor: number; floorPostIds: Readonly<MattermostId[]> }>;

/** A channel's catch-up floor, or null before the channel was started. */
export async function readChannelFloor(
	deps: ControlPlaneDeps,
	channelId: MattermostId,
): Promise<ChannelFloor | null> {
	const ids = channelCursorIds(channelId);
	const floor = await readNumericCursor(deps, ids.floor);
	if (floor === null) {
		return null;
	}
	const [row] = await poolDb(deps)
		.select({ value: sourceCursors.cursorValue })
		.from(sourceCursors)
		.where(eq(sourceCursors.sourceId, ids.floorPosts));
	const floorPostIds = row === undefined || row.value === "" ? [] : row.value.split(",");
	return { floor, floorPostIds };
}

/** The records `gateway mattermost bootstrap` reads and writes. */
export function mattermostBootstrapStore(deps: ControlPlaneDeps, actor: string) {
	return {
		setUser: (name: string, id: MattermostId) => setDirectoryEntry(deps, "user", name, id, actor),
		setAgentBot: (agentId: AgentId, userId: MattermostId) =>
			setAgentBotUser(deps, agentId, userId, actor),
		recordedChannels: () => loadDirectoryChannels(deps),
		recordedUsers: () => loadDirectoryUsers(deps),
		forget: (kind: DirectoryKind, name: string, id: MattermostId) =>
			deleteDirectoryEntry(deps, kind, name, id, actor),
		recordedBotUserId: (bot: Readonly<{ agentId: AgentId | null; username: string }>) =>
			mattermostReconcileStore(deps).botUserId(bot),
		forgetChannelStart: async (channelId: MattermostId) => {
			const ids = channelCursorIds(channelId);
			await poolDb(deps)
				.delete(sourceCursors)
				.where(inArray(sourceCursors.sourceId, [ids.cursor, ids.floor, ids.floorPosts]));
		},
		hasChannelStart: async (channelId: MattermostId) =>
			(await readNumericCursor(deps, channelCursorIds(channelId).cursor)) !== null,
		/**
		 * Records the team and its channels, each channel with its catch-up start (null: keeps an
		 * existing one), in one transaction: the bridge never sees the team without its channels'
		 * starts, and nothing sees a channel managed without its start.
		 */
		publishTeam: (
			team: Readonly<{ name: string; id: MattermostId }>,
			channels: Readonly<
				Readonly<{ name: string; id: MattermostId; start: ChannelStartRecord | null }>[]
			>,
			generation: number,
		) =>
			withConfigRead(deps, async (uow) => {
				// Starts scanned under another configuration (a channel dropped and re-added
				// meanwhile) are not installed: the caller scans again.
				if ((await generationIn(uow)) !== generation) {
					return false;
				}
				for (const channel of channels) {
					if (channel.start !== null) {
						const ids = channelCursorIds(channel.id);
						const values = [
							{
								sourceId: ids.floorPosts,
								cursorType: "post_ids",
								cursorValue: channel.start.floorPostIds.join(","),
							},
							{
								sourceId: ids.floor,
								cursorType: "create_at_ms",
								cursorValue: String(channel.start.floor),
							},
							{
								sourceId: ids.cursor,
								cursorType: "update_at_ms",
								cursorValue: String(channel.start.cursor),
							},
						];
						for (const value of values) {
							await uow.tx.db
								.insert(sourceCursors)
								.values({ ...value, updatedAt: uow.now })
								.onConflictDoNothing({ target: sourceCursors.sourceId });
						}
					}
					await setDirectoryEntryIn(uow, "channel", channel.name, channel.id, actor);
				}
				await uow.tx.db
					.delete(mattermostDirectory)
					.where(
						and(eq(mattermostDirectory.kind, "team"), ne(mattermostDirectory.name, team.name)),
					);
				await setDirectoryEntryIn(uow, "team", team.name, team.id, actor);
				return true;
			}),
	};
}

/** The records `gateway mattermost reconcile` reads and writes. */
export function mattermostReconcileStore(deps: ControlPlaneDeps) {
	return {
		channelId: (name: string) => loadDirectoryEntry(deps, "channel", name),
		botUserId: async (bot: Readonly<{ agentId: AgentId | null; username: string }>) =>
			bot.agentId === null
				? loadDirectoryEntry(deps, "user", bot.username)
				: ((await loadMattermostIdentity(deps, bot.agentId))?.userId ?? null),
		markVerified: (agentId: AgentId) => markIdentityVerified(deps, agentId),
	};
}

/** Advisory lock key of `gateway mattermost bootstrap`: one bootstrap at a time. */
const BOOTSTRAP_LOCK = "mattermost-bootstrap";

/**
 * Runs `work` holding the bootstrap lock (a session-level advisory lock on its own connection),
 * so two bootstraps never interleave their membership changes.
 */
export async function withBootstrapLock<T>(deps: ControlPlaneDeps, work: () => Promise<T>) {
	const client = await deps.pool.connect();
	try {
		await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [BOOTSTRAP_LOCK]);
		try {
			return await work();
		} finally {
			await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [BOOTSTRAP_LOCK]);
		}
	} finally {
		client.release();
	}
}

/**
 * Admits a new Mattermost post only while its channel is started and the post came after that
 * start, as the catch-up state says inside the ingest transaction: a channel removed and re-added
 * meanwhile has a new start, and work still in flight from before cannot slip under it.
 */
export function afterChannelStart(
	channelId: MattermostId,
	postId: MattermostId,
	createAt: number,
): IngestAdmission {
	return async ({ tx }) => {
		// Managed right now: a channel of the configured team, named in the configuration (a
		// replaced or removed channel's surviving floor admits nothing).
		const config = await loadActiveConfig(tx.db);
		const channels = await loadTeamChannels(tx.db);
		const name = [...channels].find(([, id]) => id === channelId)?.[0];
		if (
			config === null ||
			name === undefined ||
			!config.organization.mattermost.channels.includes(name)
		) {
			return false;
		}
		const ids = channelCursorIds(channelId);
		const rows = await tx.db
			.select({ id: sourceCursors.sourceId, value: sourceCursors.cursorValue })
			.from(sourceCursors)
			.where(inArray(sourceCursors.sourceId, [ids.floor, ids.floorPosts]));
		const floorValue = rows.find((row) => row.id === ids.floor)?.value;
		if (floorValue === undefined) {
			return false;
		}
		const floor = Number(floorValue);
		const floorPosts = rows.find((row) => row.id === ids.floorPosts)?.value ?? "";
		const atFloor = floorPosts === "" ? [] : floorPosts.split(",");
		return createAt > floor || (createAt === floor && !atFloor.includes(postId));
	};
}

/**
 * Starts a channel's catch-up (all three records) only if the channel is managed right now and
 * has no start yet, in one transaction holding the configuration row in share mode: a scan that
 * outlived the channel's removal writes nothing.
 */
export async function startManagedChannel(
	deps: ControlPlaneDeps,
	channelId: MattermostId,
	start: ChannelStartRecord,
	generation: number,
): Promise<boolean> {
	return withConfigRead(deps, async (uow) => {
		const snapshot = await snapshotIn(uow);
		// Void when the channel is not managed now, or left management (removed, or a team
		// change) after the scan's generation: whatever it saw may predate a later re-adding.
		if (
			snapshot === null ||
			!snapshot.channels.has(channelId) ||
			(await leftAfter(uow, channelId, generation))
		) {
			return false;
		}
		const ids = channelCursorIds(channelId);
		const values = [
			{
				sourceId: ids.floorPosts,
				cursorType: "post_ids",
				cursorValue: start.floorPostIds.join(","),
			},
			{ sourceId: ids.floor, cursorType: "create_at_ms", cursorValue: String(start.floor) },
			{ sourceId: ids.cursor, cursorType: "update_at_ms", cursorValue: String(start.cursor) },
		];
		for (const value of values) {
			await uow.tx.db
				.insert(sourceCursors)
				.values({ ...value, updatedAt: uow.now })
				.onConflictDoNothing({ target: sourceCursors.sourceId });
		}
		return true;
	});
}

/** True when the channel left management in a generation after `generation`. */
async function leftAfter(
	{ tx }: UnitOfWork,
	channelId: MattermostId,
	generation: number,
): Promise<boolean> {
	const rows = await tx.db
		.select({ value: sourceCursors.cursorValue })
		.from(sourceCursors)
		.where(
			inArray(sourceCursors.sourceId, [`mattermost:channel-left:${channelId}`, TEAM_CHANGE_MARKER]),
		);
	return rows.some((row) => Number(row.value) > generation);
}

/** Whether a post would be admitted now (see {@link afterChannelStart}), checked on its own. */
export async function channelAdmits(
	deps: ControlPlaneDeps,
	channelId: MattermostId,
	postId: MattermostId,
	createAt: number,
): Promise<boolean> {
	return withConfigRead(deps, (uow) => afterChannelStart(channelId, postId, createAt)(uow));
}

/** The configuration generation: incremented by every config apply. */
export async function loadConfigGeneration(deps: ControlPlaneDeps): Promise<number> {
	const [row] = await poolDb(deps)
		.select({ generation: gatewayControls.configGeneration })
		.from(gatewayControls)
		.where(eq(gatewayControls.id, 1));
	return row?.generation ?? 0;
}

async function generationIn({ tx }: UnitOfWork): Promise<number> {
	const [row] = await tx.db
		.select({ generation: gatewayControls.configGeneration })
		.from(gatewayControls)
		.where(eq(gatewayControls.id, 1));
	return row?.generation ?? 0;
}
