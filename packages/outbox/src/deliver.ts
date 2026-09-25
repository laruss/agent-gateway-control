import { type JobSink, type JsonObject, type JsonValue, QUEUES } from "@agent-gateway/contracts";
import {
	auditLog,
	type OutboxKind,
	outbox,
	type Transaction,
	withTransaction,
} from "@agent-gateway/db";
import { type Logger, redactForStorage } from "@agent-gateway/logging";
import { and, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type pg from "pg";

/** What a deliverer receives: the idempotency key travels with every call. */
export type OutboxItem = Readonly<{
	id: string;
	kind: OutboxKind;
	destination: string;
	payload: JsonObject;
	idempotencyKey: string;
	attempt: number;
}>;

/**
 * Performs one kind of side effect. It must be idempotent by `idempotencyKey`: when the effect
 * already happened (a crash after the external call, before the receipt was stored), it returns
 * the existing receipt instead of repeating the effect.
 */
export type Deliverer = Readonly<{
	deliver: (item: OutboxItem) => Promise<JsonValue>;
}>;

export class DeliveryError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
		this.name = "DeliveryError";
	}
}

export type OutboxDeps = Readonly<{
	pool: pg.Pool;
	deliverers: Readonly<Partial<Record<OutboxKind, Deliverer>>>;
	clock: () => Date;
	log: Logger;
	/** Lease of one delivery attempt; an expired lease makes the item deliverable again. */
	leaseSeconds?: number;
}>;

/** `not_due`: the item waits for its backoff; the caller retries later. */
export type DeliveryOutcome = "sent" | "skipped" | "not_due" | "dead";

const DEFAULT_LEASE_SECONDS = 60;

/** When the queue's own retry (exponential, 5 s to 5 min) is due; reconciliation waits longer. */
export function retryDelaySeconds(attempts: number): number {
	return Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));
}

/**
 * Delivers one outbox item: claim it under a lease, perform the effect, store the receipt.
 * Duplicate jobs for the same item are harmless: only one can hold the lease, and a sent item
 * is never claimed again. A retryable failure throws so the queue retries with backoff; a
 * permanent one, or the last attempt, marks the item dead.
 */
