import { type JobSink, RunJobSchema, type RunReport, reportQueue } from "@agent-gateway/contracts";
import type { Logger } from "@agent-gateway/logging";
import { executeTurn, type RuntimeAdapter } from "@agent-gateway/runtime-sdk";

export type RunJobOutcome = "completed" | "failed" | "invalid_job";

/**
 * Executes one run attempt: report `started`, run the turn under its deadline, report the
 * validated result or the failure. The worker reads no domain state; everything it needs is in
 * the job, and the controller re-checks everything it reports.
 */
export async function processRunJob(
	adapter: RuntimeAdapter,
	runtimeVersion: string,
	/** Untrusted until parsed. */
	data: unknown,
	reports: JobSink,
	signal: AbortSignal,
	log: Logger,
): Promise<RunJobOutcome> {
	const parsed = RunJobSchema.safeParse(data);
	if (!parsed.success) {
		// Without a valid run id there is nobody to report to; the job goes to the dead letter queue.
		log.error("invalid run job", { error_code: "invalid_job" });
		throw new Error("invalid run job payload");
	}
	const { runId, attempt, timeoutSeconds } = parsed.data;
	const agentId = parsed.data.input.agent.agentId;
	const runLog = log.child({
		run_id: runId,
		agent_id: agentId,
		correlation_id: parsed.data.input.trigger.correlationid,
	});
	const send = (report: RunReport) => reports.send(reportQueue(adapter.id), report);

	await send({ kind: "started", runId, attempt, agentId, runtimeVersion });
	// The time budget starts once the run has started, not when it was queued or while the
	// started report was being sent.
	const input = {
		...parsed.data.input,
		deadline: new Date(Date.now() + timeoutSeconds * 1000).toISOString(),
	};
	runLog.info("run started", { attempt });
	const execution = await executeTurn(adapter, input, { session: null, signal });
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
