import { describe, expect, it } from "vitest";
import {
	type CustomHttpsDefinition,
	CustomToolResponseLimitsSchema,
	customHttpMethodWrites,
	customHttpsDefinitionProblems,
	customToolActionType,
	customToolEntryId,
	pathTemplatePlaceholders,
	textTransform,
} from "./custom-tool.ts";

function definition(overrides: Partial<CustomHttpsDefinition> = {}): CustomHttpsDefinition {
	return {
		host: "api.example.com",
		pathTemplate: "/tickets/{id}",
		method: "POST",
		parameters: [
			{ name: "id", slot: "path", slotName: "id", type: "string", minLength: 1, maxLength: 50 },
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

describe("customHttpMethodWrites", () => {
	it("is false only for GET", () => {
		expect(customHttpMethodWrites("GET")).toBe(false);
		for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
			expect(customHttpMethodWrites(method)).toBe(true);
		}
	});
});

describe("pathTemplatePlaceholders", () => {
	it("extracts every {placeholder}, in order, duplicates included", () => {
		expect(pathTemplatePlaceholders("/a/{x}/b/{y}/{x}")).toEqual(["x", "y", "x"]);
		expect(pathTemplatePlaceholders("/a/b")).toEqual([]);
	});
});

describe("customHttpsDefinitionProblems", () => {
	it("accepts a well-formed definition", () => {
		expect(customHttpsDefinitionProblems(definition())).toEqual([]);
	});

	it("refuses a path parameter with no matching placeholder", () => {
		const bad = definition({
			pathTemplate: "/tickets",
			parameters: definition().parameters,
		});
		const problems = customHttpsDefinitionProblems(bad);
		expect(problems.some((p) => p.includes("has no '{id}' placeholder"))).toBe(true);
	});

	it("refuses a placeholder with no matching path parameter", () => {
		const bad = definition({ pathTemplate: "/tickets/{id}/{missing}" });
		const problems = customHttpsDefinitionProblems(bad);
		expect(problems.some((p) => p.includes("'{missing}' has no matching path parameter"))).toBe(
			true,
		);
	});

	it("refuses two sources targeting the same slot", () => {
		const bad = definition({
			parameters: [
				...definition().parameters,
				{
					name: "summary2",
					slot: "body",
					slotName: "summary",
					type: "string",
					minLength: 1,
					maxLength: 10,
				},
			],
		});
		const problems = customHttpsDefinitionProblems(bad);
		expect(problems.some((p) => p.includes("both target body 'summary'"))).toBe(true);
	});

	it("refuses a secret mapped into the path", () => {
		const bad = definition({
			secretSlots: [{ alias: "api_key", slot: "path", slotName: "id" }],
		});
		const problems = customHttpsDefinitionProblems(bad);
		expect(problems.some((p) => p.includes("a path segment must not come from a secret"))).toBe(
			true,
		);
	});

	it("refuses a reserved header name", () => {
		const bad = definition({
			parameters: [
				...definition().parameters,
				{
					name: "length",
					slot: "header",
					slotName: "content-length",
					type: "string",
					minLength: 1,
					maxLength: 10,
				},
			],
		});
		const problems = customHttpsDefinitionProblems(bad);
		expect(problems.some((p) => p.includes("is a reserved header"))).toBe(true);
	});

	it("refuses a write with no idempotency header, and a GET with one", () => {
		const writeWithoutIdempotency = definition({ idempotency: null });
		expect(
			customHttpsDefinitionProblems(writeWithoutIdempotency).some((p) =>
				p.includes("must declare an idempotency header"),
			),
		).toBe(true);
		const getWithIdempotency = definition({
			method: "GET",
			pathTemplate: "/tickets/{id}",
			parameters: [
				{ name: "id", slot: "path", slotName: "id", type: "string", minLength: 1, maxLength: 50 },
			],
		});
		expect(
			customHttpsDefinitionProblems(getWithIdempotency).some((p) =>
				p.includes("nothing to make idempotent"),
			),
		).toBe(true);
	});

	it("refuses a body parameter on a GET", () => {
		const bad = definition({
			method: "GET",
			idempotency: null,
		});
		const problems = customHttpsDefinitionProblems(bad);
		expect(problems.some((p) => p.includes("a GET request has no body"))).toBe(true);
	});

	it("refuses a duplicated secret alias", () => {
		const bad = definition({
			secretSlots: [
				{ alias: "api_key", slot: "header", slotName: "x-api-key" },
				{ alias: "api_key", slot: "query", slotName: "key" },
			],
		});
		const problems = customHttpsDefinitionProblems(bad);
		expect(problems.some((p) => p.includes("is used more than once"))).toBe(true);
	});

	it("refuses two header slots that collide only case-insensitively", () => {
		const bad = definition({
			parameters: [
				...definition().parameters,
				{
					name: "trace",
					slot: "header",
					slotName: "X-Api-Key",
					type: "string",
					minLength: 1,
					maxLength: 10,
				},
			],
		});
		// The definition's own secret is already mapped to header `x-api-key`; `X-Api-Key` is the
		// identical HTTP header under a different case. Secrets are claimed after parameters, so the
		// collision message reports the secret's own casing ('x-api-key'), not the new parameter's.
		const problems = customHttpsDefinitionProblems(bad);
		expect(problems.some((p) => /both target header 'x-api-key'/i.test(p))).toBe(true);
	});

	it("refuses a parameter or secret that targets the idempotency header itself", () => {
		const paramCollision = definition({
			parameters: [
				...definition().parameters,
				{
					name: "key",
					slot: "header",
					slotName: "Idempotency-Key",
					type: "string",
					minLength: 1,
					maxLength: 10,
				},
			],
		});
		expect(
			customHttpsDefinitionProblems(paramCollision).some((p) =>
				p.includes("the idempotency header"),
			),
		).toBe(true);
	});

	it("reserves the controller's own definition-version parameter name", () => {
		const bad = definition({
			parameters: [
				...definition().parameters,
				{
					name: "custom_tool_definition_version",
					slot: "query",
					slotName: "v",
					type: "string",
					minLength: 1,
					maxLength: 10,
				},
			],
		});
		const problems = customHttpsDefinitionProblems(bad);
		expect(problems.some((p) => p.includes("is reserved for the controller"))).toBe(true);
	});
});

describe("CustomToolResponseLimitsSchema's includeBodyPreview", () => {
	it("defaults to true, so a definition stored before this field existed parses unchanged", () => {
		const parsed = CustomToolResponseLimitsSchema.parse({
			maxResponseBytes: 65_536,
			allowedContentTypes: ["application/json"],
			timeoutMs: 5000,
		});
		expect(parsed.includeBodyPreview).toBe(true);
	});

	it("can be turned off explicitly", () => {
		const parsed = CustomToolResponseLimitsSchema.parse({
			maxResponseBytes: 65_536,
			allowedContentTypes: ["application/json"],
			timeoutMs: 5000,
			includeBodyPreview: false,
		});
		expect(parsed.includeBodyPreview).toBe(false);
	});
});

describe("custom.<entry-id> action types", () => {
	it("round-trips an entry id through its action type", () => {
		expect(customToolActionType("zendesk-ticket")).toBe("custom.zendesk-ticket");
		expect(customToolEntryId("custom.zendesk-ticket")).toBe("zendesk-ticket");
	});

	it("is null for an action type outside the custom namespace", () => {
		expect(customToolEntryId("finance.payment.create")).toBeNull();
	});
});

describe("textTransform", () => {
	it("applies each operation deterministically", () => {
		expect(textTransform("trim", "  hi  ")).toBe("hi");
		expect(textTransform("upper", "hi")).toBe("HI");
		expect(textTransform("lower", "HI")).toBe("hi");
		expect(textTransform("reverse", "abc")).toBe("cba");
		expect(textTransform("slugify", "  Hello, World!  ")).toBe("hello-world");
	});
});
