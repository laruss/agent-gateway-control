import type {
	GatewayEvent,
	GmailCommitResult,
	GmailDelta,
	GmailMailboxId,
	IngestStatus,
} from "@agent-gateway/contracts";
import { gmailMailboxes, withTransaction } from "@agent-gateway/db";
import { asc, eq, sql } from "drizzle-orm";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import { externalEvent, ingestInTransaction } from "./ingest.ts";
import { audit, raiseAlert } from "./store.ts";

/**
 * Control-plane state of the Gmail connector: one row per watched mailbox with its history
 * cursor and watch. The connector's transport (Google APIs) lives outside core.
 */

async function inTransaction<T>(
	deps: ControlPlaneDeps,
	work: (uow: UnitOfWork) => Promise<T>,
): Promise<T> {
	return withTransaction(deps.pool, (tx) =>
		work({ deps, tx, jobs: deps.jobs(tx), now: deps.clock() }),
	);
}

export type GmailMailboxRecord = Readonly<{
	mailboxId: GmailMailboxId;
	accountHash: string;
	historyId: string;
	watchExpiresAt: Date | null;
	watchRenewedAt: Date | null;
	lastNotificationAt: Date | null;
	lastSyncAt: Date | null;
	lastFullSyncAt: Date | null;
	/** When the cursor was created (the connector's first start on this mailbox). */
	createdAt: Date;
}>;

/** Null before the connector first started the mailbox. */
export async function loadGmailMailbox(
	deps: ControlPlaneDeps,
	mailboxId: GmailMailboxId,
): Promise<GmailMailboxRecord | null> {
	return inTransaction(deps, async ({ tx }) => {
		const [row] = await tx.db
			.select()
			.from(gmailMailboxes)
			.where(eq(gmailMailboxes.mailboxId, mailboxId));
		return row ?? null;
	});
}

export async function listGmailMailboxes(
	deps: ControlPlaneDeps,
): Promise<Readonly<GmailMailboxRecord[]>> {
	return inTransaction(deps, ({ tx }) =>
		tx.db.select().from(gmailMailboxes).orderBy(asc(gmailMailboxes.mailboxId)),
	);
}

/**
 * Creates the mailbox's cursor at `historyId`, for the account `accountHash` names, unless it
 * exists; an existing one is kept.
 */
export async function startGmailMailbox(
	deps: ControlPlaneDeps,
	mailboxId: GmailMailboxId,
	historyId: string,
	accountHash: string,
): Promise<void> {
	await inTransaction(deps, ({ tx, now }) =>
		tx.db
			.insert(gmailMailboxes)
			.values({ mailboxId, accountHash, historyId, createdAt: now })
			.onConflictDoNothing({ target: gmailMailboxes.mailboxId }),
	);
}

/** Records a renewed watch; creates the cursor at the watch's history id if there is none. */
export async function recordGmailWatch(
	deps: ControlPlaneDeps,
	mailboxId: GmailMailboxId,
	historyId: string,
	expiresAt: Date,
	accountHash: string,
): Promise<void> {
	await inTransaction(deps, ({ tx, now }) =>
		tx.db
			.insert(gmailMailboxes)
			.values({
				mailboxId,
				accountHash,
				historyId,
				watchExpiresAt: expiresAt,
				watchRenewedAt: now,
				createdAt: now,
			})
			.onConflictDoUpdate({
				target: gmailMailboxes.mailboxId,
				set: { watchExpiresAt: expiresAt, watchRenewedAt: now },
			}),
	);
}

/**
 * Ingests a delta of the mailbox's history and moves its cursor, in one transaction: a restart
 * resumes exactly after the last committed delta. Refused (nothing written) when the cursor is
 * no longer `fromHistoryId`, i.e. another sync committed first; the cursor never moves back.
 */
export async function commitGmailDelta(
	deps: ControlPlaneDeps,
	mailboxId: GmailMailboxId,
	delta: GmailDelta,
): Promise<GmailCommitResult> {
	const events = delta.events.map(externalEvent);
	return inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		// The mailbox row is always locked first, before the ingest locks (cascade, configuration,
		// agents): every transaction writing the row does so before it ingests, so none waits for
		// the row while holding an ingest lock.
		const [row] = await db
			.select({ historyId: gmailMailboxes.historyId })
			.from(gmailMailboxes)
			.where(eq(gmailMailboxes.mailboxId, mailboxId))
			.for("update");
		if (row === undefined || row.historyId !== delta.fromHistoryId) {
			return { committed: false, accepted: 0 };
		}
		let accepted = 0;
		for (const event of events) {
			const result = await ingestInTransaction(uow, event);
			if (result.status === "accepted") {
				accepted += 1;
			}
		}
		await db
			.update(gmailMailboxes)
			.set({
				historyId: sql`greatest(${gmailMailboxes.historyId}, ${delta.toHistoryId}::numeric)`,
				...(delta.complete ? { lastSyncAt: uow.now } : {}),
				...(delta.fullSync ? { lastFullSyncAt: uow.now } : {}),
			})
			.where(eq(gmailMailboxes.mailboxId, mailboxId));
		if (delta.alert !== null) {
			await raiseAlert(uow, delta.alert.key, delta.alert.message);
		}
		return { committed: true, accepted };
	});
}

/**
 * Forgets a mailbox's cursor and watch state (`gateway gmail reset`): its connector starts it
 * anew at the mailbox's present, e.g. after the credential moved to another account. Stored
 * events stay. False when there was nothing to forget.
 */
export async function resetGmailMailbox(
	deps: ControlPlaneDeps,
	mailboxId: GmailMailboxId,
	actor: string,
): Promise<boolean> {
	return inTransaction(deps, async (uow) => {
		const removed = await uow.tx.db
			.delete(gmailMailboxes)
			.where(eq(gmailMailboxes.mailboxId, mailboxId))
			.returning({ historyId: gmailMailboxes.historyId });
		const [row] = removed;
		if (row === undefined) {
			return false;
		}
		await audit(uow, actor, "gmail.reset", "gmail_mailbox", mailboxId, {
			history_id: row.historyId,
		});
		return true;
	});
}

/** Durably stores one change notification (deduplicated by its Pub/Sub message id). */
export async function recordGmailNotification(
	deps: ControlPlaneDeps,
	mailboxId: GmailMailboxId,
	event: GatewayEvent,
): Promise<IngestStatus> {
	const valid = externalEvent(event);
	return inTransaction(deps, async (uow) => {
		// Row first, then the ingest locks: the order `commitGmailDelta` takes them in.
		await uow.tx.db
			.update(gmailMailboxes)
			.set({ lastNotificationAt: uow.now })
			.where(eq(gmailMailboxes.mailboxId, mailboxId));
		return (await ingestInTransaction(uow, valid)).status;
	});
}

/** An operator alert outside any other use case (connectors), once per key. */
export async function raiseConnectorAlert(
	deps: ControlPlaneDeps,
	key: string,
	message: string,
): Promise<void> {
	await inTransaction(deps, (uow) => raiseAlert(uow, key, message));
}
