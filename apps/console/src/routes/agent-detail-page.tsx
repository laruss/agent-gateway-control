import type { AgentPatch, ConsoleAgentDetailResponse } from "@agent-gateway/contracts";
import { AlertCircle } from "lucide-react";
import * as React from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, fetchAgentDetail, fetchAgentsList } from "@/lib/api-client";
import { AssignmentsTab } from "./agent-detail/assignments-tab.tsx";
import { HistoryTab } from "./agent-detail/history-tab.tsx";
import { InstructionsTab } from "./agent-detail/instructions-tab.tsx";
import { OverviewTab } from "./agent-detail/overview-tab.tsx";
import { PermissionsTab } from "./agent-detail/permissions-tab.tsx";
import { clearAppliedFields, rebaseDraft } from "./agent-detail/rebase-draft.ts";
import { ReviewChangesDialog } from "./agent-detail/review-dialog.tsx";
import { RuntimeTab } from "./agent-detail/runtime-tab.tsx";
import type { AgentDetailTabProps } from "./agent-detail/types.ts";

type LoadState =
	| Readonly<{ status: "loading" }>
	| Readonly<{ status: "error"; message: string }>
	| Readonly<{
			status: "ok";
			detail: ConsoleAgentDetailResponse;
			knownAgentIds: Readonly<string[]>;
	  }>;

/**
 * The agent editor (ADR-025): loads the agent's current configuration, accumulates edits in a
 * local draft (never sent until the owner asks for a preview), and commits through the preview/
 * apply dialog. Unsaved edits block closing the tab (`beforeunload`) and the page's own "back to
 * Agents" navigation (a confirm dialog) — this app's router is the plain declarative
 * `<BrowserRouter>`, not a data router, so a blanket `useBlocker` (which only a data router
 * supports) is not available for every possible navigation away from this page.
 */
