import type { RuntimeAdapterId, WorkerStatusReport } from "@agent-gateway/contracts";
import {
	agents,
	runtimeAvailability,
	runtimeWorkers,
	type Transaction,
	withTransaction,
} from "@agent-gateway/db";
import { redactForStorage } from "@agent-gateway/logging";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import { raiseAlert } from "./store.ts";

/** Workers send a heartbeat this often. */
export const WORKER_HEARTBEAT_MS = 30_000;
/** A worker silent for longer than this is gone; an older heartbeat is ignored. */
export const WORKER_STALE_MS = 3 * WORKER_HEARTBEAT_MS;
/**
 * How long a change of availability must last before it is settled and alerted: a restart,
 * a deploy or one failed probe passes without an alert.
 */
export const RUNTIME_STABLE_MS = 2 * WORKER_HEARTBEAT_MS;
/** Rows of workers silent for longer than this are deleted. */
const WORKER_RETENTION_MS = 7 * 24 * 3_600_000;

export type RuntimeHealthOptions = Readonly<{ stableMs?: number }>;

export type RuntimeHealth = Readonly<{
	adapter: RuntimeAdapterId;
	available: boolean;
	/** Versions of the ready workers, sorted. */
	runtimeVersions: Readonly<string[]>;
	/** Versions every fresh worker reported, ready or not, sorted. */
	reportedVersions: Readonly<string[]>;
	readyWorkers: number;
	/** The newest probe detail of an unavailable worker, if any. */
	detail: string | null;
}>;

type WorkerRow = typeof runtimeWorkers.$inferSelect;

function healthOf(
	adapter: RuntimeAdapterId,
	rows: Readonly<WorkerRow[]>,
	now: Date,
): RuntimeHealth {
	const fresh = rows.filter(
		(row) => row.adapter === adapter && now.getTime() - row.lastSeenAt.getTime() <= WORKER_STALE_MS,
	);
	const ready = fresh.filter((row) => row.status === "ready");
	const unavailable = fresh
		.filter((row) => row.status === "unavailable")
		.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
	return {
		adapter,
		available: ready.length > 0,
		runtimeVersions: [...new Set(ready.map((row) => row.runtimeVersion))].sort(),
		reportedVersions: [...new Set(fresh.map((row) => row.runtimeVersion))]
			.filter((version) => version !== "" && version !== "unknown")
			.sort(),
		readyWorkers: ready.length,
		detail: unavailable[0]?.detail ?? null,
	};
}

async function freshWorkers(db: Transaction["db"], now: Date): Promise<Readonly<WorkerRow[]>> {
	return db
		.select()
		.from(runtimeWorkers)
		.where(gt(runtimeWorkers.lastSeenAt, new Date(now.getTime() - WORKER_STALE_MS)));
}

/** The adapters of enabled agents, each with the ids of its agents. */
async function adaptersInUse(
	db: Transaction["db"],
): Promise<ReadonlyMap<RuntimeAdapterId, Readonly<string[]>>> {
	const rows = await db
		.select({ id: agents.id, adapter: agents.runtimeAdapter })
		.from(agents)
		.where(eq(agents.enabled, true))
		.orderBy(agents.id);
	const byAdapter = new Map<RuntimeAdapterId, string[]>();
	for (const row of rows) {
		byAdapter.set(row.adapter, [...(byAdapter.get(row.adapter) ?? []), row.id]);
	}
	return byAdapter;
}

/** Serializes every availability decision of one adapter, across controllers. */
async function lockAdapter(db: Transaction["db"], adapter: RuntimeAdapterId): Promise<void> {
	await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`runtime-health:${adapter}`}))`);
}

/** Health of every adapter that has enabled agents or reporting workers. */
export async function runtimeHealth(deps: ControlPlaneDeps): Promise<Readonly<RuntimeHealth[]>> {
	return withTransaction(deps.pool, async (tx) => {
		const now = deps.clock();
		const workers = await freshWorkers(tx.db, now);
		const adapters = new Set<RuntimeAdapterId>([
			...(await adaptersInUse(tx.db)).keys(),
			...workers.map((row) => row.adapter),
		]);
		return [...adapters].sort().map((adapter) => healthOf(adapter, workers, now));
	});
}

/**
 * Stores a worker heartbeat, then settles the adapter's availability. `sentAt` is when the
 * report was queued (database time): a heartbeat applied late, after a backlog or a retry, is
 * dated by it, never moves a worker's last contact backwards, and is ignored once stale.
 */
export async function recordWorkerStatus(
	deps: ControlPlaneDeps,
	adapter: RuntimeAdapterId,
	report: WorkerStatusReport,
	sentAt: Date,
	options: RuntimeHealthOptions = {},
): Promise<void> {
	await withTransaction(deps.pool, async (tx) => {
		const uow: UnitOfWork = { deps, tx, jobs: deps.jobs(tx), now: deps.clock() };
		const seenAt = new Date(Math.min(sentAt.getTime(), uow.now.getTime()));
		if (uow.now.getTime() - seenAt.getTime() > WORKER_STALE_MS) {
			return;
		}
		await lockAdapter(tx.db, adapter);
		const [existing] = await tx.db
			.select({ adapter: runtimeWorkers.adapter })
			.from(runtimeWorkers)
			.where(eq(runtimeWorkers.workerId, report.workerId))
			.for("update");
		if (existing !== undefined && existing.adapter !== adapter) {
			// A worker id is random per process; one reused across adapters is a forgery.
			deps.log.error("rejected worker status for another adapter", {
				adapter,
				error_code: "invalid_report",
			});
			return;
		}
		const values = {
			status: report.status,
			sequence: report.sequence,
			runtimeVersion: report.runtimeVersion,
			detail: redactForStorage(report.detail),
			lastSeenAt: seenAt,
		};
		await tx.db
			.insert(runtimeWorkers)
			.values({ workerId: report.workerId, adapter, firstSeenAt: seenAt, ...values })
			.onConflictDoUpdate({
				target: runtimeWorkers.workerId,
				set: values,
				// Reports can arrive out of order: only a later one of the worker counts, never one
				// of another adapter (two queues racing for a new id).
				setWhere: and(
					lt(runtimeWorkers.sequence, report.sequence),
					eq(runtimeWorkers.adapter, adapter),
				),
			});
		await settleAvailability(uow, adapter, options);
	});
}

/** Probe details are worker-written text: one line, as inline code in the alert. */
function quoted(detail: string): string {
	return `\`${detail.replace(/[`\r\n]+/gu, " ").slice(0, 200)}\``;
}

