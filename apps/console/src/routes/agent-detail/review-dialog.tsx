import type { AgentPatch, ConsolePreviewResponse } from "@agent-gateway/contracts";
import { AlertTriangle } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { ApiError, commitAgentChange, previewAgentChange } from "@/lib/api-client";

type ReviewState =
	| Readonly<{ status: "loading" }>
	| Readonly<{ status: "error"; message: string }>
	| Readonly<{ status: "ready"; preview: ConsolePreviewResponse; idempotencyKey: string }>
	| Readonly<{ status: "applying"; preview: ConsolePreviewResponse; idempotencyKey: string }>
	| Readonly<{ status: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ status: "invalid"; problems: Readonly<string[]> }>;

export function ReviewChangesDialog({
	open,
	onOpenChange,
	agentId,
	baseRevisionId,
	draft,
	onApplied,
	onReload,
}: Readonly<{
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agentId: string;
	baseRevisionId: number | null;
	draft: AgentPatch;
	/** Called once a commit actually wrote a new revision; the caller clears the draft and
	 * refreshes the detail page's own data from it. */
	onApplied: (revisionId: number) => void;
	/** Called before retrying a preview after a conflict, so the caller's own `original` (shown
	 * elsewhere on the page) is refreshed too, not only this dialog's own preview. */
	onReload: () => void;
}>): React.ReactElement {
	const [state, setState] = React.useState<ReviewState>({ status: "loading" });
	const [confirmedImpact, setConfirmedImpact] = React.useState(false);

	const loadPreview = React.useCallback(async () => {
		setState({ status: "loading" });
		setConfirmedImpact(false);
		try {
			const preview = await previewAgentChange(agentId, { baseRevisionId, changes: draft });
			setState({ status: "ready", preview, idempotencyKey: crypto.randomUUID() });
		} catch (error) {
			setState({
				status: "error",
				message: error instanceof ApiError ? error.message : "Could not compute a preview.",
			});
		}
	}, [agentId, draft, baseRevisionId]);

	React.useEffect(() => {
		if (open) {
			void loadPreview();
		}
	}, [open, loadPreview]);

	async function apply() {
		if (state.status !== "ready") {
			return;
		}
		setState({ status: "applying", preview: state.preview, idempotencyKey: state.idempotencyKey });
		const outcome = await commitAgentChange(agentId, {
			baseRevisionId: state.preview.baseRevisionId,
			changes: draft,
			idempotencyKey: state.idempotencyKey,
		}).catch((error: unknown) => {
			toast.error(error instanceof ApiError ? error.message : "Applying the change failed.");
			setState({ status: "ready", preview: state.preview, idempotencyKey: state.idempotencyKey });
			return null;
		});
		if (outcome === null) {
			return;
		}
		if (outcome.kind === "conflict") {
			setState({ status: "conflict", currentRevisionId: outcome.currentRevisionId });
			return;
		}
		if (outcome.kind === "invalid") {
			setState({ status: "invalid", problems: outcome.problems });
			return;
		}
		toast.success(
			outcome.replayed
				? `Already applied as revision ${outcome.revisionId}.`
				: `Applied as revision ${outcome.revisionId}.`,
		);
		onOpenChange(false);
		onApplied(outcome.revisionId);
	}

	const preview = state.status === "ready" || state.status === "applying" ? state.preview : null;
	const impact = preview?.impact ?? [];
	const needsConfirmation = impact.length > 0 && !confirmedImpact;
	const canApply =
		state.status === "ready" &&
		preview !== null &&
		preview.problems.length === 0 &&
		!preview.noop &&
		!needsConfirmation;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>Review changes</DialogTitle>
					<DialogDescription>
						A preview of exactly what committing this change would do, computed against the
						configuration's current state.
					</DialogDescription>
				</DialogHeader>

				{state.status === "loading" && (
					<p className="text-sm text-muted-foreground">Computing preview…</p>
				)}

				{state.status === "error" && (
					<Alert variant="destructive">
						<AlertTriangle />
						<AlertTitle>Could not compute a preview</AlertTitle>
						<AlertDescription>{state.message}</AlertDescription>
					</Alert>
				)}

				{state.status === "conflict" && (
					<Alert variant="destructive">
						<AlertTriangle />
						<AlertTitle>Configuration changed elsewhere</AlertTitle>
						<AlertDescription>
							Someone else committed a change since this edit began (now revision{" "}
							{state.currentRevisionId ?? "none"}). Reload to see the current configuration and
							re-apply this draft on top of it.
						</AlertDescription>
					</Alert>
				)}

				{state.status === "invalid" && (
					<Alert variant="destructive">
						<AlertTriangle />
						<AlertTitle>This change is invalid</AlertTitle>
						<AlertDescription>
							<ul className="list-inside list-disc">
								{state.problems.map((problem) => (
									<li key={problem}>{problem}</li>
								))}
							</ul>
						</AlertDescription>
					</Alert>
				)}

				{preview !== null && (
					<ScrollArea className="max-h-96">
						<div className="flex flex-col gap-3 pr-4">
							{preview.noop && (
								<Alert>
									<AlertDescription>
										This change set resolves to the configuration's current content — nothing would
										be applied.
									</AlertDescription>
								</Alert>
							)}
							{preview.problems.length > 0 && (
								<Alert variant="destructive">
									<AlertTriangle />
									<AlertTitle>This change is invalid</AlertTitle>
									<AlertDescription>
										<ul className="list-inside list-disc">
											{preview.problems.map((problem) => (
												<li key={problem}>{problem}</li>
											))}
										</ul>
									</AlertDescription>
								</Alert>
							)}
							{impact.length > 0 && (
								<Alert variant="destructive">
									<AlertTriangle />
									<AlertTitle>This reduces the agent's authority</AlertTitle>
									<AlertDescription>
										<ul className="list-inside list-disc">
											{impact.map((item) => (
												<li key={item}>{item}</li>
											))}
										</ul>
									</AlertDescription>
								</Alert>
							)}
							<div className="flex flex-col gap-1 text-sm">
								{preview.diff.agents.map((agent) => (
									<div key={agent.agentId} className="rounded-lg border border-input p-2">
										<p className="font-medium">
											{agent.agentId} · {agent.kind}
										</p>
										{agent.kind === "changed" && (
											<p className="text-muted-foreground">
												{[
													...agent.fieldPaths,
													...(agent.rolePrompt.changed ? ["role prompt"] : []),
												].join(", ") || "no field-level change"}
											</p>
										)}
										{agent.kind === "changed" && agent.rolePrompt.changed && (
											<p className="text-xs text-muted-foreground">
												Role prompt: {agent.rolePrompt.beforeSize.toLocaleString()} →{" "}
												{agent.rolePrompt.afterSize.toLocaleString()} characters
											</p>
										)}
									</div>
								))}
							</div>
							{impact.length > 0 && (
								<div className="flex items-center gap-3">
									<Switch
										id="confirm-impact"
										checked={confirmedImpact}
										onCheckedChange={setConfirmedImpact}
									/>
									<Label htmlFor="confirm-impact">I understand the consequences above.</Label>
								</div>
							)}
						</div>
					</ScrollArea>
				)}

				<DialogFooter>
					{state.status === "conflict" ? (
						<Button
							onClick={() => {
								onReload();
								void loadPreview();
							}}
						>
							Reload and try again
						</Button>
					) : (
						<Button onClick={() => void apply()} disabled={!canApply}>
							{state.status === "applying" ? "Applying…" : "Apply"}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
