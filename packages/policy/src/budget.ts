import type { DailyBudget, OrganizationBudgets, RuntimeUsage } from "@agent-gateway/contracts";

/** What one attempt consumed, as the usage ledger books it. */
export type MeteredUsage = Readonly<{
	/** Null when the runtime reported no cost. */
	costUsd: number | null;
	/** Input plus output tokens; null when the runtime reported neither. */
	tokens: number | null;
}>;

/**
 * Normalizes a runtime's usage. Cached input is part of the input and is not added again. An
 * attempt without usage reports nothing: unmetered.
 */
export function meteredUsage(usage: RuntimeUsage | null): MeteredUsage {
	if (usage === null) {
		return { costUsd: null, tokens: null };
	}
	const tokens =
		usage.inputTokens === null && usage.outputTokens === null
			? null
			: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
	return { costUsd: usage.costUsd, tokens };
}

export function isUnmetered(usage: MeteredUsage): boolean {
	return usage.costUsd === null && usage.tokens === null;
}

/** One scope's consumption in the current UTC day. */
export type UsageTotals = Readonly<{
	costUsd: number;
	tokens: number;
	/** Attempts that reported neither cost nor tokens. */
	unmeteredAttempts: number;
}>;

/** Why a scope may start no more runs today, or null. */
function overBudget(totals: UsageTotals, budget: DailyBudget | undefined): string | null {
	if (budget?.cost_usd !== undefined && totals.costUsd >= budget.cost_usd) {
		return `cost ${totals.costUsd.toFixed(2)} USD reached the daily limit of ${budget.cost_usd} USD`;
	}
	if (budget?.tokens !== undefined && totals.tokens >= budget.tokens) {
		return `${totals.tokens} tokens reached the daily limit of ${budget.tokens}`;
	}
	return null;
}

export type BudgetHold = Readonly<{ scope: "agent" | "global"; reason: string }>;

/**
 * Whether an agent is held for the rest of the UTC day: the global limit first (it holds
 * everyone), then the agent's own, then unmetered usage when the organization fails closed on
 * it. Computed from the ledger each time, so a hold ends when the day changes or a limit is
 * raised. Pure.
 */
export function budgetHold(
	budgets: OrganizationBudgets | undefined,
	agent: UsageTotals,
	global: UsageTotals,
): BudgetHold | null {
	if (budgets === undefined) {
		return null;
	}
	const globalReason = overBudget(global, budgets.global_daily);
	if (globalReason !== null) {
		return { scope: "global", reason: `global budget: ${globalReason}` };
	}
	const agentReason = overBudget(agent, budgets.per_agent_daily);
	if (agentReason !== null) {
		return { scope: "agent", reason: `agent budget: ${agentReason}` };
	}
	const limited = budgets.per_agent_daily !== undefined || budgets.global_daily !== undefined;
	if (limited && budgets.unmetered === "hold" && agent.unmeteredAttempts > 0) {
		return {
			scope: "agent",
			reason: `${agent.unmeteredAttempts} run attempt(s) today reported no usage; budgets.unmetered is 'hold'`,
		};
	}
	return null;
}

/** The UTC day a moment belongs to, `YYYY-MM-DD`. */
export function utcDay(at: Date): string {
	return at.toISOString().slice(0, 10);
}

/** Share of a daily limit at which a scope's consumption is reported, before it holds. */
export const BUDGET_WARNING_RATIO = 0.8;

/**
 * How close a scope is to its daily limit: the most consumed metric, as a share of its limit,
 * when that share reaches {@link BUDGET_WARNING_RATIO}. Null below it or without a limit. Pure.
 */
export function budgetPressure(
	totals: UsageTotals,
	budget: DailyBudget | undefined,
): Readonly<{ ratio: number; reason: string }> | null {
	const shares: { ratio: number; reason: string }[] = [];
	if (budget?.cost_usd !== undefined && budget.cost_usd > 0) {
		shares.push({
			ratio: totals.costUsd / budget.cost_usd,
			reason: `cost ${totals.costUsd.toFixed(2)} of ${budget.cost_usd} USD`,
		});
	}
	if (budget?.tokens !== undefined && budget.tokens > 0) {
		shares.push({
			ratio: totals.tokens / budget.tokens,
			reason: `${totals.tokens} of ${budget.tokens} tokens`,
		});
	}
	const top = shares.sort((a, b) => b.ratio - a.ratio)[0];
	return top === undefined || top.ratio < BUDGET_WARNING_RATIO ? null : top;
}
