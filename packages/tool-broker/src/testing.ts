import type { ToolName } from "@agent-gateway/contracts";
import type { ToolExecutionResult, ToolExecutor } from "./executor.ts";

export { type RecordedExecution, type RecordingExecutor, recordingExecutor } from "./sandbox.ts";

/** An executor whose provider always says no. */
export function failingExecutor(actionType: ToolName, error: string): ToolExecutor {
	return {
		actionType,
		execute: async (): Promise<ToolExecutionResult> => ({ kind: "failed", error }),
	};
}

/** An executor that dies mid-call: whether anything happened is unknown. */
export function throwingExecutor(actionType: ToolName): ToolExecutor {
	return {
		actionType,
		execute: async () => {
			throw new Error("connection reset by the provider");
		},
	};
}

/** An executor whose provider never answers: it gives up, sending nothing, when aborted. */
export function blockingExecutor(actionType: ToolName): ToolExecutor {
	return {
		actionType,
		execute: (_, context) =>
			new Promise<ToolExecutionResult>((resolve) => {
				context.signal.addEventListener(
					"abort",
					() => resolve({ kind: "failed", error: "aborted before anything was sent" }),
					{ once: true },
				);
			}),
	};
}
