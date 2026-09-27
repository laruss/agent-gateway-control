import type { ActionParam } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import { actionParamIssues } from "./action-specs.ts";
import {
	approvalActionHash,
	approvalCode,
	normalizeApprovalCode,
	parseApprovalCommand,
} from "./approval-code.ts";
import { budgetHold, meteredUsage, type UsageTotals, utcDay } from "./budget.ts";
import { approvedActionIssues, evaluateTool, riskLevelFor } from "./tools.ts";

const finance = {
	allow: ["mattermost.post", "finance.read"],
	requireHumanApproval: ["finance.payment.create", "finance.subscription.create"],
	deny: ["deploy.*", "mail.*"],
};
const developer = {
	allow: ["mattermost.post", "workspace.write"],
	requireHumanApproval: ["publish.release"],
	deny: ["finance.*", "deploy.*"],
};
const subjects = {
	finance: { agentId: "finance", financeAgentId: "finance" },
	developer: { agentId: "developer", financeAgentId: "finance" },
};

const params = (values: Readonly<Record<string, string>>): ActionParam[] =>
	Object.entries(values).map(([name, value]) => ({ name, value }));

const payment = {
	amount: "120.00",
	currency: "EUR",
	recipient: "DE89370400440532013000",
	purpose: "Domain renewal",
	recurring: "false",
};

describe("evaluateTool", () => {
	it("denies finance tools to every agent but the finance agent, whatever its lists say", () => {
		expect(evaluateTool(developer, subjects.developer, "finance.payment.create").decision).toBe(
			"deny",
		);
		const permissive = { allow: [], requireHumanApproval: ["finance.*"], deny: [] };
		expect(evaluateTool(permissive, subjects.developer, "finance.payment.create")).toEqual({
			decision: "deny",
			reason: "only 'finance' may use finance tools",
		});
	});

	it("gates every finance write behind a human, also for the finance agent", () => {
		expect(evaluateTool(finance, subjects.finance, "finance.payment.create").decision).toBe(
			"require_approval",
		);
		expect(evaluateTool(finance, subjects.finance, "finance.read").decision).toBe("allow");
		const allowed = { allow: ["finance.payment.create"], requireHumanApproval: [], deny: [] };
		expect(evaluateTool(allowed, subjects.finance, "finance.payment.create").decision).toBe("deny");
	});

	it("lets deny win and denies what no list names", () => {
		expect(evaluateTool(finance, subjects.finance, "mail.send").decision).toBe("deny");
		expect(evaluateTool(finance, subjects.finance, "issue.create")).toEqual({
			decision: "deny",
			reason: "'issue.create' is not granted",
		});
		expect(evaluateTool(developer, subjects.developer, "publish.release").decision).toBe(
			"require_approval",
		);
	});

	it("assigns risk by policy", () => {
		expect(riskLevelFor("finance.payment.create")).toBe("critical");
		expect(riskLevelFor("publish.release")).toBe("high");
		expect(riskLevelFor("issue.create")).toBe("medium");
	});
});

describe("actionParamIssues", () => {
	it("accepts a complete payment in its canonical form", () => {
		expect(actionParamIssues("finance.payment.create", params(payment))).toEqual([]);
		expect(
			actionParamIssues(
				"finance.payment.create",
				params({ ...payment, amount: "12000", currency: "JPY" }),
			),
		).toEqual([]);
	});

	it.each([
		["a missing parameter", { ...payment, purpose: undefined }, "parameter 'purpose' is missing"],
		["an extra parameter", { ...payment, note: "x" }, "parameter 'note' is not part of"],
		["a negative amount", { ...payment, amount: "-5.00" }, "positive decimal"],
		["a zero amount", { ...payment, amount: "0.00" }, "positive decimal"],
		["an exponent", { ...payment, amount: "1e3" }, "positive decimal"],
		["a leading zero", { ...payment, amount: "012.00" }, "positive decimal"],
		["the wrong precision", { ...payment, amount: "120" }, "exactly 2 digits"],
		["an unknown currency", { ...payment, currency: "BTC" }, "currency must be one of"],
		["a prose recipient", { ...payment, recipient: "my landlord" }, "exact identifier"],
		["a recurring payment", { ...payment, recurring: "true" }, "finance.subscription.create"],
	])("refuses %s", (_, values, message) => {
		const defined = Object.fromEntries(
			Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
		);
		const issues = actionParamIssues("finance.payment.create", params(defined));
		expect(issues).toEqual([expect.stringContaining(message)]);
	});

	it("names the terms of a subscription", () => {
		const { recurring: _, ...base } = payment;
		const subscription = { ...base, interval: "month", first_payment_date: "2026-10-01" };
		expect(actionParamIssues("finance.subscription.create", params(subscription))).toEqual([]);
		expect(
			actionParamIssues(
				"finance.subscription.create",
				params({ ...subscription, first_payment_date: "2026-02-30" }),
			),
		).toEqual([expect.stringContaining("real calendar date")]);
	});

	it("refuses finance writes without a typed set, and leaves other actions free-form", () => {
		expect(actionParamIssues("finance.transfer.create", params(payment))).toEqual([
			expect.stringContaining("no typed parameter set"),
		]);
		expect(actionParamIssues("publish.release", params({ version: "1.2.3" }))).toEqual([]);
	});

	it("checks an approved action against policy and parameters together", () => {
		const action = { actionType: "finance.payment.create", actionParams: params(payment) };
		expect(approvedActionIssues(finance, subjects.finance, action)).toEqual([]);
		expect(approvedActionIssues(developer, subjects.developer, action)).toEqual([
			"'finance.payment.create' is denied by policy",
		]);
	});
});

