import type {
	AgentId,
	GatewayEvent,
	GatewayEventType,
	MattermostId,
	MattermostPostData,
	TrustLevel,
} from "@agent-gateway/contracts";
import { newPostEventType } from "@agent-gateway/events";
import type { ApiPost } from "./api-schemas.ts";
import { mentionedAgents } from "./mentions.ts";
import { verifiedRoutingMetadata } from "./routing-props.ts";

/** A Gateway-managed agent as the listener sees it. */
export type BridgeAgent = Readonly<{
	id: AgentId;
	/** The agent's bot account; null until bootstrap resolved it. */
	userId: MattermostId | null;
	/** Channels the agent may be addressed in (resolved ids of its allowed channels). */
	channelIds: ReadonlySet<MattermostId>;
}>;

/** Everything normalization needs to know, loaded from the active configuration. */
export type BridgeDirectory = Readonly<{
	/** Event source of this Mattermost installation, e.g. `mattermost://autonomous-lab`. */
	source: string;
	/** Managed channels: id to name. Posts elsewhere are not the Gateway's business. */
	channels: ReadonlyMap<MattermostId, string>;
	agents: Readonly<BridgeAgent[]>;
}>;

/**
 * One change of a post. `recovered` is a creation first seen after the post was edited (both
 * missed live): its original text is unknown, so it is recorded without routing.
 */
export type PostChange = "created" | "recovered" | "edited" | "deleted";

export type NormalizeContext = Readonly<{
	directory: BridgeDirectory;
	/** The listener bot itself: its alerts and approval cards never route. */
	listenerUserId: MattermostId;
	/** Whether the post's author is a bot account, as Mattermost says by user id. */
	authorIsBot: boolean;
	/**
	 * The stored correlation of the post's thread root, if any. A thread an agent started belongs
	 * to that agent's cascade, so replies in it do too; otherwise a thread is its own correlation.
	 */
	rootCorrelation: string | null;
	routingKey: string;
	now: Date;
}>;

export type SkipReason = "unmanaged_channel" | "system_post" | "listener_post";
export type RejectReason = "unsigned_agent_post" | "replayed_agent_post";

export type Normalized =
	/**
	 * `signedKey`: the signed idempotency key of an agent post, null for anyone else. A signed
	 * post counts only as the very post its delivery receipt names (checked by the listener),
	 * which also covers a post by an agent's former bot.
	 */
	| Readonly<{ kind: "event"; event: GatewayEvent; signedKey: string | null }>
	| Readonly<{ kind: "skip"; reason: SkipReason }>
	/** Looks like an agent's post but is not the Gateway's: its routing is never trusted. */
	| Readonly<{ kind: "reject"; reason: RejectReason; agentId: AgentId }>;

/** Longest message stored with an event; Mattermost's own default limit. */
const MAX_STORED_MESSAGE = 16_383;

/** Props that mark a post as written by software on a human's account. */
const AUTOMATION_PROPS = ["from_webhook", "from_bot", "from_plugin"] as const;

function isAutomated(post: ApiPost): boolean {
	return AUTOMATION_PROPS.some((prop) => post.props[prop] === "true" || post.props[prop] === true);
}

/** The event subject of every change of a post. */
export function postSubject(post: ApiPost): string {
	return `channel/${post.channel_id}/post/${post.id}`;
}

/** The external id of one change of a post; deterministic, so redelivery dedupes. */
export function postEventId(post: ApiPost, change: PostChange): string {
	switch (change) {
		case "created":
		case "recovered":
			return `mattermost:post:${post.id}`;
		case "edited":
			return `mattermost:post:${post.id}:edited:${post.edit_at}`;
		case "deleted":
			return `mattermost:post:${post.id}:deleted`;
	}
}

/**
 * The event id of a signed agent post: its signed idempotency key, not its post id. A second
 * post carrying the same signed routing (a replay with a leaked token, or a duplicate create)
 * is the same event, so it can never route twice.
 */
export function agentPostEventId(idempotencyKey: string): string {
	return `mattermost:agent-post:${idempotencyKey}`;
}

type Author = Readonly<{
	/** Overrides the post-derived event id. */
	eventId?: string;
	signedKey?: string;
	trust: TrustLevel;
	senderAgentId: AgentId | null;
	targets: Readonly<AgentId[]>;
	hop: number;
	correlationId: string;
	causationId: string | null;
}>;

/** Addressees a new post may have: registered agents that are allowed in the post's channel. */
function addressable(ctx: NormalizeContext, channelId: MattermostId): Set<AgentId> {
	return new Set(
		ctx.directory.agents.filter((agent) => agent.channelIds.has(channelId)).map((a) => a.id),
	);
}

function thread(post: ApiPost, ctx: NormalizeContext): string {
	if (post.root_id === "") {
		return `thread:${post.id}`;
	}
	return ctx.rootCorrelation ?? `thread:${post.root_id}`;
}

/** The event subject of a thread's root post, for looking up its stored correlation. */
export function rootSubject(post: ApiPost): string | null {
	return post.root_id === "" ? null : `channel/${post.channel_id}/post/${post.root_id}`;
}

type Rejected = Readonly<{ rejected: RejectReason; agentId: AgentId }>;

