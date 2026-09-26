import { randomBytes } from "node:crypto";
import {
	type AgentTurnResult,
	AgentTurnResultSchema,
	type ApprovalRequestDraft,
	checkTurnResultAuthority,
	type JsonValue,
	type MattermostApprovalPayload,
	type MattermostId,
	type MattermostPostPayload,
	QUEUES,
	type RunError,
	type RunReport,
	type RunTimeoutJob,
	type RuntimeAdapterId,
	type RuntimeUsage,
	type WaitCondition,
} from "@agent-gateway/contracts";
import {
	agentInbox,
	agentRuns,
	approvalRequests,
	artifacts,
	contextSnapshots,
	memoryItems,
	policyDecisions,
	type RunOutcome,
	runtimeSessions,
	waitSubscriptions,
	withTransaction,
} from "@agent-gateway/db";
import { mattermostPost } from "@agent-gateway/events";
import { redactForStorage } from "@agent-gateway/logging";
import { and, eq } from "drizzle-orm";
import {
	approvalActionHash,
	checkRunScope,
	type OutcomeIssue,
	type RunScope,
	renderPostMessage,
	riskLevelFor,
	runRetryDelaySeconds,
	runScope,
} from "../outcome.ts";
import { requireTransition } from "../state-machine.ts";
import { clampWaitTimeout, isThreadBound } from "../waits.ts";
import { parseThreadRef, recordThreadSummary, threadCorrelationOf } from "./context-store.ts";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import { lockMemoryKey, supersedeMemory } from "./memory.ts";
import { enqueueAttempt, enqueueRunDeadline, scheduleAgent, sessionScope } from "./scheduler.ts";
import {
	audit,
	enqueueOutbox,
	loadActiveConfig,
	loadOwnerUserIds,
	loadTeamChannels,
	lockAgent,
	lockCascade,
	raiseAlert,
	setAgentState,
} from "./store.ts";

/** How long a human has to decide an approval. */
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

type RunRow = typeof agentRuns.$inferSelect;
type AgentRow = NonNullable<Awaited<ReturnType<typeof lockAgent>>>;

export type ReportOutcome =
	| "started"
	| "completed"
	| "retry_scheduled"
	| "failed"
	| "ignored_stale"
	| "ignored_unknown";

/** Correlations of the waits a completed report would create, sorted for a stable lock order. */
function waitCorrelations(report: RunReport): Readonly<string[]> {
	if (report.kind !== "completed") {
		return [];
	}
	const parsed = AgentTurnResultSchema.safeParse(report.result);
	if (!parsed.success || parsed.data.nextState.kind !== "waiting") {
		return [];
	}
	return [...new Set(parsed.data.nextState.waits.map((wait) => wait.correlationId))].sort();
}

function inProgress(run: RunRow): boolean {
	return run.status === "queued" || run.status === "running";
}

/**
 * Locks the agent, then the run, in the order every use case takes them. Returns null for an
 * unknown run or a report about another agent's run.
 */
async function lockRun(
	uow: UnitOfWork,
	runId: string,
	agentId: string | null,
): Promise<{ run: RunRow; agent: AgentRow } | null> {
	const { db } = uow.tx;
	const [peek] = await db
		.select({ agentId: agentRuns.agentId })
		.from(agentRuns)
		.where(eq(agentRuns.id, runId));
	if (peek === undefined || (agentId !== null && peek.agentId !== agentId)) {
		return null;
	}
	const agent = await lockAgent(db, peek.agentId);
	const [run] = await db
		.select()
		.from(agentRuns)
		.where(eq(agentRuns.id, runId))
		.for("no key update");
	return agent === null || run === undefined ? null : { run, agent };
}

/**
 * Applies a worker's report. The report is untrusted: stale attempts are ignored, and a
 * completed result is validated and checked against the authority fixed at scheduling.
 */
