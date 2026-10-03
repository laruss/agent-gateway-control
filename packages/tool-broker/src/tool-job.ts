import {
	type ToolActionJob,
	ToolActionJobSchema,
	type ToolNamespace,
	ToolReceiptSchema,
	type ToolReport,
	toolNamespace,
	withoutUnsafeCharacters,
} from "@agent-gateway/contracts";
import { errorFields, type Logger, redactForStorage, traceFields } from "@agent-gateway/logging";
import { actionParamIssues, approvalActionHash } from "@agent-gateway/policy";
import type { ToolExecutionContext, ToolExecutionResult, ToolExecutors } from "./executor.ts";

/** What `gateway_begin_tool_action` answered. */
export type BeginVerdict =
	/** The action may run now, with the idempotency key stored with it (never the job's). */
	| Readonly<{ verdict: "begin"; idempotencyKey: string }>
	/** Why not: kill switch, not queued, hash mismatch, deadline passed, ... */
	| Readonly<{ verdict: string; idempotencyKey: null }>;

/** The runner's call into domain state that lets an approved action start. */
export type BeginToolAction = (
	actionId: string,
	attempt: number,
	hash: string,
) => Promise<BeginVerdict>;

/**
 * Runs one job whose action type is not a statically registered executor's own — a `custom_https`
 * entry's `custom.<entry-id>`, dynamic and owner-created, so no fixed `ToolExecutors` map could
 * ever enumerate it in advance the way `finance.payment.create` is known at startup. Tried only
 * once the static `executors` map has no entry for the job's exact action type.
 */
export type DynamicExecutor = (
	job: ToolActionJob,
	context: ToolExecutionContext,
) => Promise<ToolExecutionResult>;

export type ToolJobDeps = Readonly<{
	namespace: ToolNamespace;
	executors: ToolExecutors;
	/** Resolves a job whose action type `executors` has no entry for; see `DynamicExecutor`. */
	dynamicExecutor?: DynamicExecutor;
	begin: BeginToolAction;
	/** Whether a running action was asked to stop (kill-all, the agent disabled). */
	stopRequested: (actionId: string) => Promise<boolean>;
	report: (report: ToolReport) => Promise<void>;
	log: Logger;
	/** How often a running executor's stop request is checked. */
	stopPollMs?: number;
}>;

const STOP_POLL_MS = 2000;

export type ToolJobOutcome = ToolReport["kind"] | "invalid_job";

/** A report's error: redacted, bounded and free of control characters, never empty. */
const errorText = (text: string) =>
	withoutUnsafeCharacters(redactForStorage(text, 500)).trim() || "no detail";

/**
 * Handles one execute job. Nothing in the job is trusted: the namespace must be the runner's,
 * the hash is recomputed from the action and must match, the parameters must fit the action's
 * typed set, and `begin` must agree (approval granted, same hash, kill switch off, deadline
 * ahead). Only then does the executor run. Whatever happens is reported; an executor that
 * throws leaves the outcome unknown.
 */
