import type { AgentConfig, AgentId, ChannelRef, MattermostId } from "@agent-gateway/contracts";

/** A channel an owner or system admin gave an agent by adding its bot in Mattermost. */
export type ChannelGrant = Readonly<{
	channelId: MattermostId;
	name: string;
	/** When the bot was added: nothing created at or before it reaches the agent. */
	sinceMs: number;
}>;

/**
 * Where agents may work: the configured channels of the team bootstrap resolved (name to id),
 * and the channels granted to each agent's current bot. Everything that authorizes a channel
 * (routing, scheduling, the turn's authority, delivery) reads it, so a grant and its revocation
 * take effect everywhere at once.
 */
export type ChannelAccess = Readonly<{
	named: ReadonlyMap<string, MattermostId>;
	granted: ReadonlyMap<AgentId, Readonly<ChannelGrant[]>>;
}>;

type AgentChannels = Readonly<{ id: AgentId; config: Pick<AgentConfig, "mattermost"> }>;

/** An agent's channels: its configured ones that are resolved, then its grants. */
export function agentChannelRefs(agent: AgentChannels, access: ChannelAccess): ChannelRef[] {
	const refs = new Map<MattermostId, ChannelRef>();
	for (const name of agent.config.mattermost.allowed_channels) {
		const channelId = access.named.get(name);
		if (channelId !== undefined) {
			refs.set(channelId, { channelId, name });
		}
	}
	for (const grant of access.granted.get(agent.id) ?? []) {
		if (!refs.has(grant.channelId)) {
			refs.set(grant.channelId, { channelId: grant.channelId, name: grant.name });
		}
	}
	return [...refs.values()];
}

export function agentChannelIds(agent: AgentChannels, access: ChannelAccess): Set<MattermostId> {
	return new Set(agentChannelRefs(agent, access).map((ref) => ref.channelId));
}

/**
 * Per channel, the newest time the agent may not see: its grant's add. A configured channel has
 * no floor of its own (the channel's catch-up start decides).
 */
export function agentChannelFloors(
	agent: AgentChannels,
	access: ChannelAccess,
): ReadonlyMap<MattermostId, number> {
	const configured = new Set(
		agent.config.mattermost.allowed_channels.flatMap((name) => {
			const id = access.named.get(name);
			return id === undefined ? [] : [id];
		}),
	);
	return new Map(
		(access.granted.get(agent.id) ?? [])
			.filter((grant) => !configured.has(grant.channelId))
			.map((grant) => [grant.channelId, grant.sinceMs]),
	);
}

/** Every granted channel, id to name. */
export function grantedChannels(access: ChannelAccess): Map<MattermostId, string> {
	const channels = new Map<MattermostId, string>();
	for (const grants of access.granted.values()) {
		for (const grant of grants) {
			channels.set(grant.channelId, grant.name);
		}
	}
	return channels;
}
