import type { ToolName, ToolReceipt } from "@agent-gateway/contracts";
import type { ToolExecutor } from "./executor.ts";

/** One call an executor received. */
export type RecordedExecution = Readonly<{
	idempotencyKey: string;
	params: Readonly<Record<string, string>>;
}>;

export type RecordingExecutor = ToolExecutor &
	Readonly<{
		/** Every call, repeats included. */
		calls: () => Readonly<RecordedExecution[]>;
		/** Side effects actually performed: one per idempotency key. */
		effects: () => Readonly<RecordedExecution[]>;
	}>;

/**
 * A provider stand-in that honours idempotency keys the way a real one must: a repeated key
 * returns the first receipt and performs nothing again.
 */
export function recordingExecutor(
	actionType: ToolName,
	receipt: (params: Readonly<Record<string, string>>, n: number) => ToolReceipt = (_, n) => ({
		provider_id: `sandbox-${n}`,
	}),
): RecordingExecutor {
	const calls: RecordedExecution[] = [];
	const done = new Map<string, Readonly<{ execution: RecordedExecution; receipt: ToolReceipt }>>();
	return {
		actionType,
		calls: () => calls,
		effects: () => [...done.values()].map((entry) => entry.execution),
		execute: async (params, context) => {
			const execution = { idempotencyKey: context.idempotencyKey, params: { ...params } };
			calls.push(execution);
			const earlier = done.get(context.idempotencyKey);
			if (earlier !== undefined) {
				return { kind: "succeeded", receipt: earlier.receipt };
			}
			const issued = receipt(params, done.size + 1);
			done.set(context.idempotencyKey, { execution, receipt: issued });
			return { kind: "succeeded", receipt: issued };
		},
	};
}

/**
 * Sandbox executors for development: they record the call and return a receipt marked
 * `sandbox`, and move no money and send nothing. A tool runner registers them only in a
 * development or test environment.
 */
export function sandboxExecutors(): Readonly<ToolExecutor[]> {
	const sandboxReceipt = (_: Readonly<Record<string, string>>, n: number): ToolReceipt => ({
		sandbox: true,
		provider_id: `sandbox-${n}`,
	});
	return [
		recordingExecutor("finance.payment.create", sandboxReceipt),
		recordingExecutor("finance.subscription.create", sandboxReceipt),
	];
}
