import type { ConfigDiffAgent, ConsoleRevisionListItem } from "@agent-gateway/contracts";
import { AlertCircle } from "lucide-react";
import * as React from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, fetchConfigRevisionDiff, fetchConfigRevisions } from "@/lib/api-client";

/** The most recent revisions scanned for ones touching this agent; older history is reachable
 * only through `gateway config history`/`diff`, not this tab (ADR-025's console scope). */
const REVISIONS_SCANNED = 20;

type Entry = Readonly<{ revision: ConsoleRevisionListItem; agentDiff: ConfigDiffAgent }>;

type HistoryState =
	| Readonly<{ status: "loading" }>
	| Readonly<{ status: "error"; message: string }>
	| Readonly<{ status: "ok"; entries: Readonly<Entry[]> }>;

function describeAgentDiff(entry: ConfigDiffAgent): string {
	if (entry.kind === "added") {
		return "agent added";
	}
	if (entry.kind === "removed") {
		return "agent removed";
	}
	const parts = [...entry.fieldPaths];
	if (entry.rolePrompt.changed) {
		parts.push("role prompt");
	}
	return parts.length === 0 ? "no field-level change" : `changed: ${parts.join(", ")}`;
}

export function HistoryTab({ agentId }: Readonly<{ agentId: string }>): React.ReactElement {
	const [state, setState] = React.useState<HistoryState>({ status: "loading" });

	React.useEffect(() => {
		let cancelled = false;
		async function load() {
			try {
				const list = await fetchConfigRevisions(REVISIONS_SCANNED);
				const diffs = await Promise.all(
					list.revisions.map((revision) => fetchConfigRevisionDiff(revision.id)),
				);
				if (cancelled) {
					return;
				}
				const entries: Entry[] = [];
				list.revisions.forEach((revision, index) => {
					const agentDiff = diffs[index]?.diff.agents.find((a) => a.agentId === agentId);
					if (agentDiff !== undefined) {
						entries.push({ revision, agentDiff });
					}
				});
				setState({ status: "ok", entries });
			} catch (error) {
				if (!cancelled) {
					setState({
						status: "error",
						message: error instanceof ApiError ? error.message : "Could not load history.",
					});
				}
			}
		}
		void load();
		return () => {
			cancelled = true;
		};
	}, [agentId]);

	if (state.status === "loading") {
		return (
			<div className="flex flex-col gap-2">
				<Skeleton className="h-10 w-full" />
				<Skeleton className="h-10 w-full" />
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<Alert variant="destructive">
				<AlertCircle />
				<AlertTitle>Could not load history</AlertTitle>
				<AlertDescription>{state.message}</AlertDescription>
			</Alert>
		);
	}
	if (state.entries.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">
				No revision in the last {REVISIONS_SCANNED} touched this agent.
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-2">
			{state.entries.map(({ revision, agentDiff }) => (
				<div key={revision.id} className="flex flex-col gap-1 rounded-lg border border-input p-3">
					<div className="flex items-center gap-2 text-sm">
						<Badge variant="outline">#{revision.id}</Badge>
						<span>{new Date(revision.createdAt).toLocaleString()}</span>
						<span className="text-muted-foreground">
							{revision.actor} · {revision.source}
						</span>
					</div>
					<p className="text-sm text-muted-foreground">{describeAgentDiff(agentDiff)}</p>
					{revision.reason !== null && <p className="text-sm italic">{revision.reason}</p>}
				</div>
			))}
		</div>
	);
}
