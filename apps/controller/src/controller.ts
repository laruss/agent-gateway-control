import {
	OutboxDeliverJobSchema,
	QUEUES,
	RunTimeoutJobSchema,
	RuntimeAdapterIdSchema,
	reportQueue,
	TOOL_NAMESPACES,
	ToolReportSchema,
	toolReportQueue,
	WaitTimeoutJobSchema,
	WorkerReportSchema,
} from "@agent-gateway/contracts";
import {
	type ControlPlaneDeps,
	handleRunReport,
	handleRunTimeout,
	handleToolReport,
	handleWaitTimeout,
	type JobProbe,
	reconcileRunsAndWaits,
	recordWorkerStatus,
	runRetentionIfDue,
	sweepAlertConditions,
	sweepApprovals,
	sweepRuntimeHealth,
	sweepSchedules,
} from "@agent-gateway/core";
import type { OutboxKind } from "@agent-gateway/db";
import { createServicePool, requireCompatibleSchema, schemaCompatibility } from "@agent-gateway/db";
import { errorFields, type Logger, releaseVersion } from "@agent-gateway/logging";
import type { RunningListener } from "@agent-gateway/mattermost";
import { type Deliverer, deliverOutboxItem, reconcileOutbox } from "@agent-gateway/outbox";
import { createBoss, transactionalJobSink } from "@agent-gateway/queue";
import { gauge, type HealthCheck, MetricsRegistry } from "@agent-gateway/service";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import {
	type MattermostBridgeOptions,
	startBridgeListener,
	startBridgeMembershipSync,
} from "./mattermost-bridge.ts";
import { registerControllerMetrics } from "./metrics.ts";

export type ControllerOptions = Readonly<{
	connectionString: string;
	log: Logger;
	/** Built once the control plane deps exist, so a deliverer can ingest (loopback). */
	deliverers: (deps: ControlPlaneDeps) => Readonly<Partial<Record<OutboxKind, Deliverer>>>;
	clock?: () => Date;
	random?: () => number;
	/** How often lost or stale outbox deliveries are re-enqueued. */
	reconcileIntervalMs?: number;
	/** How long a runtime availability change must last before it is alerted; lower in tests. */
	runtimeStableMs?: number;
	/** Queue polling interval; lower in tests. */
	pollingIntervalSeconds?: number;
	/** How often retention removes expired content; hourly by default. */
	retentionIntervalMs?: number;
	/** Listen to Mattermost; without it no Mattermost event reaches the Gateway. */
	mattermost?: MattermostBridgeOptions;
	/** Where the controller's metrics go; a registry of its own by default. */
	metrics?: MetricsRegistry;
}>;

