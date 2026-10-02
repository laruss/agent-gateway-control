import {
	type ApprovalNotice,
	type ApprovalReply,
	type ApprovalReplyOutcome,
	type ToolActionJob,
	type ToolNamespace,
	type ToolReport,
	toolActionIdempotencyKey,
	toolExecuteQueue,
	toolNamespace,
} from "@agent-gateway/contracts";
import {
	approvalReplies,
	approvalRequests,
	policyDecisions,
	toolActions,
	withTransaction,
} from "@agent-gateway/db";
import { childTraceparent, errorFields, redactForStorage } from "@agent-gateway/logging";
import {
	approvalActionHash,
	approvalCode,
	approvedActionIssues,
	parseApprovalCommand,
} from "@agent-gateway/policy";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
	type ApprovalRow,
	approvalByCardPost,
	extendApprovalWait,
	lockApproval,
	postApprovalNotice,
	postNoticeOnCard,
	recordDecision,
	resolveApproval,
	type ToolActionRow,
} from "./approval-store.ts";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import {
	audit,
	isKillSwitchOn,
	loadActiveConfig,
	loadAgentLifecycleStatus,
	loadAgents,
	loadOwnerUserIds,
	lockAgent,
	raiseAlert,
	runTraceparent,
} from "./store.ts";

/** How long a granted action may take to begin; `begin` refuses after it. */
export const TOOL_BEGIN_WINDOW_MS = 15 * 60 * 1000;
/** How long a begun action may run past its begin deadline before it counts as unknown. */
export const TOOL_RUN_GRACE_MS = 15 * 60 * 1000;
/** The agent's wait outlasts the action, so the sweep settles it before the wait times out. */
const WAIT_MARGIN_MS = 5 * 60 * 1000;

/** A reply's card thread is still being delivered: the listener reads the post again soon. */
export class ApprovalCardPendingError extends Error {
	constructor(postId: string) {
		super(`post '${postId}' may answer an approval card that is still being delivered`);
		this.name = "ApprovalCardPendingError";
	}
}

type Verdict = Readonly<{ notice: ApprovalNotice; detail: string | null }>;

/**
 * Handles an approval command the listener read in a card's thread. The author must be an
 * active human owner, in the request's approver snapshot and among the owners now; the command
 * must be exact and carry the request's code; the request must be pending and not expired, by
 * the controller's clock under the request's lock. The first valid decision wins; a post is
 * handled once. Every attempt is answered in the thread, and attempts by anyone who may not
 * decide are audited and alerted.
 */
export async function handleApprovalReply(
	deps: ControlPlaneDeps,
	reply: ApprovalReply,
): Promise<ApprovalReplyOutcome> {
	const command = parseApprovalCommand(reply.message);
	if (command === null) {
		return "ignored";
	}
	return withTransaction(deps.pool, async (tx) => {
		const uow: UnitOfWork = { deps, tx, jobs: deps.jobs(tx), now: deps.clock() };
		const lookup = await approvalByCardPost(uow, reply.rootPostId, reply.rootCardKey);
		if (lookup.kind === "pending") {
			throw new ApprovalCardPendingError(reply.postId);
		}
		if (lookup.kind === "none" || lookup.card.channelId !== reply.channelId) {
			return "not_a_card";
		}
		const locked = await lockApproval(uow, lookup.approvalId);
		if (locked === null) {
			return "not_a_card";
		}
		const [seen] = await tx.db
			.select({ notice: approvalReplies.notice })
			.from(approvalReplies)
			.where(eq(approvalReplies.postId, reply.postId));
		if (seen !== undefined) {
			return "replayed";
		}
		const { approval } = locked;
		const verdict = await decide(uow, approval, reply, command);
		await tx.db.insert(approvalReplies).values({
			postId: reply.postId,
			approvalId: approval.id,
			userId: reply.userId,
			notice: verdict.notice,
			createdAt: uow.now,
		});
		await postApprovalNotice(uow, `approval-reply:${reply.postId}`, {
			approvalId: approval.id,
			channelId: lookup.card.channelId,
			rootPostId: lookup.card.postId,
			notice: verdict.notice,
			userId: reply.userId,
			outcome: null,
			receipt: null,
			detail: verdict.detail,
		});
		return verdict.notice;
	});
}

