import { TEXT_TRANSFORM_MAX_INPUT_LENGTH, TOOL_RECEIPT_TEXT_MAX } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "./executor.ts";
import { utilityExecutor } from "./utility.ts";

const context: ToolExecutionContext = {
	idempotencyKey: "tool-action:test:test",
	signal: new AbortController().signal,
};

describe("utilityExecutor (utility.text-transform)", () => {
	it("succeeds for an ordinary transform", async () => {
		const result = await utilityExecutor().execute({ operation: "upper", text: "hello" }, context);
		expect(result).toEqual({ kind: "succeeded", receipt: { result: "HELLO" } });
	});

	it("reports an empty result as '(empty)', never a blank receipt field", async () => {
		const result = await utilityExecutor().execute({ operation: "trim", text: "   " }, context);
		expect(result).toEqual({ kind: "succeeded", receipt: { result: "(empty)" } });
	});

	it("refuses an input whose transform would overflow a receipt field ('ß' x 400, upper)", async () => {
		const text = "ß".repeat(TEXT_TRANSFORM_MAX_INPUT_LENGTH);
		const result = await utilityExecutor().execute({ operation: "upper", text }, context);
		expect(result.kind).toBe("failed");
		expect(result).toMatchObject({ error: expect.stringContaining(String(TOOL_RECEIPT_TEXT_MAX)) });
	});

	it("accepts the same input for an operation that cannot expand it", async () => {
		const text = "ß".repeat(TEXT_TRANSFORM_MAX_INPUT_LENGTH);
		const result = await utilityExecutor().execute({ operation: "reverse", text }, context);
		expect(result.kind).toBe("succeeded");
	});

	it("refuses a lowercase fold that fits the length but is not a representable receipt (Turkish 'İ' -> 'i' + combining dot above)", async () => {
		// `"İ".toLowerCase()` is `"i̇"` (2 code units, well within any length bound) — a
		// combining mark `ToolReceiptSchema`'s own `safeText(.., "verbatim")` refuses. Previously
		// reported `succeeded` here and only discovered unrepresentable later, when `tool-job.ts`'s
		// own re-parse withheld it (`{ receipt_withheld: true }`) behind an already-"succeeded" job.
		const result = await utilityExecutor().execute({ operation: "lower", text: "İ" }, context);
		expect(result.kind).toBe("failed");
		expect(result).toMatchObject({
			error: expect.stringContaining("cannot be represented in a tool receipt"),
		});
	});
});