export type RunningController = Readonly<{
	deps: ControlPlaneDeps;
	boss: PgBoss;
	/** The Mattermost listener, when one runs. */
	listener: RunningListener | null;
	readiness: () => Promise<Readonly<HealthCheck[]>>;
	metrics: MetricsRegistry;
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
 * The control plane process: consumes worker and tool runner reports, run and wait timeouts,
 * and outbox deliveries. Refuses to start on a database this release may not run against.
 */
export async function startController(options: ControllerOptions): Promise<RunningController> {
	const { log } = options;
	const pool: pg.Pool = createServicePool(options.connectionString);
	// An idle connection lost (a database restart, a failed keepalive) is replaced on next use.
	pool.on("error", (error) => log.error("database pool error", errorFields(error)));
	const release = releaseVersion();
	try {
		await requireCompatibleSchema(pool, release);
	} catch (error) {
		await pool.end();
		throw error;
	}
	// The queue schema and the queues come from `gateway db migrate`.
	const boss = createBoss(options.connectionString, "supervisor");
	boss.on("error", (error) => log.error("pg-boss error", errorFields(error)));
	await boss.start();

	const clock = options.clock ?? (() => new Date());
	const deps: ControlPlaneDeps = {
		pool,
		jobs: (tx) => transactionalJobSink(boss, tx.client),
		clock,
		random: options.random ?? Math.random,
		log,
	};
	const metrics = options.metrics ?? new MetricsRegistry();
	registerControllerMetrics(metrics, pool, clock);
	const reportsApplied = metrics.counter(
		"gateway_run_reports_total",
		"Worker run reports applied, by adapter, kind and outcome.",
	);
	const toolReportsApplied = metrics.counter(
		"gateway_tool_reports_total",
		"Tool runner reports applied, by namespace, kind and outcome.",
	);
	const deliveries = metrics.counter(
		"gateway_outbox_deliveries_total",
		"Outbox delivery attempts, by outcome.",
	);
	const sweepFailures = metrics.counter(
		"gateway_reconcile_failures_total",
		"Failed reconciliation steps, by step.",
	);
	const outboxDeps = { pool, deliverers: options.deliverers(deps), clock, log };
	const polling = { pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2 };
	const runtimeHealthOptions =
		options.runtimeStableMs === undefined ? {} : { stableMs: options.runtimeStableMs };

	// One report queue per adapter: a report counts only for runs of the adapter it came from.
	for (const adapter of RuntimeAdapterIdSchema.options) {
		await boss.work(
			reportQueue(adapter),
			{ ...polling, batchSize: 1, localConcurrency: 4, includeMetadata: true },
			async ([job]) => {
				if (job === undefined) {
					return;
				}
				const report = WorkerReportSchema.safeParse(job.data);
				if (!report.success) {
					// A malformed report is a worker defect or a forgery; never retried into the domain.
					log.error("rejected malformed run report", {
						job_id: job.id,
						error_code: "invalid_report",
					});
					return;
				}
				if (report.data.kind === "worker_status") {
					// Dated by when the worker queued it, not when it is applied. A heartbeat is never
					// retried: the next one supersedes it, and it must not fill the dead letter queue.
					try {
						await recordWorkerStatus(
							deps,
							adapter,
							report.data,
							job.createdOn,
							runtimeHealthOptions,
						);
					} catch (error) {
						log.error("worker status not applied", { ...errorFields(error), adapter });
					}
					return;
				}
				const outcome = await handleRunReport(deps, report.data, adapter);
				reportsApplied.inc({ adapter, kind: report.data.kind, outcome });
				log.info("run report applied", { job_id: job.id, run_id: report.data.runId, outcome });
			},
		);
	}
	// One report queue per tool namespace: a report counts only for actions of that namespace.
	for (const namespace of TOOL_NAMESPACES) {
		await boss.work(
			toolReportQueue(namespace),
			{ ...polling, batchSize: 1, localConcurrency: 2 },
			async ([job]) => {
				if (job === undefined) {
					return;
				}
				const report = ToolReportSchema.safeParse(job.data);
				if (!report.success) {
					log.error("rejected malformed tool report", {
						job_id: job.id,
						namespace,
						error_code: "invalid_report",
					});
					return;
				}
				const outcome = await handleToolReport(deps, namespace, report.data);
				toolReportsApplied.inc({ namespace, kind: report.data.kind, outcome });
				log.info("tool report applied", {
					job_id: job.id,
					tool_action_id: report.data.actionId,
					outcome,
				});
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
				const outcome = await deliverOutboxItem(outboxDeps, outboxId).catch((error: Error) => {
					deliveries.inc({ outcome: "retryable_failure" });
					throw error;
				});
				deliveries.inc({ outcome });
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
	// The listener starts below; the sweep reads it through this binding.
	let listener: RunningListener | null = null;
	// Not connected until the listener says so: a restart does not resolve a lasting outage.
	let disconnectedSince: Date | null = options.mattermost === undefined ? null : deps.clock();
	let connectedSince: Date | null = null;
	let seenReconnects = 0;
	// Each loop runs one pass at a time; `stop` waits for the pass in flight.
	let reconciling: Promise<void> | null = null;
	const reconcile = (): Promise<void> => {
		reconciling ??= reconcileOnce().finally(() => {
			reconciling = null;
		});
		return reconciling;
	};
	// Retention has its own loop: a long first run must not hold up recovery, approvals, alerts
	// and outbox reconciliation.
	let retaining: Promise<void> | null = null;
	let stopping = false;
	const retain = (): Promise<void> => {
		retaining ??= (async () => {
			try {
				const expired = await runRetentionIfDue(deps, options.retentionIntervalMs, () => stopping);
				if (expired !== null) {
					log.info("retention applied", { ...expired });
				}
			} catch (error) {
				sweepFailures.inc({ step: "retention" });
				log.error("retention failed", errorFields(error));
			}
		})().finally(() => {
			retaining = null;
		});
		return retaining;
	};
	const reconcileOnce = async () => {
		try {
			const lost = await reconcileRunsAndWaits(deps, probe);
			if (lost.lostAttempts > 0 || lost.requeuedWaitTimeouts > 0) {
				log.warn("recovered runs or waits whose jobs were lost", { ...lost });
			}
		} catch (error) {
			sweepFailures.inc({ step: "run_waits" });
			log.error("run and wait reconciliation failed", errorFields(error));
		}
		try {
			const started = await sweepSchedules(deps);
			if (started > 0) {
				log.warn("started runs for inbox work left behind", { count: started });
			}
		} catch (error) {
			sweepFailures.inc({ step: "schedules" });
			log.error("schedule sweep failed", errorFields(error));
		}
		try {
			const settled = await sweepApprovals(deps);
			if (settled > 0) {
				log.info("settled or resolved approvals", { count: settled });
			}
		} catch (error) {
			sweepFailures.inc({ step: "approvals" });
			log.error("approval sweep failed", errorFields(error));
		}
		try {
			const unavailable = await sweepRuntimeHealth(deps, runtimeHealthOptions);
			if (unavailable.length > 0) {
				log.warn("runtimes without a ready worker", { adapters: unavailable.join(",") });
			}
		} catch (error) {
			sweepFailures.inc({ step: "runtime_health" });
			log.error("runtime health sweep failed", errorFields(error));
		}
		try {
			if (listener !== null) {
				const now = deps.clock();
				const status = listener.status();
				// A reconnect between two ticks restarts the stable period: it was a drop too.
				if (status.reconnects !== seenReconnects) {
					seenReconnects = status.reconnects;
					connectedSince = null;
				}
				if (status.connected) {
					connectedSince ??= now;
					disconnectedSince = null;
				} else {
					connectedSince = null;
					disconnectedSince ??= now;
				}
			}
			const transitions = await sweepAlertConditions(deps, {
				mattermost: options.mattermost === undefined ? null : { disconnectedSince, connectedSince },
			});
			for (const [key, transition] of Object.entries(transitions)) {
				log.warn(`alert ${transition}`, { alert_key: key });
			}
		} catch (error) {
			sweepFailures.inc({ step: "alerts" });
			log.error("alert sweep failed", errorFields(error));
		}
		try {
			const requeued = await reconcileOutbox(outboxDeps, (tx) =>
				transactionalJobSink(boss, tx.client),
			);
			if (requeued > 0) {
				log.warn("re-enqueued outbox deliveries", { count: requeued });
			}
		} catch (error) {
			sweepFailures.inc({ step: "outbox" });
			log.error("outbox reconciliation failed", errorFields(error));
		}
	};
	await reconcile();
	const timer = setInterval(() => void reconcile(), options.reconcileIntervalMs ?? 60_000);
	void retain();
	const retentionTimer = setInterval(() => void retain(), options.reconcileIntervalMs ?? 60_000);
	listener =
		options.mattermost === undefined ? null : startBridgeListener(deps, options.mattermost, log);
	const membership =
		options.mattermost === undefined
			? null
			: startBridgeMembershipSync(deps, options.mattermost, log);

	metrics.collect(() =>
		listener === null
			? []
			: [
					gauge("gateway_mattermost_connected", "1 while the listener's WebSocket is up.", [
						{ labels: {}, value: listener.status().connected ? 1 : 0 },
					]),
				],
	);

	const readiness = async (): Promise<Readonly<HealthCheck[]>> => {
		const checks: HealthCheck[] = [];
		try {
			await pool.query("select 1");
			checks.push({ name: "postgres", ok: true, detail: "reachable" });
			const schemaNow = await schemaCompatibility(pool, release);
			checks.push({ name: "migrations", ok: schemaNow.ok, detail: schemaNow.detail });
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
		metrics,
		stop: async () => {
			stopping = true;
			clearInterval(timer);
			clearInterval(retentionTimer);
			await Promise.allSettled([reconciling, retaining]);
			await membership?.stop();
			await listener?.stop();
			await boss.stop({ graceful: true, timeout: 30_000 });
			await pool.end();
			log.info("controller stopped");
		},
	};
}
