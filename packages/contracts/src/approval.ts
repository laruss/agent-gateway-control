import { z } from "zod";
import {
	AgentIdSchema,
	MattermostIdSchema,
	RiskLevelSchema,
	Sha256HexSchema,
	safeText,
	TimestampSchema,
	ToolNameSchema,
	UuidSchema,
} from "./common.ts";

/**
 * One parameter of an action. Values are strings (amounts as decimal strings)
 * so that canonical hashing does not depend on number formatting.
 */
export const ActionParamSchema = z.strictObject({
	name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
	/** Shown verbatim on the approval card, so invisible and control characters are rejected. */
	value: safeText(2000, "verbatim"),
});
export type ActionParam = z.infer<typeof ActionParamSchema>;

export const ActionParamsSchema = z
	.array(ActionParamSchema)
	.min(1)
	.max(32)
	.refine((params) => new Set(params.map((p) => p.name)).size === params.length, {
		message: "action parameter names must be unique",
	});
export type ActionParams = z.infer<typeof ActionParamsSchema>;

/**
 * What an agent asks a human to approve. Returned inside `needs_human`.
 * Risk level is assigned by policy, never by the model.
 */
/**
 * Most characters the variable part of an approval card may take (summary and parameters in
 * their code blocks, fences included), so the whole card fits one Mattermost post (16 383
 * characters) with its fixed lines around it.
 */
export const APPROVAL_TEXT_MAX = 15_000;

/** A code block's fence: longer than any backtick run inside, at least three. */
function fenceLength(text: string): number {
	return Math.max(3, 1 + Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)));
}

/** The parameters as the card shows them, one `name = value` line each. */
export function approvalParamLines(params: Readonly<ActionParam[]>): string {
	return params.map((param) => `${param.name} = ${param.value}`).join("\n");
}

/** Characters the summary and parameter blocks of an approval card take, fences included. */
export function approvalBlocksLength(
	draft: Readonly<{ actionSummary: string; actionParams: Readonly<ActionParam[]> }>,
): number {
	const params = approvalParamLines(draft.actionParams);
	return [draft.actionSummary, params].reduce(
		(sum, block) => sum + block.length + 2 * fenceLength(block) + 2,
		0,
	);
}

export const ApprovalRequestDraftSchema = z
	.strictObject({
		actionType: ToolNameSchema,
		/** Every parameter that defines the action; all of them go into the immutable hash. */
		actionParams: ActionParamsSchema,
		/** Prose; the approval card must render it apart from the hashed parameters. */
		actionSummary: safeText(2000, "text"),
	})
	.refine((draft) => approvalBlocksLength(draft) <= APPROVAL_TEXT_MAX, {
		message: `summary and parameters together must fit ${APPROVAL_TEXT_MAX} characters (one approval card)`,
		path: ["actionParams"],
	});
export type ApprovalRequestDraft = z.infer<typeof ApprovalRequestDraftSchema>;

export const ApprovalStatusSchema = z.enum(["pending", "granted", "denied", "expired", "executed"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

const DECIDED_STATUSES: Readonly<ApprovalStatus[]> = ["granted", "denied", "executed"];

/** Persisted, immutable approval request (ADR-007). */
export const ApprovalRequestSchema = z
	.strictObject({
		id: UuidSchema,
		requestedByAgentId: AgentIdSchema,
		runId: UuidSchema,
		actionType: ToolNameSchema,
		actionParams: ActionParamsSchema,
		immutableActionHash: Sha256HexSchema,
		actionSummary: safeText(2000, "text"),
		riskLevel: RiskLevelSchema,
		status: ApprovalStatusSchema,
		allowedApproverUserIds: z
			.array(MattermostIdSchema)
			.min(1)
			.max(16)
			.refine((ids) => new Set(ids).size === ids.length, "approver ids must be unique"),
		/** One-time nonce bound to this request; a decision must present it. */
		nonce: z.string().min(16).max(128),
		createdAt: TimestampSchema,
		expiresAt: TimestampSchema,
		decidedByUserId: MattermostIdSchema.nullable(),
		decidedAt: TimestampSchema.nullable(),
	})
	.check((ctx) => {
		const request = ctx.value;
		const push = (path: string, message: string) =>
			ctx.issues.push({ code: "custom", input: request, path: [path], message });

		if (Date.parse(request.expiresAt) <= Date.parse(request.createdAt)) {
			push("expiresAt", "expiresAt must be later than createdAt");
		}

		const decided = request.decidedByUserId !== null || request.decidedAt !== null;
		if (DECIDED_STATUSES.includes(request.status)) {
			if (request.decidedByUserId === null || request.decidedAt === null) {
				push("decidedByUserId", `status '${request.status}' requires a human decision`);
			} else if (!request.allowedApproverUserIds.includes(request.decidedByUserId)) {
				push("decidedByUserId", "decision was made by a user outside the approver allowlist");
			} else if (Date.parse(request.decidedAt) < Date.parse(request.createdAt)) {
				push("decidedAt", "decision predates the request");
			} else if (Date.parse(request.decidedAt) > Date.parse(request.expiresAt)) {
				push("decidedAt", "decision was made after the request expired");
			}
		} else if (decided) {
			push("decidedByUserId", `status '${request.status}' must not carry a decision`);
		}
	});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
