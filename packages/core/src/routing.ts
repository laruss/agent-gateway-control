import type {
	AgentId,
	GatewayEvent,
	OrganizationLimits,
	Uuid,
	WakeRule,
} from "@agent-gateway/contracts";
import {
	isRecordOnlyEventType,
	isReservedEventType,
	WaitTimeoutDataSchema,
} from "@agent-gateway/contracts";
import type { AgentState, RouteDecision } from "@agent-gateway/db";
import { eventSenderAgentId, eventTargets, mattermostPost } from "@agent-gateway/events";
import { type ActiveWait, isGatewayEmitted, waitMatches } from "./waits.ts";

export type RoutingAgent = Readonly<{
	id: AgentId;
	state: AgentState;
	wakeRules: Readonly<WakeRule[]>;
	/** Resolved ids of the agent's allowed channels: a post elsewhere never reaches it. */
	channelIds: ReadonlySet<string>;
}>;

/** Counters the loop guards need, computed by the caller for the event's cascade. */
export type LoopStats = Readonly<{
	/** Wake-ups (wake or wait-match routes) already granted in the event's correlation. */
	cascadeWakes: number;
	/** Runs per agent created in the last hour. */
	runsLastHour: Readonly<Record<AgentId, number>>;
	/** Earlier events with the same normalized content inside the duplicate window. */
	duplicateContent: number;
	/** Wake-ups the sender agent caused per recipient inside the pairwise window. */
	pairwiseMessages: Readonly<Record<AgentId, number>>;
	/** Wake-ups already granted in the event's thread (correlation) inside the loop window. */
	threadWakes: number;
}>;

export type RoutingInput = Readonly<{
	event: GatewayEvent;
	agents: Readonly<RoutingAgent[]>;
	waits: Readonly<ActiveWait[]>;
	limits: OrganizationLimits;
	stats: LoopStats;
	now: Date;
}>;

export type RouteReason =
	| "wait_matched"
	| "wait_timeout"
	| "wait_lost"
	| "target"
	| "subscription"
	| "self_post"
	| "channel_not_allowed"
	| "agent_disabled"
	| "hop_limit"
	| "cascade_limit"
	| "rate_limit"
	| "thread_rate_limit"
	| "duplicate_payload"
	| "pairwise_limit";

export type Route = Readonly<{
	agentId: AgentId;
	decision: RouteDecision;
	reason: RouteReason;
	/** The wait resolved by a `wait-match`. */
	waitId: Uuid | null;
	/** Inbox priority for `wake` and `wait-match`. */
	priority: number;
}>;

/** Messages one agent may send another inside the pairwise window. */
export const MAX_PAIRWISE_MESSAGES = 12;
/**
 * Wake-ups one thread may grant inside the loop window, whoever asks. The cascade budget resets
 * with every human instruction; this bounds a thread's activity across cascades.
 */
export const MAX_THREAD_WAKES_PER_WINDOW = 30;

const PRIORITY = { wait: 10, target: 5, subscription: 0 } as const;

type Candidate = Readonly<{
	agentId: AgentId;
	reason: "wait_matched" | "wait_timeout" | "target" | "subscription";
	waitId: Uuid | null;
}>;

function waitCandidates(input: RoutingInput): Candidate[] {
	const { event, waits, now } = input;
	if (event.type === "agent.wait.timeout") {
		if (!isGatewayEmitted(event)) {
			return [];
		}
		const data = WaitTimeoutDataSchema.safeParse(event.data);
		const wait = data.success ? waits.find((w) => w.id === data.data.wait_id) : undefined;
		return wait !== undefined && data.success && wait.agentId === data.data.agent_id
			? [{ agentId: wait.agentId, reason: "wait_timeout", waitId: wait.id }]
			: [];
	}
	const byAgent = new Map<AgentId, ActiveWait>();
	for (const wait of [...waits].sort((a, b) => a.timeoutAt.getTime() - b.timeoutAt.getTime())) {
		if (!byAgent.has(wait.agentId) && waitMatches(wait, event, now)) {
			byAgent.set(wait.agentId, wait);
		}
	}
	return [...byAgent.values()].map((wait) => ({
		agentId: wait.agentId,
		reason: "wait_matched",
		waitId: wait.id,
	}));
}

/**
 * An untargeted wake rule for the event's type. Reserved (Gateway-emitted) types never wake by
 * subscription: waits resume their own agent, and a subscription must not add lock or loop
 * paths to them.
 */
function subscribes(agent: RoutingAgent, event: GatewayEvent): boolean {
	return (
		!isReservedEventType(event.type) &&
		// Mattermost posts wake only their addressees, who are checked against the channel.
		!event.type.startsWith("mattermost.") &&
		agent.wakeRules.some(
			(rule) => rule.target_agent_id === undefined && rule.event_type === event.type,
		)
	);
}

