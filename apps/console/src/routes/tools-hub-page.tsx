import type { ConsoleToolCatalogListItem, ToolCatalogEntryKind } from "@agent-gateway/contracts";
import { AlertCircle } from "lucide-react";
import * as React from "react";
import { Link } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { ApiError, createCustomTool, fetchToolCatalog } from "@/lib/api-client";
import { CustomToolDialog } from "./tools-hub/custom-tool-form.tsx";

type ListState =
	| Readonly<{ status: "loading" }>
	| Readonly<{ status: "error"; message: string }>
	| Readonly<{ status: "ok"; entries: Readonly<ConsoleToolCatalogListItem[]> }>;

const KIND_LABELS: Record<ToolCatalogEntryKind, string> = {
	native: "Native",
	gateway: "Gateway",
	executor: "Executor actions",
	custom_https: "Custom HTTPS",
	utility: "Utilities",
};

const KIND_ORDER: Readonly<ToolCatalogEntryKind[]> = [
	"native",
	"gateway",
	"executor",
	"custom_https",
	"utility",
];

function matches(entry: ConsoleToolCatalogListItem, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (q.length === 0) {
		return true;
	}
	return (
		entry.id.toLowerCase().includes(q) ||
		entry.name.toLowerCase().includes(q) ||
		entry.description.toLowerCase().includes(q)
	);
}

/**
 * The Instruments & Utils hub (ADR-025/027): every active catalog entry, grouped by kind,
 * searchable by id/name/description. Built-ins are seeded by the release and never created here;
 * the one creatable kind is a `custom_https` tool, through the same review-before-commit dialog
 * the entry detail page's own edit action reuses.
 */
export function ToolsHubPage(): React.ReactElement {
	const [state, setState] = React.useState<ListState>({ status: "loading" });
	const [query, setQuery] = React.useState("");
	const [createOpen, setCreateOpen] = React.useState(false);

	const load = React.useCallback(async () => {
		try {
			const response = await fetchToolCatalog();
			setState({ status: "ok", entries: response.entries });
		} catch (error) {
			setState({
				status: "error",
				message: error instanceof ApiError ? error.message : "Could not load the tool catalog.",
			});
		}
	}, []);

	React.useEffect(() => {
		void load();
	}, [load]);

	const grouped = React.useMemo(() => {
		if (state.status !== "ok") {
			return [];
		}
		const filtered = state.entries.filter((entry) => matches(entry, query));
		return KIND_ORDER.map((kind) => ({
			kind,
			entries: filtered.filter((entry) => entry.kind === kind),
		})).filter((group) => group.entries.length > 0);
	}, [state, query]);

	return (
		<Card>
			<CardHeader className="flex flex-row items-start justify-between">
				<div>
					<CardTitle>Instruments &amp; utils</CardTitle>
					<CardDescription>
						Every tool and utility the Gateway can offer; attach or detach one from any agent.
					</CardDescription>
				</div>
				<Button onClick={() => setCreateOpen(true)}>New custom HTTPS tool</Button>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
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
						<AlertTitle>Could not load the tool catalog</AlertTitle>
						<AlertDescription className="flex items-center justify-between gap-4">
							<span>{state.message}</span>
							<Button variant="outline" size="sm" onClick={() => void load()}>
								Retry
							</Button>
						</AlertDescription>
					</Alert>
				)}
				{state.status === "ok" && (
					<>
						<Input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Search by id, name or description…"
							aria-label="Search the tool catalog"
							className="max-w-sm"
						/>
						{grouped.length === 0 && (
							<p className="text-sm text-muted-foreground">No entry matches this search.</p>
						)}
						{grouped.map((group) => (
							<div key={group.kind} className="flex flex-col gap-2">
								<h2 className="text-sm font-semibold text-muted-foreground">
									{KIND_LABELS[group.kind]}
								</h2>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Entry</TableHead>
											<TableHead>Risk floor</TableHead>
											<TableHead>Availability</TableHead>
											<TableHead>Attached agents</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{group.entries.map((entry) => (
											<TableRow key={entry.id}>
												<TableCell>
													<Link to={`/tools/${entry.id}`} className="font-medium hover:underline">
														{entry.name}
													</Link>
													<span className="ml-2 text-xs text-muted-foreground">({entry.id})</span>
													{entry.isBuiltin && (
														<Badge variant="outline" className="ml-2">
															built-in
														</Badge>
													)}
												</TableCell>
												<TableCell className="text-sm">{entry.riskFloor}</TableCell>
												<TableCell>
													<Badge variant={entry.available ? "default" : "secondary"}>
														{entry.available ? "available" : "unavailable"}
													</Badge>
												</TableCell>
												<TableCell className="text-sm">{entry.attachedAgentCount}</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
						))}
					</>
				)}
			</CardContent>
			<CustomToolDialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				mode="create"
				onSubmit={async (value) => {
					const result = await createCustomTool(value);
					return { problems: result.kind === "invalid" ? result.problems : [] };
				}}
				onSaved={() => void load()}
			/>
		</Card>
	);
}