/** Why the author may not decide this request, or null for an approver. */
async function notApprover(
	uow: UnitOfWork,
	approval: ApprovalRow,
	reply: ApprovalReply,
): Promise<string | null> {
	if (reply.author.isBot) {
		return "the author is a bot account";
	}
	if (reply.author.automated) {
		return "the post was made by an integration (webhook, bot or plugin props)";
	}
	if (!reply.author.active) {
		return "the author's account is deactivated";
	}
	if (!approval.allowedApproverUserIds.includes(reply.userId)) {
		return "the author is not an approver of this request";
	}
	if (!(await loadOwnerUserIds(uow.tx.db)).includes(reply.userId)) {
		return "the author is no longer an owner";
	}
	return null;
}

async function decide(
	uow: UnitOfWork,
	approval: ApprovalRow,
	reply: ApprovalReply,
	command: NonNullable<ReturnType<typeof parseApprovalCommand>>,
): Promise<Verdict> {
	const refusal = await notApprover(uow, approval, reply);
	if (refusal !== null) {
		await audit(uow, "system", "approval.decision_rejected", "approval", approval.id, {
			post_id: reply.postId,
			user_id: reply.userId,
			reason: refusal,
		});
		// One alert per request and author: a flood of attempts is one alert (each is audited).
		await raiseAlert(
			uow,
			`approval-forgery:${approval.id}:${reply.userId}`,
			`A command in the thread of approval ${approval.id} was ignored: ${refusal}.`,
			{ approval_id: approval.id, post_id: reply.postId, user_id: reply.userId },
		);
		return { notice: "not_an_approver", detail: null };
	}
	if (command.kind === "malformed") {
		return { notice: "malformed", detail: null };
	}
	if (command.code !== approvalCode(approval)) {
		await audit(uow, "system", "approval.wrong_code", "approval", approval.id, {
			post_id: reply.postId,
			user_id: reply.userId,
		});
		return { notice: "wrong_code", detail: null };
	}
	if (approval.status === "expired") {
		return { notice: "expired", detail: null };
	}
	if (approval.status !== "pending") {
		return { notice: "already_decided", detail: approval.status };
	}
	if (uow.now.getTime() >= approval.expiresAt.getTime()) {
		// Expiry is the controller's clock under the lock; the timeout job marks it soon.
		return { notice: "expired", detail: null };
	}
	return command.kind === "deny" ? deny(uow, approval, reply) : grant(uow, approval, reply);
}

async function deny(uow: UnitOfWork, approval: ApprovalRow, reply: ApprovalReply) {
	const [denied] = await uow.tx.db
		.update(approvalRequests)
		.set({
			status: "denied",
			decidedByUserId: reply.userId,
			decidedAt: uow.now,
			decisionPostId: reply.postId,
		})
		.where(eq(approvalRequests.id, approval.id))
		.returning();
	if (denied === undefined) {
		throw new Error(`approval '${approval.id}' vanished while locked`);
	}
	await audit(uow, `mattermost:${reply.userId}`, "approval.denied", "approval", approval.id, {
		post_id: reply.postId,
	});
	await recordDecision(uow, denied, "approval.denied", reply.userId);
	await resolveApproval(uow, denied, null, null);
	return { notice: "denied", detail: null } as const;
}

/**
 * What the policy says about executing the approval now, against the active configuration:
 * reasons it may not run, or none.
 */
async function executionIssues(uow: UnitOfWork, approval: ApprovalRow): Promise<string[]> {
	const config = await loadActiveConfig(uow.tx.db);
	const agent = (await loadAgents(uow.tx.db)).find((a) => a.id === approval.requestedByAgentId);
	if (config === null || agent === undefined) {
		return ["the requesting agent is no longer configured"];
	}
	if (agent.state === "disabled") {
		return [`@${agent.id} is disabled`];
	}
	const { permissions } = agent.config;
	const action = { actionType: approval.actionType, actionParams: approval.actionParams };
	const issues = [
		...approvedActionIssues(
			{
				allow: permissions.tools_allow,
				requireHumanApproval: permissions.tools_require_human_approval,
				deny: permissions.tools_deny,
			},
			{ agentId: agent.id, financeAgentId: config.organization.organization.finance_agent_id },
			action,
		),
	];
	if (approvalActionHash(action) !== approval.immutableActionHash) {
		issues.push("the stored action no longer matches its hash");
	}
	if (toolNamespace(approval.actionType) === null) {
		issues.push(`no tool namespace executes '${approval.actionType}'`);
	}
	return issues;
}

