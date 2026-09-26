import { createLogger } from "@agent-gateway/logging";
import { assertRoutingKey } from "@agent-gateway/mattermost";
import { dryRunDeliverers } from "@agent-gateway/outbox";
import {
	intSetting,
	onShutdown,
	readSetting,
	requireSetting,
	startHealthServer,
} from "@agent-gateway/service";
import { type ControllerOptions, startController } from "./controller.ts";
import { loopbackPostDeliverer } from "./loopback-deliverer.ts";
import { bridgeDeliverers, type MattermostBridgeOptions } from "./mattermost-bridge.ts";

const environment = readSetting("GATEWAY_ENV") ?? "unset";
const log = createLogger({ service: "controller", version: "0.0.0", environment });

/**
 * Outbox delivery mode, required explicitly:
 * - `mattermost`: the real bridge. The listener ingests posts, agents post as their own bots.
 * - `dry-run`: logs side effects and marks them sent.
 * - `loopback`: like dry-run, and feeds agent posts back as events, so cascades run without
 *   Mattermost.
 * The last two drop real posts, so they run only with an explicit development or test
 * environment.
 */
const delivery = requireSetting("OUTBOX_DELIVERY");
if (delivery !== "mattermost" && delivery !== "dry-run" && delivery !== "loopback") {
	throw new Error(
		`OUTBOX_DELIVERY '${delivery}' is not supported; use 'mattermost', 'dry-run' or 'loopback'`,
	);
}
// Fail closed: a forgotten or misspelled GATEWAY_ENV must not silently drop real posts.
if (delivery !== "mattermost" && environment !== "development" && environment !== "test") {
	throw new Error(
		`OUTBOX_DELIVERY '${delivery}' delivers nothing; it needs GATEWAY_ENV=development or test`,
	);
}

function bridgeOptions(): MattermostBridgeOptions {
	const routingKey = requireSetting("GATEWAY_ROUTING_KEY");
	assertRoutingKey(routingKey);
	const secretsDir = readSetting("SECRETS_DIR");
	return {
		baseUrl: requireSetting("MATTERMOST_URL"),
		routingKey,
		...(secretsDir === undefined ? {} : { secretsDir }),
	};
}

const bridge = delivery === "mattermost" ? bridgeOptions() : null;
const deliverers: ControllerOptions["deliverers"] = (deps) => {
	if (bridge !== null) {
		return bridgeDeliverers(deps, bridge);
	}
	return delivery === "loopback"
		? { ...dryRunDeliverers(log), "mattermost.post": loopbackPostDeliverer(deps) }
		: dryRunDeliverers(log);
};

const controller = await startController({
	connectionString: requireSetting("DATABASE_URL"),
	log,
	deliverers,
	...(bridge === null ? {} : { mattermost: bridge }),
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
