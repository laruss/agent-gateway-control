import type { GmailMailboxId, GmailMode } from "@agent-gateway/contracts";
import { errorFields, type Logger } from "@agent-gateway/logging";
import { z } from "zod";
import { GoogleAuthError } from "./auth.ts";
import type { GmailClient } from "./gmail-client.ts";
import { notificationEvent } from "./normalize.ts";
import type { PubsubClient, ReceivedMessage } from "./pubsub-client.ts";
import { accountHash, type GmailStore, type SyncResult, syncMailbox } from "./sync.ts";

/** Gmail's change notifications through Pub/Sub, when the connector uses them. */
export type PubsubNotifications = Readonly<{
	/** `projects/<project>/topics/<topic>`, which Gmail publishes the mailbox's changes to. */
	topicName: string;
	pubsub: PubsubClient;
}>;

export type GmailConnectorOptions = Readonly<{
	mailboxId: GmailMailboxId;
	gmail: GmailClient;
	/** Null polls the history every `reconcileMs` instead: no watch, no Pub/Sub. */
	notifications: PubsubNotifications | null;
	store: GmailStore;
	log: Logger;
	clock?: () => Date;
	/**
	 * Sync from the cursor this often: the polling interval, or with notifications the
	 * reconciliation that finds what a lost notification announced.
	 */
	reconcileMs?: number;
	/** How often the watch is checked. */
	watchCheckMs?: number;
	/** Renew the watch when it is this old (Gmail stops notifying after seven days). */
	renewAfterMs?: number;
	/** Backoff after failures: doubles from the minimum up to the maximum. */
	retryMinMs?: number;
	retryMaxMs?: number;
}>;

export type GmailConnectorStatus = Readonly<{
	/** False when Google refused the credential (revoked, or with other scopes). */
	authorized: boolean;
	mode: GmailMode;
	/** With notifications: the last pull succeeded. */
	pulling: boolean;
	/** With notifications: when the watch expires. */
	watchExpiresAt: Date | null;
	/** The last successful sync (also one that found nothing new). */
	lastSyncAt: Date | null;
	lastError: string | null;
}>;

export type RunningGmailConnector = Readonly<{
	status: () => GmailConnectorStatus;
	/** Syncs now (after a running sync), for tests and the CLI. */
	syncNow: () => Promise<SyncResult>;
	stop: () => Promise<void>;
}>;

/** Renew the watch this long before it expires, whatever its age. */
const RENEW_BEFORE_EXPIRY_MS = 2 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Consecutive pull failures that raise an alert (once per day). */
const PULL_FAILURES_ALERT = 5;
/** Pause after an empty pull that came back at once. */
const EMPTY_PULL_PAUSE_MS = 1000;
/** Most notifications pulled per request. */
const PULL_BATCH = 10;

/** The JSON Gmail publishes: which mailbox changed, up to which history id. */
const NotificationSchema = z.object({
	emailAddress: z.string().min(1),
	historyId: z
		.union([z.string(), z.number()])
		.transform(String)
		.pipe(z.string().regex(/^[1-9][0-9]{0,19}$/)),
});

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

