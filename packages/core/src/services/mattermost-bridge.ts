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
	SERVICE_DATABASE_LIMITS,
	sourceCursors,
	withTransaction,
} from "@agent-gateway/db";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type pg from "pg";
import { agentChannelIds, grantedChannels } from "../channel-access.ts";
import { setDirectoryEntry, setDirectoryEntryIn, TEAM_CHANGE_MARKER } from "./admin.ts";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import type { IngestAdmission } from "./ingest.ts";
import {
	audit,
	loadActiveConfig,
	loadChannelAccess,
	loadDirectory,
	loadProvisioningAdminUserId,
	lockConfigShared,
	NEW_POST_EVENT_TYPES,
	PROVISIONING_ADMIN_DIRECTORY_NAME,
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
	/** The provisioning admin account's own id, or null before it is resolved (ADR-026): its posts
	 * route like the listener's own, never a wake-up or an approval. */
	adminUserId: MattermostId | null;
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
		// resolved (after a team change, before bootstrap) nothing is managed. Granted channels
		// are managed as long as a grant holds.
		const access = await loadChannelAccess(tx.db);
		const managed = new Map<MattermostId, string>();
		for (const name of config.organization.mattermost.channels) {
			const id = access.named.get(name);
			if (id !== undefined) {
				managed.set(id, name);
			}
		}
		for (const [id, name] of grantedChannels(access)) {
			if (!managed.has(id)) {
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
				channelIds: agentChannelIds({ id: row.id, config: row.config }, access),
			})),
			adminUserId: await loadProvisioningAdminUserId(tx.db),
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

/**
 * Where the listener bot posts: alerts and approval cards each in the channel configured for
 * them, and answers in a card's thread in that card's own channel, as long as it is managed.
 */
export type ListenerPurpose = "alerts" | "approvals" | Readonly<{ channelId: MattermostId }>;

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
		let channelId: MattermostId | null;
		if (typeof purpose === "object") {
			channelId = snapshot.channels.has(purpose.channelId) ? purpose.channelId : null;
		} else {
			const name = purpose === "alerts" ? mattermost.alerts_channel : mattermost.approvals_channel;
			channelId =
				[...snapshot.channels].find(([, channelName]) => channelName === name)?.[0] ?? null;
		}
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

/** An agent's own stored configuration (its current row, whether or not it is in the active
 * bundle): the lifecycle provisioner's one read of `username`/`display_name`/`allowed_channels`
 * for a `create`/`restore`/`reprovision` operation, by the id the operation already names. */
export async function loadAgentConfig(
	deps: ControlPlaneDeps,
	agentId: AgentId,
): Promise<AgentConfig | null> {
	const [row] = await poolDb(deps)
		.select({ config: agents.config })
		.from(agents)
		.where(eq(agents.id, agentId));
	return row?.config ?? null;
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
		         and (c.organization -> 'mattermost' -> 'channels') ? d.name
		      union
		      -- Grants as the channel access counts them: the agent's current bot, the active
		      -- configuration, the configured team.
		      select gr.channel_id
		        from mattermost_channel_grants gr
		        join mattermost_identities i
		          on i.agent_id = gr.agent_id and i.mattermost_user_id = gr.bot_user_id
		        join agents a on a.id = gr.agent_id
		        join gateway_controls g2 on g2.id = 1 and a.config_version = g2.active_config_version
		        join mattermost_directory t on t.kind = 'team' and t.mattermost_id = gr.team_id
		       where gr.state = 'active')`,
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

/**
 * Every Mattermost account id this Gateway has ever recorded as its own provisioning admin
 * (ADR-026): the current one (`#provisioning-admin`'s own directory entry, which this also
 * includes) plus every id a prior `directory.set` ever audited for that same name — an admin
 * account rotated away from (`gateway mattermost admin-token set` pointed at a different account,
 * not merely a token rotation of the same one) is still this Gateway's own as far as a bot it
 * created on its behalf is concerned, so retirement's own recovery path
 * (`findPlausibleGatewayBot`, `@agent-gateway/mattermost`) does not mistake a bot owned by an
 * earlier admin account for an unrelated integration's merely because the admin account has since
 * moved on. Empty only when the provisioner has never resolved an admin account at all.
 */
