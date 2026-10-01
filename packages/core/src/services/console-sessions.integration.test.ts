import { createPool, migrateSchema } from "@agent-gateway/db";
import { DEVELOPMENT_VERSION } from "@agent-gateway/logging";
import { migrateQueues } from "@agent-gateway/queue";
import { startTestPostgres, type TestPostgres } from "@agent-gateway/testkit";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	CONSOLE_SESSION_ABSOLUTE_MS,
	CONSOLE_SESSION_IDLE_MS,
	CONSOLE_SESSION_MAX_ACTIVE,
	CONSOLE_SESSION_TOUCH_INTERVAL_MS,
	cleanupExpiredConsoleSessions,
	createConsoleSession,
	revokeAllConsoleSessions,
	revokeConsoleSession,
	rotateConsoleSessionCsrf,
	touchConsoleSession,
} from "./console-sessions.ts";

const FINGERPRINT = "fingerprint-a";

function newSession(suffix: string) {
	return {
		tokenHash: `token-hash-${suffix}`,
		csrfTokenHash: `csrf-hash-${suffix}`,
		passwordHashFingerprint: FINGERPRINT,
	};
}

describe("console session store (ADR-025)", () => {
	let postgres: TestPostgres;
	let pool: pg.Pool;

	beforeAll(async () => {
		postgres = await startTestPostgres();
		pool = createPool(postgres.connectionString, 4);
		await migrateSchema({
			pool,
			connectionString: postgres.connectionString,
			release: DEVELOPMENT_VERSION,
			migrateQueues: () => migrateQueues(postgres.connectionString),
		});
	});

	afterAll(async () => {
		await pool.end();
		await postgres.stop();
	});

	// The active-session cap is global by design (ADR-025: one owner). Each test starts from an
	// empty table so a previous test's still-active rows never count toward another's cap.
	beforeEach(async () => {
		await pool.query("delete from console_sessions");
	});

	it("creates a session and validates it by token hash", async () => {
		const now = new Date("2031-01-01T00:00:00.000Z");
		const created = await createConsoleSession(pool, newSession("a"), now);
		expect(created.expiresAt.getTime()).toBe(now.getTime() + CONSOLE_SESSION_ABSOLUTE_MS);
		const valid = await touchConsoleSession(pool, "token-hash-a", now, FINGERPRINT);
		expect(valid?.id).toBe(created.id);
		expect(valid?.csrfTokenHash).toBe("csrf-hash-a");
		expect(valid?.expiresAt.getTime()).toBe(created.expiresAt.getTime());
	});

	it("rejects an unknown token hash", async () => {
		const now = new Date("2031-01-01T00:00:00.000Z");
		expect(await touchConsoleSession(pool, "no-such-token", now, FINGERPRINT)).toBeNull();
	});

	it("rejects a session bound to a since-rotated password hash fingerprint", async () => {
		const now = new Date("2031-01-02T00:00:00.000Z");
		await createConsoleSession(pool, newSession("fp"), now);
		expect(
			await touchConsoleSession(pool, "token-hash-fp", now, "a-different-fingerprint"),
		).toBeNull();
		// The same session is still valid against the fingerprint it was actually created with.
		expect(await touchConsoleSession(pool, "token-hash-fp", now, FINGERPRINT)).not.toBeNull();
	});

	it("slides the idle timeout, writing last_seen_at only once per touch interval", async () => {
		const start = new Date("2031-01-03T00:00:00.000Z");
		await createConsoleSession(pool, newSession("idle"), start);

		const justAfter = new Date(start.getTime() + 10_000);
		await touchConsoleSession(pool, "token-hash-idle", justAfter, FINGERPRINT);
		const unchanged = await pool.query<{ last_seen_at: Date }>(
			"select last_seen_at from console_sessions where token_hash = $1",
			["token-hash-idle"],
		);
		expect(unchanged.rows[0]?.last_seen_at.getTime()).toBe(start.getTime());

		const pastTouchInterval = new Date(start.getTime() + CONSOLE_SESSION_TOUCH_INTERVAL_MS + 1_000);
		await touchConsoleSession(pool, "token-hash-idle", pastTouchInterval, FINGERPRINT);
		const advanced = await pool.query<{ last_seen_at: Date }>(
			"select last_seen_at from console_sessions where token_hash = $1",
			["token-hash-idle"],
		);
		expect(advanced.rows[0]?.last_seen_at.getTime()).toBe(pastTouchInterval.getTime());

		// More than the idle window past that last touch, the session is no longer valid.
		const pastIdle = new Date(pastTouchInterval.getTime() + CONSOLE_SESSION_IDLE_MS + 1_000);
		expect(await touchConsoleSession(pool, "token-hash-idle", pastIdle, FINGERPRINT)).toBeNull();
	});

	it("expires absolutely even with continuous activity inside the idle window", async () => {
		const start = new Date("2031-01-04T00:00:00.000Z");
		await createConsoleSession(pool, newSession("abs"), start);
		// Touch it every 10 minutes (well inside the 30-minute idle window) right up to the
		// absolute boundary: the idle timer alone would still call this valid.
		let at = start;
		for (let i = 0; i < 70; i += 1) {
			at = new Date(at.getTime() + 10 * 60 * 1000);
			if (at.getTime() >= start.getTime() + CONSOLE_SESSION_ABSOLUTE_MS) {
				break;
			}
			expect(await touchConsoleSession(pool, "token-hash-abs", at, FINGERPRINT)).not.toBeNull();
		}
		const pastAbsolute = new Date(start.getTime() + CONSOLE_SESSION_ABSOLUTE_MS + 1_000);
		expect(await touchConsoleSession(pool, "token-hash-abs", pastAbsolute, FINGERPRINT)).toBeNull();
	});

	it("evicts the oldest active sessions beyond the active cap", async () => {
		const base = new Date("2031-01-05T00:00:00.000Z");
		const ids: string[] = [];
		for (let i = 0; i < 5; i += 1) {
			const created = await createConsoleSession(
				pool,
				newSession(`cap-${i}`),
				new Date(base.getTime() + i * 1_000),
				3,
			);
			ids.push(created.id);
		}
		// Only the 3 newest (cap-2, cap-3, cap-4) remain active; the 2 oldest were revoked.
		expect(await touchConsoleSession(pool, "token-hash-cap-0", base, FINGERPRINT)).toBeNull();
		expect(await touchConsoleSession(pool, "token-hash-cap-1", base, FINGERPRINT)).toBeNull();
		expect((await touchConsoleSession(pool, "token-hash-cap-2", base, FINGERPRINT))?.id).toBe(
			ids[2],
		);
		expect((await touchConsoleSession(pool, "token-hash-cap-4", base, FINGERPRINT))?.id).toBe(
			ids[4],
		);
	});

	it("serializes concurrent creations against the active cap: 19 existing plus 10 concurrent logins stays at exactly 20 active", async () => {
		const base = new Date("2031-01-05T12:00:00.000Z");
		for (let i = 0; i < 19; i += 1) {
			await createConsoleSession(
				pool,
				newSession(`race-existing-${i}`),
				new Date(base.getTime() + i),
			);
		}
		const concurrentNow = new Date(base.getTime() + 1_000);
		// Without serializing the insert-count-evict sequence, each of these can see only the 19
		// pre-existing rows (plus its own, still-uncommitted insert) when it counts active sessions,
		// conclude the cap of 20 is not yet exceeded, and skip eviction — leaving 29 active instead
		// of 20 once all 10 commit.
		await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				createConsoleSession(pool, newSession(`race-new-${i}`), concurrentNow),
			),
		);
		const active = await pool.query<{ count: string }>(
			"select count(*)::text as count from console_sessions where revoked_at is null and expires_at > $1",
			[concurrentNow],
		);
		expect(Number(active.rows[0]?.count)).toBe(CONSOLE_SESSION_MAX_ACTIVE);
	});

	it("validates with a read-only SELECT: two touches inside the touch interval leave the row's xmin unchanged", async () => {
		const now = new Date("2031-01-05T18:00:00.000Z");
		await createConsoleSession(pool, newSession("xmin"), now);
		const before = await pool.query<{ xmin: string }>(
			"select xmin::text as xmin from console_sessions where token_hash = $1",
			["token-hash-xmin"],
		);

		// Both well inside CONSOLE_SESSION_TOUCH_INTERVAL_MS (one minute) of session creation and of
		// each other: neither should write to the row at all.
		await touchConsoleSession(
			pool,
			"token-hash-xmin",
			new Date(now.getTime() + 10_000),
			FINGERPRINT,
		);
		await touchConsoleSession(
			pool,
			"token-hash-xmin",
			new Date(now.getTime() + 20_000),
			FINGERPRINT,
		);

		const after = await pool.query<{ xmin: string }>(
			"select xmin::text as xmin from console_sessions where token_hash = $1",
			["token-hash-xmin"],
		);
		expect(after.rows[0]?.xmin).toBe(before.rows[0]?.xmin);
	});

	it("revokes one session by id", async () => {
		const now = new Date("2031-01-06T00:00:00.000Z");
		const created = await createConsoleSession(pool, newSession("revoke-one"), now);
		await revokeConsoleSession(pool, created.id, "logout", now);
		expect(await touchConsoleSession(pool, "token-hash-revoke-one", now, FINGERPRINT)).toBeNull();
	});

	it("revokes every active session at once, for a password rotation", async () => {
		const now = new Date("2031-01-07T00:00:00.000Z");
		await createConsoleSession(pool, newSession("revoke-all-a"), now);
		await createConsoleSession(pool, newSession("revoke-all-b"), now);
		const revoked = await revokeAllConsoleSessions(pool, "password_rotated", now);
		expect(revoked).toBe(2);
		expect(await touchConsoleSession(pool, "token-hash-revoke-all-a", now, FINGERPRINT)).toBeNull();
		expect(await touchConsoleSession(pool, "token-hash-revoke-all-b", now, FINGERPRINT)).toBeNull();
	});

	it("rotates the CSRF token hash without changing session identity", async () => {
		const now = new Date("2031-01-08T00:00:00.000Z");
		const created = await createConsoleSession(pool, newSession("csrf"), now);
		await rotateConsoleSessionCsrf(pool, created.id, "rotated-csrf-hash");
		const valid = await touchConsoleSession(pool, "token-hash-csrf", now, FINGERPRINT);
		expect(valid?.id).toBe(created.id);
		expect(valid?.csrfTokenHash).toBe("rotated-csrf-hash");
	});

	it("deletes expired and revoked rows on cleanup, keeping sessions still active", async () => {
		const earlier = new Date("2031-01-09T00:00:00.000Z");
		const later = new Date(earlier.getTime() + CONSOLE_SESSION_ABSOLUTE_MS);
		await createConsoleSession(pool, newSession("cleanup-active"), later);
		await createConsoleSession(pool, newSession("cleanup-expire"), earlier);
		const toRevoke = await createConsoleSession(pool, newSession("cleanup-revoke"), earlier);
		await revokeConsoleSession(pool, toRevoke.id, "logout", earlier);

		// Just past cleanup-expire's absolute expiry (== `later`), well before cleanup-active's.
		const cleanupNow = new Date(later.getTime() + 1_000);
		const deleted = await cleanupExpiredConsoleSessions(pool, cleanupNow);
		expect(deleted).toBeGreaterThanOrEqual(2);

		const remaining = await pool.query<{ token_hash: string }>(
			"select token_hash from console_sessions where token_hash = any($1::text[]) order by token_hash",
			[["token-hash-cleanup-active", "token-hash-cleanup-expire", "token-hash-cleanup-revoke"]],
		);
		expect(remaining.rows.map((row) => row.token_hash)).toEqual(["token-hash-cleanup-active"]);
	});
});
