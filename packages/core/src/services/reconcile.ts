import {
	QUEUES,
	type ReportQueueName,
	type RunQueueName,
	type RuntimeAdapterId,
	reportQueue,
	runQueue,
} from "@agent-gateway/contracts";
import { agentRuns, type RunStatus, waitSubscriptions, withTransaction } from "@agent-gateway/db";
import { and, asc, eq, gt, lt, or } from "drizzle-orm";
import type { ControlPlaneDeps } from "./deps.ts";
import { failLostAttempt, type ReportOutcome } from "./runs.ts";

/** Queue lookups supplied by the host (the domain has no pg-boss). */
export type JobProbe = Readonly<{
	/** Whether the queue still holds a live (queued, retrying or active) job. */
	isAlive: (queue: RunQueueName, jobId: string) => Promise<boolean>;
	/** Whether a report for the run is still waiting to be applied. */
	hasPendingReport: (queue: ReportQueueName, runId: string) => Promise<boolean>;
}>;

const PAGE_SIZE = 200;

type Candidate = Readonly<{
	id: string;
	status: RunStatus;
	jobId: string | null;
	attempt: number;
	adapter: RuntimeAdapterId;
}>;

/**
 * Fails one attempt as lost when its job is gone and no report is pending. The job is probed
 * first: a worker sends its report before its job completes, so once the job is gone a report
 * is either pending (and applied first) or already applied (and the run moved on, which the
 * lock-fenced `failLostAttempt` detects).
 */
async function recoverIfLost(
	deps: ControlPlaneDeps,
	probe: JobProbe,
	run: Candidate,
): Promise<ReportOutcome> {
	if (run.status !== "queued" && run.status !== "running") {
		return "ignored_stale";
	}
	const jobGone =
		run.status === "running" ||
		run.jobId === null ||
		!(await probe.isAlive(runQueue(run.adapter), run.jobId));
	if (!jobGone || (await probe.hasPendingReport(reportQueue(run.adapter), run.id))) {
		return "ignored_stale";
	}
	const detail =
		run.status === "running"
			? "the attempt outlived its deadline without a report or timeout"
			: "the run job is no longer in the queue";
	const status = run.status;
	return failLostAttempt(
		deps,
		{ runId: run.id, jobId: run.jobId, status, attempt: run.attempt },
		detail,
	);
}

/** How long a run or wait may look stuck before reconciliation acts. */
const STALE_MS = 5 * 60 * 1000;

export type ReconcileResult = Readonly<{ lostAttempts: number; requeuedWaitTimeouts: number }>;

/**
 * Safety net for jobs that disappeared from the queue: a queued attempt whose run job is gone,
 * or a running attempt past its deadline whose backstop never fired, is failed as retryable
 * (requeued, or failed for good when attempts are used up); an active wait past its timeout
 * gets a new timeout job. Every action is idempotent and fenced by the handlers.
 */
export async function reconcileRunsAndWaits(
	deps: ControlPlaneDeps,
	probe: JobProbe,
	pageSize = PAGE_SIZE,
): Promise<ReconcileResult> {
	const stale = new Date(deps.clock().getTime() - STALE_MS);
	let lostAttempts = 0;
	// Every candidate is examined, page by page on a stable cursor, so healthy old runs cannot
	// starve a lost one.
	let after = "00000000-0000-0000-0000-000000000000";
	for (;;) {
		const page = await withTransaction(deps.pool, ({ db }) =>
			db
				.select({
					id: agentRuns.id,
					status: agentRuns.status,
					jobId: agentRuns.jobId,
					attempt: agentRuns.attempt,
					adapter: agentRuns.runtimeAdapter,
				})
				.from(agentRuns)
				.where(
					and(
						gt(agentRuns.id, after),
						or(
							and(eq(agentRuns.status, "queued"), lt(agentRuns.queuedAt, stale)),
							and(eq(agentRuns.status, "running"), lt(agentRuns.timeoutAt, stale)),
						),
					),
				)
				.orderBy(asc(agentRuns.id))
				.limit(pageSize),
		);
		for (const run of page) {
			if ((await recoverIfLost(deps, probe, run)) !== "ignored_stale") {
				lostAttempts += 1;
			}
		}
		const last = page.at(-1);
		if (last === undefined || page.length < pageSize) {
			break;
		}
		after = last.id;
	}

	const requeuedWaitTimeouts = await withTransaction(deps.pool, async (tx) => {
		const waits = await tx.db
			.select({ id: waitSubscriptions.id })
			.from(waitSubscriptions)
			.where(and(eq(waitSubscriptions.status, "active"), lt(waitSubscriptions.timeoutAt, stale)))
			.limit(200);
		const jobs = deps.jobs(tx);
		for (const wait of waits) {
			await jobs.send(QUEUES.waitTimeout, { waitId: wait.id });
		}
		return waits.length;
	});
	return { lostAttempts, requeuedWaitTimeouts };
}
