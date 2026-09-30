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
	| "channelPostsSince"
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

/** Posts scanned per channel for a new membership's add record. */
const EVIDENCE_SCAN_PAGES = 3;
const EVIDENCE_PAGE_SIZE = 200;
const DEFAULT_GRACE_MS = 60_000;

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

/** The newest add of `userId` among the channel's recent posts, or null. */
async function findAdd(
	client: MembershipClient,
	channelId: MattermostId,
	userId: MattermostId,
): Promise<ApiPost | null> {
	let before: MattermostId | null = null;
	for (let page = 0; page < EVIDENCE_SCAN_PAGES; page += 1) {
		const list = await client.channelPostsBefore(channelId, before, EVIDENCE_PAGE_SIZE);
		const add = newestAdd(list, userId);
		if (add !== null) {
			return add;
		}
		const last = list.order.at(-1);
		if (last === undefined || list.order.length < EVIDENCE_PAGE_SIZE) {
			return null;
		}
		before = last;
	}
	return null;
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
	pending: Map<string, number>;
	seen: Set<string>;
}>;

/**
 * Judges an add of the bot to a channel: grants it when an owner or admin made it and the
 * listener could be brought in; otherwise any grant ends and the bot leaves.
 */
async function judgeAdd(pass: BotPass, channel: ApiChannel, add: ApiPost): Promise<void> {
	const { options, state, bot, client, pending } = pass;
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

/** One bot's channels: revocations, re-adds of granted channels, and new memberships. */
async function syncBot(pass: BotPass): Promise<void> {
	const { options, state, bot, client, pending, seen } = pass;
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
		const channel = member.get(grant.channelId);
		if (channel === undefined) {
			await options.store.revoke(bot.agentId, grant.channelId, "bot_left");
			options.log.info("channel grant revoked", {
				agent_id: bot.agentId,
				channel_id: grant.channelId,
			});
			continue;
		}
		// Removed and added again between two polls: the newer add decides, not the old one.
		const since = await client.channelPostsSince(grant.channelId, grant.sinceMs);
		const readd = newestAdd(since, bot.userId);
		if (readd !== null && readd.create_at > grant.sinceMs) {
			await judgeAdd(pass, channel, readd);
		}
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
		const latest = records.find((grant) => grant.channelId === channel.id);
		const add = await findAdd(client, channel.id, bot.userId);
		// An add no newer than the latest record is the one that record came from (or older):
		// after a revocation, or a channel taken out of the configuration, only a new add counts.
		if (add !== null && (latest === undefined || add.create_at > latest.sinceMs)) {
			await judgeAdd(pass, channel, add);
			continue;
		}
		const now = options.clock().getTime();
		const first = pending.get(key) ?? now;
		pending.set(key, first);
		if (now - first >= (options.evidenceGraceMs ?? DEFAULT_GRACE_MS)) {
			pending.delete(key);
			await options.store.reject({
				agentId: bot.agentId,
				channelId: channel.id,
				channelName: channel.name,
				actorUserId: null,
				evidencePostId: null,
				reason: "no_add_record",
			});
			await client.removeChannelMember(channel.id, bot.userId);
			options.log.warn("an agent bot left a channel without an add record", {
				agent_id: bot.agentId,
				channel_id: channel.id,
			});
		}
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
	pending: Map<string, number>,
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
			await syncBot({ options, state, bot, client: connect(token), pending, seen });
		} catch (error) {
			options.log.warn("membership sync of an agent bot failed", {
				agent_id: bot.agentId,
				...errorFields(error),
			});
		}
	}
	// Memberships that went away while waiting for their add record wait no more.
	for (const key of [...pending.keys()]) {
		if (!seen.has(key)) {
			pending.delete(key);
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
	const pending = new Map<string, number>();
	let running: Promise<void> | null = null;
	let stopped = false;
	const pass = () => {
		if (stopped || running !== null) {
			return;
		}
		running = syncMembership(options, pending)
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
