import type { AgentState } from "@agent-gateway/db";

/** Everything that can move a logical agent between states. */
export type AgentTransition =
	| "enable"
	/** Enabling an agent whose latest run failed keeps the failure until redrive. */
	| "enable_failed"
	| "disable"
	/** A run was created for the agent. */
	| "schedule"
	/** The worker picked the run up. */
	| "start"
	/** A retryable failure: the same run is queued for another attempt. */
	| "retry"
	| "complete_idle"
	| "complete_waiting"
	| "fail"
	| "pause"
	| "resume_idle"
	| "resume_waiting"
	/** A matched or timed-out wait resumes the agent with a new run. */
	| "wait_resolved"
	/** An operator re-runs the failed run. */
	| "redrive";

type TransitionTable = Readonly<Record<AgentState, Partial<Record<AgentTransition, AgentState>>>>;

/**
 * The agent state machine. A run's report can arrive before its `started` report, so the
 * outcomes of `running` are accepted in `queued` too.
 */
const TRANSITIONS: TransitionTable = {
	disabled: { enable: "idle", enable_failed: "failed" },
	idle: { schedule: "queued", pause: "paused", disable: "disabled" },
	queued: {
		start: "running",
		retry: "queued",
		complete_idle: "idle",
		complete_waiting: "waiting",
		fail: "failed",
		pause: "paused",
	},
	running: {
		retry: "queued",
		complete_idle: "idle",
		complete_waiting: "waiting",
		fail: "failed",
		pause: "paused",
	},
	waiting: { wait_resolved: "queued", pause: "paused", disable: "disabled" },
	// Only a redrive leaves FAILED; pausing would let resume clear the failure.
	failed: { redrive: "queued", disable: "disabled" },
	paused: { resume_idle: "idle", resume_waiting: "waiting", disable: "disabled" },
};

/** The state after `transition`, or null when the transition is not allowed. */
export function nextAgentState(state: AgentState, transition: AgentTransition): AgentState | null {
	return TRANSITIONS[state][transition] ?? null;
}

export class InvalidTransitionError extends Error {
	constructor(
		readonly agentId: string,
		readonly state: AgentState,
		readonly transition: AgentTransition,
	) {
		super(`agent '${agentId}' cannot '${transition}' from '${state}'`);
		this.name = "InvalidTransitionError";
	}
}

/** Like `nextAgentState`, but throws for a transition the state machine does not allow. */
export function requireTransition(
	agentId: string,
	state: AgentState,
	transition: AgentTransition,
): AgentState {
	const next = nextAgentState(state, transition);
	if (next === null) {
		throw new InvalidTransitionError(agentId, state, transition);
	}
	return next;
}
