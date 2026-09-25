import { createLogger } from "@agent-gateway/logging";
import { dryRunDeliverers } from "@agent-gateway/outbox";
import {
	intSetting,
	onShutdown,
	readSetting,
	requireSetting,
	startHealthServer,
} from "@agent-gateway/service";
import { startController } from "./controller.ts";
import { loopbackPostDeliverer } from "./loopback-deliverer.ts";

const environment = readSetting("GATEWAY_ENV") ?? "unset";
const log = createLogger({ service: "controller", version: "0.0.0", environment });

/**
 * Outbox delivery mode, required explicitly: `dry-run` logs side effects and marks them sent;
 * `loopback` also feeds agent posts back as events, so cascades run without Mattermost. Both
 * drop real posts, so they run only with an explicit development or test environment. Real
 * Mattermost delivery arrives with the Mattermost bridge.
 */
const delivery = requireSetting("OUTBOX_DELIVERY");
if (delivery !== "dry-run" && delivery !== "loopback") {
	throw new Error(`OUTBOX_DELIVERY '${delivery}' is not supported; use 'dry-run' or 'loopback'`);
}
// Fail closed: a forgotten or misspelled GATEWAY_ENV must not silently drop real posts.
if (environment !== "development" && environment !== "test") {
	throw new Error(
		`OUTBOX_DELIVERY '${delivery}' delivers nothing; it needs GATEWAY_ENV=development or test`,
	);
}

const controller = await startController({
	connectionString: requireSetting("DATABASE_URL"),
	log,
	deliverers: (deps) =>
		delivery === "loopback"
			? { ...dryRunDeliverers(log), "mattermost.post": loopbackPostDeliverer(deps) }
			: dryRunDeliverers(log),
});
const health = startHealthServer({
	port: intSetting("HEALTH_PORT", 8080),
	hostname: readSetting("HEALTH_HOST") ?? "127.0.0.1",
	readiness: controller.readiness,
});
log.info("health endpoints listening", { port: health.port });

onShutdown(log, async () => {
	await health.stop();
	await controller.stop();
});
