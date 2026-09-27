import type {
	ApprovalDecisionData,
	ApprovalNotice,
	ApprovalOutcome,
	ApprovalResolvedData,
	JsonValue,
	MattermostApprovalReplyPayload,
	ToolReceipt,
} from "@agent-gateway/contracts";
import { QUEUES } from "@agent-gateway/contracts";
import {
	agentRuns,
	approvalRequests,
	outbox,
	toolActions,
	waitSubscriptions,
} from "@agent-gateway/db";
import { internalEvent } from "@agent-gateway/events";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { UnitOfWork } from "./deps.ts";
import { ingestInTransaction } from "./ingest.ts";
import { enqueueOutbox, lockAgent, lockCascade, lockConfigShared } from "./store.ts";

const APPROVAL_CORRELATION_PREFIX = "approval:";
const CARD_KEY_PREFIX = "approval-card:";

/** The correlation of everything about one approval: its wait, its events. */
export function approvalCorrelation(approvalId: string): string {
	return `${APPROVAL_CORRELATION_PREFIX}${approvalId}`;
}

/** The approval a correlation belongs to, or null. */
export function approvalIdOf(correlationId: string): string | null {
	return correlationId.startsWith(APPROVAL_CORRELATION_PREFIX)
		? correlationId.slice(APPROVAL_CORRELATION_PREFIX.length)
		: null;
}

export type ApprovalRow = typeof approvalRequests.$inferSelect;
export type ToolActionRow = typeof toolActions.$inferSelect;

/**
 * Locks one approval in the order every use case takes: its cascade, the configuration row in
 * share mode, the requesting agent, then the approval row and its tool action. Emitting its
 * events afterwards takes the same locks again, so nothing inside can deadlock with an ingest.
 * The wait timeout locks the approval's wait row before this, and a decision locks the wait
 * after it (through ingest); both take the approval's cascade and agent first, so they never
 * hold one row each.
 */
export async function lockApproval(
	uow: UnitOfWork,
	approvalId: string,
): Promise<Readonly<{ approval: ApprovalRow; action: ToolActionRow | null }> | null> {
	const { db } = uow.tx;
	const [peek] = await db
		.select({ agentId: approvalRequests.requestedByAgentId })
		.from(approvalRequests)
		.where(eq(approvalRequests.id, approvalId));
	if (peek === undefined) {
		return null;
	}
	await lockCascade(uow, approvalCorrelation(approvalId));
	await lockConfigShared(uow);
	await lockAgent(db, peek.agentId);
	const [approval] = await db
		.select()
		.from(approvalRequests)
		.where(eq(approvalRequests.id, approvalId))
		.for("update");
	if (approval === undefined) {
		return null;
	}
	const [action] = await db
		.select()
		.from(toolActions)
		.where(eq(toolActions.approvalId, approvalId))
		.for("update");
	return { approval, action: action ?? null };
}

/** The card as delivered: the post the listener bot made, and its channel. */
export type CardPost = Readonly<{ postId: string; channelId: string }>;

function receiptOf(value: JsonValue | null): CardPost | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const { postId, channelId } = value;
	return typeof postId === "string" && typeof channelId === "string" ? { postId, channelId } : null;
}

/** The delivered card of an approval, or null while it is not (yet) delivered. */
export async function approvalCard(uow: UnitOfWork, approvalId: string): Promise<CardPost | null> {
	const [row] = await uow.tx.db
		.select({ receipt: outbox.receipt })
		.from(outbox)
		.where(eq(outbox.idempotencyKey, `${CARD_KEY_PREFIX}${approvalId}`));
	return receiptOf(row?.receipt ?? null);
}

export type CardLookup =
	| Readonly<{ kind: "card"; approvalId: string; card: CardPost }>
	/** A card is still being delivered: the post may be its thread; ask again soon. */
	| Readonly<{ kind: "pending" }>
	| Readonly<{ kind: "none" }>;

/**
 * Which approval a thread root is the card of, by the cards' delivery receipts. A root the
 * listener bot posted with a card's key whose delivery has no receipt yet is `pending`: the
 * receipt is written a moment after the post. Any other root is no card.
 */
export async function approvalByCardPost(
	uow: UnitOfWork,
	rootPostId: string,
	rootCardKey: string | null,
): Promise<CardLookup> {
	const [row] = await uow.tx.db
		.select({ key: outbox.idempotencyKey, receipt: outbox.receipt })
		.from(outbox)
		.where(
			and(
				eq(outbox.kind, "mattermost.approval"),
				sql`${outbox.receipt} ->> 'postId' = ${rootPostId}`,
			),
		);
	const card = receiptOf(row?.receipt ?? null);
	if (row !== undefined && card !== null) {
		return { kind: "card", approvalId: row.key.slice(CARD_KEY_PREFIX.length), card };
	}
	if (rootCardKey === null || !rootCardKey.startsWith(CARD_KEY_PREFIX)) {
		return { kind: "none" };
	}
	const [inFlight] = await uow.tx.db
		.select({ id: outbox.id })
		.from(outbox)
		.where(
			and(
				eq(outbox.idempotencyKey, rootCardKey),
				eq(outbox.kind, "mattermost.approval"),
				isNull(outbox.receipt),
				ne(outbox.status, "dead"),
			),
		);
	return inFlight === undefined ? { kind: "none" } : { kind: "pending" };
}

