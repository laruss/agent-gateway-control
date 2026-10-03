import {
	type ApprovalNotice,
	type ApprovalOutcome,
	approvalParamLines,
	type MattermostAlertPayload,
	type MattermostApprovalPayload,
	type MattermostApprovalReplyPayload,
} from "@agent-gateway/contracts";

/**
 * A fenced code block that `text` cannot break out of: the fence is longer than any backtick run
 * inside. Inside it Markdown, links and @mentions are inert.
 */
export function codeBlock(text: string): string {
	const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
	const fence = "`".repeat(Math.max(3, longestRun + 1));
	return `${fence}\n${text}\n${fence}`;
}

/**
 * An alert: a fixed heading, everything variable inside a code block, so an event field can
 * neither mention anyone nor forge formatting.
 */
export function renderAlert(alert: MattermostAlertPayload): string {
	const detail = Object.keys(alert.detail).length === 0 ? "" : `\n${JSON.stringify(alert.detail)}`;
	return `**Gateway alert**\n${codeBlock(`${alert.message}${detail}`)}`;
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
function mixedScriptWarning(card: MattermostApprovalPayload): string | null {
	const mixed = card.actionParams
		.filter((param) => scriptsOf(param.value).length > 1)
		.map((param) => param.name);
	if (mixed.length === 0) {
		return null;
	}
	const listed = mixed.slice(0, MAX_FLAGGED).map((name) => `\`${name}\``);
	const more = mixed.length > MAX_FLAGGED ? ` and ${mixed.length - MAX_FLAGGED} more` : "";
	return `:warning: Mixed alphabets in ${listed.join(", ")}${more}: look-alike letters can hide a different value; check them character by character.`;
}

/**
 * An approval card. The summary is the agent's prose and the parameters are what the hash
 * covers; both are shown verbatim in separate code blocks, never rendered as Markdown. A
 * `custom_https` action also carries `customRequestPreview` — the authoritative, secret-free
 * rendering of the exact request (method, resolved path, query/header/body field names, a
 * secret-filled slot named but never its value) — shown in its own block, separate from the
 * model's own summary, since one is the agent's prose and the other is what will actually run.
 * The card tells an owner how to decide: one line in its thread with the request's code.
 */
export function renderApprovalCard(card: MattermostApprovalPayload): string {
	const params = approvalParamLines(card.actionParams);
	const warning = mixedScriptWarning(card);
	return [
		`**Approval requested** · risk **${card.riskLevel}** · expires ${card.expiresAt}`,
		`Agent \`${card.requestedByAgentId}\` asks to run \`${card.actionType}\`.`,
		"Summary (written by the agent):",
		codeBlock(card.actionSummary),
		"Parameters (covered by the approval hash):",
		codeBlock(params),
		...(card.customRequestPreview === undefined
			? []
			: [
					"Request preview (authoritative; no secret value is ever shown):",
					codeBlock(card.customRequestPreview),
				]),
		...(warning === null ? [] : [warning]),
		`To decide, an owner replies in this thread with exactly one line: \`approve ${card.approvalCode}\` or \`deny ${card.approvalCode}\`.`,
		`Request \`${card.approvalId}\` · hash \`${card.immutableActionHash}\``,
	].join("\n");
}

const NOTICES: Readonly<Record<ApprovalNotice, string>> = {
	granted: "**Approved.** The action is queued for execution; its result follows in this thread.",
	denied: "**Denied.** Nothing runs.",
	refused:
		"**Approved, but refused.** The action cannot run now (the reason follows); the approval is cancelled and nothing runs.",
	not_an_approver:
		"Ignored: only an owner can decide, with their own account and without an integration.",
	malformed:
		"Not a decision. Reply with exactly one line: `approve <code>` or `deny <code>`, the code from the card.",
	wrong_code: "Ignored: that is not this request's code.",
	already_decided: "Ignored: this request is already decided.",
	expired: "This request has expired; nothing runs. The agent has to ask again.",
	withdrawn:
		"This request was withdrawn (kill-all, the agent was disabled, or the configuration changed); nothing runs.",
	executed: "**Execution finished.**",
};

const OUTCOMES: Readonly<Record<ApprovalOutcome, string>> = {
	succeeded: "The action succeeded.",
	failed: "The action failed; nothing was done.",
	unknown:
		"The outcome is unknown: the action began but did not report. Check the provider before anything is retried.",
	cancelled: "The action was cancelled before it began.",
	denied: "The request was denied.",
	expired: "The request expired.",
};

/**
 * The listener bot's answer in an approval card's thread: a fixed text, and anything variable
 * (a status, a receipt, an error) in a code block.
 */
export function renderApprovalReply(reply: MattermostApprovalReplyPayload): string {
	const lines = [NOTICES[reply.notice]];
	if (reply.outcome !== null && reply.notice === "executed") {
		lines.push(OUTCOMES[reply.outcome]);
	}
	if (reply.receipt !== null) {
		lines.push("Receipt:", codeBlock(JSON.stringify(reply.receipt, null, 2)));
	}
	if (reply.detail !== null) {
		lines.push(codeBlock(reply.detail));
	}
	return lines.join("\n");
}
