import type { AgentId, MattermostId } from "@agent-gateway/contracts";
import { errorFields, type Logger } from "@agent-gateway/logging";
import type { ApiChannel, ApiPost, ApiUser } from "./api-schemas.ts";
import { MattermostClient } from "./client.ts";

/**
 * The membership synchronizer (ADR-022): an agent works in a channel from the moment an owner or
 * a system admin adds its bot there, and stops when the bot leaves. It polls the channels of
 * every agent bot (a bot hears nothing of channels it is not in, and the listener is not there
 * yet): an add by an owner or admin becomes a grant and the agent's bot adds the listener; any
 * other add is refused (the bot leaves, the operators are alerted); a bot gone from a channel
 * loses its grant, and the listener leaves when nothing needs the channel any more. Agents never
 * grant: an add made by a bot, another agent's included, is refused.
 */

export type MembershipBotView = Readonly<{
	agentId: AgentId;
	userId: MattermostId;
	tokenSecretRef: string;
	/** Configured channels need no grant. */
	configuredChannelIds: ReadonlySet<MattermostId>;
}>;

export type MembershipGrantView = Readonly<{
	agentId: AgentId;
	channelId: MattermostId;
	state: "active" | "revoked";
	botUserId: MattermostId;
	sinceMs: number;
}>;

export type MembershipView = Readonly<{
	teamId: MattermostId;
	ownerUserIds: ReadonlySet<MattermostId>;
	listener: Readonly<{ userId: MattermostId; tokenSecretRef: string }>;
	bots: Readonly<MembershipBotView[]>;
	grants: Readonly<MembershipGrantView[]>;
}>;

export type MembershipGrant = Readonly<{
	agentId: AgentId;
	botUserId: MattermostId;
	teamId: MattermostId;
	channelId: MattermostId;
	channelName: string;
	grantorUserId: MattermostId;
	evidencePostId: MattermostId;
	sinceMs: number;
}>;

export type MembershipRejection = Readonly<{
	agentId: AgentId;
	channelId: MattermostId;
	channelName: string;
	actorUserId: MattermostId | null;
	evidencePostId: MattermostId | null;
	reason: "not_owner_or_admin" | "no_add_record" | "listener_not_added";
}>;

/** The control-plane records behind the synchronizer. */
export type MembershipStore = Readonly<{
	view: () => Promise<MembershipView | null>;
	grant: (grant: MembershipGrant) => Promise<boolean>;
	/** True while the channel is still followed for others. */
	revoke: (agentId: AgentId, channelId: MattermostId, reason: string) => Promise<boolean>;
	reject: (rejection: MembershipRejection) => Promise<void>;
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

/** Posts scanned per channel for the add record: the add is recent when a poll finds it. */
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

/** The newest system post saying `userId` was added to the channel, or null. */
async function findAdd(
	client: MembershipClient,
	channelId: MattermostId,
	userId: MattermostId,
): Promise<ApiPost | null> {
	let before: MattermostId | null = null;
	for (let page = 0; page < EVIDENCE_SCAN_PAGES; page += 1) {
		const list = await client.channelPostsBefore(channelId, before, EVIDENCE_PAGE_SIZE);
		for (const id of list.order) {
			const post = list.posts[id];
			// Only the server writes system posts (clients cannot create or edit them), and only
			// its add record names the added user in `addedUserId`.
			if (
				post !== undefined &&
				post.type === "system_add_to_channel" &&
				post.props.addedUserId === userId &&
				post.delete_at === 0
			) {
				return post;
			}
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

/** One pass over every agent bot's channels. */
export async function syncMembership(
	options: MembershipSyncOptions,
	pending: Map<string, number>,
): Promise<void> {
	const { store, log } = options;
	const view = await store.view();
	if (view === null) {
		return;
	}
	const connect =
		options.client ??
		((token: string): MembershipClient =>
			new MattermostClient({ baseUrl: options.baseUrl, token }));
	const grace = options.evidenceGraceMs ?? DEFAULT_GRACE_MS;
	const listenerToken = store.token(view.listener.tokenSecretRef);
	const seen = new Set<string>();

	for (const bot of view.bots) {
		const token = store.token(bot.tokenSecretRef);
		if (token === null) {
			continue;
		}
		const client = connect(token);
		const channels = (await client.userChannelsInTeam(bot.userId, view.teamId)).filter((channel) =>
			isTeamChannel(channel, view.teamId),
		);
		const member = new Set(channels.map((channel) => channel.id));
		const records = view.grants.filter((grant) => grant.agentId === bot.agentId);
		const active = records.filter(
			(grant) => grant.state === "active" && grant.botUserId === bot.userId,
		);

		for (const grant of active) {
			if (!member.has(grant.channelId)) {
				const followed = await store.revoke(bot.agentId, grant.channelId, "bot_left");
				log.info("channel grant revoked", { agent_id: bot.agentId, channel_id: grant.channelId });
				if (!followed && listenerToken !== null) {
					await connect(listenerToken)
						.removeChannelMember(grant.channelId, view.listener.userId)
						.catch((error: Error) =>
							log.warn("the listener could not leave a channel", {
								channel_id: grant.channelId,
								...errorFields(error),
							}),
						);
				}
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
			// An add no newer than the latest record is the one that record came from: after a
			// revocation only a new add counts.
			const evidence =
				add !== null && (latest === undefined || add.create_at > latest.sinceMs) ? add : null;
			const leave = async (rejection: MembershipRejection) => {
				pending.delete(key);
				await store.reject(rejection);
				await client.removeChannelMember(channel.id, bot.userId);
				log.warn("an agent bot left a channel it was not granted", {
					agent_id: bot.agentId,
					channel_id: channel.id,
					reason: rejection.reason,
				});
			};
			const base = { agentId: bot.agentId, channelId: channel.id, channelName: channel.name };
			if (evidence === null) {
				const first = pending.get(key) ?? options.clock().getTime();
				pending.set(key, first);
				if (options.clock().getTime() - first >= grace) {
					await leave({
						...base,
						actorUserId: null,
						evidencePostId: null,
						reason: "no_add_record",
					});
				}
				continue;
			}
			const actor = await client.user(evidence.user_id);
			if (!mayGrant(actor, view.ownerUserIds)) {
				await leave({
					...base,
					actorUserId: evidence.user_id,
					evidencePostId: evidence.id,
					reason: "not_owner_or_admin",
				});
				continue;
			}
			// The agent's own bot brings the listener in: a plain member may add members by default,
			// so no admin credential is needed.
			if (!(await client.isChannelMember(channel.id, view.listener.userId))) {
				try {
					await client.addChannelMember(channel.id, view.listener.userId);
				} catch (error) {
					log.warn("the listener could not be added to a granted channel", {
						agent_id: bot.agentId,
						channel_id: channel.id,
						...errorFields(error),
					});
					await store.reject({
						...base,
						actorUserId: evidence.user_id,
						evidencePostId: evidence.id,
						reason: "listener_not_added",
					});
					continue;
				}
			}
			pending.delete(key);
			if (
				await store.grant({
					agentId: bot.agentId,
					botUserId: bot.userId,
					teamId: view.teamId,
					channelId: channel.id,
					channelName: channel.name,
					grantorUserId: evidence.user_id,
					evidencePostId: evidence.id,
					sinceMs: evidence.create_at,
				})
			) {
				log.info("channel granted", { agent_id: bot.agentId, channel_id: channel.id });
			}
		}
	}
	// Memberships that went away while waiting for their add record wait no more.
	for (const key of [...pending.keys()]) {
		if (!seen.has(key)) {
			pending.delete(key);
		}
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
