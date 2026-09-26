import { randomUUID } from "node:crypto";
import {
	type RuntimeAdapterId,
	reportQueue,
	runQueue,
	type WorkerStatusReport,
} from "@agent-gateway/contracts";
import { errorFields, type Logger } from "@agent-gateway/logging";
import { createBoss, directJobSink } from "@agent-gateway/queue";
import {
	checkWorkspaceRoot,
	type RuntimeAdapter,
	type RuntimeProbeResult,
} from "@agent-gateway/runtime-sdk";
import { createRuntimeAdapter } from "./adapters.ts";
import { processRunJob } from "./run-job.ts";

export type WorkerOptions = Readonly<{
	connectionString: string;
	adapter: RuntimeAdapterId;
	concurrency: number;
	/** Absolute directory under which every run gets its own workspace. */
	workspaceRoot: string;
	log: Logger;
	/**
	 * The exact runtime version this worker was verified with. A runtime reporting another
	 * version is unavailable: its agents are degraded instead of running on an untested CLI.
	 */
	pinnedVersion?: string | null;
	/** Overrides the adapter built from `adapter`, e.g. in tests. */
	runtime?: RuntimeAdapter;
	/** Queue polling interval; lower in tests. */
	pollingIntervalSeconds?: number;
	/** How often the worker reports its status; the controller's stale window is three of these. */
	heartbeatMs?: number;
	/** How often a ready runtime is probed again. An unavailable one is probed every heartbeat. */
	reprobeMs?: number;
}>;

export type RunningWorker = Readonly<{
	/** The version of the last probe, "unknown" before a probe succeeded. */
	runtimeVersion: () => string;
	ready: () => boolean;
	/**
	 * Resolves when the worker gave up for good: a subscription it had to drop could not be
	 * removed, so it stopped everything. The host exits and its supervisor starts a fresh one.
	 */
	failed: Promise<Error>;
	stop: () => Promise<void>;
}>;

const HEARTBEAT_MS = 30_000;
const REPROBE_MS = 300_000;
const PINNED_REPROBE_MS = 60_000;
/** How long a worker giving up waits for its cancelled turns. */
const GIVE_UP_WAIT_MS = 15_000;

/** The probe with the version pin applied. */
export function pinProbe(probe: RuntimeProbeResult, pinned: string | null): RuntimeProbeResult {
	if (!probe.ok || pinned === null || probe.runtimeVersion === pinned) {
		return probe;
	}
	return {
		...probe,
		ok: false,
		detail: `runtime version ${probe.runtimeVersion} is not the pinned ${pinned}`,
	};
}

/**
 * Serves one runtime adapter's queue while the adapter's probe passes. A failing probe, at start
 * or later, stops taking jobs and reports the runtime unavailable; the worker keeps probing and
 * takes jobs again once the runtime recovers. Other adapters and the controller are unaffected:
 * jobs of this adapter wait in its own queue.
 */
