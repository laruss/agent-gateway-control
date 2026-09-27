import { GOOGLE_ENDPOINTS, SUBSCRIPTION_NAME, TOPIC_NAME } from "@agent-gateway/connector-gmail";
import { GmailMailboxIdSchema } from "@agent-gateway/contracts";
import { createLogger } from "@agent-gateway/logging";
import {
	intSetting,
	onShutdown,
	readSecretFile,
	readSetting,
	requireSetting,
	SettingError,
	secretFileState,
	startHealthServer,
} from "@agent-gateway/service";
import { startGmailConnectorApp } from "./connector-app.ts";

const environment = readSetting("GATEWAY_ENV") ?? "unset";
const log = createLogger({ service: "connector-gmail", version: "0.0.0", environment });

function nameSetting(name: string, pattern: RegExp, example: string): string {
	const value = requireSetting(name);
	if (!pattern.test(value)) {
		throw new SettingError(`setting ${name} must look like '${example}'`);
	}
	return value;
}

/** Pub/Sub notifications when both are set; neither polls the mailbox. */
function pubsubSettings() {
	const topic = readSetting("GMAIL_PUBSUB_TOPIC");
	const subscription = readSetting("GMAIL_PUBSUB_SUBSCRIPTION");
	if (topic === undefined && subscription === undefined) {
		return null;
	}
	return {
		topicName: nameSetting("GMAIL_PUBSUB_TOPIC", TOPIC_NAME, "projects/<project>/topics/<topic>"),
		subscription: nameSetting(
			"GMAIL_PUBSUB_SUBSCRIPTION",
			SUBSCRIPTION_NAME,
			"projects/<project>/subscriptions/<subscription>",
		),
	};
}
const pubsub = pubsubSettings();

if (readSetting("GMAIL_RECONCILE_SECONDS") !== undefined) {
	throw new SettingError("GMAIL_RECONCILE_SECONDS was renamed; set GMAIL_SYNC_SECONDS instead");
}

const mailboxId = GmailMailboxIdSchema.parse(readSetting("GMAIL_MAILBOX_ID") ?? "primary");
// A file only: the refresh token reads all mail, it never lives in an environment variable.
const refreshTokenFile = requireSetting("GMAIL_REFRESH_TOKEN_FILE");
const readRefreshToken = () => {
	const state = secretFileState(refreshTokenFile);
	if (state !== "private") {
		throw new SettingError(
			`the Gmail refresh token file must be a regular file only its owner can read (is ${state})`,
		);
	}
	return readSecretFile(refreshTokenFile);
};
const refreshToken = readRefreshToken();

const app = await startGmailConnectorApp({
	connectionString: requireSetting("DATABASE_URL"),
	mailboxId,
	pubsub,
	client: {
		clientId: requireSetting("GMAIL_OAUTH_CLIENT_ID"),
		clientSecret: requireSetting("GMAIL_OAUTH_CLIENT_SECRET"),
	},
	refreshToken,
	endpoints: GOOGLE_ENDPOINTS,
	log,
	// Polling every minute by default; with notifications, a sync every five catches lost ones.
	reconcileMs: intSetting("GMAIL_SYNC_SECONDS", pubsub === null ? 60 : 300) * 1000,
});
const health = startHealthServer({
	port: intSetting("HEALTH_PORT", 8082),
	hostname: readSetting("HEALTH_HOST") ?? "127.0.0.1",
	readiness: app.readiness,
});
log.info("health endpoints listening", { port: health.port });

onShutdown(log, async () => {
	await health.stop();
	await app.stop();
});
