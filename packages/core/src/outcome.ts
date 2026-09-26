import type {
	AgentTurnResult,
	ApprovalRequestDraft,
	GatewayEvent,
	PublicMessage,
	RiskLevel,
	ToolPattern,
} from "@agent-gateway/contracts";
import { toolPatternCovers } from "@agent-gateway/contracts";
import { canonicalHash, mattermostPost } from "@agent-gateway/events";

export type OutcomeIssue = Readonly<{ path: string; message: string }>;

/**
 * What the run's own events establish: the correlations it may wait on and the thread roots
 * it may reply to. A result may not reach into a conversation the run was never part of.
 */
/** A thread the run may reply in: its channel and the cascade its events belong to. */
export type ThreadScope = Readonly<{ channelId: string; correlationId: string }>;

export type RunScope = Readonly<{
	correlationIds: ReadonlySet<string>;
	/** Thread root post id to the thread's channel and correlation. */
	threadRoots: ReadonlyMap<string, ThreadScope>;
	/** Highest hop among the run's events: what the run's own posts build on. */
	maxHop: number;
}>;

export function runScope(events: Readonly<GatewayEvent[]>): RunScope {
	const correlationIds = new Set<string>();
	const threadRoots = new Map<string, ThreadScope>();
	let maxHop = 0;
	for (const event of events) {
		correlationIds.add(event.correlationid);
		maxHop = Math.max(maxHop, event.hop);
		const post = mattermostPost(event);
		if (post !== null) {
			threadRoots.set(post.root_id ?? post.post_id, {
				channelId: post.channel_id,
				correlationId: event.correlationid,
			});
		}
	}
	return { correlationIds, threadRoots, maxHop };
}

/** Checks waits and replies against the run's scope; complements the authority check. */
export function checkRunScope(result: AgentTurnResult, scope: RunScope): Readonly<OutcomeIssue[]> {
	const issues: OutcomeIssue[] = [];
	result.publicMessages.forEach((message, i) => {
		if (message.rootPostId === null) {
			return;
		}
		const channelId = scope.threadRoots.get(message.rootPostId)?.channelId;
		if (channelId === undefined) {
			issues.push({
				path: `publicMessages.${i}.rootPostId`,
				message: `thread '${message.rootPostId}' is not part of this run`,
			});
		} else if (channelId !== message.channelId) {
			issues.push({
				path: `publicMessages.${i}.channelId`,
				message: `thread '${message.rootPostId}' is in another channel`,
			});
		}
	});
	if (result.nextState.kind === "waiting") {
		result.nextState.waits.forEach((wait, i) => {
			if (wait.eventType.startsWith("approval.")) {
				issues.push({
					path: `nextState.waits.${i}.eventType`,
					message: "approval waits are created by the Gateway; request approval with needs_human",
				});
			}
			if (!scope.correlationIds.has(wait.correlationId)) {
				issues.push({
					path: `nextState.waits.${i}.correlationId`,
					message: `correlation '${wait.correlationId}' is not part of this run`,
				});
			}
		});
	}
	return issues;
}

/**
 * Immutable hash of an approval: action type and parameters, canonical JSON with parameters
 * sorted by name. Execution later recomputes it and must get the same value.
 */
export function approvalActionHash(draft: ApprovalRequestDraft): string {
	const params = [...draft.actionParams].sort((a, b) => (a.name < b.name ? -1 : 1));
	return canonicalHash({
		actionType: draft.actionType,
		actionParams: params.map((p) => ({ name: p.name, value: p.value })),
	});
}

const RISK_RULES: Readonly<{ pattern: ToolPattern; risk: RiskLevel }[]> = [
	{ pattern: "finance.*", risk: "critical" },
	{ pattern: "deploy.*", risk: "high" },
	{ pattern: "mail.*", risk: "high" },
];

/** Risk comes from policy, never from the model. */
export function riskLevelFor(actionType: string): RiskLevel {
	return RISK_RULES.find((rule) => toolPatternCovers(rule.pattern, actionType))?.risk ?? "medium";
}

/** The post text: visible mentions of the targets first, then the model's Markdown. */
export function renderPostMessage(message: PublicMessage): string {
	const mentions = message.targetAgentIds.map((id) => `@${id}`).join(" ");
	return mentions === "" ? message.markdown : `${mentions} ${message.markdown}`;
}

/** Controller-side retry delay of a run: exponential with full jitter, 5 s to 5 min. */
export function runRetryDelaySeconds(attempt: number, random: () => number): number {
	const base = Math.min(300, 5 * 2 ** Math.max(0, attempt - 1));
	return Math.max(1, Math.round(base * (0.5 + random() / 2)));
}
