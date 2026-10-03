import type { CustomHttpsDefinition } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import { clientSideDefinitionProblems, entryIdProblems } from "./custom-tool-validation.ts";

function definition(overrides: Partial<CustomHttpsDefinition> = {}): CustomHttpsDefinition {
	return {
		host: "api.example.com",
		pathTemplate: "/tickets/{id}",
		method: "POST",
		parameters: [
			{ name: "id", slot: "path", slotName: "id", type: "string", minLength: 1, maxLength: 50 },
		],
		secretSlots: [],
		idempotency: { headerName: "Idempotency-Key" },
		responseLimits: {
			maxResponseBytes: 65_536,
			allowedContentTypes: ["application/json"],
			timeoutMs: 5000,
			includeBodyPreview: true,
		},
		...overrides,
	};
}

describe("clientSideDefinitionProblems", () => {
	it("is empty for a well-formed definition", () => {
		expect(clientSideDefinitionProblems(definition())).toEqual([]);
	});

	it("flags a path template placeholder with no matching path parameter", () => {
		const problems = clientSideDefinitionProblems(
			definition({ pathTemplate: "/tickets/{id}/{missing}" }),
		);
		expect(problems.some((p) => p.includes("missing"))).toBe(true);
	});

	it("flags a write method with no idempotency header", () => {
		const problems = clientSideDefinitionProblems(definition({ idempotency: null }));
		expect(problems.some((p) => p.toLowerCase().includes("idempotency"))).toBe(true);
	});

	it("flags a GET that still declares an idempotency header", () => {
		const problems = clientSideDefinitionProblems(
			definition({ method: "GET", idempotency: { headerName: "Idempotency-Key" } }),
		);
		expect(problems.some((p) => p.toLowerCase().includes("idempotent"))).toBe(true);
	});

	it("flags two parameters colliding on the same header slot", () => {
		const problems = clientSideDefinitionProblems(
			definition({
				parameters: [
					{
						name: "a",
						slot: "header",
						slotName: "x-dup",
						type: "string",
						minLength: 1,
						maxLength: 10,
					},
					{
						name: "b",
						slot: "header",
						slotName: "X-Dup",
						type: "string",
						minLength: 1,
						maxLength: 10,
					},
				],
			}),
		);
		expect(problems.some((p) => p.includes("x-dup") || p.includes("X-Dup"))).toBe(true);
	});

	it("rejects an out-of-bounds shape (e.g. an empty host) before the cross-field rules even run", () => {
		const problems = clientSideDefinitionProblems(definition({ host: "" }));
		expect(problems.length).toBeGreaterThan(0);
	});
});

describe("entryIdProblems", () => {
	it("is empty for a well-formed entry id", () => {
		expect(entryIdProblems("ticketing-create")).toEqual([]);
	});

	it("flags an uppercase letter, the same rule the create request's own schema enforces", () => {
		expect(entryIdProblems("Ticketing-Create").length).toBeGreaterThan(0);
	});

	it("flags a space", () => {
		expect(entryIdProblems("ticketing create").length).toBeGreaterThan(0);
	});

	it("flags one that is too short", () => {
		expect(entryIdProblems("a").length).toBeGreaterThan(0);
	});

	it("flags an empty string", () => {
		expect(entryIdProblems("").length).toBeGreaterThan(0);
	});
});
