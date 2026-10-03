import type { ConsoleToolCatalogListItem, ToolAttachmentMode } from "@agent-gateway/contracts";
import { riskFloorAllows } from "@agent-gateway/contracts";
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
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ApiError, attachTool, fetchToolCatalog } from "@/lib/api-client";

export type AttachEntryDialogProps = Readonly<{
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agentId: string;
	/** Already-requested entry ids, excluded from the picker: re-attaching one is an edit
	 * (`updateAttachment`), not this dialog's job. */
	alreadyRequestedEntryIds: Readonly<string[]>;
	/** The agent-tools read's own `baseRevisionId` (the Tools tab's already-loaded state): echoed
	 * back on attach, which refuses with `409` once the active configuration has moved past it,
	 * rather than silently converting a still-legacy agent's current `permissions` against state
	 * this page never actually showed. */
	baseRevisionId: number | null;
	onAttached: () => void;
}>;

/** The agent capability editor's own "Attach a tool" action: picks a catalog entry and its mode
 * for this one, already-known agent — the inverse of the hub's own `AttachToAgentDialog`, which
 * fixes the entry and picks the agent. */
export function AttachEntryDialog({
	open,
	onOpenChange,
	agentId,
	alreadyRequestedEntryIds,
	baseRevisionId,
	onAttached,
}: AttachEntryDialogProps): React.ReactElement {
	const [entries, setEntries] = React.useState<Readonly<ConsoleToolCatalogListItem[]>>([]);
	const [entryId, setEntryId] = React.useState("");
	const [mode, setMode] = React.useState<ToolAttachmentMode>("allow");
	const [submitting, setSubmitting] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	React.useEffect(() => {
		if (!open) {
			return;
		}
		void fetchToolCatalog().then((response) => setEntries(response.entries));
	}, [open]);

	const requested = new Set(alreadyRequestedEntryIds);
	const options = entries.filter((entry) => !requested.has(entry.id));
	const selected = options.find((entry) => entry.id === entryId);

	React.useEffect(() => {
		if (selected !== undefined && !riskFloorAllows(mode, selected.riskFloor)) {
			setMode("require_approval");
		}
	}, [selected, mode]);

	function handleOpenChange(next: boolean) {
		onOpenChange(next);
		if (!next) {
			setEntryId("");
			setError(null);
		}
	}

	async function submit() {
		if (entryId.length === 0) {
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const result = await attachTool(agentId, {
				idempotencyKey: crypto.randomUUID(),
				entryId,
				pinnedVersion: null,
				mode,
				baseRevisionId,
			});
			if (result.kind === "conflict") {
				setError(
					"The active configuration changed since this page was loaded. Reload and try again.",
				);
				return;
			}
			if (result.kind === "invalid") {
				setError(result.problems.join("; "));
				return;
			}
			toast.success(`Attached '${entryId}'.`);
			handleOpenChange(false);
			onAttached();
		} catch (caught) {
			setError(caught instanceof ApiError ? caught.message : "Could not attach this entry.");
		} finally {
			setSubmitting(false);
		}
	}

	const availableModes: Readonly<ToolAttachmentMode[]> = (
		["allow", "require_approval", "disabled"] as const
	).filter((candidate) => selected === undefined || riskFloorAllows(candidate, selected.riskFloor));

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Attach a tool</DialogTitle>
					<DialogDescription>Takes effect on this agent's very next turn.</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="attach-entry-select">Entry</Label>
						<Select value={entryId} onValueChange={setEntryId} disabled={submitting}>
							<SelectTrigger id="attach-entry-select">
								<SelectValue placeholder="Select a catalog entry" />
							</SelectTrigger>
							<SelectContent>
								{options.map((entry) => (
									<SelectItem key={entry.id} value={entry.id}>
										{entry.name} ({entry.id})
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="attach-entry-mode">Mode</Label>
						<Select
							value={mode}
							onValueChange={(value) => setMode(value as ToolAttachmentMode)}
							disabled={submitting}
						>
							<SelectTrigger id="attach-entry-mode">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{availableModes.map((candidate) => (
									<SelectItem key={candidate} value={candidate}>
										{candidate}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					{error !== null && <p className="text-sm text-destructive">{error}</p>}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
						Cancel
					</Button>
					<Button onClick={() => void submit()} disabled={submitting || entryId.length === 0}>
						{submitting ? "Attaching…" : "Attach"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
