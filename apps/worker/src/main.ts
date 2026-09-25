import { RuntimeAdapterIdSchema } from "@agent-gateway/contracts";
import { createLogger } from "@agent-gateway/logging";
import { intSetting, onShutdown, readSetting, requireSetting } from "@agent-gateway/service";
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
	log,
});
onShutdown(log, worker.stop);