function author(post: ApiPost, change: PostChange, ctx: NormalizeContext): Author | Rejected {
	const rootId = post.root_id === "" ? null : post.root_id;
	const agent = ctx.directory.agents.find((a) => a.userId === post.user_id);
	if (agent !== undefined) {
		if (change === "recovered") {
			// The Gateway never edits its posts: an edited agent post no longer carries a
			// verifiable signature, and without its creation it cannot be attributed.
			return { rejected: "unsigned_agent_post", agentId: agent.id };
		}
		if (change !== "created") {
			// Edits and deletions are record-only and carry no routing.
			return {
				trust: "internal-untrusted",
				senderAgentId: agent.id,
				targets: [],
				hop: 0,
				correlationId: thread(post, ctx),
				causationId: null,
			};
		}
		const metadata = verifiedRoutingMetadata(ctx.routingKey, post.props, {
			channelId: post.channel_id,
			rootId,
			message: post.message,
		});
		if (metadata === null || metadata.agent_id !== agent.id) {
			return { rejected: "unsigned_agent_post", agentId: agent.id };
		}
		const allowed = addressable(ctx, post.channel_id);
		return {
			eventId: agentPostEventId(metadata.idempotency_key),
			signedKey: metadata.idempotency_key,
			trust: "internal-untrusted",
			senderAgentId: agent.id,
			targets: metadata.targets.filter((id) => id !== agent.id && allowed.has(id)),
			hop: metadata.hop,
			correlationId: metadata.correlation_id,
			causationId: `run:${metadata.run_id}`,
		};
	}
	// A bot that was an agent's when it posted (replaced since, e.g. before a catch-up): its
	// signed post may still route, but only as the exact post the delivery receipt names.
	if (ctx.authorIsBot && change === "created") {
		const metadata = verifiedRoutingMetadata(ctx.routingKey, post.props, {
			channelId: post.channel_id,
			rootId,
			message: post.message,
		});
		const agentOf = ctx.directory.agents.find((a) => a.id === metadata?.agent_id);
		if (metadata !== null && agentOf !== undefined) {
			const allowed = addressable(ctx, post.channel_id);
			return {
				eventId: agentPostEventId(metadata.idempotency_key),
				signedKey: metadata.idempotency_key,
				trust: "internal-untrusted",
				senderAgentId: agentOf.id,
				targets: metadata.targets.filter((id) => id !== agentOf.id && allowed.has(id)),
				hop: metadata.hop,
				correlationId: metadata.correlation_id,
				causationId: `run:${metadata.run_id}`,
			};
		}
	}
	// Anyone else. Posts by other bots and integrations (webhooks, plugins) are recorded but
	// address nobody: only a human's own words are an instruction. Bots are known by account,
	// not by props any client can set.
	const human = !ctx.authorIsBot && !isAutomated(post);
	const targets =
		human && change === "created"
			? mentionedAgents(post.message, addressable(ctx, post.channel_id))
			: [];
	return {
		trust: human ? "human-trusted" : "internal-untrusted",
		senderAgentId: null,
		targets: targets.slice(0, 8),
		hop: 0,
		correlationId: thread(post, ctx),
		causationId: null,
	};
}

function eventType(change: PostChange, rootId: MattermostId | null, targets: Readonly<AgentId[]>) {
	const types: Readonly<Record<PostChange, GatewayEventType>> = {
		created: newPostEventType(rootId, targets),
		recovered: "mattermost.post.recovered",
		edited: "mattermost.post.edited",
		deleted: "mattermost.post.deleted",
	};
	return types[change];
}

function eventTime(post: ApiPost, change: PostChange, now: Date): string {
	const ms =
		change === "created" || change === "recovered"
			? post.create_at
			: change === "edited"
				? post.edit_at
				: post.delete_at > 0
					? post.delete_at
					: now.getTime();
	return new Date(ms).toISOString();
}

/**
 * Turns one change of a Mattermost post into a Gateway event, or says why it is not one. Pure.
 *
 * Senders are identified by user id only; props any client can set (`from_bot`, a copied
 * `agent_gateway`) are never proof of identity. A post by an agent's bot routes only with
 * routing metadata signed by the Gateway for exactly this post. A deleted post keeps no text.
 */
export function normalizePost(
	post: ApiPost,
	change: PostChange,
	ctx: NormalizeContext,
): Normalized {
	if (!ctx.directory.channels.has(post.channel_id)) {
		return { kind: "skip", reason: "unmanaged_channel" };
	}
	if (post.type !== "") {
		return { kind: "skip", reason: "system_post" };
	}
	if (post.user_id === ctx.listenerUserId) {
		return { kind: "skip", reason: "listener_post" };
	}
	const who = author(post, change, ctx);
	if ("rejected" in who) {
		return { kind: "reject", reason: who.rejected, agentId: who.agentId };
	}
	const rootId = post.root_id === "" ? null : post.root_id;
	const data: MattermostPostData = {
		post_id: post.id,
		root_id: rootId,
		channel_id: post.channel_id,
		user_id: post.user_id,
		sender_agent_id: who.senderAgentId,
		target_agent_ids: [...who.targets],
		message: change === "deleted" ? "" : post.message.slice(0, MAX_STORED_MESSAGE),
	};
	return {
		kind: "event",
		signedKey: who.signedKey ?? null,
		event: {
			specversion: "1.0",
			id: who.eventId ?? postEventId(post, change),
			source: ctx.directory.source,
			type: eventType(change, rootId, who.targets),
			time: eventTime(post, change, ctx.now),
			subject: postSubject(post),
			datacontenttype: "application/json",
			correlationid: who.correlationId,
			causationid: who.causationId,
			trustlevel: who.trust,
			hop: who.hop,
			data,
		},
	};
}
