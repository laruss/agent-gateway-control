import { RuntimeAdapterIdSchema } from "@agent-gateway/contracts";
import { createLogger, serviceVersion } from "@agent-gateway/logging";
import {
	claimDeployment,
	intSetting,
	MetricsRegistry,
	onShutdown,
	readSetting,
	registerProcessMetrics,
	requireSetting,
	startHealthServer,
} from "@agent-gateway/service";
import { workspaceRoot } from "./adapters.ts";
import { startWorker } from "./worker.ts";

const log = createLogger({
	service: "worker",
	version: serviceVersion(),
	environment: readSetting("GATEWAY_ENV") ?? "development",
});

const metrics = new MetricsRegistry();
registerProcessMetrics(metrics, { service: "worker", version: serviceVersion() });
const databaseUrl = requireSetting("DATABASE_URL");
const deployment = await claimDeployment(log, databaseUrl);
const worker = await startWorker({
	connectionString: databaseUrl,
	adapter: RuntimeAdapterIdSchema.parse(readSetting("WORKER_ADAPTER") ?? "mock"),
	concurrency: intSetting("WORKER_CONCURRENCY", 1),
	workspaceRoot: workspaceRoot(),
	pinnedVersion: readSetting("WORKER_RUNTIME_VERSION") ?? null,
	log,
	metrics,
});
const health = startHealthServer({
	port: intSetting("HEALTH_PORT", 8081),
	hostname: readSetting("HEALTH_HOST") ?? "127.0.0.1",
	readiness: worker.readiness,
	metrics: () => metrics.render(),
});
log.info("health endpoints listening", { port: health.port });

onShutdown(log, async () => {
	await health.stop();
	await worker.stop();
	await deployment.release();
});
void worker.failed.then(() => {
	// Fail closed: a supervisor restarts the worker with a clean subscription.
	process.exit(1);
});
