import { z } from "zod";
import { ActionParamsSchema } from "./approval.ts";
import {
	AgentIdSchema,
	MattermostIdSchema,
	Sha256HexSchema,
	safeText,
	TimestampSchema,
	ToolNameSchema,
	UuidSchema,
} from "./common.ts";

/**
 * Namespaces the tool broker executes: the first segment of an approved action type. Each has
 * its own execute, report and dead letter queue, so a tool runner's database role, and the
 * credentials it holds, can be limited to the namespaces it serves (ADR-018).
 */
export const TOOL_NAMESPACES = ["finance", "mail", "deploy", "publish", "issue"] as const;
export const ToolNamespaceSchema = z.enum(TOOL_NAMESPACES);
export type ToolNamespace = z.infer<typeof ToolNamespaceSchema>;

/** The namespace that executes an action type, or null when the broker executes none. */
export function toolNamespace(actionType: string): ToolNamespace | null {
	const parsed = ToolNamespaceSchema.safeParse(actionType.split(".")[0]);
	return parsed.success ? parsed.data : null;
}

export type ToolExecuteQueueName = `tool.execute.${ToolNamespace}`;
export type ToolReportQueueName = `tool.report.${ToolNamespace}`;
export type ToolDeadLetterQueueName = `dlq.tool.execute.${ToolNamespace}`;

/** Controller -> tool runner: approved actions of one namespace. */
export function toolExecuteQueue(namespace: ToolNamespace): ToolExecuteQueueName {
	return `tool.execute.${namespace}`;
}

/** Tool runner -> controller: outcomes of one namespace's actions. */
export function toolReportQueue(namespace: ToolNamespace): ToolReportQueueName {
	return `tool.report.${namespace}`;
}

/** Expired or failed execute jobs of one namespace. */
export function toolDeadLetterQueue(namespace: ToolNamespace): ToolDeadLetterQueueName {
	return `dlq.tool.execute.${namespace}`;
}

/**
 * A tool action's execution, one per granted approval. `failed` is a known failure (nothing
 * happened, or the provider said no); `unknown` is a runner that began and never reported, so
 * the side effect may have happened. An unknown action is never retried automatically.
 */
export const TOOL_ACTION_STATUSES = [
	"queued",
	"running",
	"succeeded",
	"failed",
	"unknown",
	"cancelled",
] as const;
export const ToolActionStatusSchema = z.enum(TOOL_ACTION_STATUSES);
export type ToolActionStatus = z.infer<typeof ToolActionStatusSchema>;

/** The idempotency key an executor must honour at its provider. */
export function toolActionIdempotencyKey(approvalId: string, actionHash: string): string {
	return `tool-action:${approvalId}:${actionHash}`;
}

/**
 * What an executor returns as proof: a flat record of short values. It reaches the agent and
 * the card's thread, so it is bounded and holds no control or invisible characters.
 */
export const ToolReceiptSchema = z
	.record(
		z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
		z.union([safeText(500, "verbatim"), z.number().finite(), z.boolean()]),
	)
	.refine((receipt) => Object.keys(receipt).length <= 20, "a receipt has at most 20 fields");
export type ToolReceipt = z.infer<typeof ToolReceiptSchema>;

/**
 * An approved action handed to a tool runner. The runner trusts none of it: it recomputes the
 * hash from the action, and `begin` checks that hash, the approval and the kill switch before
 * anything runs, and hands out the action's stored idempotency key.
 */
export const ToolActionJobSchema = z.strictObject({
	actionId: UuidSchema,
	approvalId: UuidSchema,
	attempt: z.int().min(1),
	agentId: AgentIdSchema,
	actionType: ToolNameSchema,
	actionParams: ActionParamsSchema,
	immutableActionHash: Sha256HexSchema,
	/** Past it `begin` refuses and the controller settles the action. */
	deadline: TimestampSchema,
});
export type ToolActionJob = z.infer<typeof ToolActionJobSchema>;

/** A short, redacted explanation; never a credential or a raw provider response. */
const ToolErrorSchema = safeText(500, "text");

const ToolReportBase = { actionId: UuidSchema, attempt: z.int().min(1) };

/**
 * Tool runner -> controller. Bound by the controller to the report queue's namespace, the
 * action and the attempt; anything else is ignored.
 */
export const ToolReportSchema = z.discriminatedUnion("kind", [
	/** The executor ran and returned proof. */
	z.strictObject({ ...ToolReportBase, kind: z.literal("succeeded"), receipt: ToolReceiptSchema }),
	/** A known failure: the executor said no, or the runner refused before `begin`. */
	z.strictObject({ ...ToolReportBase, kind: z.literal("failed"), error: ToolErrorSchema }),
	/** The executor threw after `begin`: the side effect may or may not have happened. */
	z.strictObject({ ...ToolReportBase, kind: z.literal("unknown"), error: ToolErrorSchema }),
	/** `begin` refused (kill switch, cancelled, deadline, hash): nothing ran. */
	z.strictObject({ ...ToolReportBase, kind: z.literal("refused"), reason: ToolErrorSchema }),
]);
export type ToolReport = z.infer<typeof ToolReportSchema>;

/** How an approval ended for the agent that asked. */
export const APPROVAL_OUTCOMES = [
	"denied",
	"expired",
	"cancelled",
	"succeeded",
	"failed",
	"unknown",
] as const;
export const ApprovalOutcomeSchema = z.enum(APPROVAL_OUTCOMES);
export type ApprovalOutcome = z.infer<typeof ApprovalOutcomeSchema>;

/**
 * `data` of `approval.resolved`, the one event the requesting agent waits for: the human's
 * decision and, for a grant, how the execution ended.
 */
export const ApprovalResolvedDataSchema = z.strictObject({
	approval_id: UuidSchema,
	action_type: ToolNameSchema,
	outcome: ApprovalOutcomeSchema,
	decided_by_user_id: MattermostIdSchema.nullable(),
	receipt: ToolReceiptSchema.nullable(),
	/** Why it was cancelled or failed, in the Gateway's words. */
	detail: ToolErrorSchema.nullable(),
});
export type ApprovalResolvedData = z.infer<typeof ApprovalResolvedDataSchema>;

/** `data` of the record-only `approval.granted` and `approval.denied` events. */
export const ApprovalDecisionDataSchema = z.strictObject({
	approval_id: UuidSchema,
	action_type: ToolNameSchema,
	decided_by_user_id: MattermostIdSchema,
});
export type ApprovalDecisionData = z.infer<typeof ApprovalDecisionDataSchema>;
