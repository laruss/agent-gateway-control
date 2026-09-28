import { z } from "zod";
import {
	AgentIdSchema,
	hasUnsafeCharacters,
	type JsonObject,
	JsonObjectSchema,
	MattermostIdSchema,
	TimestampSchema,
	TraceparentSchema,
	type TrustLevel,
	TrustLevelSchema,
} from "./common.ts";
import { ApprovalDecisionDataSchema, ApprovalResolvedDataSchema } from "./tool-action.ts";

/** MVP event types. */
export const GatewayEventTypeSchema = z.enum([
	"mattermost.post.created",
	"mattermost.post.edited",
	"mattermost.post.deleted",
	/** A post first seen after it was edited: its original text, hence its address, is unknown. */
	"mattermost.post.recovered",
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
	/** How an approval ended, execution included: the one approval event an agent waits for. */
	"approval.resolved",
	"google.gmail.notification.received",
	"google.gmail.message.received",
	"timer.fired",
	"gateway.control.pause",
	"gateway.control.resume",
	"gateway.control.kill_all",
]);
export type GatewayEventType = z.infer<typeof GatewayEventTypeSchema>;

/**
 * Event types only the Gateway itself emits (lifecycle, waits, approvals, timers, control).
 * External ingest rejects them: a forged `approval.granted` or `agent.wait.timeout` must never
 * resume an agent.
 */
export function isReservedEventType(type: GatewayEventType): boolean {
	return (
		type.startsWith("agent.") ||
		type.startsWith("approval.") ||
		type.startsWith("gateway.control.") ||
		type === "timer.fired"
	);
}

/**
 * Edits, deletions and recovered posts are recorded for audit and never route: no wake-up, no
 * wait match, no new cascade. An edit that adds a mention does not address anyone; a new post
 * does. A Gmail notification only says that the mailbox changed; the messages it announces are
 * their own events.
 */
export function isRecordOnlyEventType(type: GatewayEventType): boolean {
	return (
		type === "mattermost.post.edited" ||
		type === "mattermost.post.deleted" ||
		type === "mattermost.post.recovered" ||
		type === "google.gmail.notification.received"
	);
}

/** Event types carrying a Mattermost post in `data`. */
export const MATTERMOST_POST_EVENT_TYPES: Readonly<GatewayEventType[]> = [
	"mattermost.post.created",
	"mattermost.post.edited",
	"mattermost.post.deleted",
	"mattermost.post.recovered",
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

/** The Gateway's name for a watched mailbox, e.g. `primary`; never the address itself. */
export const GmailMailboxIdSchema = z
	.string()
	.regex(/^[a-z][a-z0-9-]{0,31}$/, "mailbox id like 'primary'");
export type GmailMailboxId = z.infer<typeof GmailMailboxIdSchema>;

/**
 * How the Gmail connector learns of new mail: by polling the mailbox's history (the default,
 * only a read-only credential), or by Gmail's Pub/Sub notifications (faster, needs a topic, a
 * subscription and the `pubsub` scope).
 */
export const GMAIL_MODES = ["poll", "pubsub"] as const;
export type GmailMode = (typeof GMAIL_MODES)[number];

/** Gmail message and thread ids: opaque strings to Google, URL-safe in practice. */
const GmailIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Gmail id");
export const GmailHistoryIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/, "Gmail history id");

/** Longest mail body kept with an event, in characters. */
export const MAX_MAIL_BODY = 16_000;

/** Mail text as the connector stores it: any length up to `max`, no unsafe characters. */
function mailText(max: number) {
	return z
		.string()
		.max(max)
		.refine(
			(value) => !hasUnsafeCharacters(value, "text"),
			"control or invisible characters are not allowed",
		);
}

/** `data` of a Gmail change notification: which mailbox changed, and up to which history id. */
export const GmailNotificationDataSchema = z.strictObject({
	mailbox_id: GmailMailboxIdSchema,
	history_id: GmailHistoryIdSchema,
});
export type GmailNotificationData = z.infer<typeof GmailNotificationDataSchema>;

/** An attachment as the model sees it: described, never its content. */
export const GmailAttachmentSchema = z.strictObject({
	filename: mailText(255),
	mime_type: mailText(255),
	size_bytes: z.int().min(0),
});
export type GmailAttachment = z.infer<typeof GmailAttachmentSchema>;

/**
 * Normalized `data` of a received message. Everything in it comes from the sender and is
 * external-untrusted: the body is plain text (HTML is converted, active and hidden content
 * removed), attachments are described only. Only fields that do not change after delivery are
 * kept (no labels, no read state), so a redelivery of the same message is the same event.
 */
