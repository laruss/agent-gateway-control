import type { GatewayEvent } from "./event.ts";

/**
 * How the control plane took an event: stored for the first time, a redelivery of a stored one
 * (same content), or a redelivery that differs from it (audited, not stored).
 */
export type IngestStatus = "accepted" | "duplicate" | "conflict";

/** A delta of a mailbox's history, ingested together with the cursor move. */
export type GmailDelta = Readonly<{
	/** The cursor the delta was read from; the commit is refused if it moved meanwhile. */
	fromHistoryId: string;
	/** Not below `fromHistoryId`; equal for a sync that found nothing new. */
	toHistoryId: string;
	events: Readonly<GatewayEvent[]>;
	/** The delta replaces lost history (a full sync). */
	fullSync: boolean;
	/**
	 * The sync reached the mailbox's present with this delta. Only then is the sync recorded as
	 * completed: a full sync after a history gap looks back from the last completed one.
	 */
	complete: boolean;
	/** An operator alert committed with the delta, so it cannot be lost after the cursor moved. */
	alert: Readonly<{ key: string; message: string }> | null;
}>;

export type GmailCommitResult = Readonly<{
	/** False when another sync moved the cursor first; nothing was written. */
	committed: boolean;
	/** Events stored for the first time (redeliveries excluded). */
	accepted: number;
}>;
