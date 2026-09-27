import type { ToolName, ToolReceipt } from "@agent-gateway/contracts";

/** What an executor gets besides the parameters. */
export type ToolExecutionContext = Readonly<{
	/**
	 * `tool-action:<approval id>:<hash>`. The executor must pass it to its provider as the
	 * provider's idempotency key (or check the provider's state by it): a second call with the
	 * same key must not act twice.
	 */
	idempotencyKey: string;
	/**
	 * Aborted when the action is asked to stop (kill-all, the agent disabled) or the runner
	 * stops. An executor that honours it returns `failed` when nothing was sent yet, and throws
	 * when it cannot tell.
	 */
	signal: AbortSignal;
}>;

/**
 * How an execution ended, as far as the executor knows. `failed` is a known failure: the
 * provider refused, or nothing was sent. An executor that cannot tell must throw: the outcome
 * is then recorded as unknown and never retried automatically.
 */
export type ToolExecutionResult =
	| Readonly<{ kind: "succeeded"; receipt: ToolReceipt }>
	| Readonly<{ kind: "failed"; error: string }>;

/**
 * One approved action type a tool runner can perform. Executors are registered statically in
 * the runner; they hold the provider credential, which no other process has.
 */
export type ToolExecutor = Readonly<{
	actionType: ToolName;
	/** The parameters, by name, exactly as approved and hashed. */
	execute: (
		params: Readonly<Record<string, string>>,
		context: ToolExecutionContext,
	) => Promise<ToolExecutionResult>;
}>;

/** Executors by action type; a runner refuses an action none of them performs. */
export type ToolExecutors = ReadonlyMap<string, ToolExecutor>;

export function executorRegistry(executors: Readonly<ToolExecutor[]>): ToolExecutors {
	const registry = new Map<string, ToolExecutor>();
	for (const executor of executors) {
		if (registry.has(executor.actionType)) {
			throw new Error(`two executors for '${executor.actionType}'`);
		}
		registry.set(executor.actionType, executor);
	}
	return registry;
}
