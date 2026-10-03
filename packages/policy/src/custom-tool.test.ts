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
			includeBodyPreview: true,
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

	it("rejects a number that overflows to Infinity, even with no declared bounds", () => {
		// `retries` declares bounds (0-5); a bare, unbounded number parameter would otherwise let
		// this straight through — `urgent` is boolean, so build a one-off definition with an
		// unbounded number parameter instead of smuggling this through an existing typed field.
		const unboundedNumber = definition({
			parameters: [{ name: "amount", slot: "query", slotName: "amount", type: "number" }],
			secretSlots: [],
			idempotency: null,
			method: "GET",
		});
		const overflowing = "1".repeat(400);
		const issues = customToolParamIssues(unboundedNumber, [{ name: "amount", value: overflowing }]);
		expect(issues).toEqual(["parameter 'amount' must be a finite number"]);
	});

	it("refuses control characters (CR/LF, NUL) in a header or query value", () => {
		const withStringSlots = definition({
			parameters: [
				{
					name: "label",
					slot: "query",
					slotName: "label",
					type: "string",
					minLength: 1,
					maxLength: 50,
				},
				{
					name: "note",
					slot: "header",
					slotName: "x-note",
					type: "string",
					minLength: 1,
					maxLength: 50,
				},
			],
			secretSlots: [],
			idempotency: null,
			method: "GET",
		});
		for (const bad of ["a\r\nX-Injected: 1", "a\u0000b", "a\nb"]) {
			expect(
				customToolParamIssues(withStringSlots, [
					{ name: "label", value: bad },
					{ name: "note", value: "fine" },
				])[0],
			).toMatch(/control characters/);
			expect(
				customToolParamIssues(withStringSlots, [
					{ name: "label", value: "fine" },
					{ name: "note", value: bad },
				])[0],
			).toMatch(/control characters/);
		}
	});

	it("refuses a non-Latin-1 character in a header value, but allows it in a query value", () => {
		const withStringSlots = definition({
			parameters: [
				{
					name: "label",
					slot: "query",
					slotName: "label",
					type: "string",
					minLength: 1,
					maxLength: 50,
				},
				{
					name: "note",
					slot: "header",
					slotName: "x-note",
					type: "string",
					minLength: 1,
					maxLength: 50,
				},
			],
			secretSlots: [],
			idempotency: null,
			method: "GET",
		});
		// 'λ' (U+03BB) is outside Latin-1 (which ends at U+00FF) — unlike an accented Latin letter
		// such as 'é', which Latin-1 already covers and so must stay allowed in a header too.
		expect(
			customToolParamIssues(withStringSlots, [
				{ name: "label", value: "aλb" },
				{ name: "note", value: "fine" },
			]),
		).toEqual([]);
		expect(
			customToolParamIssues(withStringSlots, [
				{ name: "label", value: "fine" },
				{ name: "note", value: "aλb" },
			])[0],
		).toMatch(/Latin-1/);
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

	it("resolves a path placeholder by the declaring parameter's name, not its own slot name", () => {
		// The path template's placeholder is `{ticket_ref}` (the path parameter's `slotName`); the
		// model fills it in by the parameter's own `name`, `id` — the two differ on purpose here.
		const slotNameDiffers = definition({
			pathTemplate: "/tickets/{ticket_ref}",
			parameters: [
				{
					name: "id",
					slot: "path",
					slotName: "ticket_ref",
					type: "string",
					minLength: 1,
					maxLength: 50,
				},
			],
			secretSlots: [],
			idempotency: null,
			method: "GET",
		});
		const resolved = resolveCustomHttpRequest(slotNameDiffers, [{ name: "id", value: "123" }]);
		expect(resolved.path).toBe("/tickets/123");
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
