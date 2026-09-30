import type {
	AgentId,
	ChannelGrantInput,
	GrantRecord,
	MattermostId,
	MembershipBot,
	MembershipState,
	RejectedAdd,
} from "@agent-gateway/contracts";
import { errorFields, type Logger } from "@agent-gateway/logging";
import type { ApiChannel, ApiPost, ApiPostList, ApiUser } from "./api-schemas.ts";
import { MattermostClient } from "./client.ts";

/**
 * The membership synchronizer (ADR-022): an agent works in a channel from the moment an owner or
 * a system admin adds its bot there, and stops when the bot leaves. It polls the channels of
 * every agent bot (a bot hears nothing of channels it is not in, and the listener is not there
 * yet): an add by an owner or admin becomes a grant and the agent's bot adds the listener; any
 * other add is refused (the bot leaves, the operators are alerted); a bot gone from a channel
 * loses its grant, and the listener leaves the channels nothing needs. Agents never grant: an
 * add made by a bot, another agent's included, is refused.
 */

/** The control-plane records behind the synchronizer. */
export type MembershipStore = Readonly<{
	state: () => Promise<MembershipState | null>;
	grant: (grant: ChannelGrantInput) => Promise<boolean>;
	revoke: (agentId: AgentId, channelId: MattermostId, reason: string) => Promise<boolean>;
	reject: (rejection: RejectedAdd) => Promise<void>;
	/** Those of the given channels nothing needs any more (not configured, not granted). */
	unneeded: (channelIds: Readonly<MattermostId[]>) => Promise<Readonly<MattermostId[]>>;
	/** A bot's token, read at use; null when its secret file is missing or not private. */
	token: (secretRef: string) => string | null;
}>;

/** The Mattermost calls the synchronizer makes, each with one bot's token. */
export type MembershipClient = Pick<
	MattermostClient,
	| "userChannelsInTeam"
	| "channelPostsBefore"
	| "user"
	| "isChannelMember"
	| "addChannelMember"
	| "removeChannelMember"
>;

export type MembershipSyncOptions = Readonly<{
	baseUrl: string;
	store: MembershipStore;
	log: Logger;
	clock: () => Date;
	/**
	 * How long a membership without a matching add record waits before the bot leaves: the add
	 * and its system post can be seen a moment apart.
	 */
	evidenceGraceMs?: number;
	/** For tests. */
	client?: (token: string) => MembershipClient;
}>;

/** Pages scanned for a new membership's add record. */
const EVIDENCE_SCAN_PAGES = 3;
/** Pages scanned for a re-add of a granted bot, back to the last check. */
const READD_SCAN_PAGES = 10;
const EVIDENCE_PAGE_SIZE = 200;
const DEFAULT_GRACE_MS = 60_000;
/** A post may be stored a little after its creation time: rescans overlap by this much. */
const SCAN_OVERLAP_MS = 10_000;

/** What the synchronizer remembers between passes. */
export type MembershipMemory = Readonly<{
	/** Memberships waiting for their add record, since when (ms), by `agent:channel`. */
	pending: Map<string, number>;
	/** Per granted `agent:channel`, up to when (ms) its posts were checked for a re-add. */
	scanned: Map<string, number>;
}>;

export function membershipMemory(): MembershipMemory {
	return { pending: new Map(), scanned: new Map() };
}

/** A channel type the Gateway works in: public or private, never direct or group messages. */
function isTeamChannel(channel: ApiChannel, teamId: MattermostId): boolean {
	return (
		(channel.type === "O" || channel.type === "P") &&
		channel.delete_at === 0 &&
		channel.team_id === teamId &&
		// Every team member is in it: membership there says nothing, it is granted by config only.
		channel.name !== "town-square"
	);
}

/**
 * The server's record of `userId` being added. Only the server writes system posts (clients
 * cannot create or edit them), and only its add record names the added user in `addedUserId`.
 */