function parseNotification(message: ReceivedMessage["message"]) {
	if (message.data === undefined) {
		return null;
	}
	try {
		const text = Buffer.from(message.data, "base64").toString("utf8");
		const parsed = NotificationSchema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * The Gmail connector of one mailbox: syncs the mailbox's history into events periodically.
 * With Pub/Sub notifications it also keeps the watch renewed, pulls the notifications, records
 * each durably before acknowledging it and syncs on every one; the periodic sync still runs,
 * because Gmail may delay or drop notifications.
 * Failures are retried with backoff and never stop the process; the status says what is
 * failing, and alerts reach the operator.
 */
export function startGmailConnector(options: GmailConnectorOptions): RunningGmailConnector {
	const { mailboxId, gmail, notifications, store, log } = options;
	const clock = options.clock ?? (() => new Date());
	const reconcileMs = options.reconcileMs ?? 5 * 60_000;
	const watchCheckMs = options.watchCheckMs ?? 60 * 60_000;
	const renewAfterMs = options.renewAfterMs ?? DAY_MS;
	const retryMinMs = options.retryMinMs ?? 1000;
	const retryMaxMs = options.retryMaxMs ?? 5 * 60_000;
	const stopping = new AbortController();
	const signal = stopping.signal;

	let authorized = true;
	let pulling = false;
	let watchExpiresAt: Date | null = null;
	let lastSyncAt: Date | null = null;
	let lastError: string | null = null;

	const failed = async (what: string, error: unknown) => {
		if (signal.aborted) {
			// Calls cut off by the shutdown are no failures.
			return;
		}
		lastError = `${what}: ${error instanceof Error ? error.message : String(error)}`;
		log.warn(`gmail ${what} failed`, { ...errorFields(error), mailbox_id: mailboxId });
		if (error instanceof GoogleAuthError) {
			authorized = false;
			await store
				.alert(
					`gmail:${mailboxId}:auth:${error.failure}:${clock().toISOString().slice(0, 10)}`,
					`Gmail connector of mailbox '${mailboxId}' cannot use its Google credential: ${error.message}. No mail is read until it is fixed: run 'gateway gmail authorize${mode === "pubsub" ? " --pubsub" : ""}' and restart the connector.`,
				)
				.catch((alertError: unknown) =>
					log.error("gmail alert failed", { ...errorFields(alertError), mailbox_id: mailboxId }),
				);
		}
	};
	const succeeded = () => {
		authorized = true;
	};
	const backoff = (failures: number) =>
		Math.min(retryMaxMs, retryMinMs * 2 ** Math.min(failures - 1, 16));

	// The account the credential signs in to, checked once against the one the stored cursor
	// belongs to: a credential re-authorized for another account must not continue from this
	// cursor (history ids of different accounts are unrelated) or read that account's mail.
	let account: Readonly<{ address: string; hash: string }> | null = null;
	let refused = false;
	const identify = async (): Promise<Readonly<{ address: string; hash: string }>> => {
		if (account !== null) {
			return account;
		}
		if (refused) {
			throw new Error(lastError ?? "refused");
		}
		const profile = await gmail.profile();
		const identity = {
			address: profile.emailAddress.trim().toLowerCase(),
			hash: accountHash(profile.emailAddress),
		};
		const stored = (await store.state()).accountHash;
		if (stored !== null && stored !== identity.hash) {
			refused = true;
			authorized = false;
			lastError = "the credential belongs to another account than the mailbox's cursor";
			await store.alert(
				`gmail:${mailboxId}:account:${identity.hash}`,
				`Gmail connector of mailbox '${mailboxId}' was authorized for another Google account than the one it has been reading. It reads nothing; run 'gateway gmail reset ${mailboxId}' to start this mailbox anew with the new account, or authorize the original account again.`,
			);
			markInitialized();
			throw new Error(lastError);
		}
		account = identity;
		return identity;
	};

	// Sync and pull wait for the first watch renewal (or its first failure), which starts the
	// cursor of a new mailbox.
	let markInitialized: () => void = () => undefined;
	const initialized = new Promise<void>((resolve) => {
		markInitialized = resolve;
	});
	signal.addEventListener("abort", () => markInitialized(), { once: true });

	// Sync: one at a time; a request during a sync runs another one right after it.
	let syncing: Promise<SyncResult> | null = null;
	const mode: GmailMode = notifications === null ? "poll" : "pubsub";
	let modeRecorded = false;
	let again = false;
	const runSync = async (): Promise<SyncResult> => {
		try {
			for (;;) {
				again = false;
				const result = await syncMailbox({
					mailboxId,
					gmail,
					store,
					log,
					clock,
					signal,
					accountHash: (await identify()).hash,
				});
				if (result.kind === "synced" || result.kind === "full_sync") {
					// Health counts syncs that reached the mailbox's present only.
					lastSyncAt = clock();
					if (!modeRecorded) {
						// Once per process, on a cursor that now surely exists.
						await store.recordMode(mode, Math.ceil(reconcileMs / 1000));
						modeRecorded = true;
					}
				}
				succeeded();
				if (result.accepted > 0 || result.kind !== "synced") {
					log.info("gmail mailbox synced", {
						mailbox_id: mailboxId,
						kind: result.kind,
						accepted: result.accepted,
					});
				}
				if (!again || signal.aborted) {
					return result;
				}
			}
		} finally {
			// Cleared with no await after the last check of `again`: a request arriving later
			// starts a new sync instead of joining the finished one.
			syncing = null;
			if (again && !signal.aborted) {
				// A request that came during a failed sync still gets its sync.
				queueMicrotask(requestSync);
			}
		}
	};
	const syncNow = (): Promise<SyncResult> => {
		if (syncing !== null) {
			again = true;
			return syncing;
		}
		syncing = runSync();
		return syncing;
	};
	const requestSync = () => {
		syncNow().catch((error: unknown) => failed("sync", error));
	};

	const syncLoop = async () => {
		await initialized;
		let failures = 0;
		while (!signal.aborted && !refused) {
			try {
				await syncNow();
				failures = 0;
				await sleep(reconcileMs, signal);
			} catch (error) {
				failures += 1;
				await failed("sync", error);
				await sleep(Math.min(backoff(failures), reconcileMs), signal);
			}
		}
	};

	const ensureWatch = async () => {
		const identity = await identify();
		const state = await store.state();
		watchExpiresAt = state.watchExpiresAt;
		const now = clock().getTime();
		const due =
			state.watchRenewedAt === null ||
			state.watchExpiresAt === null ||
			now - state.watchRenewedAt.getTime() >= renewAfterMs ||
			state.watchExpiresAt.getTime() - now < RENEW_BEFORE_EXPIRY_MS;
		if (!due) {
			markInitialized();
			return;
		}
		if (notifications === null) {
			return;
		}
		const watch = await gmail.watch(notifications.topicName);
		// Creates the cursor at the watch's history id on a first start: the first sync then
		// reads everything the watch notifies about, and nothing races it for the cursor.
		await store.recordWatch(watch.historyId, watch.expiresAt, identity.hash);
		watchExpiresAt = watch.expiresAt;
		markInitialized();
		succeeded();
		log.info("gmail watch renewed", {
			mailbox_id: mailboxId,
			expires_at: watch.expiresAt.toISOString(),
		});
	};
	const watchLoop = async () => {
		let failures = 0;
		let first = true;
		while (!signal.aborted && !refused) {
			try {
				await ensureWatch();
				failures = 0;
				await sleep(watchCheckMs, signal);
			} catch (error) {
				if (refused) {
					return;
				}
				if (first) {
					first = false;
					// Syncing starts without a watch; mail then arrives by the periodic sync only.
					markInitialized();
				}
				failures += 1;
				await failed("watch renewal", error);
				const expiresAt = watchExpiresAt;
				if (
					expiresAt === null ||
					expiresAt.getTime() - clock().getTime() < RENEW_BEFORE_EXPIRY_MS
				) {
					await store
						.alert(
							`gmail:${mailboxId}:watch:${clock().toISOString().slice(0, 10)}`,
							expiresAt === null || expiresAt <= clock()
								? `Gmail watch of mailbox '${mailboxId}' is not active and cannot be renewed; new mail is found only by the periodic sync.`
								: `Gmail watch of mailbox '${mailboxId}' expires at ${expiresAt.toISOString()} and cannot be renewed.`,
						)
						.catch((alertError: unknown) =>
							log.error("gmail alert failed", {
								...errorFields(alertError),
								mailbox_id: mailboxId,
							}),
						);
				}
				await sleep(Math.min(backoff(failures), watchCheckMs), signal);
			}
		}
	};

	const handle = async (received: ReceivedMessage, address: string): Promise<"ack" | "retry"> => {
		const notification = parseNotification(received.message);
		if (notification === null) {
			// Redelivering a malformed message would never make it valid.
			log.warn("dropped a malformed Pub/Sub message", { mailbox_id: mailboxId });
			return "ack";
		}
		if (notification.emailAddress.toLowerCase() !== address) {
			log.warn("dropped a notification of another mailbox", { mailbox_id: mailboxId });
			return "ack";
		}
		try {
			await store.recordNotification(
				notificationEvent(
					mailboxId,
					received.message.messageId,
					received.message.publishTime,
					notification.historyId,
				),
			);
			return "ack";
		} catch (error) {
			await failed("notification record", error);
			return "retry";
		}
	};
	const pullLoop = async (pubsub: PubsubClient) => {
		await initialized;
		let failures = 0;
		while (!signal.aborted && !refused) {
			try {
				// Notifications name the mailbox by address; only the watched one counts.
				const { address } = await identify();
				const pulledAt = Date.now();
				const received = await pubsub.pull(PULL_BATCH, signal);
				pulling = true;
				if (received.length === 0 && Date.now() - pulledAt < EMPTY_PULL_PAUSE_MS) {
					// Pub/Sub may answer an empty pull at once; do not spin on it.
					await sleep(EMPTY_PULL_PAUSE_MS, signal);
				}
				succeeded();
				const acks: string[] = [];
				let retry = false;
				for (const message of received) {
					if ((await handle(message, address)) === "retry") {
						// Not acknowledged: Pub/Sub delivers it again after its ack deadline.
						retry = true;
						break;
					}
					acks.push(message.ackId);
				}
				await pubsub.acknowledge(acks);
				if (acks.length > 0) {
					requestSync();
				}
				if (retry) {
					failures += 1;
					await sleep(backoff(failures), signal);
				} else {
					failures = 0;
				}
			} catch (error) {
				if (signal.aborted) {
					break;
				}
				pulling = false;
				failures += 1;
				await failed("pull", error);
				if (failures === PULL_FAILURES_ALERT) {
					await store
						.alert(
							`gmail:${mailboxId}:pull:${clock().toISOString().slice(0, 10)}`,
							`Gmail connector of mailbox '${mailboxId}' cannot pull its notifications (${error instanceof Error ? error.message : "failed"}); new mail is found only by the periodic sync.`,
						)
						.catch((alertError: unknown) =>
							log.error("gmail alert failed", {
								...errorFields(alertError),
								mailbox_id: mailboxId,
							}),
						);
				}
				await sleep(backoff(failures), signal);
			}
		}
	};

	if (notifications === null) {
		// Polling: nothing to set up first; the first sync starts the cursor.
		markInitialized();
	}
	const loops =
		notifications === null
			? [syncLoop()]
			: [syncLoop(), watchLoop(), pullLoop(notifications.pubsub)];
	log.info("gmail connector started", { mailbox_id: mailboxId });
	return {
		status: () => ({
			authorized,
			mode,
			pulling,
			watchExpiresAt,
			lastSyncAt,
			lastError,
		}),
		// Also from outside, never before the first watch attempt settled the cursor.
		syncNow: () => initialized.then(syncNow),
		stop: async () => {
			stopping.abort();
			await Promise.allSettled([...loops, ...(syncing === null ? [] : [syncing])]);
			log.info("gmail connector stopped", { mailbox_id: mailboxId });
		},
	};
}
