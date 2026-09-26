import { createHash } from "node:crypto";
import type {
	GatewayEvent,
	GmailCommitResult,
	GmailDelta,
	GmailMailboxId,
	IngestStatus,
} from "@agent-gateway/contracts";
import { errorFields, type Logger } from "@agent-gateway/logging";
import type { GmailClient, GmailMessageRef } from "./gmail-client.ts";
import { isExcludedMail, isInboxMail, messageEvent } from "./normalize.ts";

/** What the connector knows about its mailbox, as the control plane stored it. */
export type MailboxState = Readonly<{
	/** Every change up to this history id is ingested; null before the first start. */
	historyId: string | null;
	/** The account the cursor belongs to (SHA-256 of its address); null before the first start. */
	accountHash: string | null;
	watchExpiresAt: Date | null;
	watchRenewedAt: Date | null;
	/** The last completed sync (up to the mailbox's present), also one that found nothing new. */
	lastSyncAt: Date | null;
	/** When the cursor was created; null before. */
	startedAt: Date | null;
}>;

/**
 * The control plane behind one mailbox. Implemented by the connector app over `core`, in memory
 * by tests.
 */
export type GmailStore = Readonly<{
	state: () => Promise<MailboxState>;
	/** Creates the cursor at `historyId`, for the account, unless one exists. */
	start: (historyId: string, accountHash: string) => Promise<void>;
	/** Ingests the events and moves the cursor, in one transaction. */
	commit: (delta: GmailDelta) => Promise<GmailCommitResult>;
	/** Durably records a notification; the source may be acknowledged once this resolves. */
	recordNotification: (event: GatewayEvent) => Promise<IngestStatus>;
	/** Records a renewed watch; creates the cursor, for the account, if there is none. */
	recordWatch: (historyId: string, expiresAt: Date, accountHash: string) => Promise<void>;
	/** Raises an operator alert, once per key. */
	alert: (key: string, message: string) => Promise<void>;
}>;

export type SyncResult = Readonly<{
	kind: "started" | "synced" | "full_sync" | "stale";
	/** New message events stored. */
	accepted: number;
	historyId: string;
}>;

export type SyncDeps = Readonly<{
	mailboxId: GmailMailboxId;
	gmail: GmailClient;
	store: GmailStore;
	/** The account the credential belongs to; see {@link accountHash}. */
	accountHash: string;
	log: Logger;
	clock: () => Date;
	/** Stops a sync between messages (shutdown). */
	signal?: AbortSignal;
}>;

/** How a cursor names its account: SHA-256 of the lowercased address, never the address. */
export function accountHash(emailAddress: string): string {
	return createHash("sha256").update(emailAddress.trim().toLowerCase()).digest("hex");
}

/** Most messages a full sync reads; older mail after a history gap is not replayed. */
export const MAX_FULL_SYNC_MESSAGES = 500;
/** How far before the last sync a full sync looks for messages. */
const FULL_SYNC_OVERLAP_MS = 60 * 60 * 1000;

function laterHistoryId(a: string, b: string): boolean {
	return BigInt(a) > BigInt(b);
}

/**
 * The messages among refs, each once, in order. History is read filtered by the INBOX label, so
 * every ref is an inbox arrival; Gmail usually omits the labels, and when it sends them, spam
 * and the like are left out right away.
 */
function uniqueRefs(refs: Readonly<GmailMessageRef[]>): Readonly<GmailMessageRef[]> {
	const seen = new Set<string>();
	return refs.filter((ref) => {
		if (seen.has(ref.id) || isExcludedMail(ref.labelIds)) {
			return false;
		}
		seen.add(ref.id);
		return true;
	});
}

/** How a fetched message is admitted: by history (not excluded) or by listing (in the inbox). */
type Admission = "history" | "inbox";

/**
 * Events of the referenced messages. A message deleted meanwhile, or moved to spam or trash, is
 * skipped. One that cannot be normalized is skipped with an alert, rather than holding the
 * mailbox's cursor forever.
 */
async function messageEvents(
	deps: SyncDeps,
	refs: Readonly<GmailMessageRef[]>,
	admission: Admission,
): Promise<GatewayEvent[]> {
	const events: GatewayEvent[] = [];
	for (const ref of refs) {
		deps.signal?.throwIfAborted();
		const message = await deps.gmail.message(ref.id);
		if (
			message === null ||
			(admission === "history" ? isExcludedMail(message.labelIds) : !isInboxMail(message.labelIds))
		) {
			continue;
		}
		try {
			events.push(messageEvent(deps.mailboxId, message));
		} catch (error) {
			deps.log.warn("skipped a message that cannot be normalized", {
				...errorFields(error),
				mailbox_id: deps.mailboxId,
			});
			await deps.store.alert(
				`gmail:${deps.mailboxId}:unreadable:${ref.id}`,
				`A message in mailbox '${deps.mailboxId}' could not be normalized and was skipped (Gmail id ${ref.id}).`,
			);
		}
	}
	return events;
}