export async function deliverOutboxItem(
	deps: OutboxDeps,
	outboxId: string,
): Promise<DeliveryOutcome> {
	const now = deps.clock();
	const lease = new Date(now.getTime() + (deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000);
	const claimed = await withTransaction(deps.pool, async ({ db }) => {
		const [row] = await db
			.update(outbox)
			.set({ status: "sending", attempts: sql`${outbox.attempts} + 1`, lockedUntil: lease })
			.where(
				and(
					eq(outbox.id, outboxId),
					or(
						// A pending item only once its backoff has passed, so duplicate jobs cannot
						// retry early.
						and(eq(outbox.status, "pending"), lte(outbox.nextAttemptAt, now)),
						and(
							eq(outbox.status, "sending"),
							or(isNull(outbox.lockedUntil), lt(outbox.lockedUntil, now)),
							lt(outbox.attempts, outbox.maxAttempts),
						),
					),
				),
			)
			.returning();
		return row ?? null;
	});
	if (claimed === null) {
		const [row] = await deps.pool
			.query<{ status: string }>("select status from outbox where id = $1", [outboxId])
			.then((result) => result.rows);
		return row?.status === "pending" ? "not_due" : "skipped";
	}
	const item: OutboxItem = {
		id: claimed.id,
		kind: claimed.kind,
		destination: claimed.destination,
		payload: claimed.payload,
		idempotencyKey: claimed.idempotencyKey,
		attempt: claimed.attempts,
	};
	const log = deps.log.child({ outbox_id: item.id, run_id: claimed.runId ?? undefined });

	// Fencing: only the holder of this claim may settle the item. After an expired lease a newer
	// claim bumped `attempts`, and a late settle of the old one changes nothing.
	const owned = and(
		eq(outbox.id, item.id),
		eq(outbox.status, "sending"),
		eq(outbox.attempts, claimed.attempts),
	);
	const deliverer = deps.deliverers[item.kind];
	try {
		if (deliverer === undefined) {
			throw new DeliveryError(`no deliverer for '${item.kind}'`, false);
		}
		const receipt = await deliverer.deliver(item);
		const recorded = await withTransaction(deps.pool, async ({ db }) =>
			db
				.update(outbox)
				.set({
					status: "sent",
					receipt,
					sentAt: deps.clock(),
					lockedUntil: null,
					lastErrorRedacted: null,
				})
				.where(owned)
				.returning({ id: outbox.id }),
		);
		if (recorded.length === 0) {
			// A newer claim owns the item; its idempotent delivery records the receipt.
			log.warn("outbox claim was taken over; late success not recorded", { kind: item.kind });
			return "skipped";
		}
		log.info("outbox item delivered", { kind: item.kind, attempt: item.attempt });
		return "sent";
	} catch (error) {
		const retryable = !(error instanceof DeliveryError) || error.retryable;
		const message = redactForStorage(error instanceof Error ? error.message : String(error));
		const dead = !retryable || claimed.attempts >= claimed.maxAttempts;
		const settled = await withTransaction(deps.pool, async ({ db }) => {
			const changed = await db
				.update(outbox)
				.set({
					status: dead ? "dead" : "pending",
					lockedUntil: null,
					lastErrorRedacted: message,
					nextAttemptAt: new Date(
						deps.clock().getTime() + retryDelaySeconds(claimed.attempts) * 1000,
					),
				})
				.where(owned)
				.returning({ id: outbox.id });
			// A claimant that lost its lease records nothing: the newer claim owns the item.
			if (changed.length === 0) {
				return false;
			}
			if (dead) {
				await db.insert(auditLog).values({
					at: deps.clock(),
					actor: "system",
					action: "outbox.dead",
					subjectType: "outbox",
					subjectId: item.id,
					detail: { kind: item.kind, attempts: claimed.attempts, error: message },
				});
			}
			return true;
		});
		if (!settled) {
			log.warn("outbox claim was taken over; late failure ignored", { kind: item.kind });
			return "skipped";
		}
		if (dead) {
			log.error("outbox item is dead", {
				kind: item.kind,
				attempt: item.attempt,
				error_message: message,
			});
			return "dead";
		}
		log.warn("outbox delivery failed; retrying", { kind: item.kind, attempt: item.attempt });
		throw error;
	}
}

/**
 * Re-enqueues deliveries that no job carries any more: pending items well past their retry time
 * (the job was lost) and sending items whose lease expired (the process died mid-delivery).
 * Items still inside their backoff are left to the queue. Duplicate jobs are safe.
 */
export async function reconcileOutbox(
	deps: Pick<OutboxDeps, "pool" | "clock">,
	jobsFor: (transaction: Transaction) => JobSink,
	staleSeconds = 60,
): Promise<number> {
	const now = deps.clock();
	const stale = new Date(now.getTime() - staleSeconds * 1000);
	return withTransaction(deps.pool, async (transaction) => {
		const { db } = transaction;
		// A delivery that keeps dying mid-flight (lease expired, never settled) must not be
		// reclaimed forever: once its attempts are used up it is dead.
		const poisoned = await db
			.update(outbox)
			.set({
				status: "dead",
				lockedUntil: null,
				lastErrorRedacted: "lease expired on the last attempt",
			})
			.where(
				and(
					eq(outbox.status, "sending"),
					lt(outbox.lockedUntil, now),
					gte(outbox.attempts, outbox.maxAttempts),
				),
			)
			.returning({ id: outbox.id, kind: outbox.kind, attempts: outbox.attempts });
		for (const item of poisoned) {
			await db.insert(auditLog).values({
				at: now,
				actor: "system",
				action: "outbox.dead",
				subjectType: "outbox",
				subjectId: item.id,
				detail: { kind: item.kind, attempts: item.attempts, error: "lease expired" },
			});
		}
		const rows = await db
			.select({ id: outbox.id })
			.from(outbox)
			.where(
				or(
					and(eq(outbox.status, "pending"), lt(outbox.nextAttemptAt, stale)),
					and(eq(outbox.status, "sending"), lt(outbox.lockedUntil, now)),
				),
			)
			.limit(500);
		const jobs = jobsFor(transaction);
		for (const row of rows) {
			await jobs.send(QUEUES.outboxDeliver, { outboxId: row.id });
		}
		if (rows.length > 0) {
			await db
				.update(outbox)
				.set({ nextAttemptAt: now })
				.where(
					and(
						inArray(
							outbox.id,
							rows.map((row) => row.id),
						),
						eq(outbox.status, "pending"),
					),
				);
		}
		return rows.length;
	});
}