describe("approval codes", () => {
	const request = {
		id: "0b6f0b7e-8a36-4a45-9d9c-2ad1f1c0a001",
		nonce: "n".repeat(48),
		immutableActionHash: "a".repeat(64),
	};

	it("derives a readable code bound to the request, its nonce and its hash", () => {
		const code = approvalCode(request);
		expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
		expect(approvalCode(request)).toBe(code);
		expect(approvalCode({ ...request, nonce: "m".repeat(48) })).not.toBe(code);
		expect(approvalCode({ ...request, immutableActionHash: "b".repeat(64) })).not.toBe(code);
	});

	it("hashes parameters independently of their order", () => {
		const a = params({ amount: "1.00", currency: "EUR" });
		expect(approvalActionHash({ actionType: "finance.payment.create", actionParams: a })).toBe(
			approvalActionHash({ actionType: "finance.payment.create", actionParams: [...a].reverse() }),
		);
		expect(approvalActionHash({ actionType: "finance.payment.create", actionParams: a })).not.toBe(
			approvalActionHash({
				actionType: "finance.payment.create",
				actionParams: params({ amount: "2.00", currency: "EUR" }),
			}),
		);
	});

	it("reads exactly one command per message", () => {
		expect(parseApprovalCommand("approve AB12-CD34-EF56")).toEqual({
			kind: "approve",
			code: "AB12-CD34-EF56",
		});
		expect(parseApprovalCommand("  Deny ab12cd34ef56 ")).toEqual({
			kind: "deny",
			code: "AB12-CD34-EF56",
		});
		expect(normalizeApprovalCode("ab12-cd34ef56")).toBe("AB12-CD34-EF56");
	});

	it.each([
		["no code", "approve"],
		["trailing prose", "approve AB12-CD34-EF56 please"],
		["a second line", "approve AB12-CD34-EF56\ndeny AB12-CD34-EF56"],
		["a short code", "approve AB12-CD34"],
		["markdown", "approve `AB12-CD34-EF56`"],
		["inline code around it", "`approve AB12-CD34-EF56`"],
		["a quote", "> approve AB12-CD34-EF56"],
	])("treats a command with %s as malformed", (_, message) => {
		expect(parseApprovalCommand(message)).toEqual({ kind: "malformed" });
	});

	it("ignores remarks that are no command at all", () => {
		expect(parseApprovalCommand("APPROVED")).toBeNull();
		expect(parseApprovalCommand("I approve of this")).toBeNull();
		expect(parseApprovalCommand("approved, thanks")).toBeNull();
	});
});

describe("budgets", () => {
	const none: UsageTotals = { costUsd: 0, tokens: 0, unmeteredAttempts: 0 };
	const budgets = {
		per_agent_daily: { cost_usd: 5 },
		global_daily: { tokens: 1000 },
		unmetered: "hold" as const,
	};

	it("normalizes usage without double-counting cached input", () => {
		expect(
			meteredUsage({
				inputTokens: 100,
				outputTokens: 20,
				cachedInputTokens: 80,
				costUsd: null,
				durationMs: 5,
				model: null,
			}),
		).toEqual({ costUsd: null, tokens: 120 });
		expect(meteredUsage(null)).toEqual({ costUsd: null, tokens: null });
	});

	it("holds an agent over its limit, and everyone over the global one", () => {
		expect(budgetHold(budgets, none, none)).toBeNull();
		expect(budgetHold(budgets, { ...none, costUsd: 5 }, none)).toEqual({
			scope: "agent",
			reason: "agent budget: cost 5.00 USD reached the daily limit of 5 USD",
		});
		expect(budgetHold(budgets, none, { ...none, tokens: 1000 })?.scope).toBe("global");
	});

	it("holds on unmetered usage unless the organization allows it", () => {
		const unmetered = { ...none, unmeteredAttempts: 1 };
		expect(budgetHold(budgets, unmetered, none)?.reason).toContain("reported no usage");
		expect(budgetHold({ ...budgets, unmetered: "allow" }, unmetered, none)).toBeNull();
		expect(budgetHold({ unmetered: "hold" }, unmetered, none)).toBeNull();
		expect(budgetHold(undefined, { ...none, costUsd: 1e9 }, none)).toBeNull();
	});

	it("books by UTC day", () => {
		expect(utcDay(new Date("2026-09-27T23:59:59+02:00"))).toBe("2026-09-27");
		expect(utcDay(new Date("2026-09-28T00:30:00+02:00"))).toBe("2026-09-27");
	});
});