async function grant(uow: UnitOfWork, approval: ApprovalRow, reply: ApprovalReply) {
	const { db } = uow.tx;
	const issues = await executionIssues(uow, approval);
	if (await isKillSwitchOn(db)) {
		issues.push("the kill switch is on");
	}
	const namespace = toolNamespace(approval.actionType);
	const config = await loadActiveConfig(db);
	if (issues.length > 0 || namespace === null || config === null) {
		for (const reason of issues.slice(0, 20)) {
			await db.insert(policyDecisions).values({
				runId: approval.runId,
				agentId: approval.requestedByAgentId,
				action: approval.actionType,
				decision: "deny",
				reason,
				policyVersion: config?.version ?? "none",
				inputRedacted: { approval_id: approval.id, stage: "grant" },
				createdAt: uow.now,
			});
		}
		// Cancelled, not granted: no decision is recorded, only the reply that asked for it.
		const [cancelled] = await db
			.update(approvalRequests)
			.set({ status: "cancelled", decisionPostId: reply.postId })
			.where(eq(approvalRequests.id, approval.id))
			.returning();
		if (cancelled === undefined) {
			throw new Error(`approval '${approval.id}' vanished while locked`);
		}
		const detail = redactForStorage(`refused: ${issues.join("; ")}`).slice(0, 500);
		await audit(uow, `mattermost:${reply.userId}`, "approval.refused", "approval", approval.id, {
			post_id: reply.postId,
			reasons: issues.slice(0, 5),
		});
		await raiseAlert(
			uow,
			`approval-refused:${approval.id}`,
			`Approval ${approval.id} was approved, but '${approval.actionType}' of @${approval.requestedByAgentId} cannot run: ${issues.slice(0, 3).join("; ")}.`,
			{ approval_id: approval.id },
		);
		await resolveApproval(uow, cancelled, null, detail);
		return { notice: "refused", detail } as const;
	}

	const [granted] = await db
		.update(approvalRequests)
		.set({
			status: "granted",
			decidedByUserId: reply.userId,
			decidedAt: uow.now,
			decisionPostId: reply.postId,
		})
		.where(eq(approvalRequests.id, approval.id))
		.returning();
	if (granted === undefined) {
		throw new Error(`approval '${approval.id}' vanished while locked`);
	}
	const deadline = new Date(uow.now.getTime() + TOOL_BEGIN_WINDOW_MS);
	const idempotencyKey = toolActionIdempotencyKey(approval.id, approval.immutableActionHash);
	const [action] = await db
		.insert(toolActions)
		.values({
			approvalId: approval.id,
			agentId: approval.requestedByAgentId,
			namespace,
			actionType: approval.actionType,
			actionParams: approval.actionParams,
			immutableActionHash: approval.immutableActionHash,
			idempotencyKey,
			status: "queued",
			attempt: 1,
			configVersion: config.version,
			deadlineAt: deadline,
			createdAt: uow.now,
			traceparent: childTraceparent(await runTraceparent(uow, approval.runId)),
		})
		.returning();
	if (action === undefined) {
		throw new Error("tool action insert returned no row");
	}
	await db.insert(policyDecisions).values({
		runId: approval.runId,
		agentId: approval.requestedByAgentId,
		action: approval.actionType,
		decision: "allow",
		reason: "approved by an owner",
		policyVersion: config.version,
		inputRedacted: { approval_id: approval.id, stage: "grant" },
		createdAt: uow.now,
	});
	await enqueueToolAction(uow, action);
	await extendApprovalWait(
		uow,
		approval.id,
		new Date(deadline.getTime() + TOOL_RUN_GRACE_MS + WAIT_MARGIN_MS),
	);
	await audit(uow, `mattermost:${reply.userId}`, "approval.granted", "approval", approval.id, {
		post_id: reply.postId,
		tool_action_id: action.id,
	});
	await recordDecision(uow, granted, "approval.granted", reply.userId);
	return { notice: "granted", detail: null } as const;
}