export async function handleRunReport(
	deps: ControlPlaneDeps,
	report: RunReport,
	/** The adapter whose report queue delivered the report. */
	adapter: RuntimeAdapterId,
): Promise<ReportOutcome> {
	return withTransaction(deps.pool, async (tx) => {
		const uow: UnitOfWork = { deps, tx, jobs: deps.jobs(tx), now: deps.clock() };
		// Waits about to be created: lock their cascades first (the documented lock order), so an
		// answer ingested concurrently either sees the new wait or is seen by its missed-answer scan.
		for (const correlationId of waitCorrelations(report)) {
			await lockCascade(uow, correlationId);
		}
		const locked = await lockRun(uow, report.runId, report.agentId);
		if (locked === null) {
			deps.log.warn("report for an unknown run", {
				run_id: report.runId,
				agent_id: report.agentId,
			});
			return "ignored_unknown";
		}
		const { run, agent } = locked;
		if (run.runtimeAdapter !== adapter) {
			deps.log.warn("report from another adapter's queue", { run_id: run.id, adapter });
			return "ignored_unknown";
		}
		if (!inProgress(run) || run.attempt !== report.attempt) {
			return "ignored_stale";
		}
		switch (report.kind) {
			case "started": {
				if (run.status === "queued") {
					// The time budget starts now, not when the run was queued.
					const deadline = new Date(uow.now.getTime() + run.timeoutSeconds * 1000);
					await tx.db
						.update(agentRuns)
						.set({
							status: "running",
							startedAt: uow.now,
							timeoutAt: deadline,
							runtimeVersion: report.runtimeVersion,
						})
						.where(eq(agentRuns.id, run.id));
					await enqueueRunDeadline(uow, run.id, run.attempt, deadline);
					if (agent.state === "queued") {
						await setAgentState(uow, agent.id, agent.state, "running", `run ${run.id} started`);
					}
				}
				return "started";
			}
			case "failed":
				return applyFailure(uow, run, agent, report.error, report.runtimeVersion, report.usage);
			case "completed":
				return applyCompletion(uow, run, agent, report.result, report.runtimeVersion);
		}
	});
}

/**
 * The controller's backstop. A started attempt without a report by its deadline failed
 * silently (the worker crashed or lost the job): it is retried through the attempt counter. An
 * attempt no worker has started is not failed, only alerted: work waits for a worker.
 */
export async function handleRunTimeout(
	deps: ControlPlaneDeps,
	job: RunTimeoutJob,
): Promise<ReportOutcome> {
	return withTransaction(deps.pool, async (tx) => {
		const uow: UnitOfWork = { deps, tx, jobs: deps.jobs(tx), now: deps.clock() };
		const locked = await lockRun(uow, job.runId, null);
		if (locked === null || !inProgress(locked.run) || locked.run.attempt !== job.attempt) {
			return "ignored_stale";
		}
		const { run, agent } = locked;
		if (run.status === "queued") {
			await raiseAlert(
				uow,
				`queued:${run.id}:${run.attempt}`,
				`Run ${run.id} of @${agent.id} is still queued; is a '${run.runtimeAdapter}' worker running? If its job was dead-lettered, pause and resume the agent to queue the work again.`,
			);
			return "ignored_stale";
		}
		if (run.timeoutAt.getTime() > uow.now.getTime()) {
			return "ignored_stale";
		}
		return applyFailure(
			uow,
			run,
			agent,
			{
				code: "timeout",
				retryable: true,
				detail: "no report before the run deadline; the worker may have stopped",
			},
			run.runtimeVersion ?? "unknown",
			null,
		);
	});
}