/** A notice of the listener bot in the card's thread; one per key. */
export async function postApprovalNotice(
	uow: UnitOfWork,
	key: string,
	payload: MattermostApprovalReplyPayload,
): Promise<void> {
	await enqueueOutbox(uow, {
		kind: "mattermost.approval.reply",
		destination: `channel/${payload.channelId}/thread/${payload.rootPostId}`,
		payload,
		idempotencyKey: key,
	});
}

/** A notice about an approval whose card is delivered; nothing when it is not. */
export async function postNoticeOnCard(
	uow: UnitOfWork,
	approvalId: string,
	key: string,
	notice: Readonly<{
		notice: ApprovalNotice;
		userId: string | null;
		outcome: ApprovalOutcome | null;
		receipt: ToolReceipt | null;
		detail: string | null;
	}>,
): Promise<void> {
	const card = await approvalCard(uow, approvalId);
	if (card === null) {
		return;
	}
	await postApprovalNotice(uow, key, {
		approvalId,
		channelId: card.channelId,
		rootPostId: card.postId,
		...notice,
	});
}

/** How an approval ended for its agent, once it has; null while it is still open. */
export function approvalOutcome(
	approval: ApprovalRow,
	action: ToolActionRow | null,
): ApprovalOutcome | null {
	switch (approval.status) {
		case "denied":
		case "expired":
		case "cancelled":
			return approval.status;
		case "granted":
			if (action === null || action.status === "queued" || action.status === "running") {
				return null;
			}
			return action.status;
		default:
			return null;
	}
}

async function runHop(uow: UnitOfWork, runId: string): Promise<number> {
	const [run] = await uow.tx.db
		.select({ hop: agentRuns.hop })
		.from(agentRuns)
		.where(eq(agentRuns.id, runId));
	return run?.hop ?? 0;
}

/**
 * Emits `approval.resolved` for an approval that ended and has not been resolved yet: it
 * resumes the agent's wait (exempt from loop guards, deferred by kill-all or a budget hold).
 * The caller holds {@link lockApproval}. Returns whether an event was emitted.
 */
export async function resolveApproval(
	uow: UnitOfWork,
	approval: ApprovalRow,
	action: ToolActionRow | null,
	detail: string | null,
): Promise<boolean> {
	const outcome = approvalOutcome(approval, action);
	if (outcome === null || approval.resolvedAt !== null) {
		return false;
	}
	const data: ApprovalResolvedData = {
		approval_id: approval.id,
		action_type: approval.actionType,
		outcome,
		decided_by_user_id: approval.decidedByUserId,
		receipt: action?.receipt ?? null,
		detail: detail ?? action?.errorRedacted ?? null,
	};
	await ingestInTransaction(
		uow,
		internalEvent({
			id: `approval-resolved:${approval.id}`,
			type: "approval.resolved",
			time: uow.now,
			subject: `approval/${approval.id}`,
			correlationid: approvalCorrelation(approval.id),
			causationid: `run:${approval.runId}`,
			hop: await runHop(uow, approval.runId),
			data,
		}),
	);
	await uow.tx.db
		.update(approvalRequests)
		.set({ resolvedAt: uow.now })
		.where(eq(approvalRequests.id, approval.id));
	return true;
}

/** The record-only `approval.granted` / `approval.denied` event of a human decision. */
export async function recordDecision(
	uow: UnitOfWork,
	approval: ApprovalRow,
	type: "approval.granted" | "approval.denied",
	userId: string,
): Promise<void> {
	const data: ApprovalDecisionData = {
		approval_id: approval.id,
		action_type: approval.actionType,
		decided_by_user_id: userId,
	};
	await ingestInTransaction(
		uow,
		internalEvent({
			id: `${type}:${approval.id}`,
			type,
			time: uow.now,
			subject: `approval/${approval.id}`,
			correlationid: approvalCorrelation(approval.id),
			causationid: `run:${approval.runId}`,
			hop: await runHop(uow, approval.runId),
			data,
		}),
	);
}

/**
 * Moves the approval's wait (and its timeout job) to a later moment: a granted action keeps the
 * agent waiting until it settles.
 */
export async function extendApprovalWait(
	uow: UnitOfWork,
	approvalId: string,
	until: Date,
): Promise<void> {
	const rows = await uow.tx.db
		.update(waitSubscriptions)
		.set({ timeoutAt: until })
		.where(
			and(
				eq(waitSubscriptions.correlationId, approvalCorrelation(approvalId)),
				eq(waitSubscriptions.status, "active"),
			),
		)
		.returning({ id: waitSubscriptions.id });
	for (const row of rows) {
		// The earlier timeout job finds the wait not due and reschedules itself; this one is due.
		await uow.jobs.send(QUEUES.waitTimeout, { waitId: row.id }, { startAfter: until });
	}
}
