import { z } from "zod";
import { ActionParamsSchema } from "./approval.ts";
import {
	AgentIdSchema,
	JsonObjectSchema,
	MattermostIdSchema,
	MattermostNameSchema,
	RiskLevelSchema,
	Sha256HexSchema,
	safeText,
	TimestampSchema,
	ToolNameSchema,
	UuidSchema,
} from "./common.ts";

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
	riskLevel: RiskLevelSchema,
	immutableActionHash: Sha256HexSchema,
	expiresAt: TimestampSchema,
});
export type MattermostApprovalPayload = z.infer<typeof MattermostApprovalPayloadSchema>;