async function enqueueToolAction(uow: UnitOfWork, action: ToolActionRow): Promise<void> {
	const job: ToolActionJob = {
		actionId: action.id,
		approvalId: action.approvalId,
		attempt: action.attempt,
		agentId: action.agentId,
		actionType: action.actionType,
		actionParams: action.actionParams,
		immutableActionHash: action.immutableActionHash,
		deadline: action.deadlineAt.toISOString(),
		...(action.traceparent === null ? {} : { traceparent: childTraceparent(action.traceparent) }),
	};
	const expireInSeconds = Math.ceil(
		(action.deadlineAt.getTime() - uow.now.getTime() + TOOL_RUN_GRACE_MS) / 1000,
	);
	await uow.jobs.send(toolExecuteQueue(action.namespace), job, { expireInSeconds });
}

export type ToolReportOutcome = "applied" | "refused" | "ignored";

/**
 * Applies a tool runner's report. It counts only for an action of the report queue's namespace
 * and the current attempt, and only moves the action forward: a late truthful receipt after
 * `unknown` is still recorded, and never resolves the agent's wait a second time.
 */
export async function handleToolReport(
	deps: ControlPlaneDeps,
	namespace: ToolNamespace,
	report: ToolReport,
): Promise<ToolReportOutcome> {
	return withTransaction(deps.pool, async (tx) => {
		const uow: UnitOfWork = { deps, tx, jobs: deps.jobs(tx), now: deps.clock() };
		const [peek] = await tx.db
			.select({ approvalId: toolActions.approvalId, namespace: toolActions.namespace })
			.from(toolActions)
			.where(eq(toolActions.id, report.actionId));
		if (peek === undefined || peek.namespace !== namespace) {
			deps.log.warn("tool report for an unknown action or from another namespace", {
				action_id: report.actionId,
				namespace,
			});
			return "ignored";
		}
		const locked = await lockApproval(uow, peek.approvalId);
		const action = locked?.action;
		if (locked === null || action === null || action === undefined) {
			return "ignored";
		}
		if (action.attempt !== report.attempt) {
			return "ignored";
		}
		// A retiring or already-retired agent publishes no further effects: its queued actions were
		// already cancelled and its running ones already asked to stop (`requestAgentRetire`); a
		// late report for one that did not stop in time is dropped here too, never posted to the
		// card or resolved as if the agent were still there to resume (ADR-026).
		const lifecycleStatus = await loadAgentLifecycleStatus(tx.db, action.agentId);
		if (lifecycleStatus === "retiring" || lifecycleStatus === "retired") {
			await audit(uow, "system", "tool_action.report_dropped_retired", "tool_action", action.id, {
				reported: report.kind,
				lifecycle_status: lifecycleStatus,
			});
			return "ignored";
		}
		if (report.kind === "refused") {
			// Nothing ran; the sweep settles the action by its deadline.
			await audit(uow, "system", "tool_action.refused", "tool_action", action.id, {
				reason: report.reason,
			});
			return "refused";
		}
		const next = nextStatus(action, report);
		if (next === null) {
			// A report the action cannot take any more (it settled, e.g. by hand): kept on record,
			// and alerted when it says something else happened.
			await audit(uow, "system", "tool_action.report_ignored", "tool_action", action.id, {
				reported: report.kind,
				status: action.status,
			});
			// A known failure of an action that was cancelled before it began changes nothing.
			const harmless = report.kind === "failed" && action.status === "cancelled";
			if (report.kind !== action.status && !harmless) {
				await raiseAlert(
					uow,
					`tool-conflict:${action.id}:${report.kind}`,
					`Tool action ${action.id} is recorded as '${action.status}', but its runner reported '${report.kind}'; check the provider.`,
					{ tool_action_id: action.id },
				);
			}
			return "ignored";
		}
		const [updated] = await tx.db
			.update(toolActions)
			.set({
				status: next,
				completedAt: next === "unknown" ? null : uow.now,
				receipt: report.kind === "succeeded" ? report.receipt : null,
				errorRedacted:
					report.kind === "succeeded" ? null : redactForStorage(report.error).slice(0, 500),
			})
			.where(eq(toolActions.id, action.id))
			.returning();
		if (updated === undefined) {
			throw new Error(`tool action '${action.id}' vanished while locked`);
		}
		await settled(uow, locked.approval, updated, action.status === "unknown");
		return "applied";
	});
}