export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
	const adapter = options.runtime ?? createRuntimeAdapter(options.adapter);
	await checkWorkspaceRoot(options.workspaceRoot);
	const workerId = randomUUID();
	const pinned = options.pinnedVersion ?? null;
	const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
	const reprobeMs = options.reprobeMs ?? REPROBE_MS;
	const baseLog = options.log.child({ adapter: adapter.id, worker_id: workerId });
	const boss = createBoss(options.connectionString, "client");
	boss.on("error", (error) => baseLog.error("pg-boss error", { error_message: error.message }));
	await boss.start();
	const reports = directJobSink(boss);

	let probe: RuntimeProbeResult = {
		ok: false,
		runtimeVersion: "unknown",
		detail: "not probed yet",
		risks: [],
	};
	let workId: string | null = null;
	/** The runtime version the current subscription reports on its runs. */
	let workVersion: string | null = null;
	let probedAt = 0;
	let stopping = false;
	let sequence = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	const inFlight = new Set<Readonly<{ controller: AbortController; running: Promise<void> }>>();

	const report = async (status: WorkerStatusReport["status"]) => {
		const data: WorkerStatusReport = {
			kind: "worker_status",
			workerId,
			sequence: sequence++,
			status,
			runtimeVersion: probe.runtimeVersion.slice(0, 128),
			detail: probe.detail.slice(0, 500),
		};
		await reports.send(reportQueue(adapter.id), data);
	};

	const startTaking = async () => {
		const log = baseLog.child({ runtime_version: probe.runtimeVersion });
		const runtimeVersion = probe.runtimeVersion;
		workVersion = runtimeVersion;
		workId = await boss.work(
			runQueue(adapter.id),
			{
				batchSize: 1,
				localConcurrency: options.concurrency,
				pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2,
			},
			async ([job]) => {
				if (job !== undefined) {
					// Aborted with the job, or by `giveUp`, which must not leave CLIs running behind.
					const controller = new AbortController();
					const abort = () => controller.abort();
					job.signal.addEventListener("abort", abort, { once: true });
					const running = processRunJob(
						{
							adapter,
							runtimeVersion,
							workspaceRoot: options.workspaceRoot,
							reports,
							log: log.child({ job_id: job.id }),
							// Fail closed while a subscription that should be gone still gets jobs.
							accepting: () => !stopping && probe.ok && probe.runtimeVersion === runtimeVersion,
						},
						job.data,
						controller.signal,
					);
					// Settles either way; the job's own failure still reaches pg-boss below.
					const entry = {
						controller,
						running: running.then(
							() => undefined,
							() => undefined,
						),
					};
					inFlight.add(entry);
					try {
						await running;
					} finally {
						inFlight.delete(entry);
						job.signal.removeEventListener("abort", abort);
					}
				}
			},
		);
		log.info("worker taking jobs");
	};

	const stopTaking = async () => {
		const id = workId;
		if (id !== null) {
			// Running jobs finish; the runtime failing under them fails them on its own. The id is
			// kept until the subscription is gone, so a failed removal is retried next tick.
			await boss.offWork(runQueue(adapter.id), { id, wait: false });
			workId = null;
		}
	};

	/** The probe with the pin applied; a probe that throws is a failed probe. */
	const runProbe = async (): Promise<RuntimeProbeResult> => {
		try {
			return pinProbe(await adapter.probe(), pinned);
		} catch (error) {
			return {
				ok: false,
				runtimeVersion: probe.runtimeVersion,
				detail: `probe failed: ${error instanceof Error ? error.message : String(error)}`,
				risks: [],
			};
		}
	};

	const check = async () => {
		// A pinned version is checked every minute, so a binary replaced in place stops soon.
		const interval = pinned === null ? reprobeMs : Math.min(reprobeMs, PINNED_REPROBE_MS);
		const due = workId === null || !probe.ok || Date.now() - probedAt >= interval;
		if (due) {
			if (!stopping && probe.ok && workId !== null && workVersion === probe.runtimeVersion) {
				// A probe can take a while; the heartbeat does not wait for it.
				await report("ready");
			}
			const previous = probe;
			probe = await runProbe();
			probedAt = Date.now();
			if (!probe.ok && (previous.ok || previous.detail !== probe.detail)) {
				baseLog.error("runtime unavailable; not taking jobs", {
					runtime_version: probe.runtimeVersion,
					error_message: probe.detail,
				});
			}
		}
		// No subscription while the probe fails, and only one that reports the version the
		// runtime has now. One that cannot be removed would keep fetching (and refusing) jobs, so
		// the worker then stops altogether instead.
		if (workId !== null && (!probe.ok || workVersion !== probe.runtimeVersion)) {
			try {
				await stopTaking();
			} catch (error) {
				await giveUp(error);
				return;
			}
		}
		if (probe.ok && workId === null && !stopping) {
			await startTaking().catch((error: unknown) => {
				baseLog.error("could not start taking jobs", errorFields(error));
				probe = {
					...probe,
					ok: false,
					detail: `cannot subscribe to the run queue: ${error instanceof Error ? error.message : String(error)}`,
				};
			});
		}
		if (!stopping) {
			const readyNow = probe.ok && workId !== null && workVersion === probe.runtimeVersion;
			await report(readyNow ? "ready" : "unavailable");
		}
	};

	let fail: (error: Error) => void = () => undefined;
	const failed = new Promise<Error>((resolve) => {
		fail = resolve;
	});
	const giveUp = async (error: unknown) => {
		stopping = true;
		clearInterval(timer);
		baseLog.error("could not stop taking jobs; stopping the worker", errorFields(error));
		// Stop the turns first: their CLIs run in process groups of their own and would outlive
		// the worker. Cancelling is bounded by the kill grace.
		const turns = [...inFlight];
		for (const turn of turns) {
			turn.controller.abort();
		}
		await Promise.race([
			Promise.allSettled(turns.map((turn) => turn.running)),
			Bun.sleep(GIVE_UP_WAIT_MS),
		]);
		await boss.stop({ graceful: false }).catch(() => undefined);
		fail(error instanceof Error ? error : new Error(String(error)));
	};

	let current: Promise<void> | null = null;
	const tick = (): Promise<void> => {
		current ??= check()
			.catch((error: unknown) => {
				baseLog.error("worker health check failed", errorFields(error));
			})
			.finally(() => {
				current = null;
			});
		return current;
	};
	await tick();
	timer = setInterval(() => void tick(), heartbeatMs);
	baseLog.info("worker started", { ready: probe.ok });
	return {
		runtimeVersion: () => probe.runtimeVersion,
		ready: () => workId !== null,
		failed,
		stop: async () => {
			stopping = true;
			clearInterval(timer);
			// A check in flight could report "ready" after "stopped"; a probe that hangs gets 5 s.
			await Promise.race([current, Bun.sleep(5_000)]);
			// No new jobs from here on; running ones finish within the graceful stop below.
			await stopTaking().catch(() => undefined);
			try {
				await report("stopped");
			} catch (error) {
				baseLog.warn("could not report the worker stopping", errorFields(error));
			}
			await boss.stop({ graceful: true, timeout: 30_000 });
			baseLog.info("worker stopped");
		},
	};
}