export const GmailMessageDataSchema = z.strictObject({
	mailbox_id: GmailMailboxIdSchema,
	message_id: GmailIdSchema,
	thread_id: GmailIdSchema,
	received_at: TimestampSchema,
	from: mailText(1000),
	reply_to: mailText(1000),
	to: mailText(4000),
	cc: mailText(4000),
	subject: mailText(1000),
	/** The RFC 5322 `Message-ID` header, empty when missing. */
	rfc822_message_id: mailText(1000),
	body_text: mailText(MAX_MAIL_BODY),
	/** Where the text came from: a text/plain part, an HTML part, or nothing readable. */
	body_format: z.enum(["plain", "html", "none"]),
	body_truncated: z.boolean(),
	/** Content the HTML hid from the reader (display:none, zero size) that was dropped. */
	hidden_text_removed: z.boolean(),
	/**
	 * The HTML's stylesheet may hide text that was kept: a rule under a condition (`@media` with
	 * a width) or one the sanitizer could not resolve. Read such mail with extra care.
	 */
	hidden_text_suspected: z.boolean(),
	attachments: z.array(GmailAttachmentSchema).max(50),
	/** Attachments beyond the listed ones. */
	attachments_omitted: z.int().min(0),
});
export type GmailMessageData = z.infer<typeof GmailMessageDataSchema>;

/** Event types carrying Gmail data, each with its schema. */
const GMAIL_DATA_SCHEMAS: Readonly<Partial<Record<GatewayEventType, z.ZodType>>> = {
	"google.gmail.notification.received": GmailNotificationDataSchema,
	"google.gmail.message.received": GmailMessageDataSchema,
};

type EnvelopeIssue = Readonly<{ field: "source" | "id" | "correlationid"; message: string }>;

/**
 * A Gmail event's envelope follows from its data: source `gmail://<mailbox>`, a message's id
 * and correlation from its message and thread. Routing relies on it (each received mail
 * starts a cascade in its thread's correlation), so no Gmail event can name another
 * correlation, such as a Mattermost thread.
 */
function gmailEnvelopeIssues(
	event: Readonly<{
		type: GatewayEventType;
		source: string;
		id: string;
		correlationid: string;
		data: JsonObject;
	}>,
): Readonly<EnvelopeIssue[]> {
	const mailbox = GmailMailboxIdSchema.safeParse(event.data.mailbox_id);
	if (!mailbox.success) {
		return [];
	}
	const issues: EnvelopeIssue[] = [];
	if (event.source !== `gmail://${mailbox.data}`) {
		issues.push({
			field: "source",
			message: "the source of a Gmail event is gmail://<mailbox_id>",
		});
	}
	if (event.type === "google.gmail.message.received") {
		const message = GmailMessageDataSchema.safeParse(event.data);
		if (message.success) {
			const { message_id, thread_id } = message.data;
			if (event.id !== `gmail-message:${mailbox.data}:${message_id}`) {
				issues.push({
					field: "id",
					message: "a mail's id is gmail-message:<mailbox_id>:<message_id>",
				});
			}
			if (event.correlationid !== `gmail-thread:${mailbox.data}:${thread_id}`) {
				issues.push({
					field: "correlationid",
					message: "a mail's correlation is gmail-thread:<mailbox_id>:<thread_id>",
				});
			}
		}
	}
	return issues;
}

/** Approval events are the Gateway's; their data says which request and how it ended. */
const APPROVAL_DATA_SCHEMAS: Readonly<Partial<Record<GatewayEventType, z.ZodType>>> = {
	"approval.granted": ApprovalDecisionDataSchema,
	"approval.denied": ApprovalDecisionDataSchema,
	"approval.resolved": ApprovalResolvedDataSchema,
};

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
		const approvalSchema = APPROVAL_DATA_SCHEMAS[ctx.value.type];
		if (approvalSchema !== undefined) {
			for (const issue of approvalSchema.safeParse(ctx.value.data).error?.issues ?? []) {
				ctx.issues.push({
					code: "custom",
					input: ctx.value.data,
					path: ["data", ...issue.path],
					message: issue.message,
				});
			}
			return;
		}
		const gmailSchema = GMAIL_DATA_SCHEMAS[ctx.value.type];
		if (gmailSchema !== undefined) {
			// Mail is written by whoever sends it: never trusted, whatever the connector claims.
			if (ctx.value.trustlevel !== "external-untrusted") {
				ctx.issues.push({
					code: "custom",
					input: ctx.value.trustlevel,
					path: ["trustlevel"],
					message: "Gmail events are external-untrusted",
				});
			}
			for (const issue of gmailSchema.safeParse(ctx.value.data).error?.issues ?? []) {
				ctx.issues.push({
					code: "custom",
					input: ctx.value.data,
					path: ["data", ...issue.path],
					message: issue.message,
				});
			}
			for (const issue of gmailEnvelopeIssues(ctx.value)) {
				ctx.issues.push({
					code: "custom",
					input: ctx.value,
					path: [issue.field],
					message: issue.message,
				});
			}
			return;
		}
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
