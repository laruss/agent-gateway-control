import { silentLogger } from "@agent-gateway/logging";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectorScopes, createTokenSource } from "./auth.ts";
import { type RunningGmailConnector, startGmailConnector } from "./connector.ts";
import { type FakeGoogle, startFakeGoogle } from "./fake-google.ts";
import { createGmailClient } from "./gmail-client.ts";
import { type MemoryStore, memoryStore } from "./memory-store.ts";
import { createPubsubClient } from "./pubsub-client.ts";

let google: FakeGoogle;
let store: MemoryStore;
let connector: RunningGmailConnector | null = null;

beforeEach(() => {
	now = Date.now();
	google = startFakeGoogle({ ackDeadlineMs: 300 });
	store = memoryStore();
});
afterEach(async () => {
	await connector?.stop();
	connector = null;
	await google.stop();
});

let now = Date.now();

function start(
	overrides: Readonly<{ reconcileMs?: number; watchCheckMs?: number; poll?: boolean }> = {},
): RunningGmailConnector {
	const poll = overrides.poll === true;
	const tokens = createTokenSource({
		client: { clientId: "c", clientSecret: "s" },
		refreshToken: google.refreshToken,
		scopes: connectorScopes(poll ? "poll" : "pubsub"),
		endpoints: google.endpoints,
		clock: () => new Date(),
	});
	connector = startGmailConnector({
		mailboxId: "primary",
		gmail: createGmailClient(google.endpoints, tokens),
		notifications: poll
			? null
			: {
					topicName: google.topic,
					pubsub: createPubsubClient(google.endpoints.pubsub, google.subscription, tokens),
				},
		store,
		log: silentLogger,
		clock: () => new Date(now),
		reconcileMs: overrides.reconcileMs ?? 60_000,
		watchCheckMs: overrides.watchCheckMs ?? 60_000,
		retryMinMs: 50,
		retryMaxMs: 200,
	});
	return connector;
}

async function until<T>(check: () => T | null | undefined | false, what: string): Promise<T> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const value = check();
		if (value !== null && value !== undefined && value !== false) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await Bun.sleep(20);
	}
}

const messages = () =>
	store.events().filter((event) => event.type === "google.gmail.message.received");
const notifications = () =>
	store.events().filter((event) => event.type === "google.gmail.notification.received");