async function applyFailure(
	uow: UnitOfWork,
	run: RunRow,
	agent: AgentRow,
	error: RunError,
	runtimeVersion: string,
	usage: RuntimeUsage | null,
): Promise<ReportOutcome> {
	const { db } = uow.tx;
	const detail = redactForStorage(error.detail);
	if (error.retryable && run.attempt < run.maxAttempts) {
		const attempt = run.attempt + 1;
		const delaySeconds = runRetryDelaySeconds(run.attempt, uow.deps.random);
		const startAfter = new Date(uow.now.getTime() + delaySeconds * 1000);
		const timeoutSeconds = run.timeoutSeconds;
		const deadline = new Date(startAfter.getTime() + timeoutSeconds * 1000);
		const [snapshot] = await db
			.select({ input: contextSnapshots.input, configVersion: contextSnapshots.configVersion })
			.from(contextSnapshots)
			.where(eq(contextSnapshots.runId, run.id));
		if (snapshot === undefined) {
			throw new Error(`run '${run.id}' has no context snapshot`);
		}
		const input = { ...snapshot.input, deadline: deadline.toISOString() };
		await db.update(contextSnapshots).set({ input }).where(eq(contextSnapshots.runId, run.id));
		await db
			.update(agentRuns)
			.set({
				status: "queued",
				attempt,
				startedAt: null,
				timeoutAt: deadline,
				errorCode: error.code,
				errorDetailRedacted: detail,
				runtimeVersion,
			})
			.where(eq(agentRuns.id, run.id));
		await setAgentState(
			uow,
			agent.id,
			agent.state,
			requireTransition(agent.id, agent.state, "retry"),
			`run ${run.id} attempt ${attempt}`,
		);
		await enqueueAttempt(uow, {
			runId: run.id,
			attempt,
			adapter: run.runtimeAdapter,
			agentId: agent.id,
			model: run.model,
			sessionPolicy: agent.config.runtime.session_policy,
			sessionScope: sessionScope(snapshot.configVersion, snapshot.input),
			input,
			timeoutSeconds,
			startAfter,
		});
		await audit(uow, "system", "run.retry", "run", run.id, {
			attempt,
			error_code: error.code,
			delay_seconds: delaySeconds,
		});
		return "retry_scheduled";
	}

	await db
		.update(agentRuns)
		.set({
			status: "failed",
			finishedAt: uow.now,
			errorCode: error.code,
			errorDetailRedacted: detail,
			runtimeVersion,
			usage,
		})
		.where(eq(agentRuns.id, run.id));
	await setAgentState(
		uow,
		agent.id,
		agent.state,
		requireTransition(agent.id, agent.state, "fail"),
		`run ${run.id} failed: ${error.code}`,
	);
	await raiseAlert(
		uow,
		`run-failed:${run.id}`,
		`Run ${run.id} of @${agent.id} failed (${error.code}); the agent is FAILED until redriven.`,
		{ run_id: run.id, agent_id: agent.id, error_code: error.code, attempt: run.attempt },
	);
	await audit(uow, "system", "run.failed", "run", run.id, { error_code: error.code });
	return "failed";
}

