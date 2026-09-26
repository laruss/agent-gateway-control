import {
	type AgentId,
	MattermostAlertPayloadSchema,
	MattermostApprovalPayloadSchema,
	type MattermostId,
	type MattermostPostPayload,
	MattermostPostPayloadSchema,
} from "@agent-gateway/contracts";
import { sha256Hex } from "@agent-gateway/events";
import { type Deliverer, DeliveryError, type OutboxItem } from "@agent-gateway/outbox";
import type { z } from "zod";
import type { ApiPost } from "./api-schemas.ts";
import { channelChangesSince } from "./backfill.ts";
import { MattermostApiError, MattermostClient } from "./client.ts";
import { renderAlert, renderApprovalCard } from "./render.ts";
import { ROUTING_PROPS_KEY, signedRoutingProps, verifiedRoutingMetadata } from "./routing-props.ts";

export type AgentBot = Readonly<{ userId: MattermostId; token: string }>;

/** Bot credentials, read when needed so a rotated token takes effect without a restart. */
export type BotCredentials = Readonly<{
	/**
	 * Runs `post` with the agent's own bot while the active configuration allows the agent in
	 * `channelId`, and keeps that permission from being revoked until `post` returns.
	 * `unauthorized`: the configuration no longer has the agent there. `unresolved`: bootstrap
	 * has not resolved its bot yet.
	 */
	withAgentBot: <T>(
		agentId: AgentId,
		channelId: MattermostId,
		post: (bot: AgentBot) => Promise<T>,
	) => Promise<
		| Readonly<{ kind: "posted"; value: T }>
		| Readonly<{ kind: "unauthorized" }>
		| Readonly<{ kind: "unresolved" }>
	>;
	/** The listener bot; null when bootstrap has not resolved it. */
	listenerBot: () => Promise<AgentBot | null>;
	/**
	 * Runs `post` with the listener bot in the channel the active configuration names for
	 * `purpose`, keeping that from changing until `post` returns; `unresolved` while bootstrap
	 * has not resolved the bot or the channel.
	 */
	withListenerChannel: <T>(
		purpose: "alerts" | "approvals",
		post: (bot: AgentBot, channelId: MattermostId) => Promise<T>,
	) => Promise<Readonly<{ kind: "posted"; value: T }> | Readonly<{ kind: "unresolved" }>>;
}>;

export type MattermostDelivererOptions = Readonly<{
	baseUrl: string;
	routingKey: string;
	credentials: BotCredentials;
}>;

export type MattermostDeliverers = Readonly<{
	"mattermost.post": Deliverer;
	"mattermost.alert": Deliverer;
	"mattermost.approval": Deliverer;
}>;

/** Clock skew allowed between the Gateway and Mattermost when looking for an earlier post. */
const LOOKUP_MARGIN_MS = 10 * 60_000;

function parsePayload<S extends z.ZodType>(schema: S, item: OutboxItem): z.infer<S> {
	const parsed = schema.safeParse(item.payload);
	if (!parsed.success) {
		throw new DeliveryError(`malformed ${item.kind} payload`, false);
	}
	return parsed.data;
}

/**
 * API failures keep their retry class; anything unexpected is retried. A rejected token (401)
 * is retried too: a rotation may have revoked it mid-delivery, and the next attempt reads the
 * current secret file.
 */
function asDeliveryError(error: unknown): unknown {
	if (error instanceof MattermostApiError) {
		// 403: the bot may not be in the channel yet (bootstrap still to run after a config apply).
		return new DeliveryError(
			error.message,
			error.retryable || error.status === 401 || error.status === 403,
		);
	}
	return error;
}

/** Value for the server's short-lived create deduplication, derived from the idempotency key. */
function pendingPostId(key: string): string {
	return `agent-gateway:${sha256Hex(key).slice(0, 40)}`;
}

function receipt(post: ApiPost) {
	return {
		postId: post.id,
		channelId: post.channel_id,
		rootId: post.root_id === "" ? null : post.root_id,
		createAt: post.create_at,
	};
}

/** The idempotency key a post's props claim, if any. Anyone can set it: never proof alone. */
function claimedKey(post: ApiPost): string | null {
	const props = post.props[ROUTING_PROPS_KEY];
	if (typeof props !== "object" || props === null || Array.isArray(props)) {
		return null;
	}
	return typeof props.idempotency_key === "string" ? props.idempotency_key : null;
}

/**
 * An earlier attempt's post, if one was created before its receipt was stored (a crash or lost
 * lease between the API call and the commit). It counts only when it is the one post by the
 * same bot with this key, intact and exactly the post this item makes (`isThisPost`), and the
 * bot deleted nothing meanwhile; a look-alike made with the bot's token never stands in for the
 * real delivery.
 */
async function findEarlierPost(
	client: MattermostClient,
	item: OutboxItem,
	channelId: MattermostId,
	authorId: MattermostId,
	isThisPost: (post: ApiPost) => boolean,
): Promise<ApiPost | null> {
	let complete = true;
	const posts = await channelChangesSince(
		client,
		channelId,
		item.createdAt.getTime() - LOOKUP_MARGIN_MS,
		() => {
			complete = false;
		},
	);
	// Past the since limit older deletions are not seen, so "the bot deleted nothing" is not
	// proven: adopt nothing, post afresh.
	if (!complete) {
		return null;
	}
	const byAuthor = posts.filter((post) => post.user_id === authorId);
	// Deleted posts keep no props, so a deleted original cannot be told apart from others: with
	// any deletion by this bot, or more than one candidate, nothing is adopted and the post is
	// made afresh (a copy is then a replay of the fresh post's key).
	if (byAuthor.some((post) => post.delete_at > 0)) {
		return null;
	}
	const candidates = byAuthor.filter((post) => claimedKey(post) === item.idempotencyKey);
	const [only] = candidates;
	return candidates.length === 1 && only !== undefined && only.edit_at === 0 && isThisPost(only)
		? only
		: null;
}

