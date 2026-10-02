import type {
	AgentLifecycleCheckpoints,
	AgentLifecycleOperationKind,
	ConsoleLifecycleOperation,
} from "@agent-gateway/contracts";
import { CheckCircle2, CircleDashed, LoaderCircle } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useAgentLifecycle } from "@/hooks/use-agent-lifecycle";
import { ApiError, retryOperation } from "@/lib/api-client";

type Step = Readonly<{ key: keyof AgentLifecycleCheckpoints; label: string }>;

const CREATE_STEPS: Readonly<Step[]> = [
	{ key: "bot_user_id", label: "Resolve or create the bot" },
	{ key: "token_ref", label: "Issue an access token" },
	{ key: "team_joined", label: "Join the team" },
	{ key: "channels_joined", label: "Join its configured channels" },
];
const RETIRE_STEPS: Readonly<Step[]> = [
	{ key: "tokens_revoked", label: "Revoke its access tokens" },
	{ key: "bot_disabled", label: "Deactivate the bot" },
	{ key: "channels_left", label: "Leave its channels" },
	{ key: "token_file_deleted", label: "Remove its local token file" },
];
const REPROVISION_STEPS: Readonly<Step[]> = [
	{ key: "channels_joined", label: "Join newly configured channels" },
	{ key: "channels_left", label: "Leave channels no longer configured" },
];

function stepsFor(kind: AgentLifecycleOperationKind): Readonly<Step[]> {
	if (kind === "retire") {
		return RETIRE_STEPS;
	}
	if (kind === "reprovision") {
		return REPROVISION_STEPS;
	}
	return CREATE_STEPS;
}

function stepDone(
	checkpoints: AgentLifecycleCheckpoints,
	key: keyof AgentLifecycleCheckpoints,
): boolean {
	const value = checkpoints[key];
	return typeof value === "boolean" ? value : value !== undefined;
}

/** The current (or last) operation's own checkpoints, as a checklist: done, in progress (the
 * first not-yet-done step, only while the operation is actually `running`) or still to come. */
function CheckpointList({
	operation,
}: {
	operation: ConsoleLifecycleOperation;
}): React.ReactElement {
	const steps = stepsFor(operation.kind);
	const doneCount = steps.filter((step) => stepDone(operation.checkpoints, step.key)).length;
	let firstPending = false;
	return (
		<div className="flex flex-col gap-2">
			<Progress value={steps.length === 0 ? 0 : (100 * doneCount) / steps.length} />
			<ul className="flex flex-col gap-1 text-sm">
				{steps.map((step) => {
					const done = stepDone(operation.checkpoints, step.key);
					const inProgress = !done && !firstPending && operation.state === "running";
					if (inProgress) {
						firstPending = true;
					}
					return (
						<li key={step.key} className="flex items-center gap-2">
							{done ? (
								<CheckCircle2 className="size-4 text-green-600" />
							) : inProgress ? (
								<LoaderCircle className="size-4 animate-spin text-muted-foreground" />
							) : (
								<CircleDashed className="size-4 text-muted-foreground" />
							)}
							<span className={done ? "" : "text-muted-foreground"}>{step.label}</span>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

export type LifecyclePanelProps = Readonly<{
	agentId: string;
	onRetried: () => void;
}>;

/**
 * Live lifecycle progress (ADR-026): polls while the agent is `pending`/`reconciling` (its
 * current operation's own checkpoints, as they complete) and shows an actionable failure with a
 * Retry button once it is `failed`, or `retiring` with its own retire cleanup permanently failed.
 * Renders nothing for `ready` — the status badge in the page header already says so.
 */
export function LifecyclePanel({
	agentId,
	onRetried,
}: LifecyclePanelProps): React.ReactElement | null {
	const { data, isPending, isError } = useAgentLifecycle(agentId);
	const [retrying, setRetrying] = React.useState(false);

	if (isPending || isError || data === null || data === undefined) {
		return null;
	}

	const current = data.operations[0];
	const canRetry =
		current !== undefined &&
		current.state === "failed" &&
		(data.status === "failed" || data.status === "retiring");

	async function handleRetry() {
		setRetrying(true);
		try {
			const result = await retryOperation(agentId, { idempotencyKey: crypto.randomUUID() });
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
			toast.success(`Retrying its '${result.operationKind}' operation.`);
			onRetried();
		} catch (error) {
			toast.error(error instanceof ApiError ? error.message : "Could not retry this operation.");
		} finally {
			setRetrying(false);
		}
	}

	if (data.status !== "pending" && data.status !== "reconciling" && !canRetry) {
		return null;
	}

	return (
		<div className="flex flex-col gap-3 rounded-lg border border-input p-4">
			<div className="flex items-center justify-between">
				<h3 className="text-sm font-medium">Provisioning</h3>
				{canRetry && (
					<Button
						size="sm"
						variant="outline"
						disabled={retrying}
						onClick={() => void handleRetry()}
					>
						{retrying ? "Retrying…" : "Retry"}
					</Button>
				)}
			</div>
			{data.lastError !== null && <p className="text-sm text-destructive">{data.lastError}</p>}
			{current !== undefined && (data.status === "pending" || data.status === "reconciling") && (
				<CheckpointList operation={current} />
			)}
		</div>
	);
}
