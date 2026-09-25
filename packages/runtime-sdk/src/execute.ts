import {
	type AgentTurnInput,
	AgentTurnModelOutputSchema,
	type AgentTurnResult,
	AgentTurnResultSchema,
	type JsonValue,
	type RunError,
	type RuntimeSessionHandle,
	type RuntimeUsage,
} from "@agent-gateway/contracts";
import { redactForStorage } from "@agent-gateway/logging";
import { type RuntimeAdapter, RuntimeError, type RuntimeTurnOutput } from "./adapter.ts";

export type TurnExecution =
	| Readonly<{ kind: "completed"; result: AgentTurnResult }>
	| Readonly<{
			kind: "failed";
			error: RunError;
			usage: RuntimeUsage | null;
			session: RuntimeSessionHandle | null;
	  }>;

export type ExecuteOptions = Readonly<{
	/** Resume this provider session when the adapter supports it. */
	session: RuntimeSessionHandle | null;
	/** External cancellation (operator cancel, kill-all, worker shutdown). */
	signal?: AbortSignal;
	clock?: () => Date;
}>;

type Validation =
	| Readonly<{ ok: true; result: AgentTurnResult }>
	| Readonly<{ ok: false; issues: Readonly<string[]> }>;

function validate(input: AgentTurnInput, output: RuntimeTurnOutput): Validation {
	const model = AgentTurnModelOutputSchema.safeParse(output.modelOutput);
	if (!model.success) {
		return {
			ok: false,
			issues: model.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`),
		};
	}
	const result = AgentTurnResultSchema.safeParse({
		...model.data,
		schemaVersion: 1,
		runId: input.runId,
		usage: output.usage,
		session: output.session,
	});
	return result.success
		? { ok: true, result: result.data }
		: { ok: false, issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}

class Aborted extends Error {
	constructor(readonly code: "timeout" | "cancelled") {
		super(code);
	}
}

/** Settles with the call, or rejects as soon as the signal aborts. */
async function raceAbort<T>(
	call: Promise<T>,
	signal: AbortSignal,
	timeout: AbortSignal,
): Promise<T> {
	let onAbort = () => {};
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(new Aborted(timeout.aborted ? "timeout" : "cancelled"));
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
	try {
		// Promise.race subscribes to the call, so its late rejection is never unhandled.
		return await Promise.race([call, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function failed(error: RunError, output: RuntimeTurnOutput | null): TurnExecution {
	return {
		kind: "failed",
		error: { ...error, detail: redactForStorage(error.detail) },
		usage: output?.usage ?? null,
		session: output?.session ?? null,
	};
}

/**
 * Runs one turn under the input's deadline: start or continue, validate, one controlled repair,
 * validate again. Raw output never leaves this function unvalidated; on timeout or cancel the
 * adapter is asked to stop its process.
 */
export async function executeTurn(
	adapter: RuntimeAdapter,
	input: AgentTurnInput,
	options: ExecuteOptions,
): Promise<TurnExecution> {
	const now = (options.clock ?? (() => new Date()))();
	const remainingMs = Date.parse(input.deadline) - now.getTime();
	if (remainingMs <= 0) {
		return failed(
			// Nothing ran; another attempt with a fresh budget may well succeed.
			{ code: "timeout", retryable: true, detail: "deadline passed before start" },
			null,
		);
	}
	const timeout = AbortSignal.timeout(remainingMs);
	const signal =
		options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
	const call = (run: () => Promise<RuntimeTurnOutput>) => raceAbort(run(), signal, timeout);

	let output: RuntimeTurnOutput | null = null;
	try {
		const { session } = options;
		output = await call(() =>
			session === null
				? adapter.startTurn(input, { signal })
				: adapter.continueTurn(session, input, { signal }),
		);
		const first = validate(input, output);
		if (first.ok) {
			return { kind: "completed", result: first.result };
		}
		const previousOutput: JsonValue = output.modelOutput;
		output = await call(() =>
			adapter.repairTurn(input, { issues: first.issues, previousOutput }, { signal }),
		);
		const second = validate(input, output);
		if (second.ok) {
			return { kind: "completed", result: second.result };
		}
		return failed(
			{
				code: "invalid_output",
				retryable: false,
				detail: `output invalid after one repair: ${second.issues.join("; ")}`,
			},
			output,
		);
	} catch (error) {
		if (error instanceof Aborted) {
			await adapter.cancel(input.runId).catch(() => undefined);
			return failed(
				{
					code: error.code,
					// A deadline may pass on a retry (the controller bounds attempts and backs off);
					// an operator's cancellation must not come back.
					retryable: error.code === "timeout",
					detail: error.code === "timeout" ? "run deadline reached" : "run cancelled",
				},
				output,
			);
		}
		if (error instanceof RuntimeError) {
			return failed(
				{
					code: error.retryable ? "runtime_retryable" : "runtime_permanent",
					retryable: error.retryable,
					detail: error.message,
				},
				output,
			);
		}
		return failed(
			{
				code: "runtime_retryable",
				retryable: true,
				detail: error instanceof Error ? error.message : String(error),
			},
			output,
		);
	}
}