/** Where a report moves an action, or null when it cannot (already final, or out of order). */
function nextStatus(action: ToolActionRow, report: ToolReport): ToolActionRow["status"] | null {
	switch (report.kind) {
		case "succeeded":
			return action.status === "running" || action.status === "unknown" ? "succeeded" : null;
		case "failed":
			// Nothing was sent (the provider refused, no executor, stopped before the call): a known
			// failure, reported after `begin`.
			return action.status === "queued" ||
				action.status === "running" ||
				action.status === "unknown"
				? "failed"
				: null;
		case "unknown":
			return action.status === "running" ? "unknown" : null;
		case "refused":
			return null;
	}
}

/** After an action moved: the receipt in the card's thread, the audit, the agent resumed. */
async function settled(
	uow: UnitOfWork,
	approval: ApprovalRow,
	action: ToolActionRow,
	late: boolean,
): Promise<void> {
	await audit(uow, "system", `tool_action.${action.status}`, "tool_action", action.id, {
		approval_id: approval.id,
	});
	if (action.status === "unknown") {
		await raiseAlert(
			uow,
			`tool-unknown:${action.id}`,
			`Tool action ${action.id} ('${action.actionType}' of @${action.agentId}) began but its outcome is unknown; check the provider before anything is retried.`,
			{ tool_action_id: action.id, approval_id: approval.id },
		);
	}
	if (late) {
		await raiseAlert(
			uow,
			`tool-late:${action.id}`,
			`Tool action ${action.id} reported '${action.status}' after it was recorded as unknown.`,
			{ tool_action_id: action.id },
		);
	}
	await postNoticeOnCard(uow, approval.id, `approval-executed:${approval.id}:${action.status}`, {
		notice: "executed",
		userId: null,
		outcome: action.status === "queued" || action.status === "running" ? null : action.status,
		receipt: action.receipt,
		detail: action.errorRedacted,
	});
	await resolveApproval(uow, approval, action, null);
}

/**
 * Settles what is overdue and resolves what ended: an action that did not begin by its
 * deadline is cancelled; one that began and did not report within the grace becomes unknown;
 * an approval that ended (denied, expired, cancelled, executed) but whose agent was not told
 * yet is resolved. Runs on the controller's reconcile tick and after kill-all.
 */
export async function sweepApprovals(deps: ControlPlaneDeps): Promise<number> {
	const now = deps.clock();
	const candidates = await deps.pool.query<{ id: string }>(
		`select a.id from approval_requests a
		   left join tool_actions t on t.approval_id = a.id
		  where a.resolved_at is null
		    and (a.status in ('denied', 'expired', 'cancelled')
		         or (a.status = 'pending' and a.expires_at <= $1)
		         or (a.status = 'granted'
		             and (t.status in ('succeeded', 'failed', 'unknown', 'cancelled')
		                  or (t.status = 'queued' and t.deadline_at <= $1)
		                  or (t.status = 'running' and t.deadline_at <= $2))))
		  order by a.created_at
		  limit 100`,
		[now, new Date(now.getTime() - TOOL_RUN_GRACE_MS)],
	);
	let handled = 0;
	for (const { id } of candidates.rows) {
		// One approval that cannot be settled must not hold up the others.
		try {
			if (await sweepOne(deps, id)) {
				handled += 1;
			}
		} catch (error) {
			deps.log.error("approval not settled; retried on the next sweep", {
				...errorFields(error),
				approval_id: id,
			});
		}
	}
	return handled + (await lateCardNotices(deps));
}

/** How long after its creation an approval's card is still checked for a missing last word. */
const LATE_CARD_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Cards that were delivered after their request ended (the ending found no card to answer
 * on): they get their last word now, so no card is left inviting a decision.
 */
