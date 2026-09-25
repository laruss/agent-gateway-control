import type { OrganizationLimits, WakeRule } from "@agent-gateway/contracts";
import type { AgentState } from "@agent-gateway/db";
import { GATEWAY_SOURCE } from "@agent-gateway/events";
import { describe, expect, it } from "vitest";
import { type LoopStats, MAX_PAIRWISE_MESSAGES, type RoutingAgent, routeEvent } from "./routing.ts";
import { postEvent, ROOT } from "./test-events.ts";
import { type ActiveWait, waitMatches } from "./waits.ts";

const NOW = new Date("2026-09-25T10:00:00.000Z");
const LIMITS: OrganizationLimits = {
	max_agent_hops: 4,
	max_turns_per_cascade: 3,
	max_runs_per_agent_per_hour: 5,
	default_run_timeout_seconds: 60,
};
const NO_STATS: LoopStats = {
	cascadeWakes: 0,
	runsLastHour: {},
	duplicateContent: 0,
	pairwiseMessages: {},
};

function agent(id: string, state: AgentState = "idle", wakeRules: WakeRule[] = []): RoutingAgent {
	return { id, state, wakeRules };
}

const AGENTS = [agent("developer"), agent("finance"), agent("research")];

function wait(overrides: Partial<ActiveWait> = {}): ActiveWait {
	return {
		id: "7f6c1b3e-2f55-4f7c-9c38-0b1f8a2b9d01",
		agentId: "developer",
		timeoutAt: new Date(NOW.getTime() + 60_000),
		condition: {
			eventType: "mattermost.thread.reply",
			correlationId: `thread:${ROOT}`,
			expectedSenderAgentIds: ["finance"],
			expectedSenderUserIds: [],
			requireTargetAgentId: "developer",
			timeoutAt: new Date(NOW.getTime() + 60_000).toISOString(),
		},
		...overrides,
	};
}

const route = (event = postEvent(), overrides: Partial<Parameters<typeof routeEvent>[0]> = {}) =>
	routeEvent({
		event,
		agents: AGENTS,
		waits: [],
		limits: LIMITS,
		stats: NO_STATS,
		now: NOW,
		...overrides,
	});

