import {
	type RiskLevel,
	type ToolPattern,
	type ToolPolicySnapshot,
	toolPatternCovers,
} from "@agent-gateway/contracts";
import { actionParamIssues, isFinanceRead } from "./action-specs.ts";

/** The three permission lists of an agent, as its run's policy snapshot carries them. */
export type ToolLists = Readonly<
	Pick<ToolPolicySnapshot, "allow" | "requireHumanApproval" | "deny">
>;

export type ToolDecision = "allow" | "require_approval" | "deny";

export type ToolEvaluation = Readonly<{ decision: ToolDecision; reason: string }>;

export type ToolSubject = Readonly<{
	agentId: string;
	/** `organization.finance_agent_id`: the only agent that may touch `finance.*` at all. */
	financeAgentId: string;
}>;

const covers = (patterns: Readonly<ToolPattern[]>, actionType: string) =>
	patterns.some((pattern) => toolPatternCovers(pattern, actionType));

/**
 * What an agent may do with one concrete action, decided outside the model. Deny wins; finance
 * belongs to the finance agent only, and every finance write needs a human; anything no list
 * names is denied. Pure.
 */
export function evaluateTool(
	lists: ToolLists,
	subject: ToolSubject,
	actionType: string,
): ToolEvaluation {
	if (covers(lists.deny, actionType)) {
		return { decision: "deny", reason: `'${actionType}' is denied by policy` };
	}
	const finance = actionType.startsWith("finance.");
	if (finance && subject.agentId !== subject.financeAgentId) {
		return {
			decision: "deny",
			reason: `only '${subject.financeAgentId}' may use finance tools`,
		};
	}
	if (covers(lists.requireHumanApproval, actionType)) {
		return { decision: "require_approval", reason: `'${actionType}' needs a human approval` };
	}
	if (covers(lists.allow, actionType)) {
		if (finance && !isFinanceRead(actionType)) {
			// Configuration validation refuses this; fail closed if a snapshot slipped past it.
			return { decision: "deny", reason: `finance write '${actionType}' always needs approval` };
		}
		return { decision: "allow", reason: `'${actionType}' is allowed` };
	}
	return { decision: "deny", reason: `'${actionType}' is not granted` };
}

/**
 * Whether the broker may queue this approved action: approval-gated for the agent, not denied,
 * and with parameters its typed schema accepts. Returns the reasons it may not, or none.
 */
export function approvedActionIssues(
	lists: ToolLists,
	subject: ToolSubject,
	action: Readonly<{ actionType: string; actionParams: Parameters<typeof actionParamIssues>[1] }>,
): Readonly<string[]> {
	const evaluation = evaluateTool(lists, subject, action.actionType);
	if (evaluation.decision !== "require_approval") {
		return [evaluation.reason];
	}
	return actionParamIssues(action.actionType, action.actionParams);
}

const RISK_RULES: Readonly<{ pattern: ToolPattern; risk: RiskLevel }[]> = [
	{ pattern: "finance.*", risk: "critical" },
	{ pattern: "deploy.*", risk: "high" },
	{ pattern: "mail.*", risk: "high" },
	{ pattern: "publish.*", risk: "high" },
];

/** Risk comes from policy, never from the model. */
export function riskLevelFor(actionType: string): RiskLevel {
	return RISK_RULES.find((rule) => toolPatternCovers(rule.pattern, actionType))?.risk ?? "medium";
}
