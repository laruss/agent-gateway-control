import { RuntimeAdapterIdSchema } from "@agent-gateway/contracts";
import { createLogger } from "@agent-gateway/logging";
import { intSetting, onShutdown, readSetting, requireSetting } from "@agent-gateway/service";
import { workspaceRoot } from "./adapters.ts";
import { startWorker } from "./worker.ts";

const log = createLogger({
	service: "worker",
	version: "0.0.0",
	environment: readSetting("GATEWAY_ENV") ?? "development",
});

const worker = await startWorker({
	connectionString: requireSetting("DATABASE_URL"),
	adapter: RuntimeAdapterIdSchema.parse(readSetting("WORKER_ADAPTER") ?? "mock"),
	concurrency: intSetting("WORKER_CONCURRENCY", 1),
	workspaceRoot: workspaceRoot(),
	pinnedVersion: readSetting("WORKER_RUNTIME_VERSION") ?? null,
	log,
});
onShutdown(log, worker.stop);
void worker.failed.then(() => {
	// Fail closed: a supervisor restarts the worker with a clean subscription.
	process.exit(1);
});
