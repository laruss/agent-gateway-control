import type { ConsoleAgentChannelAssignment } from "@agent-gateway/contracts";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, fetchAgentChannels, revokeAgentChannelGrant } from "@/lib/api-client";

type LoadState =
	| Readonly<{ status: "loading" }>
	| Readonly<{ status: "error"; message: string }>
	| Readonly<{ status: "ok"; channels: Readonly<ConsoleAgentChannelAssignment[]> }>;

/**
 * An agent's channels with provenance (ADR-026): `configured` (named in its own
 * `allowed_channels` — editable above, in the channel switches) or `granted` (an ADR-022 grant an
 * owner or system admin gave its bot directly — who, when, and the post that is its evidence),
 * each with its own "Revoke" action. A channel the bot is a member of that is neither (live-only,
 * `member-unauthorized`) is not part of this database-only read model, the same way `gateway
 * agents channels` itself works — `gateway mattermost reconcile` is the live check for that.
 */
export function ChannelAssignments({ agentId }: Readonly<{ agentId: string }>): React.ReactElement {
	const [state, setState] = React.useState<LoadState>({ status: "loading" });
	const [revokingId, setRevokingId] = React.useState<string | null>(null);
	const queryClient = useQueryClient();

	const load = React.useCallback(async () => {
		setState({ status: "loading" });
		try {
			const response = await fetchAgentChannels(agentId);
			setState({ status: "ok", channels: response.channels });
		} catch (error) {
			setState({
				status: "error",
				message: error instanceof ApiError ? error.message : "Could not load its channels.",
			});
		}
	}, [agentId]);

	React.useEffect(() => {
		void load();
	}, [load]);

	async function handleRevoke(assignment: ConsoleAgentChannelAssignment) {
		setRevokingId(assignment.channelId);
		try {
			await revokeAgentChannelGrant(agentId, assignment.channelId);
			toast.success(`Revoked '${assignment.channelName}'.`);
			await load();
			// A revoke queues a `reprovision` for a lifecycle-owned, `ready` agent (ADR-026): the
			// lifecycle query may already have settled on a terminal operation (polling stopped,
			// `shouldPollLifecycle`), so without this it would never notice the new one, and its
			// progress or failure would never show.
			await queryClient.invalidateQueries({ queryKey: ["agent-lifecycle", agentId] });
		} catch (error) {
			toast.error(error instanceof ApiError ? error.message : "Could not revoke this channel.");
		} finally {
			setRevokingId(null);
		}
	}

	if (state.status === "loading") {
		return <Skeleton className="h-24 w-full" />;
	}
	if (state.status === "error") {
		return <p className="text-sm text-destructive">{state.message}</p>;
	}
	if (state.channels.length === 0) {
		return <p className="text-sm text-muted-foreground">No channel assignments.</p>;
	}

	return (
		<ul className="flex flex-col gap-2">
			{state.channels.map((assignment) => (
				<li
					key={assignment.channelId}
					className="flex items-center justify-between gap-2 rounded-lg border border-input p-2 text-sm"
				>
					<div className="flex flex-col gap-0.5">
						<div className="flex items-center gap-2">
							<span className="font-mono">{assignment.channelName}</span>
							<Badge variant={assignment.provenance === "configured" ? "secondary" : "outline"}>
								{assignment.provenance}
							</Badge>
						</div>
						{assignment.provenance === "granted" && (
							<span className="text-xs text-muted-foreground">
								granted by {assignment.grantedByUserId}
								{assignment.grantedAt !== null &&
									` on ${new Date(assignment.grantedAt).toLocaleString()}`}
								{assignment.evidencePostId !== null && ` · post ${assignment.evidencePostId}`}
							</span>
						)}
					</div>
					{assignment.provenance === "granted" && (
						<Button
							variant="outline"
							size="sm"
							disabled={revokingId === assignment.channelId}
							onClick={() => void handleRevoke(assignment)}
						>
							{revokingId === assignment.channelId ? "Revoking…" : "Revoke"}
						</Button>
					)}
				</li>
			))}
		</ul>
	);
}
