import { z } from "zod";
import {
	AgentIdSchema,
	JsonObjectSchema,
	MattermostIdSchema,
	TimestampSchema,
	type TrustLevel,
	TrustLevelSchema,
} from "./common.ts";

/** MVP event types. */
export const GatewayEventTypeSchema = z.enum([
	"mattermost.post.created",
	"mattermost.post.edited",
	"mattermost.post.deleted",
	"mattermost.agent.mentioned",
	"mattermost.thread.reply",
	"agent.run.requested",
	"agent.run.started",
	"agent.run.completed",
	"agent.run.failed",
	"agent.wait.created",
	"agent.wait.matched",
	"agent.wait.timeout",
	"agent.message.requested",
	"agent.message.posted",
	"approval.requested",
	"approval.granted",
	"approval.denied",
	"google.gmail.notification.received",
	"google.gmail.message.received",
	"timer.fired",
	"gateway.control.pause",
	"gateway.control.resume",
	"gateway.control.kill_all",
]);
export type GatewayEventType = z.infer<typeof GatewayEventTypeSchema>;

/** Event types carrying a Mattermost post in `data`. */
export const MATTERMOST_POST_EVENT_TYPES: Readonly<GatewayEventType[]> = [
	"mattermost.post.created",
	"mattermost.post.edited",
	"mattermost.post.deleted",
	"mattermost.agent.mentioned",
	"mattermost.thread.reply",
];

/** A Mattermost post is never system-trusted, whoever wrote it. */
const MATTERMOST_POST_TRUST_LEVELS: Readonly<TrustLevel[]> = [
	"human-trusted",
	"internal-untrusted",
];

/**
 * Trust label rules for a Mattermost post: never system- or external-trusted, and a post by
 * an agent bot is always internal-untrusted. Returns the violation, or null.
 */
export function mattermostPostTrustIssue(
	trust: TrustLevel,
	authoredByAgent: boolean,
): string | null {
	if (!MATTERMOST_POST_TRUST_LEVELS.includes(trust)) {
		return "Mattermost posts are human-trusted or internal-untrusted";
	}
	if (authoredByAgent && trust !== "internal-untrusted") {
		return "posts by agent bots are internal-untrusted";
	}
	return null;
}

/**
 * Normalized `data` of Mattermost post events. Sender and targets are resolved
 * by the Gateway (HMAC-verified props or exact human mentions), never by text.
 */
export const MattermostPostDataSchema = z.strictObject({
	post_id: MattermostIdSchema,
	/** Thread root; null for a root post. */
	root_id: MattermostIdSchema.nullable(),
	channel_id: MattermostIdSchema,
	user_id: MattermostIdSchema,
	/** Set when the author is a Gateway-managed agent bot. */
	sender_agent_id: AgentIdSchema.nullable(),
	target_agent_ids: z.array(AgentIdSchema).max(8),
	message: z.string().max(16_383),
});
export type MattermostPostData = z.infer<typeof MattermostPostDataSchema>;

/** W3C trace context `traceparent` header value. */
export const TraceparentSchema = z
	.string()
	.regex(/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/, "W3C traceparent");

/**
 * CloudEvents 1.0 envelope with Agent Gateway extensions
 * (`correlationid`, `causationid`, `traceparent`, `trustlevel`, `hop`).
 * `(source, id)` is globally unique; `id` is deterministic for external sources.
 */
export const GatewayEventSchema = z
	.strictObject({
		specversion: z.literal("1.0"),
		id: z.string().min(1).max(512),
		source: z.string().min(1).max(1024),
		type: GatewayEventTypeSchema,
		time: TimestampSchema,
		subject: z.string().min(1).max(1024).optional(),
		datacontenttype: z.literal("application/json"),
		correlationid: z.string().min(1).max(512),
		causationid: z.string().min(1).max(512).nullable(),
		traceparent: TraceparentSchema.optional(),
		trustlevel: TrustLevelSchema,
		hop: z.int().min(0).max(1000),
		data: JsonObjectSchema,
	})
	.check((ctx) => {
		if (!MATTERMOST_POST_EVENT_TYPES.includes(ctx.value.type)) {
			return;
		}
		const parsed = MattermostPostDataSchema.safeParse(ctx.value.data);
		const authoredByAgent = parsed.success && parsed.data.sender_agent_id !== null;
		const trustIssue = mattermostPostTrustIssue(ctx.value.trustlevel, authoredByAgent);
		if (trustIssue !== null) {
			ctx.issues.push({
				code: "custom",
				input: ctx.value.trustlevel,
				path: ["trustlevel"],
				message: trustIssue,
			});
		}
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				ctx.issues.push({
					code: "custom",
					input: ctx.value.data,
					path: ["data", ...issue.path],
					message: issue.message,
				});
			}
		} else if (ctx.value.type === "mattermost.thread.reply" && parsed.data.root_id === null) {
			ctx.issues.push({
				code: "custom",
				input: ctx.value.data,
				path: ["data", "root_id"],
				message: "a thread reply must reference its root post",
			});
		}
	});
export type GatewayEvent = z.infer<typeof GatewayEventSchema>;