function isAddOf(post: ApiPost | undefined, userId: MattermostId): post is ApiPost {
	return (
		post !== undefined &&
		post.type === "system_add_to_channel" &&
		post.props.addedUserId === userId &&
		post.delete_at === 0
	);
}

/** The newest add of `userId` in the list, or null. */
function newestAdd(list: ApiPostList, userId: MattermostId): ApiPost | null {
	let newest: ApiPost | null = null;
	for (const post of Object.values(list.posts)) {
		if (isAddOf(post, userId) && (newest === null || post.create_at > newest.create_at)) {
			newest = post;
		}
	}
	return newest;
}

/** What a scan for an add found; `complete` is false when it stopped before `afterMs`. */
type AddScan = Readonly<{ add: ApiPost | null; complete: boolean }>;

/**
 * The newest add of `userId` among the channel's posts, newest first, reading back no further
 * than posts created at `afterMs`, and at most `pages` pages.
 */
async function findAdd(
	client: MembershipClient,
	channelId: MattermostId,
	userId: MattermostId,
	afterMs: number,
	pages: number,
): Promise<AddScan> {
	let before: MattermostId | null = null;
	for (let page = 0; page < pages; page += 1) {
		const list = await client.channelPostsBefore(channelId, before, EVIDENCE_PAGE_SIZE);
		const add = newestAdd(list, userId);
		if (add !== null) {
			return { add: add.create_at > afterMs ? add : null, complete: true };
		}
		const last = list.order.at(-1);
		if (last === undefined || list.order.length < EVIDENCE_PAGE_SIZE) {
			return { add: null, complete: true };
		}
		const oldest = list.posts[last];
		if (oldest === undefined || oldest.create_at <= afterMs) {
			return { add: null, complete: true };
		}
		before = last;
	}
	return { add: null, complete: false };
}

function mayGrant(user: ApiUser, owners: ReadonlySet<MattermostId>): boolean {
	if (user.is_bot || user.delete_at !== 0) {
		return false;
	}
	return owners.has(user.id) || user.roles.split(/\s+/).includes("system_admin");
}

type BotPass = Readonly<{
	options: MembershipSyncOptions;
	state: MembershipState;
	bot: MembershipBot;
	client: MembershipClient;
	memory: MembershipMemory;
	seen: Set<string>;
}>;

/**
 * Judges an add of the bot to a channel: grants it when an owner or admin made it and the
 * listener could be brought in; otherwise any grant ends and the bot leaves.
 */
async function judgeAdd(pass: BotPass, channel: ApiChannel, add: ApiPost): Promise<void> {
	const { options, state, bot, client } = pass;
	const { pending } = pass.memory;
	const key = `${bot.agentId}:${channel.id}`;
	const base = { agentId: bot.agentId, channelId: channel.id, channelName: channel.name };
	const leave = async (rejection: RejectedAdd) => {
		pending.delete(key);
		await options.store.revoke(bot.agentId, channel.id, rejection.reason);
		await options.store.reject(rejection);
		await client.removeChannelMember(channel.id, bot.userId);
		options.log.warn("an agent bot left a channel it was not granted", {
			agent_id: bot.agentId,
			channel_id: channel.id,
			reason: rejection.reason,
		});
	};
	const actor = await client.user(add.user_id);
	if (!mayGrant(actor, state.ownerUserIds)) {
		await leave({
			...base,
			actorUserId: add.user_id,
			evidencePostId: add.id,
			reason: "not_owner_or_admin",
		});
		return;
	}
	// The agent's own bot brings the listener in: a plain member may add members by default, so
	// no admin credential is needed.
	if (!(await client.isChannelMember(channel.id, state.listener.userId))) {
		try {
			await client.addChannelMember(channel.id, state.listener.userId);
		} catch (error) {
			options.log.warn("the listener could not be added to a granted channel", {
				agent_id: bot.agentId,
				channel_id: channel.id,
				...errorFields(error),
			});
			await leave({
				...base,
				actorUserId: add.user_id,
				evidencePostId: add.id,
				reason: "listener_not_added",
			});
			return;
		}
	}
	pending.delete(key);
	const granted = await options.store.grant({
		agentId: bot.agentId,
		botUserId: bot.userId,
		teamId: state.teamId,
		channelId: channel.id,
		channelName: channel.name,
		grantorUserId: add.user_id,
		evidencePostId: add.id,
		sinceMs: add.create_at,
	});
	if (granted) {
		options.log.info("channel granted", { agent_id: bot.agentId, channel_id: channel.id });
	}
}

