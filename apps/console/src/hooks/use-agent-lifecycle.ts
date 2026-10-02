import type { ConsoleAgentLifecycleResponse } from "@agent-gateway/contracts";
import { useQuery } from "@tanstack/react-query";
import { fetchAgentLifecycle } from "@/lib/api-client";

/** Fast enough to feel live for a provisioning pass that takes a few Mattermost calls, without
 * hammering the controller while it works through them. */
const LIFECYCLE_POLL_MS = 2_000;

/**
 * Whether `useAgentLifecycle` should keep polling, decided from the agent's *current* operation
 * (`operations[0]`, newest first) rather than its `status`: a `retire` operation leaves `status`
 * at `retiring` for its whole `pending`/`running`/terminal lifetime, and a `reprovision` operation
 * never moves `status` off `ready` at all (see `markProvisioning`), so `status` alone cannot tell
 * a still-running operation from one that already finished. Polls while the current operation is
 * `pending` (queued, not yet claimed) or `running` (actively provisioning); settles the moment it
 * reaches a terminal state (`succeeded`, `failed` or `cancelled`).
 */
export function shouldPollLifecycle(
	data: ConsoleAgentLifecycleResponse | null | undefined,
): boolean {
	const current = data?.operations[0]?.state;
	return current === "pending" || current === "running";
}

/**
 * An agent's own lifecycle status and operation journal (ADR-026), polled only while there is
 * something to wait for (see {@link shouldPollLifecycle}) — the agent page's progress view needs
 * to see each checkpoint as the provisioner completes it.
 */
export function useAgentLifecycle(agentId: string | undefined) {
	return useQuery<ConsoleAgentLifecycleResponse | null>({
		queryKey: ["agent-lifecycle", agentId],
		queryFn: () => fetchAgentLifecycle(agentId as string),
		enabled: agentId !== undefined,
		refetchInterval: (query) => (shouldPollLifecycle(query.state.data) ? LIFECYCLE_POLL_MS : false),
		refetchIntervalInBackground: false,
		retry: false,
	});
}
