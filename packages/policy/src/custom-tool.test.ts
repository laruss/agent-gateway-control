import type { ActionParam, CustomHttpsDefinition } from "@agent-gateway/contracts";
import { CUSTOM_DEFINITION_VERSION_PARAM } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import {
	customDefinitionVersionIssues,
	customRequestSummary,
	customToolParamIssues,
	resolveCustomHttpRequest,
} from "./custom-tool.ts";

function definition(overrides: Partial<CustomHttpsDefinition> = {}): CustomHttpsDefinition {
	return {
		host: "api.example.com",
		pathTemplate: "/tickets/{id}",
		method: "POST",
		parameters: [
			{ name: "id", slot: "path", slotName: "id", type: "string", minLength: 1, maxLength: 50 },
			{
				name: "priority",
				slot: "query",
				slotName: "priority",
				type: "enum",
				values: ["low", "high"],
			},
			{
				name: "retries",
				slot: "header",
				slotName: "x-retries",
				type: "number",
				minimum: 0,
				maximum: 5,
			},
			{ name: "urgent", slot: "body", slotName: "urgent", type: "boolean" },
			{
				name: "summary",
				slot: "body",
				slotName: "summary",
				type: "string",
				minLength: 1,
				maxLength: 200,
			},
		],
		secretSlots: [{ alias: "api_key", slot: "header", slotName: "x-api-key" }],
		idempotency: { headerName: "idempotency-key" },
		responseLimits: {
			maxResponseBytes: 65_536,
			allowedContentTypes: ["application/json"],
			timeoutMs: 5000,
		},
		...overrides,
	};
}

const validParams: Readonly<ActionParam[]> = [
	{ name: "id", value: "123" },
	{ name: "priority", value: "high" },
	{ name: "retries", value: "3" },
	{ name: "urgent", value: "true" },
	{ name: "summary", value: "The printer is on fire" },
];

describe("customToolParamIssues", () => {
	it("accepts a fully valid, typed set of parameters", () => {
		expect(customToolParamIssues(definition(), validParams)).toEqual([]);
	});

	it("accepts the controller's own synthetic version parameter without flagging it", () => {
		const withVersion = [...validParams, { name: CUSTOM_DEFINITION_VERSION_PARAM, value: "1" }];
		expect(customToolParamIssues(definition(), withVersion)).toEqual([]);
	});

	it("reports a missing parameter", () => {
		const missing = validParams.filter((p) => p.name !== "summary");
		expect(customToolParamIssues(definition(), missing)).toEqual([
			"parameter 'summary' is missing",
		]);
	});

	it("reports a parameter the definition does not declare", () => {
		const extra = [...validParams, { name: "unexpected", value: "x" }];
		expect(customToolParamIssues(definition(), extra)).toEqual([
			"parameter 'unexpected' is not part of this tool",
		]);
	});

	it("refuses a path traversal attempt in a path-slot value", () => {
		for (const bad of ["..", ".", "", "a/b", "a\\b", "..%2Fb"]) {
			const tampered = validParams.map((p) => (p.name === "id" ? { ...p, value: bad } : p));
			const issues = customToolParamIssues(definition(), tampered);
			// `..%2Fb` is literally the percent-escape characters, not a decoded slash — only the
			// first four (containing a real '/' or '\', or being empty/'.'/'..') must be refused.
			if (bad === "..%2Fb") {
				expect(issues).toEqual([]);
			} else {
				expect(issues.length).toBeGreaterThan(0);
				expect(issues[0]).toContain("path value");
			}
		}
	});

	it("enforces string length bounds", () => {
		const tooLong = validParams.map((p) =>
			p.name === "summary" ? { ...p, value: "x".repeat(300) } : p,
		);
		expect(customToolParamIssues(definition(), tooLong)[0]).toMatch(/between 1 and 200 characters/);
	});

	it("enforces number range bounds and rejects a non-numeric value", () => {
		const tooHigh = validParams.map((p) => (p.name === "retries" ? { ...p, value: "6" } : p));
		expect(customToolParamIssues(definition(), tooHigh)[0]).toMatch(/at most 5/);
		const notANumber = validParams.map((p) => (p.name === "retries" ? { ...p, value: "abc" } : p));
		expect(customToolParamIssues(definition(), notANumber)[0]).toMatch(/must be a number/);
	});

	it("rejects a boolean value that is not exactly 'true' or 'false'", () => {
		const bad = validParams.map((p) => (p.name === "urgent" ? { ...p, value: "yes" } : p));
		expect(customToolParamIssues(definition(), bad)[0]).toMatch(/'true' or 'false'/);
	});

	it("rejects an enum value outside its declared set", () => {
		const bad = validParams.map((p) => (p.name === "priority" ? { ...p, value: "medium" } : p));
		expect(customToolParamIssues(definition(), bad)[0]).toMatch(/must be one of low, high/);
	});
});

describe("resolveCustomHttpRequest", () => {
	it("resolves every parameter into its declared slot, percent-encoding the path", () => {
		const resolved = resolveCustomHttpRequest(definition(), validParams);
		expect(resolved.path).toBe("/tickets/123");
		expect(resolved.query).toEqual([{ name: "priority", value: "high" }]);
		expect(resolved.headers).toEqual([{ name: "x-retries", value: 3 }]);
		expect(resolved.bodyFields).toEqual({ urgent: true, summary: "The printer is on fire" });
		expect(resolved.secretHeaderNames).toEqual(["x-api-key"]);
		expect(resolved.secretQueryNames).toEqual([]);
		expect(resolved.secretBodyFieldNames).toEqual([]);
	});

	it("percent-encodes a path value so it can never introduce a path segment of its own", () => {
		const tampered = validParams.map((p) => (p.name === "id" ? { ...p, value: "a/b" } : p));
		const resolved = resolveCustomHttpRequest(definition(), tampered);
		expect(resolved.path).toBe("/tickets/a%2Fb");
		expect(resolved.path).not.toContain("/tickets/a/b");
	});

	it("ignores the synthetic version parameter when resolving", () => {
		const withVersion = [...validParams, { name: CUSTOM_DEFINITION_VERSION_PARAM, value: "7" }];
		expect(resolveCustomHttpRequest(definition(), withVersion)).toEqual(
			resolveCustomHttpRequest(definition(), validParams),
		);
	});
});

describe("customRequestSummary", () => {
	it("never includes a secret value, only the slot name it will fill", () => {
		const resolved = resolveCustomHttpRequest(definition(), validParams);
		const summary = customRequestSummary(resolved);
		expect(summary).toContain("x-api-key(secret)");
		expect(summary).not.toContain("x-api-key=");
		expect(summary).toContain("POST https://api.example.com/tickets/123?priority=high");
	});
});

describe("customDefinitionVersionIssues", () => {
	it("is empty when the pinned version still matches the current one", () => {
		expect(customDefinitionVersionIssues(3, 3)).toEqual([]);
	});

	it("refuses a request pinned to a version the entry has moved on from", () => {
		const issues = customDefinitionVersionIssues(1, 2);
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatch(/edited \(version 1 -> 2\)/);
	});
});
