import type { AgentId, MattermostId, MemoryNamespace, Uuid } from "./common.ts";
import { mentionedNames, toolPatternCovers } from "./common.ts";
import type { AgentTurnResult, ToolPolicySnapshot } from "./turn.ts";

/** Posting a public message is a tool action like any other and needs policy permission. */
const POST_TOOL = "mattermost.post";

/** What the controller knows about the run when it receives a result. */
export type TurnAuthorityContext = Readonly<{
	runId: Uuid;
	agentId: AgentId;
	/** Channels the agent may post to. */
	allowedChannelIds: Readonly<MattermostId[]>;
	/** Every agent registered in the organization, addressable or not. */
	registeredAgentIds: Readonly<AgentId[]>;
	/** Agents this agent may address, each with the channels that agent is allowed in. */
	addressableAgents: Readonly<Record<AgentId, Readonly<MattermostId[]>>>;
	/** Namespaces the agent may propose memory writes to. */
	writableMemoryNamespaces: Readonly<MemoryNamespace[]>;
	/**
	 * Humans a wait may name as expected senders: people who posted in the run's threads, and the
	 * organization's owners. A wait on anyone else would never be answered by that thread.
	 */
	waitableUserIds: Readonly<MattermostId[]>;
	/**
	 * Existing artifacts the agent may attach to a post: shared or public ones it can see.
	 * The controller never lists private artifacts here.
	 */
	attachableArtifactIds: Readonly<Uuid[]>;
	/** The agent's effective tool policy for this run. */
	toolPolicy: ToolPolicySnapshot;
}>;

export type TurnAuthorityIssue = Readonly<{
	path: string;
	message: string;
}>;

/**
 * Checks a schema-valid result against the authority of the run that produced it.
 * A result with any issue must not be persisted or posted. Pure; performs no IO.
 */
export function checkTurnResultAuthority(
	result: AgentTurnResult,
	context: TurnAuthorityContext,
): Readonly<TurnAuthorityIssue[]> {
	const issues: TurnAuthorityIssue[] = [];
	const push = (path: string, message: string) => issues.push({ path, message });

	if (result.runId !== context.runId) {
		push("runId", `result belongs to run '${result.runId}', expected '${context.runId}'`);
	}

	/** Returns the channels of an addressable agent, or null after reporting why it is not. */
	const addressableChannels = (path: string, agentId: AgentId) => {
		if (agentId === context.agentId) {
			push(path, `agent '${agentId}' cannot address itself`);
			return null;
		}
		// Own keys only: an id such as "constructor" must not resolve to Object.prototype.
		const channels = Object.hasOwn(context.addressableAgents, agentId)
			? context.addressableAgents[agentId]
			: undefined;
		if (channels === undefined) {
			push(path, `agent '${agentId}' is not addressable by '${context.agentId}'`);
			return null;
		}
		return channels;
	};

	const knownAgentIds = new Set<string>([
		context.agentId,
		...context.registeredAgentIds,
		...Object.keys(context.addressableAgents),
	]);
	const producedArtifacts = new Map(
		result.artifacts.map((artifact) => [artifact.key, artifact.visibility]),
	);

	// Direct posting needs an allow entry and no deny or approval entry: the authority check
	// fails closed even if a policy snapshot that bypassed schema validation has overlaps.
	const { allow, requireHumanApproval, deny } = context.toolPolicy;
	const covers = (patterns: Readonly<string[]>) =>
		patterns.some((pattern) => toolPatternCovers(pattern, POST_TOOL));
	const mayPost = covers(allow) && !covers(deny) && !covers(requireHumanApproval);

	result.publicMessages.forEach((message, i) => {
		if (!mayPost) {
			push(`publicMessages.${i}`, `'${context.agentId}' is not allowed to use ${POST_TOOL}`);
		}
		if (!context.allowedChannelIds.includes(message.channelId)) {
			push(`publicMessages.${i}.channelId`, `channel '${message.channelId}' is not allowed`);
		}
		// Visible mentions must agree with routing: the Gateway adds @mentions for targets itself.
		for (const name of mentionedNames(message.markdown)) {
			if (knownAgentIds.has(name) && !message.targetAgentIds.includes(name)) {
				push(
					`publicMessages.${i}.markdown`,
					`'@${name}' is mentioned in the text but missing from targetAgentIds`,
				);
			}
		}
		message.targetAgentIds.forEach((target, j) => {
			const path = `publicMessages.${i}.targetAgentIds.${j}`;
			const channels = addressableChannels(path, target);
			if (channels !== null && !channels.includes(message.channelId)) {
				push(path, `agent '${target}' is not a member of channel '${message.channelId}'`);
			}
		});
		message.attachments.forEach((attachment, j) => {
			const path = `publicMessages.${i}.attachments.${j}`;
			if (attachment.artifactKey !== null) {
				const visibility = producedArtifacts.get(attachment.artifactKey);
				if (visibility === undefined) {
					push(path, `artifact key '${attachment.artifactKey}' is not produced in this turn`);
				} else if (visibility === "private") {
					push(path, `private artifact '${attachment.artifactKey}' cannot be posted`);
				}
			}
			if (
				attachment.artifactId !== null &&
				!context.attachableArtifactIds.includes(attachment.artifactId)
			) {
				push(path, `artifact '${attachment.artifactId}' is not attachable`);
			}
		});
	});

	const { nextState } = result;
	if (nextState.kind === "waiting") {
		nextState.waits.forEach((wait, i) => {
			wait.expectedSenderAgentIds.forEach((sender, j) => {
				addressableChannels(`nextState.waits.${i}.expectedSenderAgentIds.${j}`, sender);
			});
			wait.expectedSenderUserIds.forEach((userId, j) => {
				if (!context.waitableUserIds.includes(userId)) {
					push(
						`nextState.waits.${i}.expectedSenderUserIds.${j}`,
						`user '${userId}' is neither a participant of the run's threads nor an owner`,
					);
				}
			});
			if (wait.requireTargetAgentId !== null && wait.requireTargetAgentId !== context.agentId) {
				push(
					`nextState.waits.${i}.requireTargetAgentId`,
					`a wait can only require messages addressed to '${context.agentId}'`,
				);
			}
		});
	}

	if (nextState.kind === "needs_human") {
		const { actionType } = nextState.approvalRequest;
		const { deny, requireHumanApproval } = context.toolPolicy;
		const denied = deny.some((pattern) => toolPatternCovers(pattern, actionType));
		const approvable = requireHumanApproval.some((pattern) =>
			toolPatternCovers(pattern, actionType),
		);
		if (denied || !approvable) {
			push(
				"nextState.approvalRequest.actionType",
				`'${context.agentId}' may not request approval for '${actionType}'`,
			);
		}
	}

	result.memoryProposals.forEach((proposal, i) => {
		if (!context.writableMemoryNamespaces.includes(proposal.namespace)) {
			push(
				`memoryProposals.${i}.namespace`,
				`namespace '${proposal.namespace}' is not writable by '${context.agentId}'`,
			);
		}
	});

	return issues;
}
