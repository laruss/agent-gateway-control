import type { ConsoleAgentListItem } from "@agent-gateway/contracts";
import { AlertCircle } from "lucide-react";
import * as React from "react";
import { Link } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { ApiError, fetchAgentsList } from "@/lib/api-client";

type ListState =
	| Readonly<{ status: "loading" }>
	| Readonly<{ status: "error"; message: string }>
	| Readonly<{ status: "ok"; agents: Readonly<ConsoleAgentListItem[]> }>;

const STATE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
	idle: "secondary",
	running: "default",
	queued: "default",
	waiting: "outline",
	paused: "outline",
	failed: "destructive",
	disabled: "outline",
};

function StateBadge({ state }: { state: string }): React.ReactElement {
	return <Badge variant={STATE_VARIANT[state] ?? "outline"}>{state}</Badge>;
}

function formatLastRun(agent: ConsoleAgentListItem): string {
	if (agent.lastRun === null) {
		return "Never run";
	}
	const when = agent.lastRun.finishedAt ?? null;
	const time = when === null ? "in progress" : new Date(when).toLocaleString();
	return `${agent.lastRun.status} · ${time}`;
}

/** The Agents hub's list: every configured agent, its runtime and model, how many channels it is
 * allowed in, and its last run — editing happens on the detail page (ADR-025). */
export function AgentsListPage(): React.ReactElement {
	const [state, setState] = React.useState<ListState>({ status: "loading" });

	React.useEffect(() => {
		let cancelled = false;
		fetchAgentsList()
			.then((response) => {
				if (!cancelled) {
					setState({ status: "ok", agents: response.agents });
				}
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setState({
						status: "error",
						message: error instanceof ApiError ? error.message : "Could not load the agents list.",
					});
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<Card>
			<CardHeader>
				<CardTitle>Agents</CardTitle>
				<CardDescription>Every configured agent; open one to edit it.</CardDescription>
			</CardHeader>
			<CardContent>
				{state.status === "loading" && (
					<div className="flex flex-col gap-2">
						<Skeleton className="h-8 w-full" />
						<Skeleton className="h-8 w-full" />
						<Skeleton className="h-8 w-full" />
					</div>
				)}
				{state.status === "error" && (
					<Alert variant="destructive">
						<AlertCircle />
						<AlertTitle>Could not load the agents list</AlertTitle>
						<AlertDescription>{state.message}</AlertDescription>
					</Alert>
				)}
				{state.status === "ok" && state.agents.length === 0 && (
					<p className="text-sm text-muted-foreground">No agents configured.</p>
				)}
				{state.status === "ok" && state.agents.length > 0 && (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Agent</TableHead>
								<TableHead>State</TableHead>
								<TableHead>Runtime / model</TableHead>
								<TableHead>Channels</TableHead>
								<TableHead>Last run</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{state.agents.map((agent) => (
								<TableRow key={agent.id}>
									<TableCell>
										<Link to={`/agents/${agent.id}`} className="font-medium hover:underline">
											{agent.displayName}
										</Link>
										<span className="ml-2 text-xs text-muted-foreground">({agent.id})</span>
										{!agent.enabled && (
											<Badge variant="outline" className="ml-2">
												disabled
											</Badge>
										)}
									</TableCell>
									<TableCell>
										<StateBadge state={agent.state} />
									</TableCell>
									<TableCell className="text-sm">
										{agent.runtimeAdapter}
										{agent.model !== null && (
											<span className="text-muted-foreground"> · {agent.model}</span>
										)}
									</TableCell>
									<TableCell className="text-sm">{agent.channelCount}</TableCell>
									<TableCell className="text-sm text-muted-foreground">
										{formatLastRun(agent)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
}
