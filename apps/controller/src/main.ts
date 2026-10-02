import { lookup } from "node:dns/promises";
import { createLogger, serviceVersion } from "@agent-gateway/logging";
import { assertRoutingKey } from "@agent-gateway/mattermost";
import { dryRunDeliverers } from "@agent-gateway/outbox";
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
import { withPendingApprovalCards } from "./approval-cards.ts";
import { assertConsoleOrigin } from "./console-auth.ts";
import { resolveConsolePasswordHash, startConsoleServer } from "./console-server.ts";
import { collectConsoleStatus, createConsoleStatusCache } from "./console-status.ts";
import { type ControllerOptions, startController } from "./controller.ts";
import { loopbackApprovalCardDeliverer, loopbackPostDeliverer } from "./loopback-deliverer.ts";
import { bridgeDeliverers, type MattermostBridgeOptions } from "./mattermost-bridge.ts";

const environment = readSetting("GATEWAY_ENV") ?? "unset";
const log = createLogger({
	service: "controller",
	version: serviceVersion(),
	environment,
});

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

/**
 * The owner's console (ADR-023, ADR-025) is off unless explicitly turned on, and its password
 * hash is read and validated here, before the controller or health listener starts: a missing,
 * exposed or unreadable hash file must fail the whole process closed, never start everything
 * else and skip only the console, and never start a listener that would end up serving
 * unauthenticated.
 */
const consoleEnabled = readSetting("CONSOLE_ENABLED") === "true";
const consolePasswordHash = consoleEnabled
	? resolveConsolePasswordHash(readSetting("SECRETS_DIR"))
	: null;
/** Exact `Origin` every console login and mutation must carry (ADR-025); read and validated here,
 * alongside the password hash, before anything the console serves starts. */
const consoleOrigin = consoleEnabled ? assertConsoleOrigin(requireSetting("CONSOLE_ORIGIN")) : null;
/**
 * The console's CSRF token is derived from the session token with this key (ADR-025), under its
 * own HMAC label (`deriveCsrfToken`) — not stored anywhere, so there is nothing to rotate or
 * invalidate across tabs. Reusing the routing key avoids a secret file of its own; read here,
 * independent of `OUTBOX_DELIVERY`, since the console does not depend on the Mattermost bridge
 * being the delivery mode this process runs with.
 */
const consoleCsrfKey = consoleEnabled ? requireSetting("GATEWAY_ROUTING_KEY") : null;
if (consoleCsrfKey !== null) {
	assertRoutingKey(consoleCsrfKey);
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
		return withPendingApprovalCards(deps, bridgeDeliverers(deps, bridge));
	}
	return delivery === "loopback"
		? withPendingApprovalCards(deps, {
				...dryRunDeliverers(log),
				"mattermost.post": loopbackPostDeliverer(deps),
				"mattermost.approval": loopbackApprovalCardDeliverer(),
			})
		: dryRunDeliverers(log);
};

const metrics = new MetricsRegistry();
registerProcessMetrics(metrics, {
	service: "controller",
	version: serviceVersion(),
});
const databaseUrl = requireSetting("DATABASE_URL");
const deployment = await claimDeployment(log, databaseUrl);
const controller = await startController({
	connectionString: databaseUrl,
	log,
	deliverers,
	metrics,
	...(bridge === null ? {} : { mattermost: bridge }),
});
const health = startHealthServer({
	port: intSetting("HEALTH_PORT", 8080),
	hostname: readSetting("HEALTH_HOST") ?? "127.0.0.1",
	readiness: controller.readiness,
	metrics: () => metrics.render(),
});
log.info("health endpoints listening", { port: health.port });

// A name (the container's alias on the proxy-facing network) is resolved once here and the
// listener binds that one address, never every interface of the container.
const consoleAddress = consoleEnabled
	? (await lookup(readSetting("CONSOLE_HOST") ?? "127.0.0.1", { family: 4 })).address
	: null;
/** The built console SPA's directory; defaults (inside `startConsoleServer`) to the path the
 * release image bakes it into. Overridden in development and tests to point at a local build or
 * a fixture. */
const consoleStaticDir = readSetting("CONSOLE_STATIC_DIR");
const ownerConsole =
	consoleAddress !== null &&
	consolePasswordHash !== null &&
	consoleOrigin !== null &&
	consoleCsrfKey !== null
		? startConsoleServer({
				port: intSetting("CONSOLE_PORT", 8084),
				hostname: consoleAddress,
				passwordHash: consolePasswordHash,
				origin: consoleOrigin,
				csrfKey: consoleCsrfKey,
				deps: controller.deps,
				cache: createConsoleStatusCache((now) => collectConsoleStatus(controller.deps.pool, now)),
				log,
				...(consoleStaticDir === undefined ? {} : { staticDir: consoleStaticDir }),
			})
		: null;
if (ownerConsole !== null) {
	log.info("console listening", {
		address: consoleAddress,
		port: ownerConsole.port,
	});
}

onShutdown(log, async () => {
	await ownerConsole?.stop();
	await health.stop();
	await controller.stop();
	await deployment.release();
});
