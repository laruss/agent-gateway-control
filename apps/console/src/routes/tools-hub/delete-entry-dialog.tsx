import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ApiError, deleteCatalogEntry } from "@/lib/api-client";

export type DeleteEntryDialogProps = Readonly<{
	open: boolean;
	onOpenChange: (open: boolean) => void;
	entryId: string;
	isBuiltin: boolean;
	/** Every agent currently attached, for the impact list below — the entry detail page's own
	 * already-loaded read, never a second fetch. */
	attachedAgentIds: Readonly<string[]>;
	onDeleted: () => void;
}>;

/**
 * Delete confirmation (ADR-027): states plainly which agents lose this entry (every attachment is
 * removed atomically, in the same commit as the entry's own deletion) and, for a built-in, that it
 * is permanently tombstoned — reseeding a future release never silently restores it. Never
 * reversible from here: a non-built-in entry's row survives only for history past commits can
 * still name, never attachable or recreatable under the same id again.
 */
export function DeleteEntryDialog({
	open,
	onOpenChange,
	entryId,
	isBuiltin,
	attachedAgentIds,
	onDeleted,
}: DeleteEntryDialogProps): React.ReactElement {
	const [submitting, setSubmitting] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	function handleOpenChange(next: boolean) {
		if (!next && submitting) {
			return;
		}
		onOpenChange(next);
		if (!next) {
			setError(null);
		}
	}

	async function submit() {
		setSubmitting(true);
		setError(null);
		try {
			const result = await deleteCatalogEntry(entryId, attachedAgentIds);
			if (result.kind === "conflict") {
				setError(
					"The active configuration changed since this page was loaded. Reload and try again.",
				);
				return;
			}
			if (result.kind === "would_widen") {
				setError(
					`Deleting this entry would widen effective permissions for ${result.widenings
						.map((widening) => `${widening.agentId} (${widening.tools.join(", ")})`)
						.join("; ")} — detach or reconfigure those attachments first.`,
				);
				return;
			}
			if (result.kind === "invalid") {
				setError(result.problems.join("; "));
				return;
			}
			toast.success(
				result.response.affectedAgentIds.length === 0
					? `Deleted '${entryId}'.`
					: `Deleted '${entryId}'; removed from ${result.response.affectedAgentIds.join(", ")}.`,
			);
			handleOpenChange(false);
			onDeleted();
		} catch (caught) {
			setError(caught instanceof ApiError ? caught.message : "Could not delete this entry.");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete '{entryId}'?</DialogTitle>
					<DialogDescription>
						{attachedAgentIds.length === 0 ? (
							"No agent currently holds this entry."
						) : (
							<>
								Removes it from every agent that currently holds it, in the same step:{" "}
								<span className="font-medium">{attachedAgentIds.join(", ")}</span>.
							</>
						)}{" "}
						{isBuiltin
							? "This is a built-in capability: deleting it is permanent — a future release never re-adds it on its own."
							: "This cannot be undone; the entry id can never be reused."}
					</DialogDescription>
				</DialogHeader>
				{error !== null && <p className="text-sm text-destructive">{error}</p>}
				<DialogFooter>
					<Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={() => void submit()} disabled={submitting}>
						{submitting ? "Deleting…" : "Delete"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