function issuesDetail(issues: Readonly<OutcomeIssue[]>): string {
	return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

type SnapshotRow = typeof contextSnapshots.$inferSelect;

/**
 * What the run may reply to and wait on: its own events, and the thread its context was
 * assembled from. A turn resumed by a timeout carries no post, yet it may still answer in the
 * thread it was waiting in.
 */
async function completionScope(uow: UnitOfWork, snapshot: SnapshotRow): Promise<RunScope> {
	const scope = runScope([snapshot.input.trigger, ...snapshot.input.pendingInbox]);
	const ref = parseThreadRef(snapshot.threadRef);
	if (ref === null || scope.threadRoots.has(ref.rootPostId)) {
		return scope;
	}
	const correlationId = await threadCorrelationOf(uow.tx.db, ref);
	return {
		correlationIds: new Set([...scope.correlationIds, correlationId]),
		threadRoots: new Map([
			...scope.threadRoots,
			[ref.rootPostId, { channelId: ref.channelId, correlationId }],
		]),
		maxHop: scope.maxHop,
	};
}

async function applyCompletion(
	uow: UnitOfWork,
	run: RunRow,
	agent: AgentRow,
	rawResult: JsonValue,
	runtimeVersion: string,
): Promise<ReportOutcome> {
	const { db } = uow.tx;
	const parsed = AgentTurnResultSchema.safeParse(rawResult);
	if (!parsed.success) {
		await raiseAlert(
			uow,
			`invalid-output:${run.id}`,
			`Run ${run.id} of @${agent.id} returned a result that fails validation.`,
		);
		return applyFailure(
			uow,
			run,
			agent,
			{
				code: "invalid_output",
				retryable: false,
				detail: parsed.error.issues
					.slice(0, 10)
					.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
					.join("; "),
			},
			runtimeVersion,
			null,
		);
	}
	const result = parsed.data;
	const [snapshot] = await db
		.select()
		.from(contextSnapshots)
		.where(eq(contextSnapshots.runId, run.id));
	if (snapshot === undefined) {
		throw new Error(`run '${run.id}' has no context snapshot`);
	}
	const scope = await completionScope(uow, snapshot);
	const issues = [
		...checkTurnResultAuthority(result, snapshot.authority),
		...checkRunScope(result, scope),
	];
	if (issues.length > 0) {
		for (const issue of issues.slice(0, 20)) {
			await db.insert(policyDecisions).values({
				runId: run.id,
				agentId: agent.id,
				action: `turn_result.${issue.path}`,
				decision: "deny",
				reason: issue.message,
				policyVersion: snapshot.authority.toolPolicy.policyVersion,
				inputRedacted: { path: issue.path },
				createdAt: uow.now,
			});
		}
		await raiseAlert(
			uow,
			`authority:${run.id}`,
			`Run ${run.id} of @${agent.id} exceeded its authority; nothing from it was published.`,
			{ issues: issues.length },
		);
		return applyFailure(
			uow,
			run,
			agent,
			{ code: "invalid_output", retryable: false, detail: issuesDetail(issues) },
			runtimeVersion,
			result.usage,
		);
	}

	let approvers: MattermostId[] = [];
	if (result.nextState.kind === "needs_human") {
		approvers = await loadOwnerUserIds(uow.tx.db);
		if (approvers.length === 0) {
			return applyFailure(
				uow,
				run,
				agent,
				{
					code: "runtime_permanent",
					retryable: false,
					detail: "no approver is resolved to a Mattermost user id",
				},
				runtimeVersion,
				result.usage,
			);
		}
	}

	const artifactIds = await persistArtifacts(uow, run, result);
	await persistMessages(uow, run, agent, result, artifactIds, scope);
	await persistMemory(uow, run, agent, result);
	await persistSession(uow, agent.id, result, sessionScope(snapshot.configVersion, snapshot.input));
	// A thread's summary is read by every agent working in that thread's channel: a run that also
	// saw posts of another channel keeps its summary to itself.
	const threadRef = parseThreadRef(snapshot.threadRef);
	const carriedChannels = new Set(
		[snapshot.input.trigger, ...snapshot.input.pendingInbox].flatMap((event) => {
			const post = mattermostPost(event);
			return post === null ? [] : [post.channel_id];
		}),
	);
	if (
		threadRef !== null &&
		[...carriedChannels].every((channelId) => channelId === threadRef.channelId)
	) {
		await recordThreadSummary(uow, threadRef, {
			id: run.id,
			agentId: agent.id,
			summary: result.publicSummary,
		});
	}

	const outcome: RunOutcome = result.nextState.kind;
	let runStatus: "succeeded" | "failed" = "succeeded";
	let errorCode: string | null = null;
	let errorDetail: string | null = null;
	switch (result.nextState.kind) {
		case "idle":
			await setAgentState(
				uow,
				agent.id,
				agent.state,
				requireTransition(agent.id, agent.state, "complete_idle"),
				`run ${run.id}`,
			);
			break;
		case "waiting":
			await createWaits(uow, run, agent.id, result.nextState.waits, scope);
			await setAgentState(
				uow,
				agent.id,
				agent.state,
				requireTransition(agent.id, agent.state, "complete_waiting"),
				`run ${run.id}`,
			);
			break;
		case "needs_human": {
			await createApproval(uow, run, agent.id, result.nextState.approvalRequest, approvers);
			await setAgentState(
				uow,
				agent.id,
				agent.state,
				requireTransition(agent.id, agent.state, "complete_waiting"),
				`run ${run.id} needs a human`,
			);
			break;
		}
		case "failed":
			runStatus = "failed";
			errorCode = "agent_reported_failure";
			errorDetail = redactForStorage(result.nextState.publicError);
			await setAgentState(
				uow,
				agent.id,
				agent.state,
				requireTransition(agent.id, agent.state, "fail"),
				`run ${run.id} reported failure`,
			);
			await raiseAlert(
				uow,
				`run-failed:${run.id}`,
				`@${agent.id} reported a failure in run ${run.id}; the agent is FAILED until redriven.`,
			);
			break;
	}

	await db
		.update(agentRuns)
		.set({
			status: runStatus,
			outcome,
			finishedAt: uow.now,
			runtimeVersion,
			model: result.usage?.model ?? run.model,
			usage: result.usage,
			publicSummary: result.publicSummary,
			result,
			errorCode,
			errorDetailRedacted: errorDetail,
		})
		.where(eq(agentRuns.id, run.id));
	await db
		.update(agentInbox)
		.set({ status: "consumed" })
		.where(and(eq(agentInbox.runId, run.id), eq(agentInbox.status, "claimed")));
	await audit(uow, "system", "run.completed", "run", run.id, { outcome, status: runStatus });
	await scheduleAgent(uow, agent.id);
	return "completed";
}

async function persistArtifacts(
	uow: UnitOfWork,
	run: RunRow,
	result: AgentTurnResult,
): Promise<Map<string, string>> {
	const ids = new Map<string, string>();
	for (const artifact of result.artifacts) {
		const [row] = await uow.tx.db
			.insert(artifacts)
			.values({
				runId: run.id,
				agentId: run.agentId,
				key: artifact.key,
				kind: artifact.kind,
				workspacePath: artifact.workspacePath,
				url: artifact.url,
				sha256: artifact.sha256,
				mimeType: artifact.mimeType,
				sizeBytes: artifact.sizeBytes,
				visibility: artifact.visibility,
				description: artifact.description,
				createdAt: uow.now,
			})
			.returning({ id: artifacts.id });
		if (row !== undefined) {
			ids.set(artifact.key, row.id);
		}
	}
	return ids;
}

async function persistMessages(
	uow: UnitOfWork,
	run: RunRow,
	agent: AgentRow,
	result: AgentTurnResult,
	artifactIds: ReadonlyMap<string, string>,
	scope: RunScope,
): Promise<void> {
	for (const [index, message] of result.publicMessages.entries()) {
		const attachmentIds = message.attachments.flatMap((ref) => {
			const id =
				ref.artifactId ?? (ref.artifactKey === null ? undefined : artifactIds.get(ref.artifactKey));
			return id === undefined ? [] : [id];
		});
		const payload: MattermostPostPayload = {
			agentId: agent.id,
			runId: run.id,
			channelId: message.channelId,
			rootPostId: message.rootPostId,
			message: renderPostMessage(message),
			targetAgentIds: message.targetAgentIds,
			attachmentArtifactIds: attachmentIds,
			// A reply belongs to its thread's cascade, and every post builds on the highest hop the
			// run saw: coalesced inbox events cannot lower either.
			correlationId:
				message.rootPostId === null
					? run.correlationId
					: (scope.threadRoots.get(message.rootPostId)?.correlationId ?? run.correlationId),
			hop: Math.max(run.hop, scope.maxHop) + 1,
		};
		await enqueueOutbox(uow, {
			kind: "mattermost.post",
			destination: `channel/${message.channelId}`,
			payload,
			idempotencyKey: `mattermost-post:${run.id}:${index}`,
			runId: run.id,
		});
	}
}

/**
 * Stores the run's memory proposals. The agent's own private namespace is its own business: a
 * proposal there is accepted at once and supersedes the item with the same key. A shared
 * namespace reaches other agents' turns, so its proposals wait for an operator's review.
 */
async function persistMemory(
	uow: UnitOfWork,
	run: RunRow,
	agent: AgentRow,
	result: AgentTurnResult,
): Promise<void> {
	for (const proposal of result.memoryProposals) {
		const own = proposal.namespace === agent.config.memory.private_namespace;
		if (own) {
			await lockMemoryKey(uow, proposal.namespace, proposal.key);
			await supersedeMemory(uow, proposal.namespace, proposal.key);
		}
		await uow.tx.db.insert(memoryItems).values({
			namespace: proposal.namespace,
			key: proposal.key,
			content: proposal.content,
			sourceEventId: run.triggerEventId,
			sourceRunId: run.id,
			status: own ? "accepted" : "proposed",
			visibility: proposal.visibility,
			createdAt: uow.now,
		});
	}
}

async function persistSession(
	uow: UnitOfWork,
	agentId: string,
	result: AgentTurnResult,
	scope: string,
): Promise<void> {
	const session = result.session;
	if (session === null) {
		return;
	}
	const values = {
		agentId,
		adapter: session.adapter,
		providerSessionRef: session.providerSessionId,
		runtimeVersion: session.runtimeVersion,
		resumeMetadata: { scope },
		lastUsedAt: uow.now,
		expiresAt: session.expiresAt === null ? null : new Date(session.expiresAt),
		status: "active",
	};
	await uow.tx.db
		.insert(runtimeSessions)
		.values(values)
		.onConflictDoUpdate({
			target: [runtimeSessions.agentId, runtimeSessions.adapter],
			set: values,
		});
}

async function insertWait(
	uow: UnitOfWork,
	run: RunRow,
	agentId: string,
	condition: WaitCondition,
	timeoutAt: Date,
	threadRootIds: Readonly<MattermostId[]> | null,
): Promise<void> {
	const clamped = { ...condition, timeoutAt: timeoutAt.toISOString() };
	const [wait] = await uow.tx.db
		.insert(waitSubscriptions)
		.values({
			agentId,
			createdByRunId: run.id,
			status: "active",
			eventType: condition.eventType,
			correlationId: condition.correlationId,
			condition: clamped,
			threadRootIds: threadRootIds === null ? null : [...threadRootIds],
			timeoutAt,
			createdAt: uow.now,
		})
		.returning({ id: waitSubscriptions.id });
	if (wait === undefined) {
		throw new Error("wait insert returned no row");
	}
	await uow.jobs.send(QUEUES.waitTimeout, { waitId: wait.id }, { startAfter: timeoutAt });
}

/**
 * Creates the waits of a run. A wait on a reply is bound to the run's threads of the waited-on
 * conversation (and, when matching, to the threads the run itself starts).
 */
async function createWaits(
	uow: UnitOfWork,
	run: RunRow,
	agentId: string,
	waits: Readonly<WaitCondition[]>,
	scope: RunScope,
): Promise<void> {
	for (const condition of waits) {
		const roots = [...scope.threadRoots]
			.filter(([, thread]) => thread.correlationId === condition.correlationId)
			.map(([rootId]) => rootId);
		await insertWait(
			uow,
			run,
			agentId,
			condition,
			clampWaitTimeout(new Date(condition.timeoutAt), uow.now),
			isThreadBound(condition) ? roots : null,
		);
	}
}

/**
 * Persists an immutable approval request, posts its card through the outbox, and makes the
 * agent wait for the decision.
 */
async function createApproval(
	uow: UnitOfWork,
	run: RunRow,
	agentId: string,
	draft: ApprovalRequestDraft,
	approvers: Readonly<MattermostId[]>,
): Promise<void> {
	const config = await loadActiveConfig(uow.tx.db);
	if (config === null) {
		throw new Error("approval requested without an active configuration");
	}
	const expiresAt = new Date(uow.now.getTime() + APPROVAL_TTL_MS);
	const immutableActionHash = approvalActionHash(draft);
	const riskLevel = riskLevelFor(draft.actionType);
	const [approval] = await uow.tx.db
		.insert(approvalRequests)
		.values({
			requestedByAgentId: agentId,
			runId: run.id,
			actionType: draft.actionType,
			actionParams: draft.actionParams,
			immutableActionHash,
			actionSummary: draft.actionSummary,
			riskLevel,
			status: "pending",
			allowedApproverUserIds: [...approvers],
			nonce: randomBytes(24).toString("hex"),
			createdAt: uow.now,
			expiresAt,
		})
		.returning({ id: approvalRequests.id });
	if (approval === undefined) {
		throw new Error("approval insert returned no row");
	}
	const channels = await loadTeamChannels(uow.tx.db);
	const channelName = config.organization.mattermost.approvals_channel;
	const card: MattermostApprovalPayload = {
		approvalId: approval.id,
		channelName,
		channelId: channels.get(channelName) ?? null,
		requestedByAgentId: agentId,
		actionType: draft.actionType,
		actionSummary: draft.actionSummary,
		actionParams: draft.actionParams,
		riskLevel,
		immutableActionHash,
		expiresAt: expiresAt.toISOString(),
	};
	await enqueueOutbox(uow, {
		kind: "mattermost.approval",
		destination: `channel/${channelName}`,
		payload: card,
		idempotencyKey: `approval-card:${approval.id}`,
		runId: run.id,
	});
	const correlationId = `approval:${approval.id}`;
	for (const eventType of ["approval.granted", "approval.denied"] as const) {
		await insertWait(
			uow,
			run,
			agentId,
			{
				eventType,
				correlationId,
				expectedSenderAgentIds: [],
				expectedSenderUserIds: [],
				requireTargetAgentId: null,
				timeoutAt: expiresAt.toISOString(),
			},
			expiresAt,
			null,
		);
	}
	await audit(uow, "system", "approval.requested", "approval", approval.id, {
		run_id: run.id,
		action_type: draft.actionType,
	});
}

/**
 * A run attempt whose job no longer exists in the queue (deleted by retention, dead-lettered by
 * a crashed worker) or whose deadline backstop was lost: fails the attempt as retryable, so the
 * controller's attempt counter requeues it or, when attempts are used up, fails the run.
 * `jobId` fences the check: nothing happens if the attempt moved on meanwhile.
 */
export type ObservedAttempt = Readonly<{
	runId: string;
	jobId: string | null;
	status: "queued" | "running";
	attempt: number;
}>;

export async function failLostAttempt(
	deps: ControlPlaneDeps,
	observed: ObservedAttempt,
	detail: string,
): Promise<ReportOutcome> {
	return withTransaction(deps.pool, async (tx) => {
		const uow: UnitOfWork = { deps, tx, jobs: deps.jobs(tx), now: deps.clock() };
		const locked = await lockRun(uow, observed.runId, null);
		// Everything the probe saw must still hold under the lock: same job, status and attempt,
		// and a running attempt must really be past its deadline.
		const run = locked?.run;
		if (
			locked === null ||
			run === undefined ||
			run.jobId !== observed.jobId ||
			run.status !== observed.status ||
			run.attempt !== observed.attempt ||
			(run.status === "running" && run.timeoutAt.getTime() > uow.now.getTime())
		) {
			return "ignored_stale";
		}
		return applyFailure(
			uow,
			locked.run,
			locked.agent,
			{ code: "runtime_retryable", retryable: true, detail },
			locked.run.runtimeVersion ?? "unknown",
			null,
		);
	});
}
