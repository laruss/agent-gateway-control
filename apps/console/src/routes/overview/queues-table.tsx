import type { SystemStatusQueue } from "@agent-gateway/contracts";
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
import { fmt } from "./format";

export function QueuesTable({
	queues,
}: Readonly<{ queues: Readonly<SystemStatusQueue[]> }>): React.ReactElement {
	if (queues.length === 0) {
		return <p className="text-sm text-muted-foreground">No queue backlog.</p>;
	}
	return (
		<div className="overflow-x-auto">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Queue</TableHead>
						<TableHead>Waiting</TableHead>
						<TableHead>Active</TableHead>
						<TableHead>Oldest wait</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{queues.map((queue) => (
						<TableRow key={queue.queue}>
							<TableCell className="flex items-center gap-2">
								{queue.queue}
								{queue.queue.startsWith("dlq.") && <Badge variant="destructive">DLQ</Badge>}
							</TableCell>
							<TableCell>{fmt(queue.waiting)}</TableCell>
							<TableCell>{fmt(queue.active)}</TableCell>
							<TableCell>
								{queue.oldestWaitingSeconds === null
									? "—"
									: `${fmt(Math.round(queue.oldestWaitingSeconds))}s`}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
