import type { AgentId, MattermostId } from "./common.ts";

/**
 * The records behind channel grants (ADR-022), shared by the control plane that stores them and
 * the Mattermost bridge whose membership synchronizer reads and writes them.
 */

export type MembershipBot = Readonly<{
	agentId: AgentId;
	userId: MattermostId;
	tokenSecretRef: string;
	/** The agent's configured channels, resolved: they need no grant. */
	configuredChannelIds: ReadonlySet<MattermostId>;
}>;

/** The latest grant record of an agent in a channel; revoked ones are tombstones. */
export type GrantRecord = Readonly<{
	agentId: AgentId;
	channelId: MattermostId;
	state: "active" | "revoked";
	botUserId: MattermostId;
	/** An add must be newer than this to grant (again). */
	sinceMs: number;
	/** Why a revoked record ended, e.g. `bot_left` or `config_removed`; null while active. */
	revokedReason: string | null;
}>;

/** What the membership synchronizer works from; null before configuration and bootstrap. */
export type MembershipState = Readonly<{
	teamId: MattermostId;
	/** Owners by user id: their adds grant a channel (as do system admins'). */
	ownerUserIds: ReadonlySet<MattermostId>;
	listener: Readonly<{ userId: MattermostId; tokenSecretRef: string }>;
	/** Bots of the active configuration's agents that bootstrap resolved. */
	bots: Readonly<MembershipBot[]>;
	grants: Readonly<GrantRecord[]>;
}>;

export type ChannelGrantInput = Readonly<{
	agentId: AgentId;
	botUserId: MattermostId;
	teamId: MattermostId;
	channelId: MattermostId;
	channelName: string;
	grantorUserId: MattermostId;
	evidencePostId: MattermostId;
	/** When the bot was added (the add's system post): the agent's floor in this channel. */
	sinceMs: number;
}>;

export type RejectedAddReason =
	| "not_owner_or_admin"
	| "no_add_record"
	| "listener_not_added"
	/** The channel was taken out of the agent's `allowed_channels`: its bot leaves. */
	| "configuration_removed";

export type RejectedAdd = Readonly<{
	agentId: AgentId;
	channelId: MattermostId;
	channelName: string;
	/** Who added the bot, when the add's system post says; null when no such post was found. */
	actorUserId: MattermostId | null;
	evidencePostId: MattermostId | null;
	reason: RejectedAddReason;
}>;
