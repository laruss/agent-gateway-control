import type { ConsoleAgentLifecycleResponse } from "@agent-gateway/contracts";
import * as React from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { LifecycleStatusBadge } from "@/components/lifecycle-badge";
import { Button } from "@/components/ui/button";
import { ApiError, restoreAgent } from "@/lib/api-client";
import { ChannelAssignments } from "./channel-assignments.tsx";
import { LifecyclePanel } from "./lifecycle-panel.tsx";

export type RetiredAgentViewProps = Readonly<{
	agentId: string;
	lifecycle: ConsoleAgentLifecycleResponse;
	onReload: () => void;
}>;

/**
 * A retiring or retired agent (ADR-026): `GET /api/agents/:id` 404s for it (its `remove_agent`
 * commit already took it out of the active configuration snapshot `consoleShowAgent` reads), so
 * there is no editable configuration to show — only its own lifecycle status, provisioning
 * progress (a `retire` operation's own cleanup, or a retry of one that failed permanently), its
 * last channel assignments, and a Restore action once it has actually reached `retired`.
 */
export function RetiredAgentView({
	agentId,
	lifecycle,
	onReload,
}: RetiredAgentViewProps): React.ReactElement {
	const navigate = useNavigate();
	const [restoring, setRestoring] = React.useState(false);

	async function handleRestore() {
		setRestoring(true);
		try {
			const result = await restoreAgent(agentId, { idempotencyKey: crypto.randomUUID() });
			if (result.kind === "conflict") {
				toast.error(
					"The active configuration changed since this page was loaded. Reload and try again.",
				);
				return;
			}
			if (result.kind === "invalid") {
				toast.error(result.problems.join("; "));
				return;
			}
			toast.success(`Restoring '${agentId}'; its bot is being re-provisioned now.`);
			onReload();
		} catch (error) {
			toast.error(error instanceof ApiError ? error.message : "Could not restore this agent.");
		} finally {
			setRestoring(false);
		}
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={() => void navigate("/agents")}
						className="text-sm text-muted-foreground hover:underline"
					>
						← Agents
					</button>
					<h1 className="text-lg font-semibold">{agentId}</h1>
					<LifecycleStatusBadge status={lifecycle.status} />
				</div>
				{lifecycle.status === "retired" && (
					<Button disabled={restoring} onClick={() => void handleRestore()}>
						{restoring ? "Restoring…" : "Restore"}
					</Button>
				)}
			</div>
			<p className="text-sm text-muted-foreground">
				This agent has been retired: it has no editable configuration while it stays this way. Audit
				entries, identity and run history are kept; its private memory is unreadable.
			</p>
			<LifecyclePanel agentId={agentId} onRetried={onReload} />
			<div className="flex flex-col gap-2">
				<h3 className="text-sm font-medium">Channel assignments</h3>
				<ChannelAssignments agentId={agentId} />
			</div>
		</div>
	);
}
