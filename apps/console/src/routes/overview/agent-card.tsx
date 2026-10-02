import type { ConsoleAgent, DailyBudget } from "@agent-gateway/contracts";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DASH, fmt, formatTimestamp, numOrDash, orDash } from "./format";

const STATE_VARIANT: Readonly<Record<string, "default" | "secondary" | "destructive" | "outline">> =
	{
		running: "default",
		succeeded: "default",
		failed: "destructive",
		error: "destructive",
		waiting: "outline",
		queued: "outline",
		retry: "outline",
	};

function StateBadge({ state }: Readonly<{ state: string }>): React.ReactElement {
	return <Badge variant={STATE_VARIANT[state] ?? "secondary"}>{state}</Badge>;
}

function budgetLine(tokensToday: number, costTodayUsd: number, budget: DailyBudget | null): string {
	const tokenPart =
		budget?.tokens === undefined
			? `${fmt(tokensToday)} tokens today`
			: `${fmt(tokensToday)} / ${fmt(budget.tokens)} tokens today`;
	const costPart =
		budget?.cost_usd === undefined
			? `$${costTodayUsd.toFixed(2)} today`
			: `$${costTodayUsd.toFixed(2)} / $${budget.cost_usd.toFixed(2)} today`;
	return `${tokenPart} · ${costPart}`;
}

function Kv({
	label,
	children,
}: Readonly<{ label: string; children: React.ReactNode }>): React.ReactElement {
	return (
		<div className="flex items-baseline justify-between gap-2 text-sm">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="text-right">{children}</dd>
		</div>
	);
}

function TaskBlock({ agent }: Readonly<{ agent: ConsoleAgent }>): React.ReactElement {
	const task = agent.current;
	if (task === null) {
		return <p className="text-sm text-muted-foreground">No current task.</p>;
	}
	return (
		<dl className="flex flex-col gap-1">
			<Kv label="Task">
				<StateBadge state={task.status} /> attempt {task.attempt}/{task.maxAttempts}
			</Kv>
			<Kv label="Trigger">{task.triggerType}</Kv>
			<Kv label="Channel">{orDash(task.channel)}</Kv>
			<Kv label="Thread">{orDash(task.threadRootId)}</Kv>
			<Kv label="Queued">{formatTimestamp(task.queuedAt)}</Kv>
			<Kv label="Started">{task.startedAt === null ? DASH : formatTimestamp(task.startedAt)}</Kv>
			<Kv label="Deadline">{formatTimestamp(task.deadlineAt)}</Kv>
		</dl>
	);
}

function WaitsBlock({ agent }: Readonly<{ agent: ConsoleAgent }>): React.ReactElement | null {
	if (agent.waits.length === 0) {
		return null;
	}
	return (
		<div className="text-sm">
			<p className="mb-0.5 text-muted-foreground">Waits</p>
			<ul className="list-inside list-disc">
				{agent.waits.map((wait) => (
					// Waits carry no id of their own (ADR-023); the controller's own list is already
					// bounded and ordered by (eventType, timeoutAt), which is unique enough for this key.
					<li key={`${wait.eventType}-${wait.timeoutAt}`}>
						{wait.eventType} until {formatTimestamp(wait.timeoutAt)}
					</li>
				))}
			</ul>
		</div>
	);
}

function ContextBlock({ agent }: Readonly<{ agent: ConsoleAgent }>): React.ReactElement {
	const context = agent.context;
	if (context === null) {
		return (
			<div className="flex justify-between text-xs text-muted-foreground">
				<span>Context</span>
				<span>{DASH}</span>
			</div>
		);
	}
	const rows: ReadonlyArray<readonly [string, string]> = [
		["Input bytes / cap", `${fmt(context.inputBytes)} / ${fmt(context.inputLimitBytes)}`],
		[
			"Recent-replies chars / budget",
			`${fmt(context.recentRepliesChars)} / ${fmt(context.recentRepliesLimitChars)}`,
		],
		["Root chars / cap", `${fmt(context.rootChars)} / ${fmt(context.rootLimitChars)}`],
		["Summary chars / limit", `${fmt(context.summaryChars)} / ${fmt(context.summaryLimitChars)}`],
		[
			"Memory chars / budget",
			`${fmt(context.memoryChars)} / ${fmt(context.memoryLimitChars)} (${fmt(context.memoryItems)} items)`,
		],
		["Last attempt input tokens", numOrDash(context.inputTokens)],
		["Last attempt cached input tokens", numOrDash(context.cachedInputTokens)],
		["Last attempt output tokens", numOrDash(context.outputTokens)],
		["7-day max input tokens", numOrDash(agent.maxInputTokens7d)],
		["Omitted thread posts", fmt(context.omittedPosts)],
		["Pending events", fmt(context.pendingEvents)],
		["Model", context.model === null ? DASH : context.model],
	];
	return (
		<div className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
			{rows.map(([label, value]) => (
				<React.Fragment key={label}>
					<span>{label}</span>
					<span className="text-right">{value}</span>
				</React.Fragment>
			))}
		</div>
	);
}

export function AgentCard({ agent }: Readonly<{ agent: ConsoleAgent }>): React.ReactElement {
	const status = agent.status;
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-baseline justify-between gap-2">
					<span>
						{agent.displayName} <span className="text-muted-foreground">({status.agentId})</span>
					</span>
				</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<dl className="flex flex-col gap-1">
					<Kv label="State">
						<StateBadge state={status.state} />
						{status.enabled ? "" : " (disabled)"}
					</Kv>
					<Kv label="Since">{formatTimestamp(status.stateSince)}</Kv>
					<Kv label="Runtime">
						{status.runtimeAdapter}
						{status.model === null ? "" : ` · ${status.model}`}
					</Kv>
					<Kv label="Budget">
						{budgetLine(status.tokensToday, status.costTodayUsd, agent.budget)}
					</Kv>
					<Kv label="Pending inbox">{fmt(status.pendingInbox)}</Kv>
				</dl>
				<TaskBlock agent={agent} />
				<WaitsBlock agent={agent} />
				<ContextBlock agent={agent} />
			</CardContent>
		</Card>
	);
}
