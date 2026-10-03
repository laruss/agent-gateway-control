import {
	TEXT_TRANSFORM_MAX_INPUT_LENGTH,
	TextTransformOperationSchema,
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
			const receipt: ToolReceipt = { result: result === "" ? "(empty)" : result };
			return { kind: "succeeded", receipt };
		},
	};
}
