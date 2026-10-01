import { describe, expect, it } from "vitest";
import {
	SYSTEM_STATUS_LIMITS,
	type SystemStatusAgent,
	SystemStatusAgentSchema,
	SystemStatusAlertSchema,
	SystemStatusMaintenanceSchema,
	type SystemStatusRun,
	type SystemStatusRuntime,
	SystemStatusRuntimeSchema,
	SystemStatusSchema,
} from "./system-status.ts";
import { agentTurnInput, issuePaths, RUN_ID, systemStatus } from "./test-fixtures.ts";
import { AgentTurnInputSchema } from "./turn.ts";

const NOW = "2026-09-24T14:00:00Z";

const baseAgent: SystemStatusAgent = {
	agentId: "operator",
	state: "idle",
	enabled: true,
	stateSince: NOW,
	runtimeAdapter: "codex",
	model: null,
	activeRuns: [],
	lastRun: null,
	activeWaits: 0,
	nextWaitTimeoutAt: null,
	pendingInbox: 0,
	tokensToday: 0,
	costTodayUsd: 0,
};

const baseRuntime: SystemStatusRuntime = {
	adapter: "codex",
	available: true,
	versions: [],
	changedAt: NOW,
};

const baseRun: SystemStatusRun = {
	runId: RUN_ID,
	status: "running",
	attempt: 1,
	maxAttempts: 3,
	triggerType: "mattermost.agent.mentioned",
	queuedAt: NOW,
	startedAt: null,
};

describe("SystemStatus", () => {
	it("accepts an empty snapshot", () => {
		expect(issuePaths(SystemStatusSchema, systemStatus())).toEqual([]);
	});

	it("rejects unknown fields, at the top level and nested inside a list", () => {
		expect(issuePaths(SystemStatusSchema, { ...systemStatus(), message: "hi" })).toEqual([""]);
		expect(
			issuePaths(SystemStatusSchema, { ...systemStatus(), agents: [{ ...baseAgent, note: "x" }] }),
		).toEqual(["agents.0"]);
	});

	it("carries no free-text fields: an alert key or maintenance task cannot hold prose", () => {
		expect(
			SystemStatusAlertSchema.safeParse({ key: "the queue backed up for an hour", firedAt: NOW })
				.success,
		).toBe(false);
		expect(
			SystemStatusMaintenanceSchema.safeParse({
				task: "nightly retention sweep",
				lastSuccessAt: null,
			}).success,
		).toBe(false);
	});

	it("accepts a legitimate model name and runtime version a restrictive token charset would reject", () => {
		expect(
			issuePaths(SystemStatusAgentSchema, { ...baseAgent, model: "gpt-4.1 mini (preview)+beta" }),
		).toEqual([]);
		expect(
			issuePaths(SystemStatusRuntimeSchema, {
				...baseRuntime,
				versions: ["2.4.0 (build 17)+abc", "codex-cli 0.9.0"],
			}),
		).toEqual([]);
	});

	it("bounds every list at its documented limit", () => {
		const agents = Array.from({ length: SYSTEM_STATUS_LIMITS.agents + 1 }, (_, n) => ({
			...baseAgent,
			agentId: `agent-${n}`,
		}));
		expect(issuePaths(SystemStatusSchema, { ...systemStatus(), agents })).toEqual(["agents"]);

		const runtimes = Array.from({ length: SYSTEM_STATUS_LIMITS.runtimes + 1 }, () => baseRuntime);
		expect(issuePaths(SystemStatusSchema, { ...systemStatus(), runtimes })).toEqual(["runtimes"]);

		const queues = Array.from({ length: SYSTEM_STATUS_LIMITS.queues + 1 }, (_, n) => ({
			queue: `agent.run.codex.${n}`,
			waiting: 0,
			active: 0,
			oldestWaitingSeconds: null,
		}));
		expect(issuePaths(SystemStatusSchema, { ...systemStatus(), queues })).toEqual(["queues"]);

		const alerts = Array.from({ length: SYSTEM_STATUS_LIMITS.alerts + 1 }, (_, n) => ({
			key: `alert-${n}`,
			firedAt: NOW,
		}));
		expect(issuePaths(SystemStatusSchema, { ...systemStatus(), alerts })).toEqual(["alerts"]);

		const maintenance = Array.from({ length: SYSTEM_STATUS_LIMITS.maintenance + 1 }, (_, n) => ({
			task: `task-${n}`,
			lastSuccessAt: null,
		}));
		expect(issuePaths(SystemStatusSchema, { ...systemStatus(), maintenance })).toEqual([
			"maintenance",
		]);

		const activeRuns = Array.from({ length: 9 }, () => baseRun);
		expect(issuePaths(SystemStatusAgentSchema, { ...baseAgent, activeRuns })).toEqual([
			"activeRuns",
		]);
	});
});

describe("AgentTurnInput carrying a populated system status", () => {
	it("accepts version 2 with a full snapshot", () => {
		const status = systemStatus({
			agents: [{ ...baseAgent, activeRuns: [baseRun] }],
			runtimes: [baseRuntime],
			queues: [{ queue: "agent.run.codex", waiting: 1, active: 1, oldestWaitingSeconds: 5 }],
			alerts: [{ key: "dlq.agent.run.codex", firedAt: NOW }],
			maintenance: [{ task: "retention", lastSuccessAt: NOW }],
		});
		const input = agentTurnInput({ schemaVersion: 2, systemStatus: status });
		expect(issuePaths(AgentTurnInputSchema, input)).toEqual([]);
	});
});
