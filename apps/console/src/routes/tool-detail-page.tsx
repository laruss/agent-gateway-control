import type { ConsoleToolCatalogEntryDetailResponse } from "@agent-gateway/contracts";
import { AlertCircle } from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { ApiError, editCatalogEntry, fetchToolCatalogEntry } from "@/lib/api-client";
import { AttachToAgentDialog } from "./tools-hub/attach-to-agent-dialog.tsx";
import { CustomToolDialog } from "./tools-hub/custom-tool-form.tsx";
import { DeleteEntryDialog } from "./tools-hub/delete-entry-dialog.tsx";
import { EditMetadataDialog } from "./tools-hub/edit-metadata-dialog.tsx";

type DetailState =
	| Readonly<{ status: "loading" }>
	| Readonly<{ status: "error"; message: string }>
	| Readonly<{ status: "ok"; response: ConsoleToolCatalogEntryDetailResponse }>;

/**
 * An entry's own detail page (ADR-025/027): its version history, every agent currently attached
 * (with the exact mode and pinned version), an "Attach to agent" action, edit (metadata-only for a
 * built-in, the full definition for a `custom_https` entry) and delete (shows its impact — which
 * agents lose it — before committing). Secret aliases a `custom_https` definition needs are shown
 * by name and whether each is set, never a value: setting one stays CLI-only.
 */
