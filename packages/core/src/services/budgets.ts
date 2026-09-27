import {
	type JsonValue,
	type OrganizationBudgets,
	type RuntimeUsage,
	RuntimeUsageSchema,
} from "@agent-gateway/contracts";
import { agents, runUsage, withTransaction } from "@agent-gateway/db";
import {
	type BudgetHold,
	budgetHold,
	meteredUsage,
	type UsageTotals,
	utcDay,
} from "@agent-gateway/policy";
import { and, eq, sql } from "drizzle-orm";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import { loadActiveConfig, raiseAlert } from "./store.ts";

/** A run's attempt whose usage is booked. */
export type UsageAttempt = Readonly<{
	runId: string;
	attempt: number;
	agentId: string;
}>;

/** The largest cost a ledger row holds (`numeric(14, 6)`); a larger report is capped. */
const MAX_BOOKED_COST_USD = 99_999_999;

/**
 * Books one attempt's usage in the ledger, once, on the UTC day it is reported: a redelivered
 * report changes nothing, and a retry after midnight counts for the new day. Every attempt that
 * reports counts, the failed and retried ones too.
 */
export async function recordRunUsage(
	uow: UnitOfWork,
	attempt: UsageAttempt,
	usage: RuntimeUsage | null,
): Promise<void> {
	const metered = meteredUsage(usage);
	await uow.tx.db
		.insert(runUsage)
		.values({
			runId: attempt.runId,
			attempt: attempt.attempt,
			agentId: attempt.agentId,
			day: utcDay(uow.now),
			costUsd: metered.costUsd === null ? null : Math.min(metered.costUsd, MAX_BOOKED_COST_USD),
			tokens: metered.tokens,
			recordedAt: uow.now,
		})
		.onConflictDoNothing();
}

/** The usage a worker's untrusted `completed` result reports, if it parses. */
export function reportedUsage(result: JsonValue): RuntimeUsage | null {
	if (typeof result !== "object" || result === null || Array.isArray(result)) {
		return null;
	}
	const parsed = RuntimeUsageSchema.safeParse(result.usage);
	return parsed.success ? parsed.data : null;
}

async function totals(uow: UnitOfWork, day: string, agentId: string | null): Promise<UsageTotals> {
	const [row] = await uow.tx.db
		.select({
			costUsd: sql<string>`coalesce(sum(${runUsage.costUsd}), 0)`,
			tokens: sql<string>`coalesce(sum(${runUsage.tokens}), 0)`,
			unmetered: sql<string>`count(*) filter (where ${runUsage.costUsd} is null and ${runUsage.tokens} is null)`,
		})
		.from(runUsage)
		.where(
			agentId === null
				? eq(runUsage.day, day)
				: and(eq(runUsage.day, day), eq(runUsage.agentId, agentId)),
		);
	return {
		costUsd: Number(row?.costUsd ?? 0),
		tokens: Number(row?.tokens ?? 0),
		unmeteredAttempts: Number(row?.unmetered ?? 0),
	};
}

/**
 * Whether the agent may start no run today, with an alert once per scope and day. Computed
 * from the ledger each time: the hold ends when the UTC day changes or a limit is raised.
 */
export async function budgetHoldFor(uow: UnitOfWork, agentId: string): Promise<BudgetHold | null> {
	const config = await loadActiveConfig(uow.tx.db);
	const budgets = config?.organization.organization.budgets;
	if (budgets === undefined) {
		return null;
	}
	const day = utcDay(uow.now);
	const hold = budgetHold(budgets, await totals(uow, day, agentId), await totals(uow, day, null));
	if (hold !== null) {
		const scope = hold.scope === "global" ? "global" : `agent:${agentId}`;
		await raiseAlert(
			uow,
			`budget:${scope}:${day}`,
			hold.scope === "global"
				? `No agent starts a run until the end of ${day} (UTC): ${hold.reason}.`
				: `@${agentId} starts no run until the end of ${day} (UTC): ${hold.reason}.`,
			{ day, scope: hold.scope },
		);
	}
	return hold;
}

export type AgentBudgetUsage = Readonly<{
	agentId: string;
	usage: UsageTotals;
	hold: BudgetHold | null;
}>;

export type BudgetReport = Readonly<{
	day: string;
	budgets: OrganizationBudgets | null;
	global: UsageTotals;
	agents: Readonly<AgentBudgetUsage[]>;
}>;

/** Today's consumption per agent and in total, with the holds it causes; for the CLI. */
export async function budgetReport(deps: ControlPlaneDeps): Promise<BudgetReport> {
	return withTransaction(deps.pool, async (tx) => {
		const uow: UnitOfWork = { deps, tx, jobs: deps.jobs(tx), now: deps.clock() };
		const config = await loadActiveConfig(tx.db);
		const budgets = config?.organization.organization.budgets ?? null;
		const day = utcDay(uow.now);
		const global = await totals(uow, day, null);
		const agentRows = await tx.db.select({ id: agents.id }).from(agents).orderBy(agents.id);
		const rows: AgentBudgetUsage[] = [];
		for (const { id } of agentRows) {
			const usage = await totals(uow, day, id);
			rows.push({ agentId: id, usage, hold: budgetHold(budgets ?? undefined, usage, global) });
		}
		return { day, budgets, global, agents: rows };
	});
}
