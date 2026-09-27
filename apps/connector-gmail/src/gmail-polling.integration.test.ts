import { connectorScopes } from "@agent-gateway/connector-gmail";
import { type FakeGoogle, startFakeGoogle } from "@agent-gateway/connector-gmail/testing";
import { eventually, startTestGateway, type TestGateway } from "@agent-gateway/controller/testing";
import { silentLogger } from "@agent-gateway/logging";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningGmailConnectorApp, startGmailConnectorApp } from "./connector-app.ts";

let gateway: TestGateway;
let google: FakeGoogle;
let app: RunningGmailConnectorApp | null = null;

async function startApp(): Promise<RunningGmailConnectorApp> {
	app = await startGmailConnectorApp({
		connectionString: gateway.postgres.connectionString,
		mailboxId: "primary",
		pubsub: null,
		client: { clientId: "client-id", clientSecret: "client-secret" },
		refreshToken: google.refreshToken,
		endpoints: google.endpoints,
		log: silentLogger,
		reconcileMs: 300,
		retryMinMs: 50,
		retryMaxMs: 500,
	});
	return app;
}

const query = async <T extends object>(text: string, values: Readonly<string[]> = []) =>
	(await gateway.pool.query<T>(text, [...values])).rows;

const mailRuns = () =>
	query<{ status: string }>(
		"select status from agent_runs where agent_id = 'mail-follower' order by queued_at",
	);

beforeAll(async () => {
	gateway = await startTestGateway();
	// Polling needs nothing but reading mail: a token with more is refused.
	google = startFakeGoogle({ grantedScopes: connectorScopes("poll") });
	await startApp();
	await eventually(
		async () => (await query("select 1 from gmail_mailboxes")).length === 1,
		10_000,
		"the mailbox cursor",
	);
});

afterAll(async () => {
	await app?.stop();
	await google?.stop();
	await gateway?.stop();
});

describe("Gmail connector without Pub/Sub", () => {
	it("wakes mail-follower once per email by polling, and resumes after a restart", async () => {
		google.deliver({ subject: "Polled", text: "found by polling" }, { dropNotification: true });
		await eventually(
			async () => {
				const runs = await mailRuns();
				return runs.length === 1 && runs[0]?.status === "succeeded";
			},
			30_000,
			"the mail-follower run",
		);
		await app?.stop();
		google.deliver({ subject: "While down", text: "later" }, { dropNotification: true });
		await startApp();
		await eventually(async () => (await mailRuns()).length === 2, 30_000, "the second run");
		await app?.connector.syncNow();
		expect(await mailRuns()).toHaveLength(2);
		expect(google.watchCalls()).toBe(0);
		expect(google.requests().some((request) => request.includes("/pubsub/"))).toBe(false);
		const checks = (await app?.readiness())?.map((check) => check.name);
		expect(checks).toEqual(["postgres", "gmail_auth", "gmail_sync"]);
		// Recorded for `gateway health`, which checks no watch for a polling mailbox.
		expect(await query("select mode, sync_seconds from gmail_mailboxes")).toEqual([
			{ mode: "poll", sync_seconds: 1 },
		]);
	});
});