function wakeCandidates(input: RoutingInput, taken: ReadonlySet<AgentId>): Candidate[] {
	const { event, agents } = input;
	const targets = eventTargets(event);
	const candidates: Candidate[] = [];
	for (const agent of agents) {
		if (taken.has(agent.id)) {
			continue;
		}
		if (targets.includes(agent.id)) {
			candidates.push({ agentId: agent.id, reason: "target", waitId: null });
		} else if (subscribes(agent, event)) {
			candidates.push({ agentId: agent.id, reason: "subscription", waitId: null });
		}
	}
	return candidates;
}

/**
 * The inbox priority the event would have as an ordinary wake-up of `agent` (targeted or
 * subscribed), or null. Used when the agent's wait was resolved by a concurrent event first.
 */
export function wakePriority(agent: RoutingAgent, event: GatewayEvent): number | null {
	if (eventTargets(event).includes(agent.id)) {
		return PRIORITY.target;
	}
	return subscribes(agent, event) ? PRIORITY.subscription : null;
}

/**
 * Deterministic routing of one event: exact wait matches first, then structured targets, then
 * untargeted subscriptions; everything else is stored only. Every candidate passes the loop
 * guards; fan-out spends the cascade budget one run at a time. Pure.
 */
export function routeEvent(input: RoutingInput): Readonly<Route[]> {
	const { event, agents, limits, stats } = input;
	if (event.type.startsWith("gateway.control.") || isRecordOnlyEventType(event.type)) {
		return [];
	}
	const known = new Map(agents.map((agent) => [agent.id, agent]));
	const waitRoutes = waitCandidates(input).filter((c) => known.has(c.agentId));
	// Tiers keep their priority for the cascade budget (exact wait matches, then targets, then
	// subscriptions); inside a tier the order is by agent id, so routing stays deterministic.
	const byId = (a: Candidate, b: Candidate) =>
		a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
	const wakes = wakeCandidates(input, new Set(waitRoutes.map((c) => c.agentId)));
	const candidates = [
		...[...waitRoutes].sort(byId),
		...wakes.filter((c) => c.reason === "target").sort(byId),
		...wakes.filter((c) => c.reason === "subscription").sort(byId),
	];

	const sender = eventSenderAgentId(event);
	let cascadeWakes = stats.cascadeWakes;
	let threadWakes = stats.threadWakes;
	const routes: Route[] = [];
	for (const candidate of candidates) {
		const isWait = candidate.waitId !== null;
		const decision: RouteDecision = isWait ? "wait-match" : "wake";
		const priority = isWait
			? PRIORITY.wait
			: candidate.reason === "target"
				? PRIORITY.target
				: PRIORITY.subscription;
		const route = (d: RouteDecision, reason: RouteReason): Route => ({
			agentId: candidate.agentId,
			decision: d,
			reason,
			waitId: candidate.waitId,
			priority,
		});
		const agent = known.get(candidate.agentId);
		if (agent === undefined) {
			continue;
		}
		const post = mattermostPost(event);
		if (post !== null && !agent.channelIds.has(post.channel_id)) {
			// Checked here, in the ingest transaction, against the configuration being applied:
			// a permission revoked a moment ago no longer routes.
			routes.push(route("ignore", "channel_not_allowed"));
		} else if (sender === agent.id) {
			routes.push(route("ignore", "self_post"));
		} else if (agent.state === "disabled") {
			routes.push(route("ignore", "agent_disabled"));
		} else if (candidate.reason === "wait_timeout") {
			// A timeout resolves a wait the agent already holds; blocking it would leave the agent
			// waiting forever. At most one per wait, so it cannot amplify a loop.
			cascadeWakes += 1;
			threadWakes += 1;
			routes.push(route(decision, candidate.reason));
		} else if (event.hop > limits.max_agent_hops) {
			routes.push(route("blocked", "hop_limit"));
		} else if (cascadeWakes >= limits.max_turns_per_cascade) {
			routes.push(route("blocked", "cascade_limit"));
		} else if ((stats.runsLastHour[agent.id] ?? 0) >= limits.max_runs_per_agent_per_hour) {
			routes.push(route("blocked", "rate_limit"));
		} else if (threadWakes >= MAX_THREAD_WAKES_PER_WINDOW) {
			routes.push(route("blocked", "thread_rate_limit"));
		} else if (sender !== null && stats.duplicateContent > 0) {
			routes.push(route("blocked", "duplicate_payload"));
		} else if (
			sender !== null &&
			(stats.pairwiseMessages[agent.id] ?? 0) >= MAX_PAIRWISE_MESSAGES
		) {
			routes.push(route("blocked", "pairwise_limit"));
		} else {
			cascadeWakes += 1;
			threadWakes += 1;
			routes.push(route(decision, candidate.reason));
		}
	}
	return routes;
}
