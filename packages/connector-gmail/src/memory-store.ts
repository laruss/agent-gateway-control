import type { GatewayEvent, GmailDelta, GmailMode, IngestStatus } from "@agent-gateway/contracts";
import { payloadHash } from "@agent-gateway/events";
import type { GmailStore, MailboxState } from "./sync.ts";

/** An in-memory {@link GmailStore} with the control plane's dedupe semantics. Test-only. */
export type MemoryStore = GmailStore &
	Readonly<{
		events: () => Readonly<GatewayEvent[]>;
		alerts: () => Readonly<string[]>;
		current: () => MailboxState;
		/** Every recorded mode, in order. */
		modes: () => Readonly<Readonly<{ mode: GmailMode; syncSeconds: number }>[]>;
		/** Makes the next `n` writes fail, as a database outage would. */
		failNext: (n: number) => void;
	}>;

export function memoryStore(): MemoryStore {
	let state: MailboxState = {
		historyId: null,
		accountHash: null,
		watchExpiresAt: null,
		watchRenewedAt: null,
		lastSyncAt: null,
		startedAt: null,
	};
	const stored = new Map<string, { event: GatewayEvent; hash: string }>();
	const alerts = new Map<string, string>();
	let failures = 0;
	const modes: { mode: GmailMode; syncSeconds: number }[] = [];
	const maybeFail = () => {
		if (failures > 0) {
			failures -= 1;
			throw new Error("database unavailable");
		}
	};
	const ingest = (event: GatewayEvent): IngestStatus => {
		const key = `${event.source} ${event.id}`;
		const existing = stored.get(key);
		const hash = payloadHash(event);
		if (existing !== undefined) {
			return existing.hash === hash ? "duplicate" : "conflict";
		}
		stored.set(key, { event, hash });
		return "accepted";
	};
	return {
		state: async () => state,
		start: async (historyId, account) => {
			maybeFail();
			if (state.historyId === null) {
				state = { ...state, historyId, accountHash: account, startedAt: new Date() };
			}
		},
		commit: async (delta: GmailDelta) => {
			maybeFail();
			if (state.historyId !== delta.fromHistoryId) {
				return { committed: false, accepted: 0 };
			}
			const accepted = delta.events.filter((event) => ingest(event) === "accepted").length;
			if (delta.alert !== null && !alerts.has(delta.alert.key)) {
				alerts.set(delta.alert.key, delta.alert.message);
			}
			state = {
				...state,
				historyId: delta.toHistoryId,
				lastSyncAt: delta.complete ? new Date() : state.lastSyncAt,
			};
			return { committed: true, accepted };
		},
		recordNotification: async (event) => {
			maybeFail();
			return ingest(event);
		},
		recordWatch: async (historyId, expiresAt, account) => {
			maybeFail();
			state = {
				...state,
				historyId: state.historyId ?? historyId,
				accountHash: state.accountHash ?? account,
				startedAt: state.startedAt ?? new Date(),
				watchExpiresAt: expiresAt,
				watchRenewedAt: new Date(),
			};
		},
		recordMode: async (mode, syncSeconds) => {
			modes.push({ mode, syncSeconds });
		},
		alert: async (key, message) => {
			if (!alerts.has(key)) {
				alerts.set(key, message);
			}
		},
		events: () => [...stored.values()].map((entry) => entry.event),
		alerts: () => [...alerts.values()],
		current: () => state,
		modes: () => [...modes],
		failNext: (n) => {
			failures = n;
		},
	};
}