/**
 * Brings the Gateway up to date with the mailbox: every inbox message added since the cursor
 * becomes one event, and the cursor moves with each committed page. At-least-once: a crash
 * between reading and committing re-reads the page, and the events' deterministic ids make the
 * second ingest a no-op. A first start sets the cursor to now without replaying the mailbox.
 */
export async function syncMailbox(deps: SyncDeps): Promise<SyncResult> {
	const state = await deps.store.state();
	if (state.historyId === null) {
		const profile = await deps.gmail.profile();
		await deps.store.start(profile.historyId, deps.accountHash);
		return { kind: "started", accepted: 0, historyId: profile.historyId };
	}
	const start = state.historyId;
	let cursor = start;
	let pageToken: string | null = null;
	let accepted = 0;
	for (;;) {
		const page = await deps.gmail.history(start, pageToken);
		if (page === null) {
			return fullSync(deps, state, cursor);
		}
		const records = page.history ?? [];
		const refs = uniqueRefs(
			records.flatMap((record) => [
				...(record.messagesAdded ?? []).map((added) => added.message),
				...(record.labelsAdded ?? [])
					.filter((added) => added.labelIds.includes("INBOX"))
					.map((added) => added.message),
			]),
		);
		const lastPage = page.nextPageToken === undefined;
		// Within a page, the last record is as far as the page reaches; after the last page, the
		// mailbox's current history id.
		const reach = lastPage ? page.historyId : (records.at(-1)?.id ?? cursor);
		const to = laterHistoryId(reach, cursor) ? reach : cursor;
		const events = await messageEvents(deps, refs, "history");
		// The last page always commits, also without news: that records the completed sync.
		if (lastPage || to !== cursor || events.length > 0) {
			const outcome = await deps.store.commit({
				fromHistoryId: cursor,
				toHistoryId: to,
				events,
				fullSync: false,
				complete: lastPage,
				alert: null,
			});
			if (!outcome.committed) {
				return { kind: "stale", accepted, historyId: cursor };
			}
			accepted += outcome.accepted;
			cursor = to;
		}
		if (lastPage) {
			return { kind: "synced", accepted, historyId: cursor };
		}
		pageToken = page.nextPageToken ?? null;
	}
}

/**
 * History older than the cursor is gone (Gmail keeps about a week): list the inbox since shortly
 * before the last sync instead, and restart the cursor at the mailbox's current history id.
 * Messages already ingested are redeliveries and change nothing.
 */
async function fullSync(deps: SyncDeps, state: MailboxState, cursor: string): Promise<SyncResult> {
	// Taken first: whatever arrives while the listing runs is after it, and read by the next sync.
	const profile = await deps.gmail.profile();
	// From the last sync that reached the present; one that stopped halfway through the history
	// may have left older mail unread. Never synced: from when the cursor was created.
	const since =
		(state.lastSyncAt ?? state.startedAt ?? deps.clock()).getTime() - FULL_SYNC_OVERLAP_MS;
	const query = `after:${Math.floor(since / 1000)}`;
	const refs: GmailMessageRef[] = [];
	let pageToken: string | null = null;
	do {
		const list = await deps.gmail.listInbox(query, pageToken);
		refs.push(...(list.messages ?? []));
		pageToken = list.nextPageToken ?? null;
	} while (pageToken !== null && refs.length < MAX_FULL_SYNC_MESSAGES);
	// Bounded on purpose: a week-long outage must not wake agents for thousands of old mails.
	const truncated = pageToken !== null || refs.length > MAX_FULL_SYNC_MESSAGES;
	const listed = refs.slice(0, MAX_FULL_SYNC_MESSAGES);
	const events = await messageEvents(deps, listed, "inbox");
	// Oldest first, as history would have delivered them.
	events.reverse();
	const outcome = await deps.store.commit({
		fromHistoryId: cursor,
		toHistoryId: profile.historyId,
		events,
		fullSync: true,
		complete: true,
		alert: {
			key: `gmail:${deps.mailboxId}:full-sync:${profile.historyId}`,
			message: `Gmail history of mailbox '${deps.mailboxId}' was no longer available; ${listed.length} inbox message(s) since ${new Date(since).toISOString()} were re-read (those already known changed nothing)${truncated ? `; older mail beyond the latest ${MAX_FULL_SYNC_MESSAGES} was NOT read, check the mailbox by hand` : ""}.`,
		},
	});
	if (!outcome.committed) {
		return { kind: "stale", accepted: 0, historyId: cursor };
	}
	return { kind: "full_sync", accepted: outcome.accepted, historyId: profile.historyId };
}
