import { z } from "zod";
import {
	type AgentId,
	AgentIdSchema,
	MattermostIdSchema,
	type RiskLevel,
	RiskLevelSchema,
	Sha256HexSchema,
	safeText,
	TimestampSchema,
	ToolNameSchema,
	truncateRequestPreview,
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
 * {@link ActionParamsSchema} without its own `.min(1)`: a model's own `needs_human` draft for a
 * `custom_https` action (ADR-027) may legitimately have no parameters of its own at all — a fixed
 * `GET` whose only moving part is a secret the runner alone resolves — since the one parameter
 * every custom-tool action always ends up with, `custom_tool_definition_version`, is the
 * controller's own, added only once the draft has already passed this schema
 * (`prepareCustomApprovalDraft`, `@agent-gateway/core`). `ApprovalRequestDraftSchema`'s own refine
 * restores the `>= 1` bound for every other action type, which has no such controller-added
 * parameter to fall back on.
 */
const DraftActionParamsSchema = z
	.array(ActionParamSchema)
	.max(32)
	.refine((params) => new Set(params.map((p) => p.name)).size === params.length, {
		message: "action parameter names must be unique",
	});

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

/**
 * A fenced code block `text` cannot break out of: the fence is longer than any backtick run
 * inside. Shared by the renderer (`@agent-gateway/mattermost`) and the controller's own
 * pre-creation card-fit check ({@link fitApprovalCard}), so the two can never disagree on what a
 * block actually costs.
 */
export function codeBlock(text: string): string {
	const fence = "`".repeat(fenceLength(text));
	return `${fence}\n${text}\n${fence}`;
}

/**
 * Letters a lookalike can hide among: a value mixing these scripts (a Cyrillic "а" in a Latin
 * IBAN) is flagged on the card. Han, kana and Hangul count as one script: Japanese mixes them.
 */
const SCRIPTS: Readonly<{ name: string; letters: RegExp }[]> = [
	{ name: "Latin", letters: /\p{Script=Latin}/u },
	{ name: "Cyrillic", letters: /\p{Script=Cyrillic}/u },
	{ name: "Greek", letters: /\p{Script=Greek}/u },
	{ name: "Armenian", letters: /\p{Script=Armenian}/u },
	{ name: "Georgian", letters: /\p{Script=Georgian}/u },
	{ name: "Hebrew", letters: /\p{Script=Hebrew}/u },
	{ name: "Arabic", letters: /\p{Script=Arabic}/u },
	{ name: "Devanagari", letters: /\p{Script=Devanagari}/u },
	{ name: "Thai", letters: /\p{Script=Thai}/u },
	{
		name: "CJK",
		letters: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u,
	},
];

/** The scripts whose letters a value contains. */
export function scriptsOf(value: string): Readonly<string[]> {
	return SCRIPTS.filter((script) => script.letters.test(value)).map((script) => script.name);
}

/** At most this many parameter names are listed in the mixed-script warning. */
const MAX_FLAGGED = 5;

/** The warning line for parameters that mix scripts, or null. */
function mixedScriptWarning(actionParams: Readonly<ActionParam[]>): string | null {
	const mixed = actionParams
		.filter((param) => scriptsOf(param.value).length > 1)
		.map((param) => param.name);
	if (mixed.length === 0) {
		return null;
	}
	const listed = mixed.slice(0, MAX_FLAGGED).map((name) => `\`${name}\``);
	const more = mixed.length > MAX_FLAGGED ? ` and ${mixed.length - MAX_FLAGGED} more` : "";
	return `:warning: Mixed alphabets in ${listed.join(", ")}${more}: look-alike letters can hide a different value; check them character by character.`;
}

/** Mattermost's own post limit; an approval card's rendered text must never exceed it. */
export const MATTERMOST_POST_MAX = 16_383;

export const REQUEST_PREVIEW_LABEL =
	"Request preview (authoritative; no secret value is ever shown):";

/**
 * Everything {@link fitApprovalCard} needs from an approval besides its own request preview (kept
 * separate, see there) — a structural subset of `MattermostApprovalPayload`
 * (`@agent-gateway/contracts`'s own `outbox.ts`), declared here rather than imported from it:
 * `outbox.ts` already imports from this module (`ActionParamsSchema`), and `@agent-gateway/core`
 * — which depends on neither `@agent-gateway/mattermost` nor anything that would import the
 * renderer — needs to reach this exact layout from here, to check whether a finished card fits
 * Mattermost's own post limit before an approval is ever created (ADR-027).
 */
export type ApprovalCardFields = Readonly<{
	riskLevel: RiskLevel;
	expiresAt: string;
	requestedByAgentId: AgentId;
	actionType: string;
	actionSummary: string;
	actionParams: Readonly<ActionParam[]>;
	approvalCode: string;
	approvalId: string;
	immutableActionHash: string;
}>;

/** {@link ApprovalCardFields}, but `actionSummary` may already be shortened, or `null` to omit its
 * block entirely — the only two fields `fitApprovalCard`'s own shrink loop ever varies. */
type ApprovalCardShrinkableFields = Omit<ApprovalCardFields, "actionSummary"> &
	Readonly<{ actionSummary: string | null }>;

function approvalCardLines(
	card: ApprovalCardShrinkableFields,
): Readonly<{ head: Readonly<string[]>; tail: Readonly<string[]> }> {
	const warning = mixedScriptWarning(card.actionParams);
	const head = [
		`**Approval requested** · risk **${card.riskLevel}** · expires ${card.expiresAt}`,
		`Agent \`${card.requestedByAgentId}\` asks to run \`${card.actionType}\`.`,
		...(card.actionSummary === null
			? []
			: ["Summary (written by the agent):", codeBlock(card.actionSummary)]),
		"Parameters (covered by the approval hash):",
		codeBlock(approvalParamLines(card.actionParams)),
	];
	const tail = [
		...(warning === null ? [] : [warning]),
		`To decide, an owner replies in this thread with exactly one line: \`approve ${card.approvalCode}\` or \`deny ${card.approvalCode}\`.`,
		`Request \`${card.approvalId}\` · hash \`${card.immutableActionHash}\``,
	];
	return { head, tail };
}

function assembleApprovalCard(
	lines: Readonly<{ head: Readonly<string[]>; tail: Readonly<string[]> }>,
	preview: string | null,
): string {
	if (preview === null) {
		return [...lines.head, ...lines.tail].join("\n");
	}
	return [...lines.head, REQUEST_PREVIEW_LABEL, codeBlock(preview), ...lines.tail].join("\n");
}

/**
 * The fully assembled approval card text for `card`'s own full `actionSummary`, with `preview` —
 * a `custom_https` action's own full, untruncated request preview (ADR-027), or `null` for any
 * other action type — inserted in its own block. The preview is never trimmed, shortened or
 * omitted here, whatever it takes to make the card fit: only the summary is, and only once the
 * full card does not otherwise fit {@link MATTERMOST_POST_MAX}. Returns `null` once even an
 * entirely-dropped summary still does not fit: a card this large must be refused before it is
 * ever created (`customApprovalRequestPreview`/`createApproval`, `@agent-gateway/core`), never
 * rendered with its preview cut to make room. The one case this can still return `null` for a
 * card actually reaching the renderer (`@agent-gateway/mattermost`) is data created before this
 * rule existed, which the renderer shows as a short, non-approvable "too large" card instead of
 * ever approving a request whose full preview was never actually shown.
 *
 * Shared, verbatim, by that pre-creation check and the renderer, so the two can never disagree on
 * what a finished card costs: both call this one function, never each their own measurement of
 * the same layout.
 */
export function fitApprovalCard(card: ApprovalCardFields, preview: string | null): string | null {
	let summary: string | null = card.actionSummary;
	for (;;) {
		const text = assembleApprovalCard(
			approvalCardLines({ ...card, actionSummary: summary }),
			preview,
		);
		if (text.length <= MATTERMOST_POST_MAX) {
			return text;
		}
		if (summary === null) {
			return null;
		}
		if (summary.length === 0) {
			summary = null;
			continue;
		}
		const overflow = text.length - MATTERMOST_POST_MAX;
		const shrunk = truncateRequestPreview(summary, summary.length - overflow);
		// `truncateRequestPreview` can back up past a dangling percent-escape by more than the
		// excess alone accounts for; forcing at least one character off guarantees this always
		// terminates even then (it has no percent-escapes of its own to protect, but the same
		// safety net costs nothing to share).
		summary = shrunk.length < summary.length ? shrunk : summary.slice(0, -1);
	}
}

export const ApprovalRequestDraftSchema = z
	.strictObject({
		actionType: ToolNameSchema,
		/** Every parameter that defines the action; all of them go into the immutable hash. Empty
		 * only for a `custom.*` action type (see {@link DraftActionParamsSchema}) — every other
		 * action type still needs at least one, enforced below. */
		actionParams: DraftActionParamsSchema,
		/** Prose; the approval card must render it apart from the hashed parameters. */
		actionSummary: safeText(2000, "text"),
	})
	.refine((draft) => draft.actionParams.length > 0 || draft.actionType.startsWith("custom."), {
		message: "actionParams: a non-custom action must have at least one parameter",
		path: ["actionParams"],
	})
	.refine((draft) => approvalBlocksLength(draft) <= APPROVAL_TEXT_MAX, {
		message: `summary and parameters together must fit ${APPROVAL_TEXT_MAX} characters (one approval card)`,
		path: ["actionParams"],
	});
export type ApprovalRequestDraft = z.infer<typeof ApprovalRequestDraftSchema>;

/**
 * An approval's decision, never its execution: a granted approval stays granted whatever the
 * tool action does (ADR-018). `cancelled`: withdrawn before a decision (kill-all, the agent
 * disabled) or refused by policy when granted.
 */
export const APPROVAL_STATUSES = ["pending", "granted", "denied", "expired", "cancelled"] as const;
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

const DECIDED_STATUSES: Readonly<ApprovalStatus[]> = ["granted", "denied"];

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