export async function loadKnownProvisioningAdminIds(
	deps: ControlPlaneDeps,
): Promise<ReadonlySet<MattermostId>> {
	const rows = await poolDb(deps)
		.select({ detail: auditLog.detail })
		.from(auditLog)
		.where(
			and(
				eq(auditLog.action, "directory.set"),
				eq(auditLog.subjectType, "user"),
				eq(auditLog.subjectId, PROVISIONING_ADMIN_DIRECTORY_NAME),
			),
		);
	const ids = new Set<MattermostId>();
	for (const row of rows) {
		const id = row.detail.mattermost_id;
		if (typeof id === "string") {
			ids.add(id);
		}
	}
	return ids;
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
		grantedChannelIds: (bot: Readonly<{ agentId: AgentId | null }>) =>
			loadGrantedChannelIds(deps, bot.agentId),
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
		grantedChannelIds: (bot: Readonly<{ agentId: AgentId | null }>) =>
			loadGrantedChannelIds(deps, bot.agentId),
	};
}

/**
 * Advisory lock key serializing every writer of a Mattermost bot or admin credential (ADR-026):
 * `gateway mattermost bootstrap`, `admin-token set|rotate`, and the lifecycle provisioner's own
 * pass each hold this one for as long as they create, token or revoke a Mattermost account, so no
 * two of them ever interleave those writes — one revoking a token another just issued, or
 * deactivating a bot another just re-enabled. Exported so `admin-token set|rotate`
 * (`apps/cli/src/mattermost-commands.ts`, its own pool, never `ControlPlaneDeps`) and the
 * provisioner's own pass (`apps/controller/src/agent-provisioner.ts`, a try-lock that skips its
 * tick rather than waiting) take the very same key `withBootstrapLock` does. `ADMIN_TOKEN_LOCK` and
 * the provisioner's own `PROVISIONER_PASS_LOCK` stay distinct keys of their own, still serializing
 * two runs of the very same command against each other.
 */
export const MATTERMOST_CREDENTIAL_LOCK = "agent-gateway:mattermost-credentials";

/** How long a blocking acquire of {@link MATTERMOST_CREDENTIAL_LOCK} waits before giving up with a
 * clear error, rather than hanging indefinitely: the same bound a service's own connections already
 * apply to any lock wait ({@link SERVICE_DATABASE_LIMITS}), long enough for a provisioner pass or
 * another bootstrap/admin-token run already holding it to finish its own bounded sequence of
 * Mattermost calls. */
const CREDENTIAL_LOCK_WAIT_MS = SERVICE_DATABASE_LIMITS.lockTimeoutMs;

/** `withMattermostCredentialLock` gave up waiting for {@link MATTERMOST_CREDENTIAL_LOCK}: another
 * bootstrap, `admin-token set|rotate`, or provisioner pass is still holding it. */
export class MattermostCredentialLockTimeoutError extends Error {
	constructor() {
		super(
			`could not acquire the Mattermost credential lock within ${CREDENTIAL_LOCK_WAIT_MS}ms; ` +
				"another 'mattermost bootstrap', 'admin-token set/rotate', or the lifecycle provisioner " +
				"is still running against the same Mattermost account; wait for it to finish and run " +
				"this again",
		);
		this.name = "MattermostCredentialLockTimeoutError";
	}
}

/** The Postgres SQLSTATE a statement waiting on a lock gets when `lock_timeout` elapses first
 * (`lock_not_available`). */
const LOCK_NOT_AVAILABLE = "55P03";

function isLockTimeout(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === LOCK_NOT_AVAILABLE
	);
}

/**
 * Blocks, on `client`'s own session, up to {@link CREDENTIAL_LOCK_WAIT_MS} acquiring
 * {@link MATTERMOST_CREDENTIAL_LOCK} — throwing {@link MattermostCredentialLockTimeoutError} rather
 * than hanging indefinitely when another writer still holds it. Takes an already-connected client
 * rather than a pool, so a caller that already holds one connection of its own (`admin-token
 * set|rotate`'s own `ADMIN_TOKEN_LOCK`, taken on a pool sized for exactly one connection) can nest
 * this lock on the very same session instead of a second `pool.connect()` that would otherwise
 * deadlock waiting on itself. Paired with {@link releaseMattermostCredentialLock}.
 */
