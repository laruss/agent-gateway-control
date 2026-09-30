import {
	type AgentConfig,
	type AgentId,
	type AgentTurnInput,
	AgentTurnInputSchema,
	type GatewayEvent,
	type MattermostId,
	type MemoryItem,
	modelOutputJsonSchema,
	type OrganizationConfig,
	type ResolvedWait,
	type SystemStatus,
	type ThreadContext,
	type TurnAuthorityContext,
	toolPatternCovers,
	type Uuid,
	type WorkingSummary,
} from "@agent-gateway/contracts";
import type { AgentState } from "@agent-gateway/db";
import { agentChannelRefs, type ChannelAccess } from "./channel-access.ts";

/**
 * The largest turn input a run starts with, serialized. A neutral constant (no IO, no service
 * dependency): the scheduler enforces it when it builds a turn's input, and the system status
 * read model (ADR-023) reports it as the console's byte budget, without either importing the
 * other.
 */
export const MAX_TURN_INPUT_BYTES = 2 * 1024 * 1024;

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
	/** The channels agents may work in: configured (resolved by bootstrap) and granted. */
	access: ChannelAccess;
	trigger: GatewayEvent;
	pendingInbox: Readonly<GatewayEvent[]>;
	previousRun: Readonly<{ id: Uuid; summary: WorkingSummary | null }> | null;
	resolvedWaits: Readonly<ResolvedWait[]>;
	/** The turn's thread, assembled from stored events; null for turns outside a thread. */
	threadContext: ThreadContext | null;
	/** Accepted memory of the agent's own namespaces. */
	memories: Readonly<MemoryItem[]>;
	/** Humans who posted in the run's threads, and the owners. */
	waitableUserIds: Readonly<MattermostId[]>;
	/**
	 * The Gateway's own operational snapshot (ADR-023), collected by the caller only for an agent
	 * whose permissions grant `observe_system`; null for every other agent. This function does no
	 * IO itself, so it only places what it is given: a status handed to a non-observing agent, or
	 * an observing agent handed none, is refused rather than silently reconciled.
	 */
	systemStatus: SystemStatus | null;
	now: Date;
}>;

export type TurnContext = Readonly<{
	input: AgentTurnInput;
	authority: TurnAuthorityContext;
}>;

export type TurnContextResult =
	| Readonly<{ ok: true; context: TurnContext }>
	| Readonly<{ ok: false; reason: string }>;

/**
 * Assembles the turn input and the authority its result is checked against. Both come from the
 * same sources at the same moment, so the runtime is told exactly what it is allowed to do.
 * Workspaces are not assembled yet (null). Pure.
 */
export function buildTurnContext(sources: TurnContextSources): TurnContextResult {
	const { agent, organization, now } = sources;
	const channels = agentChannelRefs(agent, sources.access);
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

	// Namespace authorization alone would still let an agent propose memory writes; an explicit
	// `memory.write` deny (a concrete pattern or a covering wildcard like `memory.*`) leaves it no
	// writable namespace at all, private or shared, so the existing namespace check in
	// `checkTurnResultAuthority` rejects every proposal rather than needing its own tool check.
	const memoryWriteDenied = permissions.tools_deny.some((pattern) =>
		toolPatternCovers(pattern, "memory.write"),
	);
	const writableSharedNamespaces = memoryWriteDenied ? [] : memory.shared_namespaces;

	// The status is placed, never collected: the caller only queries it for an agent whose
	// permissions actually grant observation (ADR-023). A mismatch here is the caller's bug, not
	// silently reconciled into whichever version fits what it happened to pass.
	const observesSystem = permissions.observe_system === true;
	let systemStatus: SystemStatus | undefined;
	if (observesSystem) {
		if (sources.systemStatus === null) {
			return { ok: false, reason: `'${agent.id}' observes the system but no status was supplied` };
		}
		systemStatus = sources.systemStatus;
	} else if (sources.systemStatus !== null) {
		return {
			ok: false,
			reason: `'${agent.id}' does not observe the system but a status was supplied`,
		};
	}

	const candidate = {
		schemaVersion: observesSystem ? 2 : 1,
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
		threadContext: sources.threadContext,
		memories: sources.memories,
		memoryNamespaces: { private: memory.private_namespace, shared: writableSharedNamespaces },
		pendingInbox: sources.pendingInbox,
		workspace: null,
		toolPolicy,
		outputSchema: modelOutputJsonSchema(),
		deadline: new Date(now.getTime() + runtime.timeout_seconds * 1000).toISOString(),
		systemStatus,
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
		addressableAgents[other.id] = agentChannelRefs(other, sources.access).map((c) => c.channelId);
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
				writableMemoryNamespaces: memoryWriteDenied
					? []
					: [memory.private_namespace, ...memory.shared_namespaces],
				attachableArtifactIds: [],
				waitableUserIds: [...new Set(sources.waitableUserIds)].sort(),
				toolPolicy,
			},
		},
	};
}
