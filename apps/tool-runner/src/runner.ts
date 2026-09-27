import {
	type ToolNamespace,
	type ToolReport,
	toolExecuteQueue,
	toolReportQueue,
} from "@agent-gateway/contracts";
import { errorFields, type Logger } from "@agent-gateway/logging";
import { createBoss, directJobSink } from "@agent-gateway/queue";
import type { HealthCheck } from "@agent-gateway/service";
import {
	type BeginToolAction,
	processToolJob,
	type ToolExecutors,
} from "@agent-gateway/tool-broker";
import pg from "pg";

export type ToolRunnerOptions = Readonly<{
	/** A role limited by `gateway db grant-tool-runner` to these namespaces. */
	connectionString: string;
	namespaces: Readonly<ToolNamespace[]>;
	executors: ToolExecutors;
	log: Logger;
	concurrency?: number;
	/** Queue polling interval; lower in tests. */
	pollingIntervalSeconds?: number;
}>;

export type RunningToolRunner = Readonly<{
	readiness: () => Promise<Readonly<HealthCheck[]>>;
	stop: () => Promise<void>;
}>;

/** How often a report that could not be sent is tried again before the job gives up. */
const REPORT_ATTEMPTS = 5;

/**
 * Serves the execute queues of its namespaces. It holds its executors' credentials and nothing
 * else; the only domain state it touches is `gateway_begin_tool_action`, the last check before
 * an executor runs, and the stop check it polls while an executor works. A job whose report cannot be sent fails: the controller settles the action
 * as unknown, and nothing is run again.
 */
export async function startToolRunner(options: ToolRunnerOptions): Promise<RunningToolRunner> {
	const { log } = options;
	for (const executor of options.executors.values()) {
		const namespace = executor.actionType.split(".")[0];
		if (!options.namespaces.some((served) => served === namespace)) {
			throw new Error(
				`executor '${executor.actionType}' is outside the served namespaces ${options.namespaces.join(", ")}`,
			);
		}
	}
	const pool = new pg.Pool({ connectionString: options.connectionString, max: 2 });
	const boss = createBoss(options.connectionString, "client");
	boss.on("error", (error) => log.error("pg-boss error", errorFields(error)));
	await boss.start();
	const reports = directJobSink(boss);
	const inFlight = new Set<AbortController>();

	const begin: BeginToolAction = async (actionId, attempt, hash) => {
		const result = await pool.query<{ verdict: string; idempotency_key: string | null }>(
			"select verdict, idempotency_key from gateway_begin_tool_action($1, $2, $3)",
			[actionId, attempt, hash],
		);
		const row = result.rows[0];
		return row?.verdict === "begin" && row.idempotency_key !== null
			? { verdict: "begin", idempotencyKey: row.idempotency_key }
			: { verdict: row?.verdict ?? "no_answer", idempotencyKey: null };
	};
	const stopRequested = async (actionId: string) => {
		const result = await pool.query<{ stop: boolean }>(
			"select gateway_tool_action_stop_requested($1) as stop",
			[actionId],
		);
		return result.rows[0]?.stop ?? true;
	};

	for (const namespace of options.namespaces) {
		const report = async (data: ToolReport) => {
			for (let attempt = 1; ; attempt += 1) {
				try {
					await reports.send(toolReportQueue(namespace), data);
					return;
				} catch (error) {
					if (attempt >= REPORT_ATTEMPTS) {
						throw error;
					}
					await Bun.sleep(500 * attempt);
				}
			}
		};
		await boss.work(
			toolExecuteQueue(namespace),
			{
				batchSize: 1,
				localConcurrency: options.concurrency ?? 1,
				pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2,
			},
			async ([job]) => {
				if (job === undefined) {
					return;
				}
				const controller = new AbortController();
				const abort = () => controller.abort();
				job.signal.addEventListener("abort", abort, { once: true });
				inFlight.add(controller);
				try {
					await processToolJob(
						{
							namespace,
							executors: options.executors,
							begin,
							stopRequested,
							report,
							log: log.child({ namespace, job_id: job.id }),
						},
						job.data,
						controller.signal,
					);
				} finally {
					inFlight.delete(controller);
					job.signal.removeEventListener("abort", abort);
				}
			},
		);
	}
	log.info("tool runner started", {
		namespaces: options.namespaces.join(","),
		executors: [...options.executors.keys()].join(","),
	});

	return {
		readiness: async () => {
			try {
				await pool.query("select 1");
				return [{ name: "postgres", ok: true, detail: "reachable" }];
			} catch (error) {
				return [
					{
						name: "postgres",
						ok: false,
						detail: error instanceof Error ? error.message : "failed",
					},
				];
			}
		},
		stop: async () => {
			for (const namespace of options.namespaces) {
				await boss.offWork(toolExecuteQueue(namespace), { wait: false }).catch(() => undefined);
			}
			// Executors in flight finish within the graceful stop; the rest are aborted.
			await boss.stop({ graceful: true, timeout: 30_000 });
			for (const controller of inFlight) {
				controller.abort();
			}
			await pool.end();
			log.info("tool runner stopped");
		},
	};
}
