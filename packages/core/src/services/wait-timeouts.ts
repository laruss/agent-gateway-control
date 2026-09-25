import { QUEUES, type WaitTimeoutJob } from "@agent-gateway/contracts";
import { agentRuns, approvalRequests, waitSubscriptions, withTransaction } from "@agent-gateway/db";
import { internalEvent } from "@agent-gateway/events";
import { and, eq } from "drizzle-orm";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import { type IngestResult, ingestInTransaction } from "./ingest.ts";
import { lockAgent, lockCascade, lockConfigShared } from "./store.ts";

const APPROVAL_CORRELATION_PREFIX = "approval:";

export type WaitTimeoutOutcome = "timed_out" | "not_due" | "ignored";

/**
 * Fires when a wait's timeout is reached: emits an `agent.wait.timeout` event, which resolves
 * the wait and resumes the agent through normal routing. An expired approval wait also marks
 * its approval request expired.
 */
export async function handleWaitTimeout(
	deps: ControlPlaneDeps,
	job: WaitTimeoutJob,
): Promise<WaitTimeoutOutcome> {
	return withTransaction(deps.pool, async (tx) => {
		const uow: UnitOfWork = { deps, tx, jobs: deps.jobs(tx), now: deps.clock() };
		const [owner] = await tx.db
			.select({
				agentId: waitSubscriptions.agentId,
				correlationId: waitSubscriptions.correlationId,
			})
			.from(waitSubscriptions)
			.where(eq(waitSubscriptions.id, job.waitId));
		if (owner === undefined) {
			return "ignored";
		}
		// Agent first, then the wait (the lock order of every use case): a concurrent match and
		// this timeout cannot both resolve the wait.
		await lockCascade(uow, owner.correlationId);
		await lockConfigShared(uow);
		await lockAgent(tx.db, owner.agentId);
		const [wait] = await tx.db
			.select({ wait: waitSubscriptions, hop: agentRuns.hop })
			.from(waitSubscriptions)
			.innerJoin(agentRuns, eq(agentRuns.id, waitSubscriptions.createdByRunId))
			.where(eq(waitSubscriptions.id, job.waitId))
			.for("update", { of: waitSubscriptions });
		if (wait === undefined || wait.wait.status !== "active") {
			return "ignored";
		}
		if (wait.wait.timeoutAt.getTime() > uow.now.getTime()) {
			await uow.jobs.send(
				QUEUES.waitTimeout,
				{ waitId: job.waitId },
				{ startAfter: wait.wait.timeoutAt },
			);
			return "not_due";
		}
		const { correlationId } = wait.wait;
		if (correlationId.startsWith(APPROVAL_CORRELATION_PREFIX)) {
			await tx.db
				.update(approvalRequests)
				.set({ status: "expired" })
				.where(
					and(
						eq(approvalRequests.id, correlationId.slice(APPROVAL_CORRELATION_PREFIX.length)),
						eq(approvalRequests.status, "pending"),
					),
				);
		}
		const result: IngestResult = await ingestInTransaction(
			uow,
			internalEvent({
				id: `wait-timeout:${job.waitId}`,
				type: "agent.wait.timeout",
				time: uow.now,
				subject: `wait/${job.waitId}`,
				correlationid: correlationId,
				causationid: null,
				hop: wait.hop,
				data: { agent_id: wait.wait.agentId, wait_id: job.waitId },
			}),
		);
		return result.status === "accepted" ? "timed_out" : "ignored";
	});
}
