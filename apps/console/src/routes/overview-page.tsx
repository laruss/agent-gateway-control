import { AlertCircle } from "lucide-react";
import type * as React from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useConsoleStatus } from "@/hooks/use-console-status";
import { AgentCard } from "./overview/agent-card";
import { AlertsList } from "./overview/alerts-list";
import { FooterStatus } from "./overview/footer-status";
import { formatTimestamp } from "./overview/format";
import { QueuesTable } from "./overview/queues-table";
import { RecentRunsTable } from "./overview/recent-runs-table";
import { TopSummary } from "./overview/top-summary";

function Section({
	title,
	children,
}: Readonly<{ title: string; children: React.ReactNode }>): React.ReactElement {
	return (
		<section className="flex flex-col gap-2">
			<h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
			{children}
		</section>
	);
}

/**
 * Everything the old server-rendered dashboard showed (ADR-023), ported section for section:
 * the top summary, alerts, one card per agent, recent runs, queues and the footer. Polls
 * `/api/status` every 15 seconds (`useConsoleStatus`) and never hides a stale or unavailable
 * collection behind an empty-looking page — the same banner the server-rendered page carried.
 */
export function OverviewPage(): React.ReactElement {
	const query = useConsoleStatus();

	if (query.isPending) {
		return (
			<div className="flex flex-col gap-4">
				<Skeleton className="h-6 w-64" />
				<Skeleton className="h-24 w-full" />
				<Skeleton className="h-64 w-full" />
			</div>
		);
	}

	// A data-less error view only when nothing has ever loaded: once a poll has succeeded once,
	// `query.data` keeps that last snapshot even if a later poll fails (`query.isError` reflects
	// only the most recent attempt) — that retained snapshot, and its own timestamp, are still
	// shown below, next to the failure banner, rather than hidden behind it.
	if (query.data === undefined) {
		return (
			<Alert variant="destructive">
				<AlertCircle />
				<AlertTitle>Could not load the console status</AlertTitle>
				<AlertDescription>
					{query.error instanceof Error ? query.error.message : "Unknown error."}
				</AlertDescription>
			</Alert>
		);
	}

	const snapshot = query.data;

	if (snapshot.state === "unavailable") {
		return (
			<Alert variant="destructive">
				<AlertCircle />
				<AlertTitle>Console data is unavailable</AlertTitle>
				<AlertDescription>{snapshot.error}</AlertDescription>
			</Alert>
		);
	}

	const { status } = snapshot;

	return (
		<div className="flex flex-col gap-6">
			<p className="text-sm text-muted-foreground">As of {formatTimestamp(snapshot.asOf)}</p>
			{query.isError && (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>The last refresh failed</AlertTitle>
					<AlertDescription>
						Showing data from {formatTimestamp(snapshot.asOf)}:{" "}
						{query.error instanceof Error ? query.error.message : "Unknown error."}
					</AlertDescription>
				</Alert>
			)}
			{snapshot.state === "stale" && (
				<Alert>
					<AlertCircle />
					<AlertTitle>Showing data from {formatTimestamp(snapshot.asOf)} (stale)</AlertTitle>
					<AlertDescription>The last refresh failed: {snapshot.error}</AlertDescription>
				</Alert>
			)}
			<TopSummary system={status.system} />
			<AlertsList alerts={status.alerts} />
			<Section title="Agents">
				{status.agents.length === 0 ? (
					<p className="text-sm text-muted-foreground">No agents configured.</p>
				) : (
					<div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
						{status.agents.map((agent) => (
							<AgentCard key={agent.status.agentId} agent={agent} />
						))}
					</div>
				)}
			</Section>
			<Section title="Recent runs">
				<RecentRunsTable runs={status.recentRuns} />
			</Section>
			<Section title="Queues">
				<QueuesTable queues={status.system.queues} />
			</Section>
			<FooterStatus system={status.system} />
		</div>
	);
}