/** Fails the attempt, retryably, when a token belongs to another account than recorded. */
async function assertOwner(client: MattermostClient, expected: MattermostId, bot: string) {
	const me = await client.me();
	if (me.id !== expected) {
		throw new DeliveryError(
			`the token of '${bot}' belongs to another account; fix its secret file`,
			true,
		);
	}
}

/**
 * Outbox deliverers for Mattermost. Agent posts go out as the agent's own bot, with routing
 * metadata signed for exactly that post; alerts and approval cards as the listener bot. Each is
 * idempotent by the item's key: a retry first looks for the post an earlier attempt may have
 * made, and the server drops a quick duplicate create by `pending_post_id`.
 */
export function mattermostDeliverers(options: MattermostDelivererOptions): MattermostDeliverers {
	const { baseUrl, routingKey, credentials } = options;

	const post: Deliverer = {
		deliver: async (item) => {
			const payload = parsePayload(MattermostPostPayloadSchema, item);
			const outcome = await credentials.withAgentBot(payload.agentId, payload.channelId, (bot) =>
				postAsAgent(item, payload, bot),
			);
			if (outcome.kind === "unauthorized") {
				// Settled as dead: the configuration changed after the post was decided.
				throw new DeliveryError(
					`agent '${payload.agentId}' may no longer post in this channel`,
					false,
				);
			}
			if (outcome.kind === "unresolved") {
				// Right after a config apply, before bootstrap: retried until the bot is ready.
				throw new DeliveryError(`agent '${payload.agentId}' has no resolved bot yet`, true);
			}
			return outcome.value;
		},
	};

	const postAsAgent = async (item: OutboxItem, payload: MattermostPostPayload, bot: AgentBot) => {
		const client = new MattermostClient({ baseUrl, token: bot.token });
		try {
			// A swapped or stale secret must not post under another identity; retried, so a
			// corrected secret file still delivers.
			await assertOwner(client, bot.userId, payload.agentId);
			const binding = {
				channelId: payload.channelId,
				rootId: payload.rootPostId,
				message: payload.message,
			};
			const props = signedRoutingProps(
				routingKey,
				{
					schema_version: 1,
					agent_id: payload.agentId,
					run_id: payload.runId,
					correlation_id: payload.correlationId,
					targets: payload.targetAgentIds,
					hop: payload.hop,
					idempotency_key: item.idempotencyKey,
				},
				binding,
			);
			if (item.attempt > 1) {
				const earlier = await findEarlierPost(
					client,
					item,
					payload.channelId,
					bot.userId,
					(candidate) =>
						verifiedRoutingMetadata(routingKey, candidate.props, {
							channelId: candidate.channel_id,
							rootId: candidate.root_id === "" ? null : candidate.root_id,
							message: candidate.message,
						})?.idempotency_key === item.idempotencyKey &&
						candidate.message === payload.message &&
						(candidate.root_id === "" ? null : candidate.root_id) === payload.rootPostId,
				);
				if (earlier !== null) {
					return receipt(earlier);
				}
			}
			const created = await client.createPost({
				channel_id: payload.channelId,
				...(payload.rootPostId === null ? {} : { root_id: payload.rootPostId }),
				message: payload.message,
				props,
				pending_post_id: pendingPostId(item.idempotencyKey),
			});
			return receipt(created);
		} catch (error) {
			throw asDeliveryError(error);
		}
	};

	/**
	 * Posts as the listener bot in the channel configured for `purpose` now (the channel recorded
	 * when the item was decided may have moved or left the configuration).
	 */
	const asListener = async (item: OutboxItem, purpose: "alerts" | "approvals", message: string) => {
		const outcome = await credentials.withListenerChannel(purpose, async (listener, channelId) => {
			const client = new MattermostClient({ baseUrl, token: listener.token });
			try {
				await assertOwner(client, listener.userId, "the listener");
				if (item.attempt > 1) {
					const earlier = await findEarlierPost(
						client,
						item,
						channelId,
						listener.userId,
						(candidate) => candidate.root_id === "" && candidate.message === message,
					);
					if (earlier !== null) {
						return receipt(earlier);
					}
				}
				const created = await client.createPost({
					channel_id: channelId,
					message,
					// Unsigned: the listener's own posts never route, the key only finds them again.
					props: { [ROUTING_PROPS_KEY]: { idempotency_key: item.idempotencyKey } },
					pending_post_id: pendingPostId(item.idempotencyKey),
				});
				return receipt(created);
			} catch (error) {
				throw asDeliveryError(error);
			}
		});
		if (outcome.kind === "unresolved") {
			throw new DeliveryError(
				`${item.kind}: the listener bot or its ${purpose} channel is not bootstrapped yet`,
				true,
			);
		}
		return outcome.value;
	};

	return {
		"mattermost.post": post,
		"mattermost.alert": {
			deliver: async (item) => {
				const alert = parsePayload(MattermostAlertPayloadSchema, item);
				return asListener(item, "alerts", renderAlert(alert));
			},
		},
		"mattermost.approval": {
			deliver: async (item) => {
				const card = parsePayload(MattermostApprovalPayloadSchema, item);
				return asListener(item, "approvals", renderApprovalCard(card));
			},
		},
	};
}
