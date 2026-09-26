import { silentLogger } from "@agent-gateway/logging";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTokenSource } from "./auth.ts";
import { type FakeGoogle, startFakeGoogle } from "./fake-google.ts";
import { createGmailClient } from "./gmail-client.ts";
import { type MemoryStore, memoryStore } from "./memory-store.ts";
import { accountHash, MAX_FULL_SYNC_MESSAGES, syncMailbox } from "./sync.ts";

let google: FakeGoogle;
let store: MemoryStore;

beforeEach(() => {
	google = startFakeGoogle();
	store = memoryStore();
});
afterEach(async () => {
	await google.stop();
});

function deps() {
	const tokens = createTokenSource({
		client: { clientId: "c", clientSecret: "s" },
		refreshToken: google.refreshToken,
		endpoints: google.endpoints,
		clock: () => new Date(),
	});
	return {
		mailboxId: "primary",
		gmail: createGmailClient(google.endpoints, tokens),
		store,
		accountHash: accountHash(google.emailAddress),
		log: silentLogger,
		clock: () => new Date(),
	};
}

const subjects = () => store.events().map((event) => event.data.subject);

describe("syncMailbox", () => {
	it("starts at the mailbox's present without replaying old mail", async () => {
		google.deliver({ subject: "old" });
		expect(await syncMailbox(deps())).toMatchObject({ kind: "started", accepted: 0 });
		expect(store.current().historyId).toBe(google.historyId());
		expect(store.events()).toEqual([]);
	});

	it("turns every new inbox message into one event and moves the cursor", async () => {
		await syncMailbox(deps());
		google.deliver({ subject: "one" });
		google.deliver({ subject: "spam", labels: ["INBOX", "SPAM"] });
		google.deliver({ subject: "sent", labels: ["SENT"] });
		const deleted = google.deliver({ subject: "deleted" });
		google.deleteMessage(deleted);
		google.deliver({ subject: "two" });
		expect(await syncMailbox(deps())).toMatchObject({ kind: "synced", accepted: 2 });
		expect(subjects()).toEqual(["one", "two"]);
		expect(store.current().historyId).toBe(google.historyId());
		expect(await syncMailbox(deps())).toMatchObject({ kind: "synced", accepted: 0 });
	});

	it("keeps mail archived before it was read, and leaves out mail moved to spam", async () => {
		await syncMailbox(deps());
		const archived = google.deliver({ subject: "archived" });
		google.setLabels(archived, ["UNREAD"]);
		const spam = google.deliver({ subject: "spam later" });
		google.setLabels(spam, ["INBOX", "SPAM"]);
		expect(await syncMailbox(deps())).toMatchObject({ accepted: 1 });
		expect(subjects()).toEqual(["archived"]);
	});

	it("takes mail moved into the inbox later, once", async () => {
		await syncMailbox(deps());
		const skipped = google.deliver({ subject: "filtered", labels: ["CATEGORY_UPDATES"] });
		expect(await syncMailbox(deps())).toMatchObject({ accepted: 0 });
		google.setLabels(skipped, ["INBOX", "CATEGORY_UPDATES"]);
		expect(await syncMailbox(deps())).toMatchObject({ accepted: 1 });
		google.setLabels(skipped, ["CATEGORY_UPDATES"]);
		google.setLabels(skipped, ["INBOX"]);
		expect(await syncMailbox(deps())).toMatchObject({ accepted: 0 });
		expect(subjects()).toEqual(["filtered"]);
	});

	it("looks back from the last completed sync, not from a page it stopped after", async () => {
		await syncMailbox(deps());
		await syncMailbox(deps());
		const completed = store.current().lastSyncAt;
		expect(completed).not.toBeNull();
		for (let i = 0; i < 150; i += 1) {
			google.deliver({ subject: `m${i}` }, { dropNotification: true });
		}
		const commit = store.commit;
		let commits = 0;
		const stopping = {
			...deps(),
			store: {
				...store,
				commit: async (delta: Parameters<typeof commit>[0]) => {
					commits += 1;
					if (commits === 2) {
						throw new Error("stopped");
					}
					return commit(delta);
				},
			},
		};
		await expect(syncMailbox(stopping)).rejects.toThrow("stopped");
		expect(store.current().lastSyncAt).toEqual(completed);
		google.expireHistory(google.historyId());
		expect(await syncMailbox(deps())).toMatchObject({ kind: "full_sync", accepted: 50 });
		expect(new Set(subjects()).size).toBe(150);
	});

	it("records a sync that found nothing new", async () => {
		await syncMailbox(deps());
		expect(store.current().lastSyncAt).toBeNull();
		await syncMailbox(deps());
		expect(store.current().lastSyncAt).not.toBeNull();
	});

	it("commits page by page, so a failure resumes after the last committed page", async () => {
		await syncMailbox(deps());
		for (let i = 0; i < 150; i += 1) {
			google.deliver({ subject: `m${i}` });
		}
		const commit = store.commit;
		let commits = 0;
		const failing = {
			...deps(),
			store: {
				...store,
				commit: async (delta: Parameters<typeof commit>[0]) => {
					commits += 1;
					if (commits === 2) {
						throw new Error("database unavailable");
					}
					return commit(delta);
				},
			},
		};
		await expect(syncMailbox(failing)).rejects.toThrow("database unavailable");
		expect(store.events()).toHaveLength(100);
		expect(await syncMailbox(deps())).toMatchObject({ kind: "synced", accepted: 50 });
		expect(new Set(subjects()).size).toBe(150);
	});

	it("refuses to commit over a cursor another sync moved", async () => {
		await syncMailbox(deps());
		google.deliver({ subject: "one" });
		const racing = {
			...deps(),
			store: {
				...store,
				commit: async (delta: Parameters<typeof store.commit>[0]) =>
					store.commit({ ...delta, fromHistoryId: "1" }),
			},
		};
		expect(await syncMailbox(racing)).toMatchObject({ kind: "stale" });
		expect(store.events()).toEqual([]);
	});

	it("re-reads recent inbox mail when the history is gone, and alerts", async () => {
		await syncMailbox(deps());
		google.deliver({ subject: "seen" });
		await syncMailbox(deps());
		google.deliver({ subject: "missed" });
		google.expireHistory(google.historyId());
		expect(await syncMailbox(deps())).toMatchObject({ kind: "full_sync", accepted: 1 });
		expect(subjects()).toEqual(["seen", "missed"]);
		expect(store.current().historyId).toBe(google.historyId());
		expect(store.alerts()).toEqual([expect.stringContaining("no longer available")]);
		google.deliver({ subject: "after" });
		expect(await syncMailbox(deps())).toMatchObject({ kind: "synced", accepted: 1 });
	});

	it("bounds a full sync and says what it left unread", async () => {
		await syncMailbox(deps());
		for (let i = 0; i < MAX_FULL_SYNC_MESSAGES + 10; i += 1) {
			google.deliver({ subject: `m${i}` }, { dropNotification: true });
		}
		google.expireHistory(google.historyId());
		expect(await syncMailbox(deps())).toMatchObject({
			kind: "full_sync",
			accepted: MAX_FULL_SYNC_MESSAGES,
		});
		// The newest ones, oldest first.
		expect(subjects().at(0)).toBe("m10");
		expect(subjects().at(-1)).toBe(`m${MAX_FULL_SYNC_MESSAGES + 9}`);
		expect(store.alerts()).toEqual([expect.stringContaining("was NOT read")]);
	});
});