async function lateCardNotices(deps: ControlPlaneDeps): Promise<number> {
	const since = new Date(deps.clock().getTime() - LATE_CARD_WINDOW_MS);
	const late = await deps.pool.query<{ id: string }>(
		`select a.id from approval_requests a
		   join outbox c on c.idempotency_key = 'approval-card:' || a.id and c.receipt ? 'postId'
		   left join tool_actions t on t.approval_id = a.id
		  where a.resolved_at is not null and a.created_at > $1
		    and (a.status = 'expired'
		         or (a.status = 'cancelled' and a.decision_post_id is null)
		         or (a.status = 'granted' and t.status in ('succeeded', 'failed', 'unknown', 'cancelled')))
		    and not exists (
		      select 1 from outbox n
		       where n.idempotency_key in (
		         'approval-final:' || a.id,
		         'approval-executed:' || a.id || ':succeeded',
		         'approval-executed:' || a.id || ':failed',
		         'approval-executed:' || a.id || ':unknown',
		         'approval-executed:' || a.id || ':cancelled'))
		  limit 50`,
		[since],
	);
	let posted = 0;
	for (const { id } of late.rows) {
		try {
			await withTransaction(deps.pool, async (tx) => {
				const uow: UnitOfWork = { deps, tx, jobs: deps.jobs(tx), now: deps.clock() };
				const locked = await lockApproval(uow, id);
				if (locked === null) {
					return;
				}
				const { approval, action } = locked;
				if (approval.status === "granted" && action !== null && action.status !== "cancelled") {
					await postNoticeOnCard(
						uow,
						approval.id,
						`approval-executed:${approval.id}:${action.status}`,
						{
							notice: "executed",
							userId: null,
							outcome:
								action.status === "queued" || action.status === "running" ? null : action.status,
							receipt: action.receipt,
							detail: action.errorRedacted,
						},
					);
				} else {
					await finalNotice(uow, approval, action);
				}
				posted += 1;
			});
		} catch (error) {
			deps.log.error("late card notice not posted; retried on the next sweep", {
				...errorFields(error),
				approval_id: id,
			});
		}
	}
	return posted;
}

/** Whether an approval still waits for a decision: only then is its card worth posting. */
export async function approvalPending(
	deps: ControlPlaneDeps,
	approvalId: string,
): Promise<boolean> {
	const result = await deps.pool.query<{ status: string }>(
		"select status from approval_requests where id = $1",
		[approvalId],
	);
	return result.rows[0]?.status === "pending";
}

async function sweepOne(deps: ControlPlaneDeps, approvalId: string): Promise<boolean> {
	return withTransaction(deps.pool, async (tx) => {
		const uow: UnitOfWork = { deps, tx, jobs: deps.jobs(tx), now: deps.clock() };
		const locked = await lockApproval(uow, approvalId);
		if (locked === null) {
			return false;
		}
		let { approval } = locked;
		if (approval.status === "pending" && approval.expiresAt.getTime() <= uow.now.getTime()) {
			// Expired without its wait's timeout (the wait is gone, e.g. the agent was disabled).
			approval = (await expire(uow, approval)) ?? approval;
		}
		const action = await settleOverdue(uow, approval, locked.action);
		if (action !== locked.action && action !== null) {
			await settled(uow, approval, action, false);
			return true;
		}
		await finalNotice(uow, approval, action);
		return resolveApproval(uow, approval, action, null);
	});
}

async function expire(uow: UnitOfWork, approval: ApprovalRow): Promise<ApprovalRow | undefined> {
	const [expired] = await uow.tx.db
		.update(approvalRequests)
		.set({ status: "expired" })
		.where(and(eq(approvalRequests.id, approval.id), eq(approvalRequests.status, "pending")))
		.returning();
	return expired;
}

/**
 * The card's last word for an approval that ended without a decision in its thread: expired,
 * withdrawn (kill-all, disable, a configuration change), or an action cancelled before it
 * began. Keyed like every other notice, so it is posted once.
 */
async function finalNotice(
	uow: UnitOfWork,
	approval: ApprovalRow,
	action: ToolActionRow | null,
): Promise<void> {
	const base = { userId: null, receipt: null, detail: null } as const;
	if (approval.status === "expired") {
		await postNoticeOnCard(uow, approval.id, `approval-final:${approval.id}`, {
			...base,
			notice: "expired",
			outcome: "expired",
		});
	} else if (approval.status === "cancelled" && approval.decisionPostId === null) {
		await postNoticeOnCard(uow, approval.id, `approval-final:${approval.id}`, {
			...base,
			notice: "withdrawn",
			outcome: "cancelled",
		});
	} else if (approval.status === "granted" && action?.status === "cancelled") {
		await postNoticeOnCard(uow, approval.id, `approval-executed:${approval.id}:cancelled`, {
			...base,
			notice: "executed",
			outcome: "cancelled",
			detail: action.errorRedacted,
		});
	}
}