/**
 * Compares an adapter's health with its settled availability, under the adapter's lock. A
 * difference is settled, and alerted once, only after it lasted `stableMs`; one that ends
 * earlier (a restart, a failed probe) is forgotten. An adapter seen for the first time counts
 * as available, so one that never gets a ready worker is still alerted.
 */
async function settleAvailability(
	uow: UnitOfWork,
	adapter: RuntimeAdapterId,
	options: RuntimeHealthOptions,
): Promise<RuntimeHealth> {
	const { db } = uow.tx;
	const health = healthOf(adapter, await freshWorkers(db, uow.now), uow.now);
	if (!(await adaptersInUse(db)).has(adapter)) {
		// Settled only for adapters with enabled agents, so agents added to a runtime that is
		// already down still get their alert.
		return health;
	}
	const versions = [...health.runtimeVersions];
	await db
		.insert(runtimeAvailability)
		.values({ adapter, available: true, runtimeVersions: versions, changedAt: uow.now })
		.onConflictDoNothing();
	const [stored] = await db
		.select()
		.from(runtimeAvailability)
		.where(eq(runtimeAvailability.adapter, adapter))
		.for("update");
	if (stored === undefined) {
		throw new Error(`runtime availability of '${adapter}' is missing`);
	}
	const where = eq(runtimeAvailability.adapter, adapter);
	if (stored.available === health.available) {
		if (
			stored.pendingSince !== null ||
			JSON.stringify(stored.runtimeVersions) !== JSON.stringify(versions)
		) {
			await db
				.update(runtimeAvailability)
				.set({ runtimeVersions: versions, pendingSince: null })
				.where(where);
		}
		return health;
	}
	if (stored.pendingSince === null) {
		await db.update(runtimeAvailability).set({ pendingSince: uow.now }).where(where);
		return health;
	}
	if (uow.now.getTime() - stored.pendingSince.getTime() < (options.stableMs ?? RUNTIME_STABLE_MS)) {
		return health;
	}
	await db
		.update(runtimeAvailability)
		.set({
			available: health.available,
			runtimeVersions: versions,
			changedAt: uow.now,
			pendingSince: null,
		})
		.where(where);
	const agentIds = (await adaptersInUse(db)).get(adapter) ?? [];
	const mentions = agentIds.map((id) => `@${id}`).join(", ");
	// One alert per settled change: the key names the state that ended.
	const key = `runtime:${adapter}:${stored.changedAt.toISOString()}`;
	await raiseAlert(
		uow,
		key,
		health.available
			? `Runtime '${adapter}' is available again (${versions.map(quoted).join(", ")}); ${mentions} can run.`
			: `Runtime '${adapter}' has no ready worker${health.detail === null ? "" : ` (${quoted(health.detail)})`}; ${mentions} are degraded and their runs wait in the queue.`,
	);
	return health;
}

/**
 * Periodic check: notices workers that went silent, settles the availability of every adapter
 * with enabled agents, and forgets long-gone workers. Returns the adapters now unavailable.
 */
export async function sweepRuntimeHealth(
	deps: ControlPlaneDeps,
	options: RuntimeHealthOptions = {},
): Promise<Readonly<RuntimeAdapterId[]>> {
	// Its own statement, holding no adapter lock, so it never waits in the other order.
	await deps.pool.query("delete from runtime_workers where last_seen_at < $1", [
		new Date(deps.clock().getTime() - WORKER_RETENTION_MS),
	]);
	return withTransaction(deps.pool, async (tx) => {
		const uow: UnitOfWork = { deps, tx, jobs: deps.jobs(tx), now: deps.clock() };
		const unavailable: RuntimeAdapterId[] = [];
		// Sorted, so concurrent sweeps take the adapter locks in the same order.
		for (const adapter of [...(await adaptersInUse(tx.db)).keys()].sort()) {
			await lockAdapter(tx.db, adapter);
			const health = await settleAvailability(uow, adapter, options);
			if (!health.available) {
				unavailable.push(adapter);
			}
		}
		return unavailable;
	});
}
