import type { ConsoleRun } from "@agent-gateway/contracts";
import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { formatTimestamp, numOrDash, orDash } from "./format";

const COLUMNS = [
	"Agent",
	"Status",
	"Outcome",
	"Error",
	"Trigger",
	"Queued",
	"Started",
	"Finished",
	"In tok",
	"Out tok",
] as const;

export function RecentRunsTable({
	runs,
}: Readonly<{ runs: Readonly<ConsoleRun[]> }>): React.ReactElement {
	if (runs.length === 0) {
		return <p className="text-sm text-muted-foreground">No recent runs.</p>;
	}
	return (
		<div className="overflow-x-auto">
			<Table>
				<TableHeader>
					<TableRow>
						{COLUMNS.map((column) => (
							<TableHead key={column}>{column}</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{runs.map((run) => (
						<TableRow key={run.runId}>
							<TableCell>{run.agentId}</TableCell>
							<TableCell>
								<Badge variant="outline">{run.status}</Badge>
							</TableCell>
							<TableCell>{orDash(run.outcome)}</TableCell>
							<TableCell>{orDash(run.errorCode)}</TableCell>
							<TableCell>{run.triggerType}</TableCell>
							<TableCell>{formatTimestamp(run.queuedAt)}</TableCell>
							<TableCell>{run.startedAt === null ? "—" : formatTimestamp(run.startedAt)}</TableCell>
							<TableCell>
								{run.finishedAt === null ? "—" : formatTimestamp(run.finishedAt)}
							</TableCell>
							<TableCell>{numOrDash(run.inputTokens)}</TableCell>
							<TableCell>{numOrDash(run.outputTokens)}</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
