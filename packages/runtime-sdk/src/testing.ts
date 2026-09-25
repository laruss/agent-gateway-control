import {
	type AgentTurnInput,
	AgentTurnInputSchema,
	modelOutputJsonSchema,
} from "@agent-gateway/contracts";

/** Fixed ids of the contract fixture; any 26-character Mattermost ids would do. */
export const CONTRACT_IDS = {
	channel: "c0ntractchanne1000000000aa",
	post: "c0ntractp0st00000000000000",
	user: "c0ntractuser00000000000000",
} as const;

export type ContractInputInit = Readonly<{
	runId: string;
	/** Text of the triggering post, e.g. the scenario instruction for the runtime. */
	message: string;
	/** Milliseconds from now until the deadline. */
	deadlineMs: number;
	now?: Date;
}>;

/**
 * A complete, valid turn input for adapter tests: agent `developer` in one channel, woken by a
 * human post that mentions it; `finance` is addressable in the same channel.
 */
export function contractTurnInput(init: ContractInputInit): AgentTurnInput {
	const now = init.now ?? new Date();
	return AgentTurnInputSchema.parse({
		schemaVersion: 1,
		runId: init.runId,
		agent: {
			agentId: "developer",
			displayName: "Developer",
			mattermostUsername: "developer",
			rolePrompt: "You are the developer agent of a test organization.",
			configVersion: "contract",
		},
		organization: {
			organizationId: "contract-org",
			globalGoal: "Pass the runtime contract suite.",
			constitution: "Follow the output schema exactly.",
			rules: [],
			limits: {
				max_agent_hops: 8,
				max_turns_per_cascade: 20,
				max_runs_per_agent_per_hour: 30,
				default_run_timeout_seconds: 60,
			},
			directory: [{ agentId: "finance", displayName: "Finance", summary: "Budget questions." }],
		},
		trigger: {
			specversion: "1.0",
			id: `contract:${init.runId}`,
			source: "mattermost://contract",
			type: "mattermost.agent.mentioned",
			time: now.toISOString(),
			datacontenttype: "application/json",
			correlationid: `thread:${CONTRACT_IDS.post}`,
			causationid: null,
			trustlevel: "human-trusted",
			hop: 0,
			data: {
				post_id: CONTRACT_IDS.post,
				root_id: null,
				channel_id: CONTRACT_IDS.channel,
				user_id: CONTRACT_IDS.user,
				sender_agent_id: null,
				target_agent_ids: ["developer"],
				message: init.message,
			},
		},
		durableState: { previousRunId: null, previousSummary: null, resolvedWaits: [] },
		channels: [{ channelId: CONTRACT_IDS.channel, name: "engineering" }],
		threadContext: null,
		memories: [],
		pendingInbox: [],
		workspace: null,
		toolPolicy: {
			policyVersion: "contract",
			allow: ["mattermost.post"],
			requireHumanApproval: ["finance.payment.create"],
			deny: ["deploy.*"],
		},
		outputSchema: modelOutputJsonSchema(),
		deadline: new Date(now.getTime() + init.deadlineMs).toISOString(),
	});
}
