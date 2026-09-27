import { randomBytes } from "node:crypto";
import {
	connectorScopes,
	createGmailClient,
	createPubsubClient,
	createTokenSource,
	GOOGLE_ENDPOINTS,
} from "@agent-gateway/connector-gmail";
import { eventually, startTestGateway, type TestGateway } from "@agent-gateway/controller/testing";
import { silentLogger } from "@agent-gateway/logging";
import { readSecretFile, readSetting } from "@agent-gateway/service";
import { afterAll, describe, expect, it } from "vitest";
import { type RunningGmailConnectorApp, startGmailConnectorApp } from "./connector-app.ts";

/**
 * Against the real Google APIs and the mailbox the refresh token belongs to, configured as
 * for the connector (GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET[_FILE],
 * GMAIL_REFRESH_TOKEN_FILE; GMAIL_PUBSUB_TOPIC and GMAIL_PUBSUB_SUBSCRIPTION for the push
 * mode, else it polls). The end-to-end test waits for an email whose subject contains the
 * printed token: send it to the mailbox. Nothing of the mail is printed.
 */
const settings = {
	clientId: readSetting("GMAIL_OAUTH_CLIENT_ID"),
	clientSecret: readSetting("GMAIL_OAUTH_CLIENT_SECRET"),
	refreshTokenFile: readSetting("GMAIL_REFRESH_TOKEN_FILE"),
	topic: readSetting("GMAIL_PUBSUB_TOPIC"),
	subscription: readSetting("GMAIL_PUBSUB_SUBSCRIPTION"),
};
const configured =
	settings.clientId !== undefined &&
	settings.clientSecret !== undefined &&
	settings.refreshTokenFile !== undefined;
const pubsub =
	settings.topic !== undefined && settings.subscription !== undefined
		? { topicName: settings.topic, subscription: settings.subscription }
		: null;
const scopes = connectorScopes(pubsub === null ? "poll" : "pubsub");

function required(value: string | undefined): string {
	if (value === undefined) {
		throw new Error("not configured");
	}
	return value;
}

const client = () => ({
	clientId: required(settings.clientId),
	clientSecret: required(settings.clientSecret),
});
const refreshToken = () => readSecretFile(required(settings.refreshTokenFile));

let gateway: TestGateway | null = null;
let app: RunningGmailConnectorApp | null = null;

afterAll(async () => {
	await app?.stop();
	await gateway?.stop();
});

describe.runIf(configured)("Gmail connector against Google", () => {
	it("holds exactly the connector's scopes and reaches Gmail (and Pub/Sub)", async () => {
		const tokens = createTokenSource({
			client: client(),
			refreshToken: refreshToken(),
			scopes,
			endpoints: GOOGLE_ENDPOINTS,
			clock: () => new Date(),
		});
		await tokens.accessToken();
		const gmail = createGmailClient(GOOGLE_ENDPOINTS, tokens);
		const profile = await gmail.profile();
		const page = await gmail.history(profile.historyId, null);
		expect(page?.historyId).toBeDefined();
		if (pubsub !== null) {
			const client = createPubsubClient(GOOGLE_ENDPOINTS.pubsub, pubsub.subscription, tokens);
			// Pulled messages are not acknowledged: they are delivered again after the deadline.
			await client.pull(1, AbortSignal.timeout(70_000));
		}
	});

	it("wakes mail-follower once for an email sent to the mailbox", async () => {
		gateway = await startTestGateway();
		app = await startGmailConnectorApp({
			connectionString: gateway.postgres.connectionString,
			mailboxId: "live",
			pubsub,
			client: client(),
			refreshToken: refreshToken(),
			endpoints: GOOGLE_ENDPOINTS,
			log: silentLogger,
			reconcileMs: pubsub === null ? 20_000 : 60_000,
		});
		const pool = gateway.pool;
		await eventually(
			async () =>
				(
					await pool.query(
						pubsub === null
							? "select 1 from gmail_mailboxes"
							: "select 1 from gmail_mailboxes where watch_expires_at > now()",
					)
				).rowCount === 1,
			60_000,
			"the mailbox cursor",
		);
		const token = `gateway-live-${randomBytes(4).toString("hex")}`;
		console.log(`Send an email with '${token}' in its subject to the mailbox now.`);
		const event = await eventually(
			async () =>
				(
					await pool.query<{ id: string; trust_level: string }>(
						"select id, trust_level from events where type = 'google.gmail.message.received' and payload->>'subject' like $1",
						[`%${token}%`],
					)
				).rows[0],
			600_000,
			"the email",
		);
		expect(event.trust_level).toBe("external-untrusted");
		const run = await eventually(
			async () =>
				(
					await pool.query<{ status: string }>(
						"select status from agent_runs where agent_id = 'mail-follower' and trigger_event_id = $1",
						[event.id],
					)
				).rows[0],
			60_000,
			"the mail-follower run",
		);
		expect(["queued", "running", "succeeded"]).toContain(run.status);
		if (pubsub !== null) {
			// A notification also arrived and was stored, not only the periodic sync.
			const notifications = await pool.query(
				"select 1 from events where type = 'google.gmail.notification.received'",
			);
			expect(notifications.rowCount).toBeGreaterThan(0);
		}
		expect(
			(
				await pool.query(
					"select 1 from events where type = 'google.gmail.message.received' and payload->>'subject' like $1",
					[`%${token}%`],
				)
			).rowCount,
		).toBe(1);
	});
});