/** Runs one channel's step; a failure is logged and the bot's other channels go on. */
async function step(pass: BotPass, channelId: MattermostId, work: () => Promise<void>) {
	try {
		await work();
	} catch (error) {
		pass.options.log.warn("membership sync of a channel failed", {
			agent_id: pass.bot.agentId,
			channel_id: channelId,
			...errorFields(error),
		});
	}
}

/** One bot's channels: revocations, re-adds of granted channels, and new memberships. */
async function syncBot(pass: BotPass): Promise<void> {
	const { options, state, bot, client, seen } = pass;
	const { pending, scanned } = pass.memory;
	const channels = (await client.userChannelsInTeam(bot.userId, state.teamId)).filter((channel) =>
		isTeamChannel(channel, state.teamId),
	);
	const member = new Map(channels.map((channel) => [channel.id, channel]));
	const records: Readonly<GrantRecord[]> = state.grants.filter(
		(grant) => grant.agentId === bot.agentId,
	);
	const active = records.filter(
		(grant) => grant.state === "active" && grant.botUserId === bot.userId,
	);

	for (const grant of active) {
		const key = `${bot.agentId}:${grant.channelId}`;
		await step(pass, grant.channelId, async () => {
			const channel = member.get(grant.channelId);
			if (channel === undefined) {
				scanned.delete(key);
				await options.store.revoke(bot.agentId, grant.channelId, "bot_left");
				options.log.info("channel grant revoked", {
					agent_id: bot.agentId,
					channel_id: grant.channelId,
				});
				return;
			}
			// Configured as well: the configuration's rules hold there, whoever re-adds.
			if (bot.configuredChannelIds.has(grant.channelId)) {
				return;
			}
			// Removed and added again between two polls: the newer add decides, not the old one.
			// Only posts since the last check are read (newest first, overlapping a little); the
			// check counts as done only once whatever it found was judged.
			const checkedAt = options.clock().getTime() - SCAN_OVERLAP_MS;
			const after = Math.max(grant.sinceMs, scanned.get(key) ?? grant.sinceMs);
			const scan = await findAdd(client, grant.channelId, bot.userId, after, READD_SCAN_PAGES);
			if (!scan.complete) {
				// Who added the bot this time cannot be told: fail closed.
				scanned.delete(key);
				await options.store.revoke(bot.agentId, grant.channelId, "add_unverified");
				await options.store.reject({
					agentId: bot.agentId,
					channelId: grant.channelId,
					channelName: channel.name,
					actorUserId: null,
					evidencePostId: null,
					reason: "add_unverified",
				});
				await client.removeChannelMember(grant.channelId, bot.userId);
				return;
			}
			if (scan.add !== null && scan.add.create_at > grant.sinceMs) {
				await judgeAdd(pass, channel, scan.add);
			}
			scanned.set(key, checkedAt);
		});
	}

	for (const channel of channels) {
		if (
			bot.configuredChannelIds.has(channel.id) ||
			active.some((grant) => grant.channelId === channel.id)
		) {
			continue;
		}
		const key = `${bot.agentId}:${channel.id}`;
		seen.add(key);
		await step(pass, channel.id, async () => {
			const latest = records.find((grant) => grant.channelId === channel.id);
			const { add } = await findAdd(client, channel.id, bot.userId, 0, EVIDENCE_SCAN_PAGES);
			// An add no newer than the latest record is the one that record came from (or older):
			// after a revocation, or a channel taken out of the configuration, only a new add counts.
			if (add !== null && (latest === undefined || add.create_at > latest.sinceMs)) {
				await judgeAdd(pass, channel, add);
				return;
			}
			const now = options.clock().getTime();
			const first = pending.get(key) ?? now;
			pending.set(key, first);
			if (now - first < (options.evidenceGraceMs ?? DEFAULT_GRACE_MS)) {
				return;
			}
			pending.delete(key);
			await options.store.reject({
				agentId: bot.agentId,
				channelId: channel.id,
				channelName: channel.name,
				actorUserId: null,
				evidencePostId: null,
				reason:
					latest?.revokedReason === "config_removed" ? "configuration_removed" : "no_add_record",
			});
			await client.removeChannelMember(channel.id, bot.userId);
			options.log.warn("an agent bot left a channel it holds no grant for", {
				agent_id: bot.agentId,
				channel_id: channel.id,
			});
		});
	}
}

