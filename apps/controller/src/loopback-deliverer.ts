import { type GatewayEvent, MattermostIdSchema } from "@agent-gateway/contracts";
import { type ControlPlaneDeps, ingestEvent } from "@agent-gateway/core";
import { sha256Hex } from "@agent-gateway/events";
import { type Deliverer, DeliveryError } from "@agent-gateway/outbox";
import { z } from "zod";

/** The `mattermost.post` outbox payload written by the controller. */
const PostPayloadSchema = z.object({
	agentId: z.string(),
	runId: z.uuid(),
	channelId: MattermostIdSchema,
	rootPostId: MattermostIdSchema.nullable(),
	message: z.string(),
	targetAgentIds: z.array(z.string()),
	correlationId: z.string(),
	hop: z.int().min(0),
});

/** A stable fake Mattermost id: the same key always yields the same post. */
function fakeMattermostId(key: string): string {
	return sha256Hex(key).slice(0, 26);
}

/**
 * Development and test stand-in for Mattermost: a post is "delivered" by ingesting the event the
 * Mattermost listener would produce for it, with Gateway-resolved sender and targets. This lets
 * agent-to-agent cascades run end to end without a Mattermost server. Idempotent: the post id
 * derives from the outbox idempotency key, so a redelivery is a duplicate event.
 */
export function loopbackPostDeliverer(deps: ControlPlaneDeps): Deliverer {
	return {
		deliver: async (item) => {
			const payload = PostPayloadSchema.safeParse(item.payload);
			if (!payload.success) {
				throw new DeliveryError("malformed mattermost.post payload", false);
			}
			const post = payload.data;
			const postId = fakeMattermostId(item.idempotencyKey);
			const type: GatewayEvent["type"] =
				post.rootPostId !== null
					? "mattermost.thread.reply"
					: post.targetAgentIds.length > 0
						? "mattermost.agent.mentioned"
						: "mattermost.post.created";
			const result = await ingestEvent(deps, {
				specversion: "1.0",
				id: `mattermost:post:${postId}`,
				source: "mattermost://loopback",
				type,
				time: deps.clock().toISOString(),
				subject: `channel/${post.channelId}/post/${postId}`,
				datacontenttype: "application/json",
				correlationid: post.correlationId,
				causationid: `run:${post.runId}`,
				trustlevel: "internal-untrusted",
				hop: post.hop,
				data: {
					post_id: postId,
					root_id: post.rootPostId,
					channel_id: post.channelId,
					user_id: fakeMattermostId(`bot:${post.agentId}`),
					sender_agent_id: post.agentId,
					target_agent_ids: post.targetAgentIds,
					message: post.message,
				},
			});
			return { loopback: true, postId, eventId: result.eventId, ingest: result.status };
		},
	};
}