export async function acquireMattermostCredentialLock(client: pg.PoolClient): Promise<void> {
	await client.query(`set lock_timeout = ${CREDENTIAL_LOCK_WAIT_MS}`);
	try {
		await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [
			MATTERMOST_CREDENTIAL_LOCK,
		]);
	} catch (error) {
		if (isLockTimeout(error)) {
			throw new MattermostCredentialLockTimeoutError();
		}
		throw error;
	} finally {
		// `lock_timeout` was only ever meant to bound the wait above; a connection a caller goes on
		// to reuse (pooled or not) must not keep applying it to whatever unrelated query runs next.
		await client.query("set lock_timeout = default").catch(() => undefined);
	}
}

/** Releases a lock {@link acquireMattermostCredentialLock} acquired on the same client. */
export async function releaseMattermostCredentialLock(client: pg.PoolClient): Promise<void> {
	await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [
		MATTERMOST_CREDENTIAL_LOCK,
	]);
}

/**
 * Tries, without waiting, to acquire {@link MATTERMOST_CREDENTIAL_LOCK} on `client`'s own session:
 * true when it was free and is now held, false when another writer already holds it. The
 * lifecycle provisioner's own pass uses this (never the blocking
 * {@link acquireMattermostCredentialLock}) to skip its tick instead of waiting behind a CLI command
 * with no bound on how long an operator takes to run it. Released the same way, with
 * {@link releaseMattermostCredentialLock}.
 */
export async function tryAcquireMattermostCredentialLock(client: pg.PoolClient): Promise<boolean> {
	const result = await client.query<{ locked: boolean }>(
		"select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
		[MATTERMOST_CREDENTIAL_LOCK],
	);
	return result.rows[0]?.locked === true;
}

/**
 * Runs `work` holding the Mattermost credential lock (a session-level advisory lock on its own,
 * dedicated connection), so two bootstraps, or a bootstrap and a provisioner pass or an
 * `admin-token set|rotate`, never interleave their membership or credential changes.
 */
export async function withBootstrapLock<T>(
	deps: ControlPlaneDeps,
	work: () => Promise<T>,
): Promise<T> {
	const client = await deps.pool.connect();
	// A client whose unlock failed may still hold the lock: it is closed, not pooled (the same
	// margin `runProvisionerPass`/`runRetentionIfDue` leave).
	let unlocked = true;
	try {
		await acquireMattermostCredentialLock(client);
		try {
			return await work();
		} finally {
			unlocked = false;
			await releaseMattermostCredentialLock(client);
			unlocked = true;
		}
	} finally {
		client.release(!unlocked);
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
		// Managed right now: a channel of the configured team, named in the configuration or
		// granted to an agent (a replaced, removed or revoked channel's surviving floor admits
		// nothing).
		const config = await loadActiveConfig(tx.db);
		const access = await loadChannelAccess(tx.db);
		const name = [...access.named].find(([, id]) => id === channelId)?.[0];
		const configured =
			name !== undefined && config?.organization.mattermost.channels.includes(name) === true;
		if (config === null || (!configured && !grantedChannels(access).has(channelId))) {
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

/**
 * Channels granted to an agent's current bot, or (for the listener, `agentId` null) to any
 * agent: bootstrap keeps its bots in them, and reconcile counts them as allowed.
 */
export async function loadGrantedChannelIds(
	deps: ControlPlaneDeps,
	agentId: AgentId | null,
): Promise<ReadonlySet<MattermostId>> {
	return inTransaction(deps, async ({ tx }) => {
		const access = await loadChannelAccess(tx.db);
		return agentId === null
			? new Set(grantedChannels(access).keys())
			: new Set((access.granted.get(agentId) ?? []).map((grant) => grant.channelId));
	});
}
