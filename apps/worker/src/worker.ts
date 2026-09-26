import { type RuntimeAdapterId, runQueue } from "@agent-gateway/contracts";
import type { Logger } from "@agent-gateway/logging";
import { createBoss, directJobSink } from "@agent-gateway/queue";
import { checkWorkspaceRoot, type RuntimeAdapter } from "@agent-gateway/runtime-sdk";
import { createRuntimeAdapter } from "./adapters.ts";
import { processRunJob } from "./run-job.ts";

export type WorkerOptions = Readonly<{
	connectionString: string;
	adapter: RuntimeAdapterId;
	concurrency: number;
	/** Absolute directory under which every run gets its own workspace. */
	workspaceRoot: string;
	log: Logger;
	/** Overrides the adapter built from `adapter`, e.g. in tests. */
	runtime?: RuntimeAdapter;
	/** Queue polling interval; lower in tests. */
	pollingIntervalSeconds?: number;
}>;

export type RunningWorker = Readonly<{
	runtimeVersion: string;
	stop: () => Promise<void>;
}>;

/**
 * Serves one runtime adapter's queue. Refuses to start when the adapter's probe fails, so a
 * worker without a working runtime never takes jobs.
 */
export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
	const adapter = options.runtime ?? createRuntimeAdapter(options.adapter);
	const probe = await adapter.probe();
	if (!probe.ok) {
		throw new Error(`runtime '${adapter.id}' probe failed: ${probe.detail}`);
	}
	await checkWorkspaceRoot(options.workspaceRoot);
	const log = options.log.child({ adapter: adapter.id, runtime_version: probe.runtimeVersion });
	const boss = createBoss(options.connectionString, "client");
	boss.on("error", (error) => log.error("pg-boss error", { error_message: error.message }));
	await boss.start();
	const reports = directJobSink(boss);
	await boss.work(
		runQueue(adapter.id),
		{
			batchSize: 1,
			localConcurrency: options.concurrency,
			pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2,
		},
		async ([job]) => {
			if (job !== undefined) {
				await processRunJob(
					{
						adapter,
						runtimeVersion: probe.runtimeVersion,
						workspaceRoot: options.workspaceRoot,
						reports,
						log: log.child({ job_id: job.id }),
					},
					job.data,
					job.signal,
				);
			}
		},
	);
	log.info("worker started");
	return {
		runtimeVersion: probe.runtimeVersion,
		stop: async () => {
			await boss.stop({ graceful: true, timeout: 30_000 });
			log.info("worker stopped");
		},
	};
}