function defaultClient(options: MembershipSyncOptions) {
	return (token: string): MembershipClient =>
		new MattermostClient({ baseUrl: options.baseUrl, token });
}

/** The listener leaves every channel of the team that nothing needs any more. */
async function sweepListener(options: MembershipSyncOptions, state: MembershipState) {
	const token = options.store.token(state.listener.tokenSecretRef);
	if (token === null) {
		return;
	}
	const client = (options.client ?? defaultClient(options))(token);
	const channels = (await client.userChannelsInTeam(state.listener.userId, state.teamId)).filter(
		(channel) => isTeamChannel(channel, state.teamId),
	);
	for (const channelId of await options.store.unneeded(channels.map((channel) => channel.id))) {
		await client.removeChannelMember(channelId, state.listener.userId);
		options.log.info("the listener left a channel nothing needs", { channel_id: channelId });
	}
}

/**
 * One pass over every agent bot's channels, then the listener's. A failure with one bot (a
 * rejected token, a server error) is logged and the others go on.
 */
export async function syncMembership(
	options: MembershipSyncOptions,
	memory: MembershipMemory,
): Promise<void> {
	const state = await options.store.state();
	if (state === null) {
		return;
	}
	const connect = options.client ?? defaultClient(options);
	const seen = new Set<string>();
	for (const bot of state.bots) {
		const token = options.store.token(bot.tokenSecretRef);
		if (token === null) {
			continue;
		}
		try {
			await syncBot({ options, state, bot, client: connect(token), memory, seen });
		} catch (error) {
			options.log.warn("membership sync of an agent bot failed", {
				agent_id: bot.agentId,
				...errorFields(error),
			});
		}
	}
	// Memberships that went away while waiting for their add record wait no more.
	for (const key of [...memory.pending.keys()]) {
		if (!seen.has(key)) {
			memory.pending.delete(key);
		}
	}
	try {
		await sweepListener(options, state);
	} catch (error) {
		options.log.warn("membership sync of the listener failed", errorFields(error));
	}
}

export type RunningMembershipSync = Readonly<{ stop: () => Promise<void> }>;

/** Runs {@link syncMembership} every `intervalMs`, one pass at a time. */
export function startMembershipSync(
	options: MembershipSyncOptions & Readonly<{ intervalMs?: number }>,
): RunningMembershipSync {
	const memory = membershipMemory();
	let running: Promise<void> | null = null;
	let stopped = false;
	const pass = () => {
		if (stopped || running !== null) {
			return;
		}
		running = syncMembership(options, memory)
			.catch((error: Error) => options.log.warn("membership sync failed", errorFields(error)))
			.finally(() => {
				running = null;
			});
	};
	const timer = setInterval(pass, options.intervalMs ?? 5_000);
	timer.unref();
	pass();
	return {
		stop: async () => {
			stopped = true;
			clearInterval(timer);
			await running;
		},
	};
}
