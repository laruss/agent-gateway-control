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
import { Textarea } from "@/components/ui/textarea";
import { ApiError, retireAgent } from "@/lib/api-client";

export type RetireAgentDialogProps = Readonly<{
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agentId: string;
	/** `permissions.observe_system`: the closest thing this configuration has to a "system agent"
	 * flag (the operator example agent sets it). Retiring one is never blocked — only warned
	 * about, since the console and CLI must keep working with zero agents ready. */
	isSystemAgent: boolean;
	isFinanceAgent: boolean;
	/** Every other currently configured agent, for the required reassignment select. */
	otherAgentIds: Readonly<string[]>;
	onRetired: () => void;
}>;

/**
 * Retire confirmation (ADR-026): states plainly what retirement cancels (its active run and
 * waits, pending approvals and queued tool actions, every channel grant, pending deliveries) and
 * that it is reversible (Restore re-adds its configuration and re-provisions the same bot).
 * Requires `reassignFinanceTo` before the agent can even submit when it is the organization's
 * finance agent — `requestAgentRetire` would refuse it anyway, but asking first is clearer than a
 * round trip to find out.
 */
export function RetireAgentDialog({
	open,
	onOpenChange,
	agentId,
	isSystemAgent,
	isFinanceAgent,
	otherAgentIds,
	onRetired,
}: RetireAgentDialogProps): React.ReactElement {
	const [reassignTo, setReassignTo] = React.useState("");
	const [reason, setReason] = React.useState("");
	const [idempotencyKey, setIdempotencyKey] = React.useState(() => crypto.randomUUID());
	const [submitting, setSubmitting] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	function reset() {
		setReassignTo("");
		setReason("");
		setIdempotencyKey(crypto.randomUUID());
		setError(null);
	}

	function handleOpenChange(next: boolean) {
		onOpenChange(next);
		if (!next) {
			reset();
		}
	}

	const canSubmit = !submitting && (!isFinanceAgent || reassignTo.length > 0);

	async function submit() {
		if (!canSubmit) {
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const result = await retireAgent(agentId, {
				idempotencyKey,
				...(reason.trim().length === 0 ? {} : { reason: reason.trim() }),
				...(isFinanceAgent ? { reassignFinanceTo: reassignTo } : {}),
			});
			if (result.kind === "conflict") {
				setError(
					"The active configuration changed since this page was loaded. Close this dialog, reload and try again.",
				);
				return;
			}
			if (result.kind === "invalid") {
				setError(result.problems.join("; "));
				return;
			}
			toast.success(`Retiring '${agentId}'.`);
			handleOpenChange(false);
			onRetired();
		} catch (caught) {
			setError(caught instanceof ApiError ? caught.message : "Could not retire this agent.");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Retire '{agentId}'?</DialogTitle>
					<DialogDescription>
						Cancels its active run and waits, withdraws its pending approvals and queued tool
						actions, revokes every channel it was granted directly, and blocks its pending
						Mattermost deliveries. Its bot is deactivated, its tokens revoked, and (once created
						through this console or the CLI) its local token file removed. This is reversible:
						Restore re-adds its configuration and re-provisions the same bot.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4">
					{isSystemAgent && (
						<p className="text-sm text-amber-600 dark:text-amber-500">
							This agent has <code className="font-mono">observe_system</code> permission (an
							operator-style agent). Retiring it is not blocked, but stops that function until it is
							restored.
						</p>
					)}
					{isFinanceAgent && (
						<div className="flex flex-col gap-1.5">
							<Label>Reassign the finance role to</Label>
							<Select value={reassignTo} onValueChange={setReassignTo} disabled={submitting}>
								<SelectTrigger>
									<SelectValue placeholder="Select an agent" />
								</SelectTrigger>
								<SelectContent>
									{otherAgentIds.map((id) => (
										<SelectItem key={id} value={id}>
											{id}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-xs text-muted-foreground">
								Required: '{agentId}' is the organization's finance agent; retiring it without
								reassigning the role is refused.
							</p>
						</div>
					)}
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="retire-reason">Reason (optional)</Label>
						<Textarea
							id="retire-reason"
							value={reason}
							onChange={(event) => setReason(event.target.value)}
							rows={2}
							disabled={submitting}
						/>
					</div>
					{error !== null && <p className="text-sm text-destructive">{error}</p>}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={() => void submit()} disabled={!canSubmit}>
						{submitting ? "Retiring…" : "Retire"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