export function AgentDetailPage(): React.ReactElement {
	const { agentId } = useParams<{ agentId: string }>();
	const navigate = useNavigate();
	const [state, setState] = React.useState<LoadState>({ status: "loading" });
	const [draft, setDraft] = React.useState<AgentPatch>({});
	const [reviewOpen, setReviewOpen] = React.useState(false);
	const [confirmLeaveOpen, setConfirmLeaveOpen] = React.useState(false);

	const load = React.useCallback(async () => {
		if (agentId === undefined) {
			return;
		}
		setState({ status: "loading" });
		try {
			const [detail, agents] = await Promise.all([fetchAgentDetail(agentId), fetchAgentsList()]);
			setState({ status: "ok", detail, knownAgentIds: agents.agents.map((a) => a.id) });
		} catch (error) {
			setState({
				status: "error",
				message:
					error instanceof ApiError && error.status === 404
						? `Agent '${agentId}' does not exist.`
						: error instanceof ApiError
							? error.message
							: "Could not load this agent.",
			});
		}
	}, [agentId]);

	React.useEffect(() => {
		void load();
	}, [load]);

	/** "Reload and try again" after a 409 (`review-dialog.tsx`): re-fetches the agent and rebases
	 * the draft onto it (`rebaseDraft`), rather than merely re-running `load()` and leaving the
	 * draft exactly as it was. A dirty field whose own live value changed upstream in the meantime
	 * is dropped, with a visible notice, instead of silently re-applied over someone else's change
	 * to that same field; if nothing is left to preview, the dialog closes itself. */
	async function handleReload(): Promise<void> {
		if (agentId === undefined || state.status !== "ok") {
			return;
		}
		const previousAgent = state.detail.agent;
		try {
			const [detail, agents] = await Promise.all([fetchAgentDetail(agentId), fetchAgentsList()]);
			const { rebased, discardedFields } = rebaseDraft(previousAgent, detail.agent, draft);
			setState({ status: "ok", detail, knownAgentIds: agents.agents.map((a) => a.id) });
			setDraft(rebased);
			if (discardedFields.length > 0) {
				toast.warning(
					`Discarded your edit to ${discardedFields.join(", ")}: changed elsewhere since you started editing.`,
				);
			}
			if (Object.keys(rebased).length === 0) {
				setReviewOpen(false);
			}
		} catch (error) {
			toast.error(error instanceof ApiError ? error.message : "Could not reload this agent.");
		}
	}

	const hasUnsavedChanges = Object.keys(draft).length > 0;

	React.useEffect(() => {
		if (!hasUnsavedChanges) {
			return;
		}
		function onBeforeUnload(event: BeforeUnloadEvent) {
			event.preventDefault();
		}
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [hasUnsavedChanges]);

	function goToAgentsList() {
		if (hasUnsavedChanges) {
			setConfirmLeaveOpen(true);
			return;
		}
		void navigate("/agents");
	}

	function patchDraft<K extends keyof AgentPatch>(key: K, value: AgentPatch[K] | undefined) {
		setDraft((current) => {
			const next = { ...current };
			if (value === undefined) {
				delete next[key];
			} else {
				next[key] = value;
			}
			return next;
		});
	}

	if (agentId === undefined || state.status === "loading") {
		return (
			<div className="flex flex-col gap-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-96 w-full" />
			</div>
		);
	}

	if (state.status === "error") {
		return (
			<Alert variant="destructive">
				<AlertCircle />
				<AlertTitle>Could not open this agent</AlertTitle>
				<AlertDescription>{state.message}</AlertDescription>
			</Alert>
		);
	}

	const { agent, knownChannels, knownRuntimeAdapters } = state.detail;
	const tabProps: AgentDetailTabProps = {
		original: agent,
		draft,
		patchDraft,
		knownChannels,
		knownRuntimeAdapters,
		knownAgentIds: state.knownAgentIds,
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between">
				<div>
					<button
						type="button"
						onClick={goToAgentsList}
						className="text-sm text-muted-foreground hover:underline"
					>
						← Agents
					</button>
					<h1 className="text-lg font-semibold">
						{agent.displayName} <span className="text-muted-foreground">({agent.id})</span>
					</h1>
				</div>
				<div className="flex items-center gap-2">
					{hasUnsavedChanges && <Badge variant="outline">Unsaved changes</Badge>}
					<Button disabled={!hasUnsavedChanges} onClick={() => setReviewOpen(true)}>
						Review changes
					</Button>
				</div>
			</div>

			<Tabs defaultValue="overview">
				<TabsList>
					<TabsTrigger value="overview">Overview</TabsTrigger>
					<TabsTrigger value="instructions">Instructions</TabsTrigger>
					<TabsTrigger value="runtime">Runtime</TabsTrigger>
					<TabsTrigger value="assignments">Assignments</TabsTrigger>
					<TabsTrigger value="permissions">Permissions</TabsTrigger>
					<TabsTrigger value="history">History</TabsTrigger>
				</TabsList>
				<TabsContent value="overview">
					<OverviewTab {...tabProps} />
				</TabsContent>
				<TabsContent value="instructions">
					<InstructionsTab {...tabProps} />
				</TabsContent>
				<TabsContent value="runtime">
					<RuntimeTab {...tabProps} />
				</TabsContent>
				<TabsContent value="assignments">
					{/* Keyed by the loaded revision: a reload (`handleReload`) remounts this tab, resetting
					the wake rules editor's own locally held, stable row ids (`assignments-tab.tsx`) to
					match the freshly reloaded data instead of leaving them paired with rules that may no
					longer be at the same index. */}
					<AssignmentsTab key={agent.activeRevisionId} {...tabProps} />
				</TabsContent>
				<TabsContent value="permissions">
					<PermissionsTab {...tabProps} />
				</TabsContent>
				<TabsContent value="history">
					<HistoryTab agentId={agent.id} />
				</TabsContent>
			</Tabs>

			<ReviewChangesDialog
				open={reviewOpen}
				onOpenChange={setReviewOpen}
				agentId={agent.id}
				baseRevisionId={agent.activeRevisionId}
				draft={draft}
				onReload={() => void handleReload()}
				onApplied={(_revisionId, appliedPatch) => {
					setDraft((current) => clearAppliedFields(current, appliedPatch));
					void load();
				}}
			/>

			<AlertDialog open={confirmLeaveOpen} onOpenChange={setConfirmLeaveOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Leave without saving?</AlertDialogTitle>
						<AlertDialogDescription>
							This agent has unsaved changes. Leaving now discards them; they were never sent to the
							server.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Stay</AlertDialogCancel>
						<AlertDialogAction onClick={() => void navigate("/agents")}>
							Leave without saving
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
