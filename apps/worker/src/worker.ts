import { type RuntimeAdapterId, runQueue } from "@agent-gateway/contracts";
import type { Logger } from "@agent-gateway/logging";
import { createBoss, directJobSink } from "@agent-gateway/queue";
import { createMockRuntime } from "@agent-gateway/runtime-mock";
import type { RuntimeAdapter } from "@agent-gateway/runtime-sdk";
import { processRunJob } from "./run-job.ts";

export type WorkerOptions = Readonly<{
	connectionString: string;
	adapter: RuntimeAdapterId;
	concurrency: number;
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

function createAdapter(id: RuntimeAdapterId): RuntimeAdapter {
	switch (id) {
		case "mock":
			return createMockRuntime();
		default:
			throw new Error(`runtime adapter '${id}' is not implemented yet`);
	}
}

/**
 * Serves one runtime adapter's queue. Refuses to start when the adapter's probe fails, so a
 * worker without a working runtime never takes jobs.
 */
export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
	const adapter = options.runtime ?? createAdapter(options.adapter);
	const probe = await adapter.probe();
	if (!probe.ok) {
		throw new Error(`runtime '${adapter.id}' probe failed: ${probe.detail}`);
	}
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
					adapter,
					probe.runtimeVersion,
					job.data,
					reports,
					job.signal,
					log.child({ job_id: job.id }),
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
