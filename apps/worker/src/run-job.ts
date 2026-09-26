import { type JobSink, RunJobSchema, type RunReport, reportQueue } from "@agent-gateway/contracts";
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
	const workspacePath = await createRunWorkspace(host.workspaceRoot, agentId, runId, attempt).catch(
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
				detail: `cannot create the run workspace: ${workspacePath.message}`.slice(0, 2000),
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
	if (execution.kind === "completed") {
		await send({
			kind: "completed",
			runId,
			attempt,
			agentId,
			runtimeVersion,
			result: execution.result,
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
		session: execution.session,
	});
	runLog.warn("run failed", { attempt, error_code: execution.error.code });
	return "failed";
}
