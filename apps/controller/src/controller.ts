import {
	OutboxDeliverJobSchema,
	QUEUES,
	RunReportSchema,
	RunTimeoutJobSchema,
	RuntimeAdapterIdSchema,
	reportQueue,
	WaitTimeoutJobSchema,
} from "@agent-gateway/contracts";
import {
	type ControlPlaneDeps,
	handleRunReport,
	handleRunTimeout,
	handleWaitTimeout,
	type JobProbe,
	reconcileRunsAndWaits,
	sweepSchedules,
} from "@agent-gateway/core";
import type { OutboxKind } from "@agent-gateway/db";
import { createPool, pendingMigrationCount } from "@agent-gateway/db";
import { errorFields, type Logger } from "@agent-gateway/logging";
import type { RunningListener } from "@agent-gateway/mattermost";
import { type Deliverer, deliverOutboxItem, reconcileOutbox } from "@agent-gateway/outbox";
import { createBoss, ensureQueues, transactionalJobSink } from "@agent-gateway/queue";
import type { HealthCheck } from "@agent-gateway/service";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import { type MattermostBridgeOptions, startBridgeListener } from "./mattermost-bridge.ts";

export type ControllerOptions = Readonly<{
	connectionString: string;
	log: Logger;
	/** Built once the control plane deps exist, so a deliverer can ingest (loopback). */
	deliverers: (deps: ControlPlaneDeps) => Readonly<Partial<Record<OutboxKind, Deliverer>>>;
	clock?: () => Date;
	random?: () => number;
	/** How often lost or stale outbox deliveries are re-enqueued. */
	reconcileIntervalMs?: number;
	/** Queue polling interval; lower in tests. */
	pollingIntervalSeconds?: number;
	/** Listen to Mattermost; without it no Mattermost event reaches the Gateway. */
	mattermost?: MattermostBridgeOptions;
}>;

export type RunningController = Readonly<{
	deps: ControlPlaneDeps;
	boss: PgBoss;
	/** The Mattermost listener, when one runs. */
	listener: RunningListener | null;
	readiness: () => Promise<Readonly<HealthCheck[]>>;
	stop: () => Promise<void>;
}>;

const LIVE_JOB_STATES: Readonly<string[]> = ["created", "retry", "active"];

/** The queue lookups reconciliation needs, answered by pg-boss. */
export function bossJobProbe(boss: PgBoss): JobProbe {
	return {
		isAlive: async (queue, id) =>
			(await boss.findJobs(queue, { id })).some((job) => LIVE_JOB_STATES.includes(job.state)),
		hasPendingReport: async (queue, runId) =>
			(await boss.findJobs(queue, { data: { runId } })).some((job) =>
				LIVE_JOB_STATES.includes(job.state),
			),
	};
}

/**
 * The control plane process: consumes worker reports, run and wait timeouts, and outbox
 * deliveries. Refuses to start on a database with pending migrations.
 */
