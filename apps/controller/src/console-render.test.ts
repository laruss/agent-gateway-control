import type { ConsoleStatus } from "@agent-gateway/core";
import { describe, expect, it } from "vitest";
import { escapeHtml, renderConsolePage } from "./console-render.ts";
import type { ConsoleSnapshot } from "./console-status.ts";

// Every payload here contains at least one character `escapeHtml` changes, so a correctly
// escaped page can never contain the raw payload string; a bare "javascript:..." string (no
// HTML metacharacters at all) would trivially "pass" that check without proving anything, so it
// is exercised separately below, by proving the page never emits a link or a URL attribute.
const XSS_PAYLOADS = [
	"<script>alert(1)</script>",
	"\"'><img src=x onerror=alert(1)>",
	"<svg/onload=alert(1)>",
] as const;

function baseStatus(overrides: Partial<ConsoleStatus> = {}): ConsoleStatus {
	return {
		system: {
			asOf: "2031-01-01T00:00:00.000Z",
			killSwitch: false,
			agents: [],
			omittedAgents: 0,
			runtimes: [
				{
					adapter: "mock",
					available: true,
					versions: ["1.0.0"],
					changedAt: "2031-01-01T00:00:00.000Z",
				},
			],
			queues: [{ queue: "dlq.agent.run.mock", waiting: 1, active: 0, oldestWaitingSeconds: 42 }],
			outbox: { pending: 1, dead: 2 },
			approvalsPending: 3,
			toolActionsUnknown: 4,
			alerts: [],
			maintenance: [{ task: "retention", lastSuccessAt: null }],
		},
		agents: [],
		recentRuns: [],
		alerts: [],
		...overrides,
	};
}

function agentWithPayload(payload: string): ConsoleStatus["agents"][number] {
	return {
		status: {
			agentId: "director",
			state: "running",
			enabled: true,
			stateSince: "2031-01-01T00:00:00.000Z",
			runtimeAdapter: "mock",
			model: payload,
			activeRuns: [],
			lastRun: null,
			activeWaits: 0,
			nextWaitTimeoutAt: null,
			pendingInbox: 0,
			tokensToday: 10,
			costTodayUsd: 0.1,
		},
		displayName: payload,
		current: {
			runId: "00000000-0000-0000-0000-000000000000",
			status: "running",
			attempt: 1,
			maxAttempts: 3,
			queuedAt: "2031-01-01T00:00:00.000Z",
			startedAt: null,
			deadlineAt: "2031-01-01T01:00:00.000Z",
			triggerType: "mattermost.agent.mentioned",
			channel: payload,
			threadRootId: null,
		},
		waits: [{ eventType: payload, timeoutAt: "2031-01-01T02:00:00.000Z" }],
		context: null,
		maxInputTokens7d: null,
		session: null,
		budget: null,
	};
}

describe("escapeHtml", () => {
	it("escapes the five HTML-significant characters", () => {
		expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
	});
});

describe("renderConsolePage", () => {
	it("never emits an XSS payload unescaped, anywhere it can appear", () => {
		for (const payload of XSS_PAYLOADS) {
			const status = baseStatus({
				agents: [agentWithPayload(payload)],
				alerts: [{ key: "alert-key", message: payload, firedAt: "2031-01-01T00:00:00.000Z" }],
			});
			const html = renderConsolePage({ state: "ok", asOf: status.system.asOf, status });
			expect(html).not.toContain(payload);
			expect(html).toContain(escapeHtml(payload));
		}
	});

	it("never emits a link or a script tag: no href, no <script", () => {
		const status = baseStatus({ agents: [agentWithPayload("javascript:alert(1)")] });
		const html = renderConsolePage({ state: "ok", asOf: status.system.asOf, status });
		expect(html).not.toMatch(/<a\s/i);
		expect(html).not.toMatch(/href\s*=/i);
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/<\s*\/\s*head\s*>[\s\S]*<script/i);
	});

	it("renders the kill switch, alerts, budgets and context measurements without a context-window percentage", () => {
		const status = baseStatus({
			agents: [
				{
					...agentWithPayload("director"),
					budget: { cost_usd: 5, tokens: 1000 },
					context: {
						runId: "00000000-0000-0000-0000-000000000000",
						inputBytes: 1024,
						inputLimitBytes: 2 * 1024 * 1024,
						rootChars: 10,
						rootLimitChars: 4000,
						threadPosts: 2,
						omittedPosts: 1,
						recentRepliesChars: 200,
						recentRepliesLimitChars: 24_000,
						summaryChars: 50,
						summaryLimitChars: 8000,
						memoryItems: 3,
						memoryChars: 300,
						memoryLimitChars: 20_000,
						pendingEvents: 0,
						inputTokens: 777,
						cachedInputTokens: 100,
						outputTokens: 111,
						model: "test-model",
					},
					maxInputTokens7d: 900,
				},
			],
			alerts: [
				{ key: "disk-space", message: "low disk space", firedAt: "2031-01-01T00:00:00.000Z" },
			],
		});
		const withKillSwitch = { ...status, system: { ...status.system, killSwitch: true } };
		const html = renderConsolePage({
			state: "ok",
			asOf: status.system.asOf,
			status: withKillSwitch,
		});

		expect(html).toContain("Kill switch: ON");
		expect(html).toContain("low disk space");
		expect(html).toContain("10 / 1,000 tokens today");
		expect(html).toContain("$0.10 / $5.00 today");
		expect(html).toContain("1,024 / 2,097,152");
		expect(html).toContain("200 / 24,000");
		expect(html).toContain("10 / 4,000");
		expect(html).toContain("50 / 8,000");
		expect(html).toContain("300 / 20,000");
		expect(html).toContain("777");
		expect(html).toContain("100");
		expect(html).toContain("111");
		expect(html).toContain("900");
		// No context-window fill percentage anywhere (CSS widths like "100%" are unrelated and
		// expected): only the measurement block's own labeled "value / limit" pairs.
		expect(html).not.toMatch(/context window/i);
		expect(html).not.toMatch(/\d+(\.\d+)?\s?%\s*(full|used|of context)/i);
	});

	it("shows a stale banner with the last successful time and the failure reason", () => {
		const status = baseStatus();
		const snapshot: ConsoleSnapshot = {
			state: "stale",
			asOf: "2031-01-01T00:00:00.000Z",
			status,
			error: "connection timed out",
		};
		const html = renderConsolePage(snapshot);
		expect(html).toContain("2031-01-01T00:00:00.000Z");
		expect(html).toContain("connection timed out");
	});

	it("renders an unavailable page on a cold failure, with no dashboard content", () => {
		const snapshot: ConsoleSnapshot = { state: "unavailable", error: "no database connection" };
		const html = renderConsolePage(snapshot);
		expect(html).toContain("unavailable");
		expect(html).toContain("no database connection");
		expect(html).not.toContain("Recent runs");
	});

	it("has no external assets: no remote script, stylesheet or image source", () => {
		const status = baseStatus();
		const html = renderConsolePage({ state: "ok", asOf: status.system.asOf, status });
		expect(html).not.toMatch(/<script[^>]*\bsrc=/i);
		expect(html).not.toMatch(/<link[^>]*\bhref=/i);
		expect(html).not.toMatch(/https?:\/\//i);
	});
});