/** An overdue action moved on (cancelled or unknown), or the action as it was. */
async function settleOverdue(
	uow: UnitOfWork,
	approval: ApprovalRow,
	action: ToolActionRow | null,
): Promise<ToolActionRow | null> {
	if (action === null || approval.status !== "granted") {
		return action;
	}
	const now = uow.now.getTime();
	const overdueQueued = action.status === "queued" && action.deadlineAt.getTime() <= now;
	const overdueRunning =
		action.status === "running" && action.deadlineAt.getTime() + TOOL_RUN_GRACE_MS <= now;
	if (!overdueQueued && !overdueRunning) {
		return action;
	}
	const [updated] = await uow.tx.db
		.update(toolActions)
		.set(
			overdueQueued
				? { status: "cancelled", completedAt: uow.now, errorRedacted: "did not begin in time" }
				: { status: "unknown", errorRedacted: "began but did not report in time" },
		)
		.where(eq(toolActions.id, action.id))
		.returning();
	return updated ?? action;
}

/**
 * The approval's wait timed out (its expiry, or a granted action's execution window): a
 * pending request expires, an action still open is settled like an overdue one. Then the
 * agent is resolved. The caller holds the approval's cascade, the configuration and the agent.
 */
export async function settleApprovalOnTimeout(
	uow: UnitOfWork,
	approvalId: string,
): Promise<boolean> {
	const locked = await lockApproval(uow, approvalId);
	if (locked === null) {
		return false;
	}
	let { approval, action } = locked;
	if (approval.status === "pending") {
		approval = (await expire(uow, approval)) ?? approval;
		await finalNotice(uow, approval, action);
	} else if (approval.status === "granted" && action !== null) {
		const open = action.status === "queued" || action.status === "running";
		if (open) {
			const [updated] = await uow.tx.db
				.update(toolActions)
				.set(
					action.status === "queued"
						? { status: "cancelled", completedAt: uow.now, errorRedacted: "did not begin in time" }
						: { status: "unknown", errorRedacted: "began but did not report in time" },
				)
				.where(eq(toolActions.id, action.id))
				.returning();
			action = updated ?? action;
			await settled(uow, approval, action, false);
			return true;
		}
	}
	return resolveApproval(uow, approval, action, null);
}

/**
 * Withdraws open approvals: pending requests are cancelled, queued actions cancelled (a fresh
 * approval is needed), running ones asked to stop (their report still counts). `agentId` limits
 * it to one agent (disable); null is kill-all. The agents are told by {@link sweepApprovals},
 * outside the caller's transaction. Returns how many were withdrawn.
 */
export async function withdrawOpenApprovals(
	uow: UnitOfWork,
	agentId: string | null,
	reason: string,
	/** Only requests still waiting for a decision; granted actions go on. */
	pendingOnly = false,
): Promise<number> {
	const { db } = uow.tx;
	if (pendingOnly) {
		const pending = await db
			.update(approvalRequests)
			.set({ status: "cancelled" })
			.where(
				and(
					eq(approvalRequests.status, "pending"),
					agentId === null ? undefined : eq(approvalRequests.requestedByAgentId, agentId),
				),
			)
			.returning({ id: approvalRequests.id });
		if (pending.length > 0) {
			await audit(uow, "system", "approvals.withdrawn", "gateway", agentId ?? "all", {
				reason,
				approvals: pending.map((row) => row.id).slice(0, 50),
			});
		}
		return pending.length;
	}
	const pending = await db
		.update(approvalRequests)
		.set({ status: "cancelled" })
		.where(
			and(
				eq(approvalRequests.status, "pending"),
				agentId === null ? undefined : eq(approvalRequests.requestedByAgentId, agentId),
			),
		)
		.returning({ id: approvalRequests.id });
	const queued = await db
		.update(toolActions)
		.set({ status: "cancelled", completedAt: uow.now, errorRedacted: reason.slice(0, 500) })
		.where(
			and(
				eq(toolActions.status, "queued"),
				agentId === null ? undefined : eq(toolActions.agentId, agentId),
			),
		)
		.returning({ id: toolActions.id });
	const running = await db
		.update(toolActions)
		.set({ cancelRequestedAt: uow.now })
		.where(
			and(
				eq(toolActions.status, "running"),
				isNull(toolActions.cancelRequestedAt),
				agentId === null ? undefined : eq(toolActions.agentId, agentId),
			),
		)
		.returning({ id: toolActions.id });
	if (pending.length + queued.length + running.length > 0) {
		await audit(uow, "system", "approvals.withdrawn", "gateway", agentId ?? "all", {
			reason,
			approvals: pending.map((row) => row.id).slice(0, 50),
			cancelled_actions: queued.map((row) => row.id).slice(0, 50),
			stop_requested: running.map((row) => row.id).slice(0, 50),
		});
	}
	return pending.length + queued.length;
}

