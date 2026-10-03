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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, editCatalogEntry } from "@/lib/api-client";

export type EditMetadataDialogProps = Readonly<{
	open: boolean;
	onOpenChange: (open: boolean) => void;
	entryId: string;
	name: string;
	description: string;
	/** The entry's own `currentVersion.version`, as this page last loaded it: echoed back on
	 * submit, refused with a clear message once someone else's edit already moved the entry past
	 * it, rather than silently overwriting that edit. */
	expectedVersion: number;
	onSaved: () => void;
}>;

/**
 * A built-in's own edit (ADR-027): name and description only — its `kind`, `implementationKey`,
 * risk floor and supported adapters describe a real integration this release itself ships, not
 * something an edit here can redefine. Publishes a new, immutable version; its history stays
 * readable on the entry detail page's own version list.
 */
export function EditMetadataDialog({
	open,
	onOpenChange,
	entryId,
	name: initialName,
	description: initialDescription,
	expectedVersion,
	onSaved,
}: EditMetadataDialogProps): React.ReactElement {
	const [name, setName] = React.useState(initialName);
	const [description, setDescription] = React.useState(initialDescription);
	const [submitting, setSubmitting] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	React.useEffect(() => {
		if (open) {
			setName(initialName);
			setDescription(initialDescription);
			setError(null);
		}
	}, [open, initialName, initialDescription]);

	function handleOpenChange(next: boolean) {
		if (!next && submitting) {
			return;
		}
		onOpenChange(next);
	}

	const changed = name !== initialName || description !== initialDescription;

	async function submit() {
		if (!changed) {
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const result = await editCatalogEntry(entryId, {
				...(name !== initialName ? { name } : {}),
				...(description !== initialDescription ? { description } : {}),
				expectedVersion,
			});
			if (result.kind === "conflict") {
				setError(
					"This entry was edited elsewhere since this page was loaded. Reload and try again.",
				);
				return;
			}
			if (result.kind === "invalid") {
				setError(result.problems.join("; "));
				return;
			}
			toast.success(`Updated '${entryId}'.`);
			handleOpenChange(false);
			onSaved();
		} catch (caught) {
			setError(caught instanceof ApiError ? caught.message : "Could not update this entry.");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Edit '{entryId}'</DialogTitle>
					<DialogDescription>
						Only its name and description change here: this entry's own behavior is fixed by this
						release's code.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="edit-metadata-name">Name</Label>
						<Input
							id="edit-metadata-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							disabled={submitting}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="edit-metadata-description">Description</Label>
						<Textarea
							id="edit-metadata-description"
							value={description}
							onChange={(event) => setDescription(event.target.value)}
							rows={3}
							disabled={submitting}
						/>
					</div>
					{error !== null && <p className="text-sm text-destructive">{error}</p>}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
						Cancel
					</Button>
					<Button onClick={() => void submit()} disabled={submitting || !changed}>
						{submitting ? "Saving…" : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