export async function startController(options: ControllerOptions): Promise<RunningController> {
	const { log } = options;
	const pool: pg.Pool = createPool(options.connectionString);
	const pending = await pendingMigrationCount(pool);
	if (pending > 0) {
		await pool.end();
		throw new Error(`${pending} database migration(s) pending; run 'gateway db migrate' first`);
	}
	const boss = createBoss(options.connectionString, "service");
	boss.on("error", (error) => log.error("pg-boss error", errorFields(error)));
	await boss.start();
	await ensureQueues(boss, RuntimeAdapterIdSchema.options);

	const clock = options.clock ?? (() => new Date());
	const deps: ControlPlaneDeps = {
		pool,
		jobs: (tx) => transactionalJobSink(boss, tx.client),
		clock,
		random: options.random ?? Math.random,
		log,
	};
	const outboxDeps = { pool, deliverers: options.deliverers(deps), clock, log };
	const polling = { pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2 };

	// One report queue per adapter: a report counts only for runs of the adapter it came from.
	for (const adapter of RuntimeAdapterIdSchema.options) {
		await boss.work(
			reportQueue(adapter),
			{ ...polling, batchSize: 1, localConcurrency: 4 },
			async ([job]) => {
				if (job === undefined) {
					return;
				}
				const report = RunReportSchema.safeParse(job.data);
				if (!report.success) {
					// A malformed report is a worker defect or a forgery; never retried into the domain.
					log.error("rejected malformed run report", {
						job_id: job.id,
						error_code: "invalid_report",
					});
					return;
				}
				const outcome = await handleRunReport(deps, report.data, adapter);
				log.info("run report applied", { job_id: job.id, run_id: report.data.runId, outcome });
			},
		);
	}
	await boss.work(QUEUES.agentTimeout, polling, async ([job]) => {
		if (job !== undefined) {
			await handleRunTimeout(deps, RunTimeoutJobSchema.parse(job.data));
		}
	});
	await boss.work(QUEUES.waitTimeout, polling, async ([job]) => {
		if (job !== undefined) {
			await handleWaitTimeout(deps, WaitTimeoutJobSchema.parse(job.data));
		}
	});
	await boss.work(
		QUEUES.outboxDeliver,
		{ ...polling, batchSize: 1, localConcurrency: 4 },
		async ([job]) => {
			if (job !== undefined) {
				const { outboxId } = OutboxDeliverJobSchema.parse(job.data);
				const outcome = await deliverOutboxItem(outboxDeps, outboxId);
				if (outcome === "not_due") {
					// Inside its backoff: come back when it is due, without spending a job retry.
					const due = await pool.query<{ next_attempt_at: Date }>(
						"select next_attempt_at from outbox where id = $1",
						[outboxId],
					);
					await boss.send(
						QUEUES.outboxDeliver,
						{ outboxId },
						{
							startAfter: due.rows[0]?.next_attempt_at ?? new Date(Date.now() + 5000),
						},
					);
				}
			}
		},
	);

	const probe = bossJobProbe(boss);
	const reconcile = async () => {
		try {
			const lost = await reconcileRunsAndWaits(deps, probe);
			if (lost.lostAttempts > 0 || lost.requeuedWaitTimeouts > 0) {
				log.warn("recovered runs or waits whose jobs were lost", { ...lost });
			}
		} catch (error) {
			log.error("run and wait reconciliation failed", errorFields(error));
		}
		try {
			const started = await sweepSchedules(deps);
			if (started > 0) {
				log.warn("started runs for inbox work left behind", { count: started });
			}
		} catch (error) {
			log.error("schedule sweep failed", errorFields(error));
		}
		try {
			const requeued = await reconcileOutbox(outboxDeps, (tx) =>
				transactionalJobSink(boss, tx.client),
			);
			if (requeued > 0) {
				log.warn("re-enqueued outbox deliveries", { count: requeued });
			}
		} catch (error) {
			log.error("outbox reconciliation failed", errorFields(error));
		}
	};
	await reconcile();
	const timer = setInterval(() => void reconcile(), options.reconcileIntervalMs ?? 60_000);
	const listener =
		options.mattermost === undefined ? null : startBridgeListener(deps, options.mattermost, log);

	const readiness = async (): Promise<Readonly<HealthCheck[]>> => {
		const checks: HealthCheck[] = [];
		try {
			await pool.query("select 1");
			checks.push({ name: "postgres", ok: true, detail: "reachable" });
			const pendingNow = await pendingMigrationCount(pool);
			checks.push({ name: "migrations", ok: pendingNow === 0, detail: `${pendingNow} pending` });
		} catch (error) {
			checks.push({
				name: "postgres",
				ok: false,
				detail: error instanceof Error ? error.message : "failed",
			});
		}
		if (listener !== null) {
			const status = listener.status();
			checks.push({
				name: "mattermost",
				ok: status.connected,
				detail: status.connected
					? `connected${status.degraded ? ", catching up" : ""}`
					: "disconnected",
			});
		}
		return checks;
	};

	log.info("controller started");
	return {
		deps,
		boss,
		listener,
		readiness,
		stop: async () => {
			clearInterval(timer);
			await listener?.stop();
			await boss.stop({ graceful: true, timeout: 30_000 });
			await pool.end();
			log.info("controller stopped");
		},
	};
}
