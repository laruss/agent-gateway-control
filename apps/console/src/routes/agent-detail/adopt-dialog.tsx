import type { ConsoleAdoptPreviewResponse } from "@agent-gateway/contracts";
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
import { ApiError, commitAdopt, fetchAdoptPreview } from "@/lib/api-client";

export type AdoptDialogProps = Readonly<{
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agentId: string;
	onAdopted: () => void;
}>;

type State =
	| Readonly<{ status: "loading" }>
	| Readonly<{ status: "error"; message: string }>
	| Readonly<{ status: "ready"; preview: ConsoleAdoptPreviewResponse }>
	| Readonly<{ status: "applying"; preview: ConsoleAdoptPreviewResponse }>
	| Readonly<{ status: "conflict" }>;

/**
 * "Adopt into the tools hub" (ADR-027): a dry-run preview of converting this legacy agent's
 * `permissions` lists into real, recorded attachments, with an explicit before/after comparison —
 * identical in effect whenever every pattern resolves, the whole point of a safe migration — before
 * committing it.
 */
export function AdoptDialog({
	open,
	onOpenChange,
	agentId,
	onAdopted,
}: AdoptDialogProps): React.ReactElement {
	const [state, setState] = React.useState<State>({ status: "loading" });

	const load = React.useCallback(async () => {
		setState({ status: "loading" });
		try {
			const preview = await fetchAdoptPreview(agentId);
			setState({ status: "ready", preview });
		} catch (error) {
			setState({
				status: "error",
				message: error instanceof ApiError ? error.message : "Could not preview this adoption.",
			});
		}
	}, [agentId]);

	React.useEffect(() => {
		if (open) {
			void load();
		}
	}, [open, load]);

	async function confirm() {
		if (state.status !== "ready") {
			return;
		}
		setState({ status: "applying", preview: state.preview });
		try {
			const result = await commitAdopt(agentId, { idempotencyKey: crypto.randomUUID() });
			if (result.kind === "conflict") {
				setState({ status: "conflict" });
				return;
			}
			if (result.kind === "invalid") {
				toast.error(result.problems.join("; "));
				setState({ status: "ready", preview: state.preview });
				return;
			}
			toast.success(`'${agentId}' is now managed in the tools hub.`);
			onOpenChange(false);
			onAdopted();
		} catch (error) {
			toast.error(error instanceof ApiError ? error.message : "Could not adopt this agent.");
			setState({ status: "ready", preview: state.preview });
		}
	}

	const preview = state.status === "ready" || state.status === "applying" ? state.preview : null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[85dvh] max-w-xl flex-col overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Adopt '{agentId}' into the tools hub</DialogTitle>
					<DialogDescription>
						Converts its current <code>permissions</code> lists into real, recorded attachments —
						its effective access stays the same whenever every pattern below resolves cleanly.
					</DialogDescription>
				</DialogHeader>
				{state.status === "loading" && (
					<p className="text-sm text-muted-foreground">Computing a preview…</p>
				)}
				{state.status === "error" && (
					<Alert variant="destructive">
						<AlertTriangle />
						<AlertTitle>Could not preview this adoption</AlertTitle>
						<AlertDescription>{state.message}</AlertDescription>
					</Alert>
				)}
				{state.status === "conflict" && (
					<Alert variant="destructive">
						<AlertTriangle />
						<AlertTitle>Configuration changed elsewhere</AlertTitle>
						<AlertDescription>
							Someone else committed a change since this preview was computed. Close and reopen this
							dialog to try again.
						</AlertDescription>
					</Alert>
				)}
				{preview !== null && (
					<div className="flex flex-col gap-3 text-sm">
						{preview.problems.length > 0 && (
							<Alert variant="destructive">
								<AlertTriangle />
								<AlertTitle>This agent cannot be adopted yet</AlertTitle>
								<AlertDescription>
									<ul className="list-inside list-disc">
										{preview.problems.map((problem) => (
											<li key={problem}>{problem}</li>
										))}
									</ul>
								</AlertDescription>
							</Alert>
						)}
						{preview.unresolved.length > 0 && (
							<Alert>
								<AlertTriangle />
								<AlertTitle>Unresolved patterns</AlertTitle>
								<AlertDescription>
									<ul className="list-inside list-disc">
										{preview.unresolved.map((pattern) => (
											<li key={`${pattern.list}:${pattern.pattern}`}>
												{pattern.pattern} ({pattern.list})
											</li>
										))}
									</ul>
									These patterns name no catalog entry known right now and are dropped, not silently
									matched to anything future.
								</AlertDescription>
							</Alert>
						)}
						<div className="grid grid-cols-2 gap-3">
							<div>
								<p className="font-medium">Before</p>
								<p className="text-xs text-muted-foreground">
									allow: {preview.before.tools_allow.join(", ") || "—"}
								</p>
								<p className="text-xs text-muted-foreground">
									approval: {preview.before.tools_require_human_approval.join(", ") || "—"}
								</p>
								<p className="text-xs text-muted-foreground">
									deny: {preview.before.tools_deny.join(", ") || "—"}
								</p>
							</div>
							<div>
								<p className="font-medium">After</p>
								<p className="text-xs text-muted-foreground">
									allow: {preview.after.tools_allow.join(", ") || "—"}
								</p>
								<p className="text-xs text-muted-foreground">
									approval: {preview.after.tools_require_human_approval.join(", ") || "—"}
								</p>
								<p className="text-xs text-muted-foreground">
									deny: {preview.after.tools_deny.join(", ") || "—"}
								</p>
							</div>
						</div>
					</div>
				)}
				<DialogFooter>
					{state.status === "conflict" ? (
						<Button onClick={() => void load()}>Reload and try again</Button>
					) : (
						<Button
							onClick={() => void confirm()}
							disabled={
								preview === null ||
								preview.problems.length > 0 ||
								preview.alreadyHubManaged ||
								state.status === "applying"
							}
						>
							{state.status === "applying" ? "Adopting…" : "Adopt"}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
