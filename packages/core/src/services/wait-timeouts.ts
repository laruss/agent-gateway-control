import { QUEUES, type WaitTimeoutJob } from "@agent-gateway/contracts";
import { agentRuns, waitSubscriptions, withTransaction } from "@agent-gateway/db";
import { internalEvent } from "@agent-gateway/events";
import { eq } from "drizzle-orm";
import { approvalIdOf } from "./approval-store.ts";
import { settleApprovalOnTimeout } from "./approvals.ts";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import { type IngestResult, ingestInTransaction } from "./ingest.ts";
import { lockAgent, lockCascade, lockConfigShared } from "./store.ts";

export type WaitTimeoutOutcome = "timed_out" | "not_due" | "ignored";

/**
 * Fires when a wait's timeout is reached: emits an `agent.wait.timeout` event, which resolves
 * the wait and resumes the agent through normal routing. An approval's wait ends differently: a
 * pending request expires, an open action is settled, and `approval.resolved` resumes the agent.
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
			.select({
				wait: waitSubscriptions,
				hop: agentRuns.hop,
				traceparent: agentRuns.traceparent,
			})
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
		const approvalId = approvalIdOf(correlationId);
		if (approvalId !== null && (await settleApprovalOnTimeout(uow, approvalId))) {
			// The agent learns how the approval ended (expired, or its action settled) from
			// `approval.resolved`, which resolves this very wait.
			return "timed_out";
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
				traceparent: wait.traceparent,
			}),
		);
		return result.status === "accepted" ? "timed_out" : "ignored";
	});
}
