import {
	type AgentConfig,
	type AgentId,
	type AgentTurnInput,
	AgentTurnInputSchema,
	type ChannelRef,
	type GatewayEvent,
	type MattermostId,
	modelOutputJsonSchema,
	type OrganizationConfig,
	type ResolvedWait,
	type TurnAuthorityContext,
	type Uuid,
	type WorkingSummary,
} from "@agent-gateway/contracts";
import type { AgentState } from "@agent-gateway/db";

export type AgentRecord = Readonly<{
	id: AgentId;
	displayName: string;
	state: AgentState;
	config: AgentConfig;
	rolePrompt: string;
	configVersion: string;
}>;

export type TurnContextSources = Readonly<{
	runId: Uuid;
	agent: AgentRecord;
	organization: OrganizationConfig;
	constitution: string;
	/** Every registered agent, including `agent`. */
	agents: Readonly<AgentRecord[]>;
	/** Channel ids resolved by bootstrap, by channel name. */
	channelIds: ReadonlyMap<string, MattermostId>;
	trigger: GatewayEvent;
	pendingInbox: Readonly<GatewayEvent[]>;
	previousRun: Readonly<{ id: Uuid; summary: WorkingSummary | null }> | null;
	resolvedWaits: Readonly<ResolvedWait[]>;
	now: Date;
}>;

export type TurnContext = Readonly<{
	input: AgentTurnInput;
	authority: TurnAuthorityContext;
}>;

export type TurnContextResult =
	| Readonly<{ ok: true; context: TurnContext }>
	| Readonly<{ ok: false; reason: string }>;

function resolveChannels(
	names: Readonly<string[]>,
	channelIds: ReadonlyMap<string, MattermostId>,
): ChannelRef[] {
	return names.flatMap((name) => {
		const channelId = channelIds.get(name);
		return channelId === undefined ? [] : [{ channelId, name }];
	});
}

/**
 * Assembles the turn input and the authority its result is checked against. Both come from the
 * same sources at the same moment, so the runtime is told exactly what it is allowed to do.
 * Thread context, memories and workspaces are not assembled yet (empty/null). Pure.
 */
export function buildTurnContext(sources: TurnContextSources): TurnContextResult {
	const { agent, organization, now } = sources;
	const channels = resolveChannels(agent.config.mattermost.allowed_channels, sources.channelIds);
	if (channels.length === 0) {
		return { ok: false, reason: `no allowed channel of '${agent.id}' is resolved to an id` };
	}
	const others = sources.agents.filter((a) => a.id !== agent.id && a.state !== "disabled");
	const { permissions, memory, runtime } = agent.config;
	const toolPolicy = {
		policyVersion: agent.configVersion,
		allow: permissions.tools_allow,
		requireHumanApproval: permissions.tools_require_human_approval,
		deny: permissions.tools_deny,
	};

	const candidate = {
		schemaVersion: 1,
		runId: sources.runId,
		agent: {
			agentId: agent.id,
			displayName: agent.displayName,
			mattermostUsername: agent.config.mattermost.username,
			rolePrompt: agent.rolePrompt,
			configVersion: agent.configVersion,
		},
		organization: {
			organizationId: organization.organization.id,
			globalGoal: organization.organization.global_goal,
			constitution: sources.constitution,
			rules: organization.organization.rules,
			limits: organization.organization.default_limits,
			directory: others.map((a) => ({ agentId: a.id, displayName: a.displayName, summary: "" })),
		},
		trigger: sources.trigger,
		durableState: {
			previousRunId: sources.previousRun?.id ?? null,
			previousSummary: sources.previousRun?.summary ?? null,
			resolvedWaits: sources.resolvedWaits,
		},
		channels,
		threadContext: null,
		memories: [],
		pendingInbox: sources.pendingInbox,
		workspace: null,
		toolPolicy,
		outputSchema: modelOutputJsonSchema(),
		deadline: new Date(now.getTime() + runtime.timeout_seconds * 1000).toISOString(),
	};
	const parsed = AgentTurnInputSchema.safeParse(candidate);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return {
			ok: false,
			reason: `turn input is invalid at '${first?.path.join(".") ?? ""}': ${first?.message ?? ""}`,
		};
	}

	const addressableAgents: Record<AgentId, MattermostId[]> = {};
	for (const other of others) {
		addressableAgents[other.id] = resolveChannels(
			other.config.mattermost.allowed_channels,
			sources.channelIds,
		).map((c) => c.channelId);
	}
	return {
		ok: true,
		context: {
			input: parsed.data,
			authority: {
				runId: sources.runId,
				agentId: agent.id,
				allowedChannelIds: channels.map((c) => c.channelId),
				registeredAgentIds: sources.agents.map((a) => a.id),
				addressableAgents,
				writableMemoryNamespaces: [memory.private_namespace, ...memory.shared_namespaces],
				attachableArtifactIds: [],
				toolPolicy,
			},
		},
	};
}
