import type { ConsoleAgentListItem, ConsoleAgentListResponse } from "@agent-gateway/contracts";
import { AlertCircle } from "lucide-react";
import * as React from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { LifecycleStatusBadge } from "@/components/lifecycle-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { ApiError, fetchAgentsList, restoreAgent } from "@/lib/api-client";
import { NewAgentDialog } from "./agents-list/new-agent-dialog.tsx";

type ListState =
	| Readonly<{ status: "loading" }>
	| Readonly<{ status: "error"; message: string }>
	| Readonly<{ status: "ok"; response: ConsoleAgentListResponse }>;

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

function isRetired(agent: ConsoleAgentListItem): boolean {
	return agent.lifecycleStatus === "retiring" || agent.lifecycleStatus === "retired";
}

/** The Agents hub's list: every configured agent, its runtime and model, how many channels it is
 * allowed in, its last run and its lifecycle status — editing happens on the detail page
 * (ADR-025); creating, retiring and restoring an agent are lifecycle actions (ADR-026). Retired
 * agents are filtered out by default (a "Show retired" switch reveals them) but, unlike a plain
 * disabled agent, never disappear outright: their own Restore action stays reachable here even
 * after their configuration has left the active bundle. */
export function AgentsListPage(): React.ReactElement {
	const [state, setState] = React.useState<ListState>({ status: "loading" });
	const [showRetired, setShowRetired] = React.useState(false);
	const [dialogOpen, setDialogOpen] = React.useState(false);
	const [restoringId, setRestoringId] = React.useState<string | null>(null);

	const load = React.useCallback(async () => {
		try {
			const response = await fetchAgentsList();
			setState({ status: "ok", response });
		} catch (error) {
			setState({
				status: "error",
				message: error instanceof ApiError ? error.message : "Could not load the agents list.",
			});
		}
	}, []);

	React.useEffect(() => {
		void load();
	}, [load]);

	async function handleRestore(agent: ConsoleAgentListItem) {
		setRestoringId(agent.id);
		try {
			const result = await restoreAgent(agent.id, { idempotencyKey: crypto.randomUUID() });
			if (result.kind === "conflict") {
				toast.error(
					"The active configuration changed since this list was loaded. Reload and try again.",
				);
				return;
			}
			if (result.kind === "invalid") {
				toast.error(result.problems.join("; "));
				return;
			}
			toast.success(`Restoring '${agent.id}'; its bot is being re-provisioned now.`);
			await load();
		} catch (error) {
			toast.error(error instanceof ApiError ? error.message : "Could not restore this agent.");
		} finally {
			setRestoringId(null);
		}
	}

	const agents = state.status === "ok" ? state.response.agents : [];
	const retiredCount = agents.filter(isRetired).length;
	const visible = agents.filter((agent) => showRetired || !isRetired(agent));

	return (
		<Card>
			<CardHeader className="flex flex-row items-start justify-between">
				<div>
					<CardTitle>Agents</CardTitle>
					<CardDescription>Every configured agent; open one to edit it.</CardDescription>
				</div>
				<Button onClick={() => setDialogOpen(true)}>New agent</Button>
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
				{state.status === "ok" && (
					<>
						{retiredCount > 0 && (
							<div className="mb-4 flex items-center gap-3">
								<Switch id="show-retired" checked={showRetired} onCheckedChange={setShowRetired} />
								<label htmlFor="show-retired" className="text-sm text-muted-foreground">
									Show {retiredCount} retired agent{retiredCount === 1 ? "" : "s"}
								</label>
							</div>
						)}
						{visible.length === 0 && (
							<p className="text-sm text-muted-foreground">No agents configured.</p>
						)}
						{visible.length > 0 && (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Agent</TableHead>
										<TableHead>State</TableHead>
										<TableHead>Runtime / model</TableHead>
										<TableHead>Channels</TableHead>
										<TableHead>Last run</TableHead>
										<TableHead />
									</TableRow>
								</TableHeader>
								<TableBody>
									{visible.map((agent) => (
										<TableRow key={agent.id}>
											<TableCell>
												<Link to={`/agents/${agent.id}`} className="font-medium hover:underline">
													{agent.displayName}
												</Link>
												<span className="ml-2 text-xs text-muted-foreground">({agent.id})</span>
												{!agent.enabled && !isRetired(agent) && (
													<Badge variant="outline" className="ml-2">
														disabled
													</Badge>
												)}
												{agent.lifecycleStatus !== null && (
													<LifecycleStatusBadge status={agent.lifecycleStatus} className="ml-2" />
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
											<TableCell>
												{agent.lifecycleStatus === "retired" && (
													<Button
														variant="outline"
														size="sm"
														disabled={restoringId === agent.id}
														onClick={() => void handleRestore(agent)}
													>
														{restoringId === agent.id ? "Restoring…" : "Restore"}
													</Button>
												)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</>
				)}
			</CardContent>
			{state.status === "ok" && (
				<NewAgentDialog
					open={dialogOpen}
					onOpenChange={setDialogOpen}
					knownChannels={state.response.knownChannels}
					knownRuntimeAdapters={state.response.knownRuntimeAdapters}
					onCreated={() => void load()}
				/>
			)}
		</Card>
	);
}