/**
 * After a configuration change: queued actions the new policy no longer permits are cancelled
 * before they can begin. Runs in the config apply transaction, after the new agents are stored.
 */
export async function revokeQueuedActions(uow: UnitOfWork): Promise<number> {
	const { db } = uow.tx;
	const queued = await db
		.select({ approval: approvalRequests, actionId: toolActions.id })
		.from(toolActions)
		.innerJoin(approvalRequests, eq(approvalRequests.id, toolActions.approvalId))
		.where(eq(toolActions.status, "queued"));
	const revoked: string[] = [];
	for (const row of queued) {
		const issues = await executionIssues(uow, row.approval);
		if (issues.length === 0) {
			continue;
		}
		await lockAgent(db, row.approval.requestedByAgentId);
		await db
			.update(toolActions)
			.set({
				status: "cancelled",
				completedAt: uow.now,
				errorRedacted: redactForStorage(
					`revoked by a configuration change: ${issues.join("; ")}`,
				).slice(0, 500),
			})
			.where(and(eq(toolActions.id, row.actionId), eq(toolActions.status, "queued")));
		revoked.push(row.actionId);
	}
	if (revoked.length > 0) {
		await audit(uow, "system", "tool_actions.revoked", "gateway", "config", {
			tool_action_ids: revoked.slice(0, 50),
		});
	}
	return revoked.length;
}

export type ManualOutcome = "succeeded" | "failed" | "cancelled";

/**
 * An operator's word on an action whose outcome is unknown, after checking the provider by its
 * idempotency key: it settled as `succeeded`, `failed` (nothing happened) or `cancelled`.
 * Audited; the agent was told `unknown` already and is not resumed again.
 */
export async function settleToolAction(
	deps: ControlPlaneDeps,
	actionId: string,
	outcome: ManualOutcome,
	actor: string,
	note: string,
): Promise<ToolActionRow> {
	return withTransaction(deps.pool, async (tx) => {
		const uow: UnitOfWork = { deps, tx, jobs: deps.jobs(tx), now: deps.clock() };
		const [peek] = await tx.db
			.select({ approvalId: toolActions.approvalId })
			.from(toolActions)
			.where(eq(toolActions.id, actionId));
		const locked = peek === undefined ? null : await lockApproval(uow, peek.approvalId);
		const action = locked?.action ?? null;
		if (locked === null || action === null) {
			throw new Error(`tool action '${actionId}' does not exist`);
		}
		if (action.status !== "unknown") {
			throw new Error(
				`tool action '${actionId}' is '${action.status}'; only an unknown one is settled by hand`,
			);
		}
		const [updated] = await tx.db
			.update(toolActions)
			.set({
				status: outcome,
				completedAt: uow.now,
				errorRedacted: redactForStorage(`settled by ${actor}: ${note}`).slice(0, 500),
			})
			.where(eq(toolActions.id, actionId))
			.returning();
		if (updated === undefined) {
			throw new Error(`tool action '${actionId}' vanished while locked`);
		}
		await audit(uow, actor, "tool_action.settled", "tool_action", actionId, { outcome, note });
		await postNoticeOnCard(
			uow,
			locked.approval.id,
			`approval-executed:${locked.approval.id}:${outcome}`,
			{
				notice: "executed",
				userId: null,
				outcome,
				receipt: null,
				detail: updated.errorRedacted,
			},
		);
		return updated;
	});
}

/** Open tool actions for `doctor` and the CLI. */
export async function listToolActions(deps: ControlPlaneDeps, openOnly: boolean) {
	return withTransaction(deps.pool, async (tx) =>
		tx.db
			.select({
				id: toolActions.id,
				approvalId: toolActions.approvalId,
				agentId: toolActions.agentId,
				actionType: toolActions.actionType,
				status: toolActions.status,
				deadlineAt: toolActions.deadlineAt,
				cancelRequestedAt: toolActions.cancelRequestedAt,
				completedAt: toolActions.completedAt,
				error: toolActions.errorRedacted,
			})
			.from(toolActions)
			.where(openOnly ? inArray(toolActions.status, ["queued", "running", "unknown"]) : undefined)
			.orderBy(toolActions.createdAt)
			.limit(100),
	);
}
