import {
	type AgentId,
	type GatewayEvent,
	isReservedEventType,
	type Uuid,
	type WaitCondition,
} from "@agent-gateway/contracts";
import { eventTargets, GATEWAY_SOURCE, mattermostPost } from "@agent-gateway/events";

/** An active wait as the router sees it. */
export type ActiveWait = Readonly<{
	id: Uuid;
	agentId: AgentId;
	condition: WaitCondition;
	/** Clamped timeout; the condition's own `timeoutAt` is what the agent asked for. */
	timeoutAt: Date;
}>;

/**
 * True when `event` satisfies every condition of `wait`: type, correlation, sender, target
 * and expiry. An agent's own post never satisfies its wait.
 */
export function waitMatches(wait: ActiveWait, event: GatewayEvent, now: Date): boolean {
	const { condition } = wait;
	if (event.type !== condition.eventType || event.correlationid !== condition.correlationId) {
		return false;
	}
	if (wait.timeoutAt.getTime() <= now.getTime()) {
		return false;
	}
	// Approvals, timers and lifecycle events count only when the Gateway itself emitted them.
	if (isReservedEventType(event.type) && !isGatewayEmitted(event)) {
		return false;
	}
	const post = mattermostPost(event);
	const namesSender =
		condition.expectedSenderAgentIds.length > 0 || condition.expectedSenderUserIds.length > 0;
	if (post === null) {
		// Waits on Mattermost types always name a sender, so an untyped post never matches; an
		// event without structured targets never satisfies a required target.
		return !namesSender && condition.requireTargetAgentId === null;
	}
	if (post.sender_agent_id === wait.agentId) {
		return false;
	}
	// A user id names a human: webhooks, plugins and bots posting under that account (recorded
	// as internal-untrusted) are not that human's answer.
	const senderMatches =
		(post.sender_agent_id !== null &&
			condition.expectedSenderAgentIds.includes(post.sender_agent_id)) ||
		(event.trustlevel === "human-trusted" &&
			condition.expectedSenderUserIds.includes(post.user_id));
	if (namesSender && !senderMatches) {
		return false;
	}
	return (
		condition.requireTargetAgentId === null ||
		eventTargets(event).includes(condition.requireTargetAgentId)
	);
}

export function isGatewayEmitted(event: GatewayEvent): boolean {
	return event.source === GATEWAY_SOURCE && event.trustlevel === "system-trusted";
}

/** Longest a wait may last, whatever the agent asked for. */
export const MAX_WAIT_SECONDS = 7 * 24 * 3600;
/** Shortest wait; a timeout in the past still gives the other side a moment. */
export const MIN_WAIT_SECONDS = 60;

/** Clamps a requested timeout into `[now + MIN_WAIT_SECONDS, now + MAX_WAIT_SECONDS]`. */
export function clampWaitTimeout(requested: Date, now: Date): Date {
	const min = now.getTime() + MIN_WAIT_SECONDS * 1000;
	const max = now.getTime() + MAX_WAIT_SECONDS * 1000;
	return new Date(Math.min(max, Math.max(min, requested.getTime())));
}
