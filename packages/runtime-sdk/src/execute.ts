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
import {
	type RuntimeAdapter,
	RuntimeError,
	type RuntimeTurnOutput,
	type TurnOptions,
} from "./adapter.ts";

/** What became of the session offered to the turn. */
export type SessionResume = "not_requested" | "resumed" | "unavailable";

export type TurnExecution = Readonly<
	(
		| { kind: "completed"; result: AgentTurnResult }
		| {
				kind: "failed";
				error: RunError;
				usage: RuntimeUsage | null;
				session: RuntimeSessionHandle | null;
		  }
	) & { resume: SessionResume }
>;

export type ExecuteOptions = Readonly<{
	/** Resume this provider session; the turn starts fresh when the runtime cannot. */
	session: RuntimeSessionHandle | null;
	/** The run's working directory (see `createRunWorkspace`). */
	workspacePath: string;
	model: string | null;
	persistSession: boolean;
	/** External cancellation (operator cancel, kill-all, worker shutdown). */
	signal?: AbortSignal;
	clock?: () => Date;
}>;

type Validation =
	| Readonly<{ ok: true; result: AgentTurnResult }>
	| Readonly<{
			ok: false;
			/** Full messages, for the repair request to the model. */
			issues: Readonly<string[]>;
			/** Paths and codes only, for reports: messages can quote the output (unknown keys). */
			codes: Readonly<string[]>;
	  }>;

type Issue = Readonly<{ path: readonly PropertyKey[]; code: string; message: string }>;

function failedValidation(issues: Readonly<Issue[]>): Validation {
	const first = issues.slice(0, 20);
	return {
		ok: false,
		issues: first.map((i) => `${i.path.map(String).join(".")}: ${i.message}`),
		codes: first.map((i) => `${i.path.map(String).join(".")}: ${i.code}`),
	};
}

function validate(input: AgentTurnInput, output: RuntimeTurnOutput): Validation {
	const model = AgentTurnModelOutputSchema.safeParse(output.modelOutput);
	if (!model.success) {
		return failedValidation(model.error.issues);
	}
	const result = AgentTurnResultSchema.safeParse({
		...model.data,
		schemaVersion: 1,
		runId: input.runId,
		usage: output.usage,
		session: output.session,
	});
	return result.success ? { ok: true, result: result.data } : failedValidation(result.error.issues);
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

function failed(
	error: RunError,
	output: RuntimeTurnOutput | null,
	resume: SessionResume,
): TurnExecution {
	return {
		kind: "failed",
		error: { ...error, detail: redactForStorage(error.detail) },
		usage: output?.usage ?? null,
		session: output?.session ?? null,
		resume,
	};
}

/**
 * Runs one turn under the input's deadline: start or continue (falling back to a fresh start
 * when the session is gone), validate, one controlled repair, validate again. Raw output never
 * leaves this function unvalidated; on timeout or cancel the adapter is asked to stop its
 * process.
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
			"not_requested",
		);
	}
	const timeout = AbortSignal.timeout(remainingMs);
	const signal =
		options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
	const call = (run: () => Promise<RuntimeTurnOutput>) => raceAbort(run(), signal, timeout);
	const turnOptions: TurnOptions = {
		signal,
		workspacePath: options.workspacePath,
		model: options.model,
		persistSession: options.persistSession,
	};

	let output: RuntimeTurnOutput | null = null;
	let resume: SessionResume = "not_requested";
	const startOrContinue = async (): Promise<RuntimeTurnOutput> => {
		const { session } = options;
		if (session === null || !adapter.capabilities.sessionResume) {
			return adapter.startTurn(input, turnOptions);
		}
		try {
			const continued = await adapter.continueTurn(session, input, turnOptions);
			resume = "resumed";
			return continued;
		} catch (error) {
			if (signal.aborted) {
				throw error;
			}
			// The session is an optimization: the input carries the full canonical context. Any
			// failure of a resumed call (gone, corrupt, too long, an unknown CLI message) starts
			// fresh, so one bad session never fails every later run of the agent.
			resume = "unavailable";
			return adapter.startTurn(input, turnOptions);
		}
	};
	try {
		output = await call(startOrContinue);
		const first = validate(input, output);
		if (first.ok) {
			return { kind: "completed", result: first.result, resume };
		}
		const previousOutput: JsonValue = output.modelOutput;
		output = await call(() =>
			adapter.repairTurn(input, { issues: first.issues, previousOutput }, turnOptions),
		);
		const second = validate(input, output);
		if (second.ok) {
			return { kind: "completed", result: second.result, resume };
		}
		return failed(
			{
				code: "invalid_output",
				retryable: false,
				detail: `output invalid after one repair: ${second.codes.join("; ")}`,
			},
			output,
			resume,
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
				resume,
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
				resume,
			);
		}
		return failed(
			{
				code: "runtime_retryable",
				retryable: true,
				detail: error instanceof Error ? error.message : String(error),
			},
			output,
			resume,
		);
	}
}
