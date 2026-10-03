import {
	type ApprovalNotice,
	type ApprovalOutcome,
	codeBlock,
	fitApprovalCard,
	type MattermostAlertPayload,
	type MattermostApprovalPayload,
	type MattermostApprovalReplyPayload,
	scriptsOf,
} from "@agent-gateway/contracts";

export { codeBlock, scriptsOf };

/**
 * An alert: a fixed heading, everything variable inside a code block, so an event field can
 * neither mention anyone nor forge formatting.
 */
export function renderAlert(alert: MattermostAlertPayload): string {
	const detail = Object.keys(alert.detail).length === 0 ? "" : `\n${JSON.stringify(alert.detail)}`;
	return `**Gateway alert**\n${codeBlock(`${alert.message}${detail}`)}`;
}

/**
 * An approval card. The summary is the agent's prose and the parameters are what the hash
 * covers; both are shown verbatim in separate code blocks, never rendered as Markdown. A
 * `custom_https` action also carries `customRequestPreview` — the authoritative, secret-free
 * rendering of the exact request (method, resolved path, query/header/body field names, a
 * secret-filled slot named but never its value) — shown in its own block, separate from the
 * model's own summary, since one is the agent's prose and the other is what will actually run.
 * The card tells an owner how to decide: one line in its thread with the request's code.
 *
 * `fitApprovalCard` (`@agent-gateway/contracts`, shared verbatim with the controller's own
 * pre-creation check) builds the actual text: the preview is never trimmed or omitted, only the
 * model's own summary is, and only once the full card would otherwise exceed Mattermost's own
 * post limit (ADR-027) — the parameters (already bounded, refused outright rather than trimmed,
 * before the request is ever created) are never touched either. A request created under this
 * rule always fits, one way or the other: `null` here means data from before it existed, whose
 * card cannot fit even with its summary dropped entirely — the one case rendered as a short,
 * non-approvable notice instead, since an owner must never be asked to approve a request whose
 * full preview this card cannot actually show.
 */
export function renderApprovalCard(card: MattermostApprovalPayload): string {
	const fitted = fitApprovalCard(card, card.customRequestPreview ?? null);
	if (fitted !== null) {
		return fitted;
	}
	return [
		`**Approval requested** · risk **${card.riskLevel}** · expires ${card.expiresAt}`,
		`Agent \`${card.requestedByAgentId}\` asks to run \`${card.actionType}\`.`,
		"This request is too large to show in full on one card and must be refused: nothing here can be approved.",
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
