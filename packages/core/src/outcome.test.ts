import type { AgentTurnResult } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import {
	approvalActionHash,
	checkRunScope,
	renderPostMessage,
	riskLevelFor,
	runRetryDelaySeconds,
	runScope,
} from "./outcome.ts";
import { CHANNEL, postEvent, ROOT } from "./test-events.ts";
import { clampWaitTimeout, MAX_WAIT_SECONDS, MIN_WAIT_SECONDS } from "./waits.ts";

const summary = {
	assigned: "x",
	facts: [],
	decisions: [],
	done: [],
	remaining: [],
	waitingFor: [],
	risks: [],
};

function result(overrides: Partial<AgentTurnResult>): AgentTurnResult {
	return {
		schemaVersion: 1,
		runId: "0d7bc6f6-58a4-4a4b-8b7e-8b7c1f0d0a11",
		publicMessages: [],
		nextState: { kind: "idle" },
		publicSummary: summary,
		memoryProposals: [],
		artifacts: [],
		usage: null,
		session: null,
		...overrides,
	};
}

describe("run scope", () => {
	const scope = runScope([postEvent()]);

	it("allows replies in the run's threads and waits on its correlations", () => {
		const ok = result({
			publicMessages: [
				{
					channelId: CHANNEL,
					rootPostId: ROOT,
					markdown: "ok",
					targetAgentIds: [],
					attachments: [],
				},
				{
					channelId: CHANNEL,
					rootPostId: null,
					markdown: "new thread",
					targetAgentIds: [],
					attachments: [],
				},
			],
			nextState: {
				kind: "waiting",
				waits: [
					{
						eventType: "mattermost.thread.reply",
						correlationId: `thread:${ROOT}`,
						expectedSenderAgentIds: ["finance"],
						expectedSenderUserIds: [],
						requireTargetAgentId: null,
						timeoutAt: "2026-09-25T11:00:00.000Z",
					},
				],
			},
		});
		expect(checkRunScope(ok, scope)).toEqual([]);
	});

	it("rejects foreign threads and correlations", () => {
		const foreign = result({
			publicMessages: [
				{
					channelId: CHANNEL,
					rootPostId: "f0reign0000000000000000000",
					markdown: "x",
					targetAgentIds: [],
					attachments: [],
				},
			],
			nextState: {
				kind: "waiting",
				waits: [
					{
						eventType: "mattermost.thread.reply",
						correlationId: "thread:someone-else",
						expectedSenderAgentIds: ["finance"],
						expectedSenderUserIds: [],
						requireTargetAgentId: null,
						timeoutAt: "2026-09-25T11:00:00.000Z",
					},
				],
			},
		});
		expect(checkRunScope(foreign, scope).map((issue) => issue.path)).toEqual([
			"publicMessages.0.rootPostId",
			"nextState.waits.0.correlationId",
		]);
	});
});

describe("model waits", () => {
	it("may not wait on approvals directly", () => {
		const forged = result({
			nextState: {
				kind: "waiting",
				waits: [
					{
						eventType: "approval.granted",
						correlationId: `thread:${ROOT}`,
						expectedSenderAgentIds: [],
						expectedSenderUserIds: [],
						requireTargetAgentId: null,
						timeoutAt: "2026-09-25T11:00:00.000Z",
					},
				],
			},
		});
		expect(checkRunScope(forged, runScope([postEvent()])).map((i) => i.path)).toEqual([
			"nextState.waits.0.eventType",
		]);
	});
});

describe("approvals", () => {
	it("hashes parameters independently of their order", () => {
		const a = approvalActionHash({
			actionType: "finance.payment.create",
			actionParams: [
				{ name: "amount", value: "10.00" },
				{ name: "currency", value: "EUR" },
			],
			actionSummary: "one",
		});
		const b = approvalActionHash({
			actionType: "finance.payment.create",
			actionParams: [
				{ name: "currency", value: "EUR" },
				{ name: "amount", value: "10.00" },
			],
			actionSummary: "the summary is not part of the hash",
		});
		expect(a).toBe(b);
		expect(a).toMatch(/^[a-f0-9]{64}$/);
		const changed = approvalActionHash({
			actionType: "finance.payment.create",
			actionParams: [{ name: "amount", value: "10.01" }],
			actionSummary: "one",
		});
		expect(changed).not.toBe(a);
	});

	it("assigns risk from policy", () => {
		expect(riskLevelFor("finance.payment.create")).toBe("critical");
		expect(riskLevelFor("mail.send")).toBe("high");
		expect(riskLevelFor("repository.write")).toBe("medium");
	});
});

describe("helpers", () => {
	it("prepends visible mentions of the targets", () => {
		expect(
			renderPostMessage({
				channelId: CHANNEL,
				rootPostId: null,
				markdown: "please check",
				targetAgentIds: ["finance", "research"],
				attachments: [],
			}),
		).toBe("@finance @research please check");
	});

	it("backs off exponentially with jitter and a cap", () => {
		expect(runRetryDelaySeconds(1, () => 1)).toBe(5);
		expect(runRetryDelaySeconds(2, () => 1)).toBe(10);
		expect(runRetryDelaySeconds(20, () => 1)).toBe(300);
		expect(runRetryDelaySeconds(2, () => 0)).toBe(5);
	});

	it("clamps wait timeouts", () => {
		const now = new Date("2026-09-25T10:00:00.000Z");
		expect(clampWaitTimeout(new Date(0), now).getTime()).toBe(
			now.getTime() + MIN_WAIT_SECONDS * 1000,
		);
		expect(clampWaitTimeout(new Date("2030-01-01T00:00:00Z"), now).getTime()).toBe(
			now.getTime() + MAX_WAIT_SECONDS * 1000,
		);
		const inside = new Date(now.getTime() + 3600_000);
		expect(clampWaitTimeout(inside, now)).toEqual(inside);
	});
});