export function ToolDetailPage(): React.ReactElement {
	const { entryId } = useParams<{ entryId: string }>();
	const navigate = useNavigate();
	const [state, setState] = React.useState<DetailState>({ status: "loading" });
	const [attachOpen, setAttachOpen] = React.useState(false);
	const [editOpen, setEditOpen] = React.useState(false);
	const [deleteOpen, setDeleteOpen] = React.useState(false);

	const load = React.useCallback(async () => {
		if (entryId === undefined) {
			return;
		}
		setState({ status: "loading" });
		try {
			const response = await fetchToolCatalogEntry(entryId);
			setState({ status: "ok", response });
		} catch (error) {
			setState({
				status: "error",
				message:
					error instanceof ApiError && error.status === 404
						? `Catalog entry '${entryId}' does not exist.`
						: error instanceof ApiError
							? error.message
							: "Could not load this entry.",
			});
		}
	}, [entryId]);

	React.useEffect(() => {
		void load();
	}, [load]);

	if (entryId === undefined || state.status === "loading") {
		return (
			<div className="flex flex-col gap-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-64 w-full" />
			</div>
		);
	}

	if (state.status === "error") {
		return (
			<Alert variant="destructive">
				<AlertCircle />
				<AlertTitle>Could not open this entry</AlertTitle>
				<AlertDescription className="flex items-center justify-between gap-4">
					<span>{state.message}</span>
					<Button variant="outline" size="sm" onClick={() => void load()}>
						Retry
					</Button>
				</AlertDescription>
			</Alert>
		);
	}

	const { entry, versions, attachedAgents, legacyGrantingAgents, secretAliases } = state.response;
	const current = entry.currentVersion;

	return (
		<div className="flex flex-col gap-4">
			<div>
				<Link to="/tools" className="text-sm text-muted-foreground hover:underline">
					← Instruments &amp; utils
				</Link>
				<h1 className="text-lg font-semibold">
					{current.name} <span className="text-muted-foreground">({entry.id})</span>
				</h1>
			</div>

			<Card>
				<CardHeader className="flex flex-row items-start justify-between">
					<div>
						<CardTitle>Overview</CardTitle>
						<CardDescription>{current.description}</CardDescription>
					</div>
					<div className="flex items-center gap-2">
						<Button variant="outline" onClick={() => setAttachOpen(true)}>
							Attach to agent
						</Button>
						<Button variant="outline" onClick={() => setEditOpen(true)}>
							Edit
						</Button>
						<Button variant="destructive" onClick={() => setDeleteOpen(true)}>
							Delete
						</Button>
					</div>
				</CardHeader>
				<CardContent className="flex flex-col gap-2 text-sm">
					<p>
						Kind: <span className="font-mono">{entry.kind}</span> · Risk floor:{" "}
						<span className="font-mono">{current.riskFloor}</span> ·{" "}
						<Badge variant={entry.available ? "default" : "secondary"}>
							{entry.available ? "available" : "unavailable"}
						</Badge>
						{entry.isBuiltin && (
							<Badge variant="outline" className="ml-2">
								built-in
							</Badge>
						)}
					</p>
					{current.supportedAdapters.length > 0 && (
						<p className="text-muted-foreground">
							Supported adapters: {current.supportedAdapters.join(", ")}
						</p>
					)}
					{entry.kind === "native" && (
						<p className="text-muted-foreground">
							<code>tests.run</code> grants general sandboxed command execution: hiding this entry
							cannot retract a binary from an agent already granted a shell on a prior turn.
						</p>
					)}
				</CardContent>
			</Card>

			{current.httpsDefinition !== null && (
				<Card>
					<CardHeader>
						<CardTitle>Definition</CardTitle>
						<CardDescription>
							<span className="font-mono">
								{current.httpsDefinition.method} https://{current.httpsDefinition.host}
								{current.httpsDefinition.pathTemplate}
							</span>
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-3 text-sm">
						<p>
							{current.httpsDefinition.parameters.length} typed parameter(s)
							{current.httpsDefinition.idempotency !== null &&
								`, idempotency header '${current.httpsDefinition.idempotency.headerName}'`}
						</p>
						{secretAliases.length > 0 && (
							<div className="flex flex-col gap-1">
								<p className="font-medium">Secret aliases</p>
								{secretAliases.map((alias) => (
									<div key={alias.alias} className="flex items-center gap-2">
										<Badge variant={alias.set ? "default" : "secondary"}>
											{alias.set ? "set" : "not set"}
										</Badge>
										<span className="font-mono">{alias.alias}</span>
										{!alias.set && (
											<code className="text-xs text-muted-foreground">
												gateway tools secret set {alias.alias}
											</code>
										)}
									</div>
								))}
							</div>
						)}
					</CardContent>
				</Card>
			)}

			<Card>
				<CardHeader>
					<CardTitle>Attached agents</CardTitle>
					<CardDescription>
						Editing or deleting this entry affects every agent listed here.
					</CardDescription>
				</CardHeader>
				<CardContent>
					{attachedAgents.length === 0 ? (
						<p className="text-sm text-muted-foreground">No agent currently holds this entry.</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Agent</TableHead>
									<TableHead>Mode</TableHead>
									<TableHead>Pinned version</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{attachedAgents.map((agent) => (
									<TableRow key={agent.agentId}>
										<TableCell>
											<Link to={`/agents/${agent.agentId}`} className="hover:underline">
												{agent.displayName}
											</Link>
											<span className="ml-2 text-xs text-muted-foreground">({agent.agentId})</span>
										</TableCell>
										<TableCell className="text-sm">{agent.mode}</TableCell>
										<TableCell className="text-sm">
											{agent.pinnedVersion ?? "tracks current"}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
					{legacyGrantingAgents.length > 0 && (
						<Alert className="mt-2">
							<AlertCircle />
							<AlertTitle>Also granted outside the hub</AlertTitle>
							<AlertDescription>
								These agents' own legacy permissions still grant this tool directly, unaffected by
								attaching, editing or deleting it here, and blocking delete until each adopts:{" "}
								<span className="font-medium">
									{legacyGrantingAgents.map((agent) => agent.displayName).join(", ")}
								</span>
								. Run <code>gateway tools adopt &lt;agent-id&gt;</code> (or the agent's own Adopt
								action) first.
							</AlertDescription>
						</Alert>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Version history</CardTitle>
				</CardHeader>
				<CardContent>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Version</TableHead>
								<TableHead>Name</TableHead>
								<TableHead>Created by</TableHead>
								<TableHead>Created at</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{[...versions].reverse().map((version) => (
								<TableRow key={version.id}>
									<TableCell>{version.version}</TableCell>
									<TableCell>{version.name}</TableCell>
									<TableCell className="text-sm text-muted-foreground">
										{version.createdBy}
									</TableCell>
									<TableCell className="text-sm text-muted-foreground">
										{new Date(version.createdAt).toLocaleString()}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</CardContent>
			</Card>

			<AttachToAgentDialog
				open={attachOpen}
				onOpenChange={setAttachOpen}
				entryId={entry.id}
				riskFloor={current.riskFloor}
				onAttached={() => void load()}
			/>

			{current.httpsDefinition !== null ? (
				<CustomToolDialog
					open={editOpen}
					onOpenChange={setEditOpen}
					mode="edit"
					initial={{
						entryId: entry.id,
						name: current.name,
						description: current.description,
						httpsDefinition: current.httpsDefinition,
					}}
					onSubmit={async (value) => {
						const result = await editCatalogEntry(entry.id, {
							name: value.name,
							description: value.description,
							httpsDefinition: value.httpsDefinition,
							expectedVersion: current.version,
						});
						return {
							problems:
								result.kind === "invalid"
									? result.problems
									: result.kind === "conflict"
										? [
												"This entry was edited elsewhere since this page was loaded. Reload and try again.",
											]
										: [],
						};
					}}
					onSaved={() => void load()}
				/>
			) : (
				<EditMetadataDialog
					open={editOpen}
					onOpenChange={setEditOpen}
					entryId={entry.id}
					name={current.name}
					description={current.description}
					expectedVersion={current.version}
					onSaved={() => void load()}
				/>
			)}

			<DeleteEntryDialog
				open={deleteOpen}
				onOpenChange={setDeleteOpen}
				entryId={entry.id}
				isBuiltin={entry.isBuiltin}
				attachedAgentIds={attachedAgents.map((agent) => agent.agentId)}
				onDeleted={() => void navigate("/tools")}
			/>
		</div>
	);
}
