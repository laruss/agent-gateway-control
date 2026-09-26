import { describe, expect, it } from "vitest";
import { parseJsonAnswer, withoutUnanchoredPatterns } from "./output.ts";

describe("parseJsonAnswer", () => {
	it("reads plain and fenced JSON and keeps anything else as text", () => {
		expect(parseJsonAnswer('{"a":1}')).toEqual({ a: 1 });
		expect(parseJsonAnswer('```json\n{"a":1}\n```')).toEqual({ a: 1 });
		expect(parseJsonAnswer('Sure! {"a":1}')).toBe('Sure! {"a":1}');
	});
});

describe("withoutUnanchoredPatterns", () => {
	it("drops only unanchored pattern keywords", () => {
		expect(
			withoutUnanchoredPatterns({
				type: "object",
				properties: {
					pattern: { type: "string", pattern: "\\S" },
					id: { type: "string", pattern: "^[a-z]{3}$" },
					either: { type: "string", pattern: "^a|b$" },
				},
				items: [{ pattern: "x" }],
				default: { pattern: "kept" },
			}),
		).toEqual({
			type: "object",
			properties: {
				pattern: { type: "string" },
				id: { type: "string", pattern: "^[a-z]{3}$" },
				either: { type: "string" },
			},
			items: [{}],
			default: { pattern: "kept" },
		});
	});
});
