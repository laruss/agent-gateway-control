import { ToolNamespaceSchema } from "@agent-gateway/contracts";
import { createLogger, serviceVersion } from "@agent-gateway/logging";
import {
	claimDeployment,
	intSetting,
	MetricsRegistry,
	onShutdown,
	readSecretFile,
	readSetting,
	registerProcessMetrics,
	requireSetting,
	resolveCustomToolSecretPath,
	startHealthServer,
} from "@agent-gateway/service";
import {
	executorRegistry,
	type SecretResolver,
	sandboxExecutors,
	utilityExecutor,
} from "@agent-gateway/tool-broker";
import { startToolRunner } from "./runner.ts";

const environment = readSetting("GATEWAY_ENV") ?? "unset";
const log = createLogger({ service: "tool-runner", version: serviceVersion(), environment });

/** The namespaces this runner serves, e.g. `finance`; its database role must match. */
const namespaces = requireSetting("TOOL_RUNNER_NAMESPACES")
	.split(",")
	.map((name) => name.trim())
	.filter((name) => name !== "")
	.map((name) => ToolNamespaceSchema.parse(name));
if (namespaces.length === 0) {
	throw new Error("TOOL_RUNNER_NAMESPACES names no namespace");
}

/**
 * No real integration ships yet: without executors every approved action fails as known,
 * before anything begins. `TOOL_RUNNER_SANDBOX=true` registers executors that only record the
 * call, in a development or test environment only.
 */
const sandbox = readSetting("TOOL_RUNNER_SANDBOX") === "true";
if (sandbox && environment !== "development" && environment !== "test") {
	throw new Error("TOOL_RUNNER_SANDBOX needs GATEWAY_ENV=development or test");
}
const executors = executorRegistry([
	...(sandbox
		? sandboxExecutors().filter((executor) =>
				namespaces.some((namespace) => executor.actionType.startsWith(`${namespace}.`)),
			)
		: []),
	// A packaged utility is fixed, image-shipped code: always registered when the runner serves
	// `utility`, in every environment — unlike the sandbox executors above, it moves nothing and
	// sends nothing, so it needs no development/test gate.
	...(namespaces.includes("utility") ? [utilityExecutor()] : []),
]);

/** Overrides where a custom tool's secrets are read from (`/run/custom-tool-secrets/` otherwise);
 * local development and tests only — `gateway tools secret set <alias>` writes there in
 * production, read-only here. */
const customToolSecretsDir = readSetting("CUSTOM_TOOL_SECRETS_DIR");

/** Resolves a `custom_https` definition's secret alias from its own file; throws (never a
 * placeholder) when the file is missing or empty, so a custom tool missing its secret cannot be
 * silently half-executed. Built only when this runner actually serves `custom`. */
const customToolSecrets: SecretResolver | undefined = namespaces.includes("custom")
	? async (alias) => readSecretFile(resolveCustomToolSecretPath(alias, customToolSecretsDir))
	: undefined;

const metrics = new MetricsRegistry();
registerProcessMetrics(metrics, { service: "tool-runner", version: serviceVersion() });
const databaseUrl = requireSetting("DATABASE_URL");
const deployment = await claimDeployment(log, databaseUrl);
const runner = await startToolRunner({
	metrics,
	connectionString: databaseUrl,
	namespaces,
	executors,
	log,
	concurrency: intSetting("TOOL_RUNNER_CONCURRENCY", 1),
	customToolSecrets,
});
const health = startHealthServer({
	port: intSetting("HEALTH_PORT", 8083),
	hostname: readSetting("HEALTH_HOST") ?? "127.0.0.1",
	readiness: runner.readiness,
	metrics: () => metrics.render(),
});
log.info("health endpoints listening", { port: health.port });

onShutdown(log, async () => {
	await health.stop();
	await runner.stop();
	await deployment.release();
});
