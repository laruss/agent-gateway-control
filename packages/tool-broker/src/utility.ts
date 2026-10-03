import {
	TEXT_TRANSFORM_MAX_INPUT_LENGTH,
	TextTransformOperationSchema,
	TOOL_RECEIPT_TEXT_MAX,
	type ToolReceipt,
	textTransform,
	UTILITY_TEXT_TRANSFORM,
} from "@agent-gateway/contracts";
import type { ToolExecutionResult, ToolExecutor } from "./executor.ts";

/**
 * `utility.text-transform`: the one packaged utility this release ships (ADR-027) — fixed code in
 * the tool runner image, a typed input, a bounded, side-effect-free output. It still runs behind a
 * human approval like every other broker action (`utility` supports only `require_approval`/
 * `disabled`, the same as `executor`/`custom_https`: the broker has no second, approval-free
 * execution path), proving the packaged-utility path end to end rather than carving out a new one.
 */
export function utilityExecutor(): ToolExecutor {
	return {
		actionType: UTILITY_TEXT_TRANSFORM,
		execute: async (params): Promise<ToolExecutionResult> => {
			const operation = TextTransformOperationSchema.safeParse(params.operation);
			if (!operation.success) {
				return {
					kind: "failed",
					error: `parameter 'operation' must be one of ${TextTransformOperationSchema.options.join(", ")}`,
				};
			}
			const text = params.text;
			if (text === undefined) {
				return { kind: "failed", error: "parameter 'text' is missing" };
			}
			if (text.length > TEXT_TRANSFORM_MAX_INPUT_LENGTH) {
				return {
					kind: "failed",
					error: `parameter 'text' must be at most ${TEXT_TRANSFORM_MAX_INPUT_LENGTH} characters`,
				};
			}
			const result = textTransform(operation.data, text);
			// `upper`/`lower` are Unicode case mapping, not 1:1 (`"ß".toUpperCase()` is `"SS"`): a
			// bounded input does not itself bound this output. Refused rather than truncated — this
			// utility's whole contract is handing back the actual transform, and a silently
			// truncated slug or case fold would be a wrong answer the caller has no way to tell from
			// a right one, where a refusal at least says so.
			if (result.length > TOOL_RECEIPT_TEXT_MAX) {
				return {
					kind: "failed",
					error: `the transformed text is ${result.length} characters, over the ${TOOL_RECEIPT_TEXT_MAX}-character limit a receipt can hold; shorten the input`,
				};
			}
			const receipt: ToolReceipt = { result: result === "" ? "(empty)" : result };
			return { kind: "succeeded", receipt };
		},
	};
}
