import type { ConsoleAgentToolsResponse } from "@agent-gateway/contracts";
import { AlertCircle } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { ApiError, detachTool, fetchAgentTools } from "@/lib/api-client";
import { AdoptDialog } from "./adopt-dialog.tsx";
import { AttachEntryDialog } from "./attach-entry-dialog.tsx";

type State =
	| Readonly<{ status: "loading" }>
	| Readonly<{ status: "error"; message: string }>
	| Readonly<{ status: "ok"; response: ConsoleAgentToolsResponse }>;

/**
 * The agent capability editor (ADR-025/027): requested attachments (recorded, for a hub-managed
 * agent; a read-only preview of its `permissions` conversion otherwise) against effective, compiled
 * access — implied capabilities, unresolved legacy patterns, a missing adapter prerequisite, and
 * memory-write authority all shown explicitly, since none of them follow from the requested list
 * alone. Attach/detach act immediately (no draft, no preview/commit round trip — ADR-027's own
 * attachments are a separate document from the rest of this editor's patch).
 */
export function ToolsTab({ agentId }: Readonly<{ agentId: string }>): React.ReactElement {
	const [state, setState] = React.useState<State>({ status: "loading" });
	const [attachOpen, setAttachOpen] = React.useState(false);
	const [adoptOpen, setAdoptOpen] = React.useState(false);
	const [detachingEntryId, setDetachingEntryId] = React.useState<string | null>(null);

	const load = React.useCallback(async () => {
		setState({ status: "loading" });
		try {
			const response = await fetchAgentTools(agentId);
			setState({ status: "ok", response });
		} catch (error) {
			setState({
				status: "error",
				message: error instanceof ApiError ? error.message : "Could not load this agent's tools.",
			});
		}
	}, [agentId]);

	React.useEffect(() => {
		void load();
	}, [load]);

	/** `confirmWidening`: the owner's own explicit acknowledgement, from the warning toast's own
	 * "Detach anyway" action below — detaching never silently widens what this agent may do
	 * (ADR-027: an attached `disabled`/`require_approval` can be the only thing suppressing a
	 * native dependency's implication). */
	async function handleDetach(entryId: string, confirmWidening = false) {
		setDetachingEntryId(entryId);
		try {
			const result = await detachTool(agentId, {
				idempotencyKey: crypto.randomUUID(),
				entryId,
				...(confirmWidening ? { confirmWidening: true } : {}),
			});
			if (result.kind === "conflict") {
				toast.error(
					"The active configuration changed since this page was loaded. Reload and try again.",
				);
				return;
			}
			if (result.kind === "would_widen") {
				const summary = result.widenings
					.map((widening) => `${widening.agentId}: ${widening.tools.join(", ")}`)
					.join("; ");
				toast.warning(`Detaching '${entryId}' would widen effective permissions — ${summary}.`, {
					action: { label: "Detach anyway", onClick: () => void handleDetach(entryId, true) },
				});
				return;
			}
			if (result.kind === "invalid") {
				toast.error(result.problems.join("; "));
				return;
			}
			toast.success(`Detached '${entryId}'.`);
			await load();
		} catch (error) {
			toast.error(error instanceof ApiError ? error.message : "Could not detach this entry.");
		} finally {
			setDetachingEntryId(null);
		}
	}

	if (state.status === "loading") {
		return (
			<div className="flex flex-col gap-2">
				<Skeleton className="h-8 w-full" />
				<Skeleton className="h-8 w-full" />
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<Alert variant="destructive">
				<AlertCircle />
				<AlertTitle>Could not load this agent's tools</AlertTitle>
				<AlertDescription>
					{state.message}{" "}
					<Button variant="link" className="h-auto p-0" onClick={() => void load()}>
						Retry
					</Button>
				</AlertDescription>
			</Alert>
		);
	}

	const { response } = state;

	return (
		<div className="flex max-w-3xl flex-col gap-6">
			{!response.hubManaged && (
				<Alert>
					<AlertDescription className="flex items-center justify-between gap-4">
						<span>
							This agent is not yet managed in the tools hub: the table below previews what its
							current <code>permissions</code> lists would become, read-only, until adopted.
						</span>
						<Button size="sm" onClick={() => setAdoptOpen(true)}>
							Adopt into the tools hub
						</Button>
					</AlertDescription>
				</Alert>
			)}

			{response.unresolved.length > 0 && (
				<Alert variant="destructive">
					<AlertTitle>Unresolved legacy patterns</AlertTitle>
					<AlertDescription>
						<ul className="list-inside list-disc">
							{response.unresolved.map((pattern) => (
								<li key={`${pattern.list}:${pattern.pattern}`}>
									{pattern.pattern} ({pattern.list})
								</li>
							))}
						</ul>
						Each names no catalog entry known right now; adopting this agent drops them rather than
						silently matching a future one.
					</AlertDescription>
				</Alert>
			)}

			<div className="flex flex-col gap-2">
				<div className="flex items-center justify-between">
					<h3 className="text-sm font-semibold">Requested</h3>
					<Button size="sm" disabled={!response.hubManaged} onClick={() => setAttachOpen(true)}>
						Attach a tool
					</Button>
				</div>
				{response.requested.length === 0 ? (
					<p className="text-sm text-muted-foreground">Nothing attached.</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Entry</TableHead>
								<TableHead>Mode</TableHead>
								<TableHead>Pinned version</TableHead>
								<TableHead />
							</TableRow>
						</TableHeader>
						<TableBody>
							{response.requested.map((attachment) => (
								<TableRow key={attachment.entryId}>
									<TableCell className="font-mono text-sm">{attachment.entryId}</TableCell>
									<TableCell className="text-sm">{attachment.mode}</TableCell>
									<TableCell className="text-sm">
										{attachment.pinnedVersion ?? "tracks current"}
									</TableCell>
									<TableCell>
										{response.hubManaged && (
											<Button
												variant="outline"
												size="sm"
												disabled={detachingEntryId === attachment.entryId}
												onClick={() => void handleDetach(attachment.entryId)}
											>
												{detachingEntryId === attachment.entryId ? "Detaching…" : "Detach"}
											</Button>
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</div>

			<div className="flex flex-col gap-2">
				<h3 className="text-sm font-semibold">Effective</h3>
				<div className="flex flex-col gap-1 text-sm">
					<p>
						<span className="font-medium">Allowed:</span>{" "}
						{response.effective.allow.join(", ") || "—"}
					</p>
					<p>
						<span className="font-medium">Requires approval:</span>{" "}
						{response.effective.requireApproval.join(", ") || "—"}
					</p>
					<p>
						<span className="font-medium">Denied:</span> {response.effective.deny.join(", ") || "—"}
					</p>
					<p>
						<span className="font-medium">Memory writes:</span>{" "}
						{response.memoryWriteAllowed ? "allowed" : "denied"}
					</p>
				</div>
			</div>

			{response.capabilities.length > 0 && (
				<div className="flex flex-col gap-2">
					<h3 className="text-sm font-semibold">Capabilities</h3>
					<div className="flex flex-col gap-1">
						{response.capabilities.map((capability) => (
							<div key={capability.name} className="flex items-center gap-2 text-sm">
								<Badge variant={capability.mode === "allow" ? "default" : "outline"}>
									{capability.mode}
								</Badge>
								<span className="font-mono">{capability.name}</span>
								{capability.impliedBy !== undefined && capability.impliedBy.length > 0 && (
									<span className="text-xs text-muted-foreground">
										(implied by {capability.impliedBy.join(", ")})
									</span>
								)}
								<span className="text-xs text-muted-foreground">{capability.description}</span>
							</div>
						))}
					</div>
				</div>
			)}

			{Object.keys(response.missingPrerequisites).length > 0 && (
				<Alert>
					<AlertTitle>Missing runtime prerequisites</AlertTitle>
					<AlertDescription>
						<ul className="list-inside list-disc">
							{Object.entries(response.missingPrerequisites).map(([tool, missing]) => (
								<li key={tool}>
									<span className="font-mono">{tool}</span> is granted but not usable under this
									agent's own runtime adapter until {missing.join(", ")}{" "}
									{missing.length === 1 ? "is" : "are"} also attached.
								</li>
							))}
						</ul>
					</AlertDescription>
				</Alert>
			)}

			<AttachEntryDialog
				open={attachOpen}
				onOpenChange={setAttachOpen}
				agentId={agentId}
				alreadyRequestedEntryIds={response.requested.map((attachment) => attachment.entryId)}
				baseRevisionId={response.baseRevisionId}
				conversionHash={response.conversionHash}
				onAttached={() => void load()}
			/>
			<AdoptDialog
				open={adoptOpen}
				onOpenChange={setAdoptOpen}
				agentId={agentId}
				onAdopted={() => void load()}
			/>
		</div>
	);
}
