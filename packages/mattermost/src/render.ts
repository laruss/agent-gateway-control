import {
	approvalParamLines,
	type MattermostAlertPayload,
	type MattermostApprovalPayload,
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
 * An approval card. The summary is the agent's prose and the parameters are what the hash
 * covers; both are shown verbatim in separate code blocks, never rendered as Markdown.
 */
export function renderApprovalCard(card: MattermostApprovalPayload): string {
	const params = approvalParamLines(card.actionParams);
	return [
		`**Approval requested** · risk **${card.riskLevel}** · expires ${card.expiresAt}`,
		`Agent \`${card.requestedByAgentId}\` asks to run \`${card.actionType}\`.`,
		"Summary (written by the agent):",
		codeBlock(card.actionSummary),
		"Parameters (covered by the approval hash):",
		codeBlock(params),
		`Request \`${card.approvalId}\` · hash \`${card.immutableActionHash}\``,
	].join("\n");
}
