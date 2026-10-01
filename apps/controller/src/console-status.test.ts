import type { ConsoleStatus } from "@agent-gateway/core";
import { describe, expect, it, vi } from "vitest";
import { createConsoleStatusCache } from "./console-status.ts";

/** A minimal, valid-shaped `ConsoleStatus`; only its identity (`alerts[0].key`) matters here. */
function fixture(tag: string): ConsoleStatus {
	return {
		system: {
			asOf: new Date(0).toISOString(),
			killSwitch: false,
			agents: [],
			omittedAgents: 0,
			runtimes: [],
			queues: [],
			outbox: { pending: 0, dead: 0 },
			approvalsPending: 0,
			toolActionsUnknown: 0,
			alerts: [],
			maintenance: [],
		},
		agents: [],
		recentRuns: [],
		alerts: [{ key: tag, message: tag, firedAt: new Date(0).toISOString() }],
	};
}

/** A controllable clock: every call to `clock` reads the current value; `advance` moves it. */
function fakeClock(startMs = 0) {
	let now = startMs;
	return { clock: () => new Date(now), advance: (ms: number) => (now += ms) };
}

/** Resolves or rejects only when the test calls `settle`/`fail`, so a test can hold a collection
 * open to prove sharing and deadline behavior before letting it finish. */
function deferredCollector() {
	const calls: Date[] = [];
	let resolveFn: ((status: ConsoleStatus) => void) | null = null;
	let rejectFn: ((error: Error) => void) | null = null;
	const collector = (now: Date) => {
		calls.push(now);
		return new Promise<ConsoleStatus>((res, rej) => {
			resolveFn = res;
			rejectFn = rej;
		});
	};
	return {
		collector,
		calls,
		settle: (status: ConsoleStatus) => resolveFn?.(status),
		fail: (error: Error) => rejectFn?.(error),
	};
}

describe("createConsoleStatusCache", () => {
	it("shares one collection across concurrent requests", async () => {
		const { collector, calls, settle } = deferredCollector();
		const { clock } = fakeClock();
		const cache = createConsoleStatusCache(collector, { clock });

		const first = cache.get();
		const second = cache.get();
		expect(calls).toHaveLength(1);
		settle(fixture("shared"));
		const [a, b] = await Promise.all([first, second]);
		expect(a).toMatchObject({ state: "ok" });
		expect(b).toMatchObject({ state: "ok" });
		expect(calls).toHaveLength(1);
	});

	it("serves the cached result until the TTL elapses, then collects again", async () => {
		const results: ConsoleStatus[] = [fixture("one"), fixture("two")];
		let callCount = 0;
		const { clock, advance } = fakeClock();
		const collector = vi.fn(async () => {
			const value = results[callCount];
			callCount += 1;
			if (value === undefined) {
				throw new Error("no more fixtures");
			}
			return value;
		});
		const cache = createConsoleStatusCache(collector, { clock, cacheMs: 1_000 });

		const first = await cache.get();
		expect(first).toMatchObject({ state: "ok", status: results[0] });
		expect(collector).toHaveBeenCalledTimes(1);

		advance(500);
		const stillCached = await cache.get();
		expect(stillCached).toMatchObject({ state: "ok", status: results[0] });
		expect(collector).toHaveBeenCalledTimes(1);

		advance(600);
		const refreshed = await cache.get();
		expect(refreshed).toMatchObject({ state: "ok", status: results[1] });
		expect(collector).toHaveBeenCalledTimes(2);
	});

	it("reports unavailable on a cold failure, never an empty healthy system", async () => {
		const { clock } = fakeClock();
		const collector = vi.fn(async (): Promise<ConsoleStatus> => {
			throw new Error("connection refused");
		});
		const cache = createConsoleStatusCache(collector, { clock });

		const snapshot = await cache.get();
		expect(snapshot).toEqual({ state: "unavailable", error: "connection refused" });
	});

	it("falls back to the last good snapshot as stale when a later collection fails", async () => {
		const good = fixture("good");
		let call = 0;
		const { clock, advance } = fakeClock();
		const collector = vi.fn(async (): Promise<ConsoleStatus> => {
			call += 1;
			if (call === 1) {
				return good;
			}
			throw new Error("statement timeout");
		});
		const cache = createConsoleStatusCache(collector, { clock, cacheMs: 1_000 });

		const first = await cache.get();
		expect(first).toMatchObject({ state: "ok", status: good });

		advance(2_000);
		const stale = await cache.get();
		expect(stale).toMatchObject({ state: "stale", status: good, error: "statement timeout" });
	});

	it("recovers once a later collection succeeds again", async () => {
		const good = fixture("good");
		const recovered = fixture("recovered");
		let call = 0;
		const { clock, advance } = fakeClock();
		const collector = vi.fn(async (): Promise<ConsoleStatus> => {
			call += 1;
			if (call === 2) {
				throw new Error("transient");
			}
			return call === 1 ? good : recovered;
		});
		const cache = createConsoleStatusCache(collector, { clock, cacheMs: 1_000 });

		await cache.get();
		advance(2_000);
		const stale = await cache.get();
		expect(stale).toMatchObject({ state: "stale", status: good });

		advance(2_000);
		const ok = await cache.get();
		expect(ok).toMatchObject({ state: "ok", status: recovered });
	});

	it("falls back to stale past the deadline of a slow collection, then recovers in the background", async () => {
		const good = fixture("good");
		const recovered = fixture("recovered-in-background");
		const { clock, advance } = fakeClock();
		const slow = deferredCollector();
		let call = 0;
		const collector = vi.fn((now: Date) => {
			call += 1;
			return call === 1 ? Promise.resolve(good) : slow.collector(now);
		});
		const cache = createConsoleStatusCache(collector, { clock, cacheMs: 10, deadlineMs: 10 });

		const first = await cache.get();
		expect(first).toMatchObject({ state: "ok", status: good });

		advance(20); // Past the TTL: the next request starts a new, slow collection.
		const duringSlowCollection = await cache.get();
		expect(duringSlowCollection).toMatchObject({ state: "stale", status: good });
		// Only one collection is ever in flight: the slow one, never a second started behind it.
		expect(collector).toHaveBeenCalledTimes(2);

		slow.settle(recovered);
		const after = await cache.get();
		expect(after).toMatchObject({ state: "ok", status: recovered });
		expect(collector).toHaveBeenCalledTimes(2);
	});

	it("never starts a second collection while the first is still pending, even across many requests", async () => {
		const { collector, calls, settle } = deferredCollector();
		const { clock } = fakeClock();
		const cache = createConsoleStatusCache(collector, { clock });

		const requests = Array.from({ length: 10 }, () => cache.get());
		expect(calls).toHaveLength(1);
		settle(fixture("piled-up"));
		const results = await Promise.all(requests);
		for (const result of results) {
			expect(result).toMatchObject({ state: "ok" });
		}
		expect(calls).toHaveLength(1);
	});
});
