import {
	type JobSink,
	RunJobSchema,
	type RunReport,
	type RuntimeSessionHandle,
	reportQueue,
} from "@agent-gateway/contracts";
import type { Logger } from "@agent-gateway/logging";
import {
	createRunWorkspace,
	executeTurn,
	type RuntimeAdapter,
	removeRunWorkspace,
	resumableSession,
	type TurnExecution,
} from "@agent-gateway/runtime-sdk";

export type RunJobOutcome = "completed" | "failed" | "invalid_job";

/** What a worker brings to every job of its adapter. */
export type RunJobHost = Readonly<{
	adapter: RuntimeAdapter;
	runtimeVersion: string;
	/** Absolute directory under which every run gets its own workspace. */
	workspaceRoot: string;
	reports: JobSink;
	log: Logger;
	/**
	 * Whether this subscription may still run turns: false once the runtime failed its probe or
	 * changed version, also while the subscription could not be removed yet.
	 */
	accepting?: () => boolean;
}>;

/**
 * Executes one run attempt: report `started`, run the turn under its deadline in a fresh run
 * workspace, report the validated result or the failure, remove the workspace. The worker reads
 * no domain state; everything it needs is in the job, and the controller re-checks everything
 * it reports.
 */
export async function processRunJob(
	host: RunJobHost,
	/** Untrusted until parsed. */
	data: unknown,
	signal: AbortSignal,
): Promise<RunJobOutcome> {
	const { adapter, runtimeVersion, log } = host;
	const parsed = RunJobSchema.safeParse(data);
	if (!parsed.success) {
		// Without a valid run id there is nobody to report to; the job goes to the dead letter queue.
		log.error("invalid run job", { error_code: "invalid_job" });
		throw new Error("invalid run job payload");
	}
	const { runId, attempt, timeoutSeconds, runtime } = parsed.data;
	const agentId = parsed.data.input.agent.agentId;
	const runLog = log.child({
		run_id: runId,
		agent_id: agentId,
		correlation_id: parsed.data.input.trigger.correlationid,
	});
	const send = (report: RunReport) => host.reports.send(reportQueue(adapter.id), report);

	await send({ kind: "started", runId, attempt, agentId, runtimeVersion });
	// The time budget starts once the run has started, not when it was queued or while the
	// started report was being sent.
	const input = {
		...parsed.data.input,
		deadline: new Date(Date.now() + timeoutSeconds * 1000).toISOString(),
	};
	runLog.info("run started", { attempt });
	const refusal =
		host.accepting === undefined || host.accepting()
			? null
			: "the runtime of this worker is unavailable or changed version";
	const workspacePath =
		refusal !== null
			? new Error(refusal)
			: await createRunWorkspace(host.workspaceRoot, agentId, runId, attempt).catch(
					(error: Error) => error,
				);
	if (workspacePath instanceof Error) {
		await send({
			kind: "failed",
			runId,
			attempt,
			agentId,
			runtimeVersion,
			error: {
				code: "runtime_retryable",
				retryable: true,
				detail: (refusal ?? `cannot create the run workspace: ${workspacePath.message}`).slice(
					0,
					2000,
				),
			},
			usage: null,
			session: null,
		});
		runLog.error("run workspace unavailable", { attempt, error_code: "workspace" });
		return "failed";
	}
	const persistSession = runtime.sessionPolicy === "resumable-if-available";
	let execution: TurnExecution;
	try {
		execution = await executeTurn(adapter, input, {
			session: persistSession
				? resumableSession(runtime.session, adapter.id, runtimeVersion, new Date())
				: null,
			workspacePath,
			model: runtime.model,
			persistSession,
			signal,
		});
	} finally {
		// A workspace that cannot be removed must not cost the run its report.
		await removeRunWorkspace(workspacePath).catch((error: Error) =>
			runLog.error("run workspace not removed", {
				attempt,
				error_code: "workspace_cleanup",
				error_message: error.message,
			}),
		);
	}
	if (execution.resume === "unavailable") {
		runLog.info("provider session unavailable, started fresh", { attempt });
	}
	// A session is labeled with the version this run reports, not whatever the CLI is by the
	// end of the run: after an upgrade mid-run, a worker of the new version starts fresh.
	const labeled = (session: RuntimeSessionHandle | null) =>
		session === null ? null : { ...session, runtimeVersion };
	if (execution.kind === "completed") {
		await send({
			kind: "completed",
			runId,
			attempt,
			agentId,
			runtimeVersion,
			result: { ...execution.result, session: labeled(execution.result.session) },
		});
		runLog.info("run completed", { attempt, next_state: execution.result.nextState.kind });
		return "completed";
	}
	await send({
		kind: "failed",
		runId,
		attempt,
		agentId,
		runtimeVersion,
		error: execution.error,
		usage: execution.usage,
		session: labeled(execution.session),
	});
	runLog.warn("run failed", { attempt, error_code: execution.error.code });
	return "failed";
}
