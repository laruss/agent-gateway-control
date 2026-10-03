import type { ToolAttachmentMode, ToolCatalogRiskFloor } from "@agent-gateway/contracts";
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
import { ApiError, attachTool, fetchAgentsList } from "@/lib/api-client";

export type AttachToAgentDialogProps = Readonly<{
	open: boolean;
	onOpenChange: (open: boolean) => void;
	entryId: string;
	riskFloor: ToolCatalogRiskFloor;
	onAttached: () => void;
}>;

/** "Attach to agent" (the hub's entry detail page, ADR-025/027): picks which agent gets this entry
 * and its mode — the entry side is already fixed by the page this opens from. Always tracks the
 * entry's current version (`pinnedVersion: null`); pinning a specific version is a CLI-only
 * refinement (`updateAttachment`) this dialog does not expose. */
export function AttachToAgentDialog({
	open,
	onOpenChange,
	entryId,
	riskFloor,
	onAttached,
}: AttachToAgentDialogProps): React.ReactElement {
	const [agentIds, setAgentIds] = React.useState<Readonly<string[]>>([]);
	const [agentId, setAgentId] = React.useState("");
	const [mode, setMode] = React.useState<ToolAttachmentMode>(
		riskFloor === "require_approval" ? "require_approval" : "allow",
	);
	const [submitting, setSubmitting] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	React.useEffect(() => {
		if (!open) {
			return;
		}
		void fetchAgentsList().then((response) => setAgentIds(response.agents.map((a) => a.id)));
	}, [open]);

	function handleOpenChange(next: boolean) {
		onOpenChange(next);
		if (!next) {
			setAgentId("");
			setError(null);
		}
	}

	const availableModes: Readonly<ToolAttachmentMode[]> = (
		["allow", "require_approval", "disabled"] as const
	).filter((candidate) => riskFloorAllows(candidate, riskFloor));

	async function submit() {
		if (agentId.length === 0) {
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
			toast.success(`Attached '${entryId}' to '${agentId}'.`);
			handleOpenChange(false);
			onAttached();
		} catch (caught) {
			setError(caught instanceof ApiError ? caught.message : "Could not attach this entry.");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Attach '{entryId}' to an agent</DialogTitle>
					<DialogDescription>
						Takes effect on that agent's very next turn. A legacy agent's existing permissions are
						converted into real attachments in the same step, so nothing it already holds is lost.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="attach-to-agent-select">Agent</Label>
						<Select value={agentId} onValueChange={setAgentId} disabled={submitting}>
							<SelectTrigger id="attach-to-agent-select">
								<SelectValue placeholder="Select an agent" />
							</SelectTrigger>
							<SelectContent>
								{agentIds.map((id) => (
									<SelectItem key={id} value={id}>
										{id}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="attach-to-agent-mode">Mode</Label>
						<Select
							value={mode}
							onValueChange={(value) => setMode(value as ToolAttachmentMode)}
							disabled={submitting}
						>
							<SelectTrigger id="attach-to-agent-mode">
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
					<Button onClick={() => void submit()} disabled={submitting || agentId.length === 0}>
						{submitting ? "Attaching…" : "Attach"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
