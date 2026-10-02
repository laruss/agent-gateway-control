import type { ConsoleAgentLifecycleResponse } from "@agent-gateway/contracts";
import { useQuery } from "@tanstack/react-query";
import { fetchAgentLifecycle } from "@/lib/api-client";

/** Fast enough to feel live for a provisioning pass that takes a few Mattermost calls, without
 * hammering the controller while it works through them. */
const LIFECYCLE_POLL_MS = 2_000;

/**
 * An agent's own lifecycle status and operation journal (ADR-026), polled only while there is
 * something to wait for: `pending` (queued, not yet claimed) or `reconciling` (a provisioning
 * operation is actively running) — the agent page's progress view needs to see each checkpoint as
 * the provisioner completes it. Settles (stops polling) the moment the agent reaches `ready`,
 * `failed`, `retiring` (its own cleanup is the provisioner's `retire` operation, surfaced the same
 * way, but a stuck one needs an owner's attention, not a tighter poll) or `retired`.
 */
export function useAgentLifecycle(agentId: string | undefined) {
	return useQuery<ConsoleAgentLifecycleResponse | null>({
		queryKey: ["agent-lifecycle", agentId],
		queryFn: () => fetchAgentLifecycle(agentId as string),
		enabled: agentId !== undefined,
		refetchInterval: (query) => {
			const status = query.state.data?.status;
			return status === "pending" || status === "reconciling" ? LIFECYCLE_POLL_MS : false;
		},
		refetchIntervalInBackground: false,
		retry: false,
	});
}
