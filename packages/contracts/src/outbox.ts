import { z } from "zod";
import { ActionParamsSchema } from "./approval.ts";
import {
	AgentIdSchema,
	JsonObjectSchema,
	type MattermostId,
	MattermostIdSchema,
	MattermostNameSchema,
	RiskLevelSchema,
	Sha256HexSchema,
	safeText,
	TimestampSchema,
	ToolNameSchema,
	UuidSchema,
} from "./common.ts";
import { ApprovalOutcomeSchema, ToolReceiptSchema } from "./tool-action.ts";

/**
 * Outbox payloads: written by the controller in the transaction that decides the side effect,
 * read by the deliverer that performs it. Deliverers parse them again: a malformed payload is a
 * permanent delivery failure, never a guess.
 */

/** A post by an agent's own bot, rendered with its visible @mentions. */
export const MattermostPostPayloadSchema = z.strictObject({
	agentId: AgentIdSchema,
	runId: UuidSchema,
	channelId: MattermostIdSchema,
	rootPostId: MattermostIdSchema.nullable(),
	message: z.string().min(1).max(16_383),
	targetAgentIds: z.array(AgentIdSchema).max(8),
	attachmentArtifactIds: z.array(UuidSchema).max(10),
	/** The run's cascade; carried in the signed post props so a reply stays in it. */
	correlationId: z.string().min(1).max(512),
	hop: z.int().min(0).max(1000),
});
export type MattermostPostPayload = z.infer<typeof MattermostPostPayloadSchema>;

/** `MattermostApprovalPayloadSchema.customRequestPreview`'s own bound — shared with
 * `customApprovalRequestPreview` (`@agent-gateway/core`), which truncates to exactly this before
 * the field is ever stored, rather than letting an oversized preview make the card undeliverable. */
export const CUSTOM_REQUEST_PREVIEW_MAX = 4000;

/** A diagnostic in the alerts channel, posted by the listener bot. */
export const MattermostAlertPayloadSchema = z.strictObject({
	/** Null until a configuration is active; such an alert cannot be delivered. */
	channelName: MattermostNameSchema.nullable(),
	/** Null until bootstrap has resolved the channel. */
	channelId: MattermostIdSchema.nullable(),
	message: z.string().min(1).max(4000),
	detail: JsonObjectSchema,
});
export type MattermostAlertPayload = z.infer<typeof MattermostAlertPayloadSchema>;

/**
 * An approval card in the approvals channel, posted by the listener bot. It carries the
 * immutable request itself, so the card shows exactly what was hashed.
 */
export const MattermostApprovalPayloadSchema = z.strictObject({
	approvalId: UuidSchema,
	channelName: MattermostNameSchema,
	channelId: MattermostIdSchema.nullable(),
	requestedByAgentId: AgentIdSchema,
	actionType: ToolNameSchema,
	actionSummary: safeText(2000, "text"),
	actionParams: ActionParamsSchema,
	/** A `custom_https` action's own authoritative, secret-free request preview (method, resolved
	 * path, query/header/body field names, a secret-filled slot named but never its value) —
	 * `undefined` for any other action type. Optional, never `nullable`-required: this schema is
	 * re-parsed when an already-queued card is delivered, possibly after a rolling deploy, and an
	 * older-shaped payload enqueued before this field existed must still parse. */
	customRequestPreview: safeText(CUSTOM_REQUEST_PREVIEW_MAX, "text").optional(),
	riskLevel: RiskLevelSchema,
	immutableActionHash: Sha256HexSchema,
	expiresAt: TimestampSchema,
	/** The one-time code an owner replies with (`approve <code>`), bound to this request. */
	approvalCode: z
		.string()
		.regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/),
});
export type MattermostApprovalPayload = z.infer<typeof MattermostApprovalPayloadSchema>;

/** What the listener bot says in an approval card's thread. Every text is fixed. */
export const APPROVAL_NOTICES = [
	/** A valid `approve`: the action is queued for execution. */
	"granted",
	/** A valid `deny`. */
	"denied",
	/** A valid `approve` the policy no longer permits: the approval is cancelled. */
	"refused",
	/** A command from someone who may not decide (not an owner, a bot, an integration). */
	"not_an_approver",
	/** An owner's command that is not exactly `approve <code>` or `deny <code>`. */
	"malformed",
	/** The code does not belong to this request. */
	"wrong_code",
	"already_decided",
	"expired",
	/** Withdrawn without a decision: kill-all, the agent disabled, or a configuration change. */
	"withdrawn",
	/** How the execution ended; carries the outcome and the receipt. */
	"executed",
] as const;
export const ApprovalNoticeSchema = z.enum(APPROVAL_NOTICES);
export type ApprovalNotice = z.infer<typeof ApprovalNoticeSchema>;

/** A reply in an approval card's thread, posted by the listener bot. */
export const MattermostApprovalReplyPayloadSchema = z.strictObject({
	approvalId: UuidSchema,
	/** The card's channel and post, from the card's delivery receipt. */
	channelId: MattermostIdSchema,
	rootPostId: MattermostIdSchema,
	notice: ApprovalNoticeSchema,
	/** Who wrote the command answered; null for execution results. */
	userId: MattermostIdSchema.nullable(),
	outcome: ApprovalOutcomeSchema.nullable(),
	receipt: ToolReceiptSchema.nullable(),
	detail: safeText(500, "text").nullable(),
});
export type MattermostApprovalReplyPayload = z.infer<typeof MattermostApprovalReplyPayloadSchema>;

/**
 * An approval command as the listener read it: a created post in a card's thread, and its
 * author as a fresh account lookup and the post's props describe them. Only the listener hands
 * these over; generic event ingest never decides an approval.
 */
export type ApprovalReply = Readonly<{
	postId: MattermostId;
	rootPostId: MattermostId;
	/**
	 * The idempotency key the thread root claims when the root is the listener bot's own post
	 * (`approval-card:<id>` for a card), else null.
	 */
	rootCardKey: string | null;
	channelId: MattermostId;
	userId: MattermostId;
	message: string;
	author: Readonly<{
		/** A bot account, an agent's included. */
		isBot: boolean;
		/** Not deactivated. */
		active: boolean;
		/** `from_webhook`, `from_bot` or `from_plugin`: software on someone's account. */
		automated: boolean;
	}>;
}>;

/** What handling a reply did: the notice posted, or why nothing was. */
export type ApprovalReplyOutcome =
	| ApprovalNotice
	/** Not a reply to an approval card (any other thread, or another channel). */
	| "not_a_card"
	/** This post was handled before. */
	| "replayed"
	/** Not a command attempt at all. */
	| "ignored";