describe("routing", () => {
	it("wakes exactly the structured targets", () => {
		const routes = route(postEvent({ rootId: null, targets: ["developer"] }));
		expect(routes).toEqual([
			{ agentId: "developer", decision: "wake", reason: "target", waitId: null, priority: 5 },
		]);
	});

	it("stores an untargeted post without waking anybody", () => {
		expect(route(postEvent({ rootId: null }))).toEqual([]);
	});

	it("wakes untargeted subscriptions by event type only", () => {
		const agents = [
			agent("mail-follower", "idle", [{ event_type: "google.gmail.message.received" }]),
			agent("developer", "idle", [
				{ event_type: "mattermost.agent.mentioned", target_agent_id: "developer" },
			]),
		];
		const event = {
			...postEvent({ rootId: null }),
			type: "google.gmail.message.received" as const,
			trustlevel: "external-untrusted" as const,
			data: {},
		};
		expect(route(event, { agents }).map((r) => [r.agentId, r.reason])).toEqual([
			["mail-follower", "subscription"],
		]);
	});

	it("fans out to several targets, spending the cascade budget per run", () => {
		const event = postEvent({ rootId: null, targets: ["developer", "finance", "research"] });
		const routes = route(event, { stats: { ...NO_STATS, cascadeWakes: 1 } });
		expect(routes.map((r) => [r.agentId, r.decision, r.reason])).toEqual([
			["developer", "wake", "target"],
			["finance", "wake", "target"],
			["research", "blocked", "cascade_limit"],
		]);
	});

	it("matches an exact wait before normal wake-ups", () => {
		const reply = postEvent({ sender: "finance", targets: ["developer"] });
		const routes = route(reply, { waits: [wait()] });
		expect(routes).toEqual([
			{
				agentId: "developer",
				decision: "wait-match",
				reason: "wait_matched",
				waitId: wait().id,
				priority: 10,
			},
		]);
	});

	it("gives the last cascade budget to an exact wait match before a plain target", () => {
		// "zeta" waits for finance; the reply also targets "alpha". One wake-up is left.
		const agents = [agent("alpha"), agent("finance"), agent("zeta")];
		const reply = postEvent({ sender: "finance", targets: ["alpha", "zeta"] });
		const zetaWait = wait({
			agentId: "zeta",
			condition: { ...wait().condition, requireTargetAgentId: "zeta" },
		});
		const routes = route(reply, {
			agents,
			waits: [zetaWait],
			stats: { ...NO_STATS, cascadeWakes: LIMITS.max_turns_per_cascade - 1 },
		});
		expect(routes.map((r) => [r.agentId, r.decision])).toEqual([
			["zeta", "wait-match"],
			["alpha", "blocked"],
		]);
	});

	it("never wakes a subscription on Gateway-reserved events", () => {
		const agents = [agent("watcher", "idle", [{ event_type: "agent.wait.timeout" }])];
		const timeout = {
			...postEvent(),
			source: GATEWAY_SOURCE,
			type: "agent.wait.timeout" as const,
			trustlevel: "system-trusted" as const,
			data: { agent_id: "developer", wait_id: wait().id },
		};
		expect(route(timeout, { agents })).toEqual([]);
	});

	it("does not match a wait from the wrong sender, thread or target", () => {
		const wrongSender = postEvent({ sender: "developer", targets: ["developer"] });
		const wrongThread = postEvent({
			sender: "finance",
			targets: ["developer"],
			correlation: "thread:other",
		});
		const noTarget = postEvent({ sender: "finance", targets: [] });
		for (const event of [wrongThread, noTarget]) {
			expect(route(event, { waits: [wait()] }).some((r) => r.decision === "wait-match")).toBe(
				false,
			);
		}
		expect(route(wrongSender, { waits: [wait()] }).map((r) => r.reason)).toEqual(["self_post"]);
	});

	it("does not match an expired wait", () => {
		const reply = postEvent({ sender: "finance", targets: ["developer"] });
		const expired = wait({ timeoutAt: new Date(NOW.getTime() - 1) });
		expect(route(reply, { waits: [expired] })[0]?.decision).toBe("wake");
	});

	it("resolves a wait timeout event only for its own wait and agent", () => {
		const timeout = {
			...postEvent(),
			source: GATEWAY_SOURCE,
			type: "agent.wait.timeout" as const,
			trustlevel: "system-trusted" as const,
			data: { agent_id: "developer", wait_id: wait().id },
		};
		expect(route(timeout, { waits: [wait()] }).map((r) => r.reason)).toEqual(["wait_timeout"]);
		const external = { ...timeout, source: "webhook://anyone" };
		expect(route(external, { waits: [wait()] })).toEqual([]);
		const forged = { ...timeout, data: { agent_id: "finance", wait_id: wait().id } };
		expect(route(forged, { waits: [wait()] })).toEqual([]);
	});

	it("applies loop guards to agent-authored posts", () => {
		const fromAgent = (hop = 1) => postEvent({ sender: "developer", targets: ["finance"], hop });
		expect(route(fromAgent(5))[0]?.reason).toBe("hop_limit");
		expect(route(fromAgent(), { stats: { ...NO_STATS, duplicateContent: 1 } })[0]?.reason).toBe(
			"duplicate_payload",
		);
		expect(
			route(fromAgent(), {
				stats: { ...NO_STATS, pairwiseMessages: { finance: MAX_PAIRWISE_MESSAGES } },
			})[0]?.reason,
		).toBe("pairwise_limit");
		expect(
			route(fromAgent(), { stats: { ...NO_STATS, runsLastHour: { finance: 5 } } })[0]?.reason,
		).toBe("rate_limit");
	});

	it("lets a human repeat themselves", () => {
		const human = postEvent({ rootId: null, targets: ["developer"] });
		expect(route(human, { stats: { ...NO_STATS, duplicateContent: 3 } })[0]?.decision).toBe("wake");
	});

	it("ignores self-posts and disabled agents, and never routes control events", () => {
		expect(route(postEvent({ sender: "finance", targets: ["finance"] }))[0]?.reason).toBe(
			"self_post",
		);
		const disabled = [agent("developer", "disabled")];
		expect(
			route(postEvent({ rootId: null, targets: ["developer"] }), { agents: disabled })[0]?.reason,
		).toBe("agent_disabled");
		const control = {
			...postEvent(),
			type: "gateway.control.pause" as const,
			trustlevel: "system-trusted" as const,
			data: {},
		};
		expect(route(control)).toEqual([]);
	});

	it("ignores targets that are not registered agents", () => {
		expect(route(postEvent({ rootId: null, targets: ["ghost"] }))).toEqual([]);
	});
});

describe("wait matching of other event types", () => {
	it("never satisfies a required target without structured targets", () => {
		const gmailWait = wait({
			condition: {
				...wait().condition,
				eventType: "google.gmail.message.received",
				expectedSenderAgentIds: [],
				requireTargetAgentId: "developer",
			},
		});
		const gmail = {
			...postEvent({ correlation: `thread:${ROOT}` }),
			type: "google.gmail.message.received" as const,
			trustlevel: "external-untrusted" as const,
			data: {},
		};
		expect(waitMatches(gmailWait, gmail, NOW)).toBe(false);
		const open = wait({ condition: { ...gmailWait.condition, requireTargetAgentId: null } });
		expect(waitMatches(open, gmail, NOW)).toBe(true);
	});

	it("matches reserved events only when the Gateway emitted them", () => {
		const approvalWait = wait({
			condition: {
				...wait().condition,
				eventType: "approval.granted",
				expectedSenderAgentIds: [],
				requireTargetAgentId: null,
			},
		});
		const granted = {
			...postEvent({ correlation: `thread:${ROOT}` }),
			type: "approval.granted" as const,
			trustlevel: "system-trusted" as const,
			data: {},
		};
		expect(waitMatches(approvalWait, granted, NOW)).toBe(false);
		expect(waitMatches(approvalWait, { ...granted, source: GATEWAY_SOURCE }, NOW)).toBe(true);
	});
});