export async function processToolJob(
	deps: ToolJobDeps,
	/** The queue's payload: untrusted until parsed. */
	data: unknown,
	signal: AbortSignal,
): Promise<ToolJobOutcome> {
	const parsed = ToolActionJobSchema.safeParse(data);
	if (!parsed.success) {
		deps.log.error("rejected a malformed tool job", { error_code: "invalid_job" });
		return "invalid_job";
	}
	const job = parsed.data;
	const log = deps.log.child({
		tool_action_id: job.actionId,
		action_type: job.actionType,
		...traceFields(job.traceparent),
	});
	const send = async (report: ToolReport) => {
		await deps.report(report);
		log.info("tool action reported", { outcome: report.kind });
		return report.kind;
	};
	const refuse = (reason: string) =>
		send({
			kind: "refused",
			actionId: job.actionId,
			attempt: job.attempt,
			reason: errorText(reason),
		});

	// Refusals change nothing: a job that is not what was approved must not fail the action that
	// was. The controller settles an action that never begins by its deadline.
	if (toolNamespace(job.actionType) !== deps.namespace) {
		return refuse(`'${job.actionType}' is not in this runner's namespace '${deps.namespace}'`);
	}
	const hash = approvalActionHash(job);
	if (hash !== job.immutableActionHash) {
		log.error("tool job does not match its approval hash", { error_code: "hash_mismatch" });
		return refuse("the action does not match its approval hash");
	}
	const issues = actionParamIssues(job.actionType, job.actionParams);
	if (issues.length > 0) {
		return refuse(errorText(`parameters refused: ${issues.join("; ")}`));
	}
	// `begin` first: it checks the job against the stored action (hash, attempt), so a job that
	// is not what was approved can neither run nor fail the action that was.
	const begun = await deps.begin(job.actionId, job.attempt, hash);
	if (begun.verdict !== "begin" || begun.idempotencyKey === null) {
		return refuse(`not begun: ${begun.verdict}`);
	}
	const failed = (error: string) =>
		send({ kind: "failed", actionId: job.actionId, attempt: job.attempt, error: errorText(error) });
	const executor = deps.executors.get(job.actionType);
	if (executor === undefined && deps.dynamicExecutor === undefined) {
		// Nothing can run it here; a known failure, nothing was sent.
		return failed(`no executor for '${job.actionType}' in this tool runner`);
	}
	if (signal.aborted) {
		// The runner is stopping (or the job was cancelled) before the executor ran.
		return failed("the tool runner stopped before the executor ran");
	}
	// A stop request (kill-all, the agent disabled) aborts the executor's call where it can.
	const stop = new AbortController();
	const abort = () => stop.abort();
	signal.addEventListener("abort", abort, { once: true });
	// One check at a time: against a slow database, checks must not pile onto the runner's pool.
	let checking = false;
	const poll = setInterval(() => {
		if (checking || stop.signal.aborted) {
			return;
		}
		checking = true;
		deps
			.stopRequested(job.actionId)
			.then(
				(requested) => {
					if (requested && !stop.signal.aborted) {
						log.warn("stop requested; aborting the executor");
						stop.abort();
					}
				},
				(error: unknown) => log.warn("stop check failed", errorFields(error)),
			)
			.finally(() => {
				checking = false;
			});
	}, deps.stopPollMs ?? STOP_POLL_MS);
	const run: (context: ToolExecutionContext) => Promise<ToolExecutionResult> =
		executor !== undefined
			? (context) =>
					executor.execute(
						Object.fromEntries(job.actionParams.map((param) => [param.name, param.value])),
						context,
					)
			: (context) => (deps.dynamicExecutor as DynamicExecutor)(job, context);
	try {
		return send(await execute(job, begun.idempotencyKey, run, stop.signal, log));
	} finally {
		clearInterval(poll);
		signal.removeEventListener("abort", abort);
	}
}

async function execute(
	job: ToolActionJob,
	idempotencyKey: string,
	run: (context: ToolExecutionContext) => Promise<ToolExecutionResult>,
	signal: AbortSignal,
	log: Logger,
): Promise<ToolReport> {
	const base = { actionId: job.actionId, attempt: job.attempt };
	try {
		const result = await run({ idempotencyKey, signal });
		if (result.kind === "failed") {
			return { ...base, kind: "failed", error: errorText(result.error) };
		}
		const receipt = ToolReceiptSchema.safeParse(result.receipt);
		// The action did succeed; a receipt that cannot be shown is withheld, not invented.
		return {
			...base,
			kind: "succeeded",
			receipt: receipt.success ? receipt.data : { receipt_withheld: true },
		};
	} catch (error) {
		log.error("tool executor threw; the outcome is unknown", errorFields(error));
		return {
			...base,
			kind: "unknown",
			error: errorText(
				`the executor stopped without an answer: ${error instanceof Error ? error.message : String(error)}`,
			),
		};
	}
}
