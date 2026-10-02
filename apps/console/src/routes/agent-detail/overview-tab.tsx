import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useConsoleStatus } from "@/hooks/use-console-status";
import type { AgentDetailTabProps } from "./types.ts";

/** State, the current task and recent runs come from the same `/api/status` poll the overview
 * page already shows (ADR-025) — this tab never duplicates that query, only looks its own agent
 * up in it. Display name and the enabled switch are this tab's own editable fields. */
export function OverviewTab({
	original,
	draft,
	patchDraft,
}: AgentDetailTabProps): React.ReactElement {
	const query = useConsoleStatus();
	const displayName = draft.displayName ?? original.displayName;
	const enabled = draft.enabled ?? original.enabled;

	const agentStatus =
		query.data?.state !== "unavailable"
			? query.data?.status.agents.find((a) => a.status.agentId === original.id)
			: undefined;

	return (
		<div className="flex flex-col gap-6">
			<div className="grid max-w-sm gap-2">
				<Label htmlFor="display-name">Display name</Label>
				<Input
					id="display-name"
					value={displayName}
					onChange={(event) => {
						const next = event.target.value;
						patchDraft("displayName", next === original.displayName ? undefined : next);
					}}
				/>
			</div>
			<div className="flex items-center gap-3">
				<Switch
					id="enabled"
					checked={enabled}
					onCheckedChange={(checked) =>
						patchDraft("enabled", checked === original.enabled ? undefined : checked)
					}
				/>
				<Label htmlFor="enabled">Enabled</Label>
				{enabled !== original.enabled && (
					<Badge variant="outline">{enabled ? "will enable" : "will disable"}</Badge>
				)}
			</div>
			<div className="flex flex-col gap-2">
				<h3 className="text-sm font-medium text-muted-foreground">Current state</h3>
				{query.isPending && <Skeleton className="h-16 w-full max-w-md" />}
				{!query.isPending && agentStatus === undefined && (
					<p className="text-sm text-muted-foreground">No status data available yet.</p>
				)}
				{agentStatus !== undefined && (
					<div className="flex flex-col gap-1 text-sm">
						<p>
							State: <Badge variant="outline">{agentStatus.status.state}</Badge>
						</p>
						<p className="text-muted-foreground">
							{agentStatus.status.activeRuns.length > 0
								? `${agentStatus.status.activeRuns.length} run(s) in progress`
								: "No current task."}
						</p>
						{agentStatus.status.lastRun !== null && (
							<p className="text-muted-foreground">
								Last run: {agentStatus.status.lastRun.status}
								{agentStatus.status.lastRun.outcome !== null &&
									` (${agentStatus.status.lastRun.outcome})`}
							</p>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
