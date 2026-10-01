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
import { Switch } from "@/components/ui/switch";
import { ApiError, commitAgentChange, previewAgentChange } from "@/lib/api-client";
import { deepEqual } from "./rebase-draft.ts";

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
	/** Called once a commit actually wrote a new revision, with exactly the patch that was
	 * reviewed and submitted (the snapshot this dialog captured when it opened, see below) —
	 * never the live `draft` prop, which may by then carry edits made since: the caller clears
	 * only the fields this names, leaving anything edited later untouched. */
	onApplied: (revisionId: number, appliedPatch: AgentPatch) => void;
	/** Called before retrying a preview after a conflict, so the caller's own `original` (shown
	 * elsewhere on the page) is refreshed too, not only this dialog's own preview. */
	onReload: () => void;
}>): React.ReactElement {
	const [state, setState] = React.useState<ReviewState>({ status: "loading" });
	const [confirmedImpact, setConfirmedImpact] = React.useState(false);
	/** The exact patch under review: captured once, from `draft`, whenever this dialog opens (or
	 * when `onReload` moves `baseRevisionId` on while it stays open — `loadPreview`'s own
	 * `baseRevisionId` dependency below re-triggers the effect that captures this the same way it
	 * always re-ran the preview fetch). Never re-derived from `draft` afterward: `apply` commits
	 * this, not the live prop, and `isStale` below is what happens if the two ever disagree. */
	const [snapshot, setSnapshot] = React.useState<AgentPatch | null>(null);

	// Read inside the open/base-revision effect without making it re-run on every `draft` change
	// while the dialog stays open (which would silently re-snapshot a draft mid-review instead of
	// requiring a reopen — see `isStale`).
	const draftRef = React.useRef(draft);
	React.useEffect(() => {
		draftRef.current = draft;
	}, [draft]);

	// Every preview request is numbered and owns an `AbortController`: a response is applied only
	// if it is still for the latest request by the time it resolves (even one that resolves after
	// a newer request has already started), and a superseded request's own fetch is cancelled
	// rather than left to run for nothing. Closing the dialog invalidates whatever was in flight
	// the same way a newer request would, without starting one.
	const latestRequestId = React.useRef(0);
	const abortController = React.useRef<AbortController | null>(null);

	const loadPreview = React.useCallback(
		async (patch: AgentPatch) => {
			abortController.current?.abort();
			const controller = new AbortController();
			abortController.current = controller;
			const requestId = ++latestRequestId.current;
			setState({ status: "loading" });
			setConfirmedImpact(false);
			try {
				const outcome = await previewAgentChange(
					agentId,
					{ baseRevisionId, changes: patch },
					controller.signal,
				);
				if (latestRequestId.current !== requestId) {
					return;
				}
				if (outcome.kind === "conflict") {
					setState({ status: "conflict", currentRevisionId: outcome.currentRevisionId });
					return;
				}
				setState({
					status: "ready",
					preview: outcome.preview,
					idempotencyKey: crypto.randomUUID(),
				});
			} catch (error) {
				if (latestRequestId.current !== requestId) {
					return;
				}
				setState({
					status: "error",
					message: error instanceof ApiError ? error.message : "Could not compute a preview.",
				});
			}
		},
		[agentId, baseRevisionId],
	);

	React.useEffect(() => {
		if (!open) {
			abortController.current?.abort();
			latestRequestId.current += 1;
			return;
		}
		const captured = draftRef.current;
		setSnapshot(captured);
		void loadPreview(captured);
	}, [open, loadPreview]);

	async function apply() {
		if (state.status !== "ready" || snapshot === null) {
			return;
		}
		setState({ status: "applying", preview: state.preview, idempotencyKey: state.idempotencyKey });
		// `baseRevisionId` here is the prop — the revision the editor actually loaded this draft
		// against — never `state.preview.baseRevisionId`: the preview always reports the revision it
		// was computed against (which, once a mismatched preview is refused as a `conflict` instead
		// of silently computed, is always this same value on a `"ready"` state anyway), but committing
		// with whatever the *preview response* happened to carry back, rather than with the editor's
		// own loaded view, is what let a stale base silently re-derive itself as "current" and defeat
		// optimistic concurrency entirely. `snapshot`, not the live `draft` prop, is what was actually
		// previewed above — committing anything else would apply a patch the owner never reviewed.
		const outcome = await commitAgentChange(agentId, {
			baseRevisionId,
			changes: snapshot,
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
		onApplied(outcome.revisionId, snapshot);
	}

	// While a commit is in flight, the dialog refuses to close (the Close button, Escape, an
	// overlay click all funnel through this): dismissing it mid-apply let a since-made edit sit in
	// `draft` only for `onApplied` to clear it a moment later as if it had never happened. Once
	// applying resolves (success or failure), dismissal works normally again.
	function handleOpenChange(next: boolean) {
		if (!next && state.status === "applying") {
			return;
		}
		onOpenChange(next);
	}

	const preview = state.status === "ready" || state.status === "applying" ? state.preview : null;
	const impact = preview?.impact ?? [];
	const needsConfirmation = impact.length > 0 && !confirmedImpact;
	// `draft` changing while this dialog stays open is normally impossible (the modal blocks the
	// tabs behind it) — this is the belt-and-suspenders case for if it ever did: the preview on
	// screen would no longer describe what committing `draft` would do, so Apply is refused until
	// the dialog is closed and reopened to capture a fresh snapshot.
	const isStale = open && snapshot !== null && !deepEqual(draft, snapshot);
	const canApply =
		state.status === "ready" &&
		preview !== null &&
		preview.problems.length === 0 &&
		!preview.noop &&
		!needsConfirmation &&
		!isStale;

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="flex max-h-[90dvh] max-w-2xl flex-col">
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

				{isStale && (
					<Alert variant="destructive">
						<AlertTriangle />
						<AlertTitle>This draft changed</AlertTitle>
						<AlertDescription>
							Your edits changed since this preview was computed. Close and reopen this dialog to
							review the latest draft before applying it.
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
					<div className="min-h-0 flex-1 overflow-y-auto">
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
									<AlertTitle>This changes what the agent can do</AlertTitle>
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
					</div>
				)}

				<DialogFooter>
					{state.status === "conflict" ? (
						// `onReload` reloads the agent and rebases the draft onto it (dropping and
						// announcing any field that itself changed upstream, `agent-detail-page.tsx`'s
						// `rebaseDraft`); it does not call `loadPreview` itself — once the parent's own
						// `baseRevisionId` prop changes, `loadPreview`'s identity changes with it, and the
						// effect above re-runs it against a fresh snapshot of the (by then rebased) draft
						// on its own (or, if the rebase discarded the entire draft, the parent closes this
						// dialog instead, since there is nothing left to preview).
						<Button onClick={onReload}>Reload and try again</Button>
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