describe("startGmailConnector", () => {
	it("renews the watch, then ingests a notified message once", async () => {
		const running = start();
		await until(() => store.current().historyId !== null && google.watchCalls() === 1, "watch");
		expect(store.current().watchExpiresAt?.getTime()).toBeGreaterThan(Date.now());
		google.deliver({ subject: "hello" });
		await until(() => messages().length === 1, "message");
		await until(() => google.pubsubEntries().every((entry) => entry.acked), "ack");
		expect(notifications()).toHaveLength(1);
		expect(running.status()).toMatchObject({ authorized: true, pulling: true });
	});

	it("dedupes a notification Pub/Sub delivers again", async () => {
		start();
		await until(() => store.current().historyId !== null, "start");
		google.deliver({ subject: "once" });
		await until(() => google.pubsubEntries()[0]?.acked === true, "ack");
		const [entry] = google.pubsubEntries();
		google.redeliver(entry?.messageId ?? "");
		google.publishNotification();
		await until(
			() =>
				google.pubsubEntries().every((e) => e.acked) && google.pubsubEntries()[0]?.deliveries === 2,
			"redelivery",
		);
		expect(messages()).toHaveLength(1);
		expect(notifications()).toHaveLength(2);
	});

	it("finds a message whose notification was lost by the periodic sync", async () => {
		start({ reconcileMs: 300 });
		await until(() => store.current().historyId !== null, "start");
		google.deliver({ subject: "silent" }, { dropNotification: true });
		await until(() => messages().length === 1, "reconciled message");
		expect(notifications()).toHaveLength(0);
	});

	it("leaves a notification unacknowledged while it cannot be recorded", async () => {
		start();
		await until(() => store.current().historyId !== null, "start");
		store.failNext(1);
		google.deliver({ subject: "later" });
		await until(() => google.pubsubEntries()[0]?.acked === true, "ack after retry");
		expect(google.pubsubEntries()[0]?.deliveries).toBe(2);
		await until(() => messages().length === 1, "message");
	});

	it("acknowledges and drops notifications of other mailboxes and malformed ones", async () => {
		start();
		await until(() => store.current().historyId !== null, "start");
		google.publishRaw(JSON.stringify({ emailAddress: "someone@example.net", historyId: 5 }));
		google.publishRaw("not json");
		google.publishRaw(JSON.stringify({ emailAddress: google.emailAddress }));
		await until(
			() => google.pubsubEntries().length === 3 && google.pubsubEntries().every((e) => e.acked),
			"acks",
		);
		expect(notifications()).toHaveLength(0);
	});

	it("renews the watch daily, and alerts when renewal fails close to expiry", async () => {
		start({ watchCheckMs: 50 });
		await until(() => google.watchCalls() === 1, "first watch");
		await Bun.sleep(200);
		expect(google.watchCalls()).toBe(1);
		now += 25 * 60 * 60 * 1000;
		await until(() => google.watchCalls() === 2, "daily renewal");
		google.failWatch(true);
		// The watch from the renewal expires seven days after it (real time); move past five.
		now += 5.5 * 24 * 60 * 60 * 1000;
		await until(() => store.alerts().some((a) => a.includes("cannot be renewed")), "alert");
		google.failWatch(false);
		await until(() => google.watchCalls() === 3, "renewal after recovery");
	});

	it("alerts when notifications cannot be pulled, and keeps syncing", async () => {
		google.failPubsub(true);
		const running = start({ reconcileMs: 300 });
		await until(() => store.alerts().some((a) => a.includes("cannot pull")), "pull alert");
		expect(running.status().pulling).toBe(false);
		google.deliver({ subject: "still found" });
		await until(() => messages().length === 1, "message by sync");
	});

	it("refuses a credential of another account than the stored cursor's", async () => {
		await store.start("5", "another-account-hash");
		const running = start();
		await until(() => running.status().authorized === false, "refusal");
		expect(store.alerts()).toEqual([expect.stringContaining("another Google account")]);
		google.deliver({ subject: "not read" });
		await Bun.sleep(500);
		expect(messages()).toEqual([]);
		expect(store.current().historyId).toBe("5");
		expect(google.watchCalls()).toBe(0);
	});

	it("polls the mailbox without a watch or Pub/Sub, with a read-only credential", async () => {
		google.setGrantedScopes(connectorScopes("poll"));
		const running = start({ poll: true, reconcileMs: 200 });
		await until(() => store.current().historyId !== null, "start");
		google.deliver({ subject: "polled" }, { dropNotification: true });
		await until(() => messages().length === 1, "polled message");
		expect(google.watchCalls()).toBe(0);
		expect(google.requests().some((request) => request.includes("/pubsub/"))).toBe(false);
		expect(running.status()).toMatchObject({ authorized: true, mode: "poll" });
		expect(store.modes()).toEqual([{ mode: "poll", syncSeconds: 1 }]);
	});

	it("refuses a token with the Pub/Sub scope when polling", async () => {
		const running = start({ poll: true, reconcileMs: 200 });
		await until(() => running.status().authorized === false, "refusal");
		expect(store.alerts()).toEqual([expect.stringContaining("cannot use its Google credential")]);
	});

	it("reports a revoked credential and alerts, without stopping", async () => {
		google.revoke();
		const running = start();
		await until(() => running.status().authorized === false, "unauthorized");
		expect(store.alerts()).toEqual(
			expect.arrayContaining([expect.stringContaining("cannot use its Google credential")]),
		);
		expect(store.alerts().some((alert) => alert.includes("watch"))).toBe(true);
	});
});
