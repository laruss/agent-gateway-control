import type { ConsoleSnapshot } from "@agent-gateway/contracts";
import { type ConsoleStatus, loadActiveConfig, loadConsoleStatus } from "@agent-gateway/core";
import { withTransaction } from "@agent-gateway/db";
import type pg from "pg";

// ---------------------------------------------------------------------------
// The owner's console reads a bounded, cached, read-only projection of the Gateway's own state
// (ADR-023): core (`loadConsoleStatus`) owns the queries, this module owns the controller's own
// polling and cache policy, the same split `./metrics.ts` uses for the database gauges. It is
// deliberately separate from the scheduler's own `loadSystemStatus` call (an operator turn's own
// transaction, applied once per turn, never cached): that path stays transactional and
// uncached, this one is a shared, time-boxed read for however many console requests arrive.
// ---------------------------------------------------------------------------

/** Requests within this window share one collection. */
const CACHE_MS = 15_000;
/** One statement may take this long; a slow database reports a failed collection. */
const STATEMENT_TIMEOUT_MS = 2_000;
/** The whole collection, waiting for a connection included. */
const COLLECTION_DEADLINE_MS = 3_000;

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`console status collection took over ${ms} ms`)), ms);
	});
	return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Reads the console's projection in one read-only transaction, bounded by its own statement
 * timeout: a read-only characteristic (no write this module ever needs can happen by accident),
 * `SET LOCAL statement_timeout` so one slow statement fails the collection instead of holding a
 * connection open, and the per-agent daily budget from the active configuration (the same field
 * `alertConditions`'s own budget sweep reads: `organization.organization.budgets.per_agent_daily`).
 * Connection acquisition, every statement and the commit are all covered by the deadline the
 * cache below applies to this promise; `withTransaction` always rolls back and releases its
 * client, on this path's own failure or the deadline race abandoning it.
 */
export async function collectConsoleStatus(pool: pg.Pool, now: Date): Promise<ConsoleStatus> {
	return withTransaction(pool, async (tx) => {
		await tx.client.query("set transaction read only");
		await tx.client.query(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
		const config = await loadActiveConfig(tx.db);
		const perAgent = config?.organization.organization.budgets?.per_agent_daily ?? null;
		return loadConsoleStatus(tx, now, { perAgent });
	});
}

export type ConsoleStatusCollector = (now: Date) => Promise<ConsoleStatus>;

/**
 * What a console request is handed: a fresh collection, one kept past its cache window because
 * the next one failed or ran too long (still labeled with its own, older, time), or — only
 * before any collection has ever succeeded — nothing at all. Never an empty, healthy-looking
 * system in place of a real failure (ADR-023). `ConsoleSnapshot` itself is
 * `@agent-gateway/contracts`' own schema (`console-status.ts`), re-exported here so this
 * module's own callers keep importing it from here; the console frontend parses the same
 * `/api/status` JSON against that schema at the fetch boundary.
 */
export type { ConsoleSnapshot };

export type ConsoleStatusCache = Readonly<{
	get: () => Promise<ConsoleSnapshot>;
}>;

export type ConsoleStatusCacheOptions = Readonly<{
	clock?: () => Date;
	cacheMs?: number;
	deadlineMs?: number;
}>;

type PendingCollection = {
	readonly at: number;
	readonly promise: Promise<ConsoleStatus>;
	settled: boolean;
};

function collectionErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "console status collection failed";
}

/**
 * Caches the owner's console projection for `cacheMs`, sharing at most one collection across
 * every concurrent request (a slow or stuck collection is never started twice, and never piles
 * up database work behind it). A collection that fails, or is still running past `deadlineMs`,
 * falls back to the last successful snapshot — marked stale, with its own timestamp — or, before
 * any collection has ever succeeded, to `unavailable`.
 */
export function createConsoleStatusCache(
	collector: ConsoleStatusCollector,
	options: ConsoleStatusCacheOptions = {},
): ConsoleStatusCache {
	const clock = options.clock ?? (() => new Date());
	const cacheMs = options.cacheMs ?? CACHE_MS;
	const deadlineMs = options.deadlineMs ?? COLLECTION_DEADLINE_MS;
	let lastGood: Readonly<{ status: ConsoleStatus; at: Date }> | null = null;
	let pending: PendingCollection | null = null;

	function start(now: Date): PendingCollection {
		const entry: PendingCollection = {
			at: now.getTime(),
			promise: collector(now),
			settled: false,
		};
		entry.promise.then(
			(status) => {
				entry.settled = true;
				lastGood = { status, at: now };
			},
			() => {
				entry.settled = true;
				// A failed collection is never cached: the next request tries again right away,
				// instead of waiting out the rest of `cacheMs` on a result nobody got.
				if (pending === entry) {
					pending = null;
				}
			},
		);
		pending = entry;
		return entry;
	}

	return {
		async get(): Promise<ConsoleSnapshot> {
			const now = clock();
			const entry: PendingCollection =
				pending !== null && !(pending.settled && now.getTime() - pending.at > cacheMs)
					? pending
					: start(now);
			try {
				const status = await withDeadline(entry.promise, deadlineMs);
				return {
					state: "ok",
					asOf: (lastGood?.at ?? now).toISOString(),
					status,
				};
			} catch (error) {
				const message = collectionErrorMessage(error);
				return lastGood === null
					? { state: "unavailable", error: message }
					: {
							state: "stale",
							asOf: lastGood.at.toISOString(),
							status: lastGood.status,
							error: message,
						};
			}
		},
	};
}
