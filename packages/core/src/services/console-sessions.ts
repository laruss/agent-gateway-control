import { consoleSessions, withTransaction } from "@agent-gateway/db";
import { and, desc, gt, inArray, isNull } from "drizzle-orm";
import type pg from "pg";

// ---------------------------------------------------------------------------
// The owner's console session store (ADR-025): every value here is a sha256 hash or a server
// generated id, never a raw token — the raw session and CSRF tokens exist only in the HTTP layer
// (`apps/controller/src/console-auth.ts`) that mints and compares them. This module owns the
// `console_sessions` rows only: creation with eviction beyond the active cap (serialized across
// concurrent logins by an advisory lock), the read-only validate-and-conditionally-slide-idle-
// timeout check, revocation and periodic cleanup of rows nobody can use any more.
// ---------------------------------------------------------------------------

/** Sliding idle timeout: a session with no authenticated request in this long is invalid. */
export const CONSOLE_SESSION_IDLE_MS = 30 * 60 * 1000;
/** Absolute lifetime from creation, regardless of activity. */
export const CONSOLE_SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
/** `last_seen_at` only advances this often: an active session does not rewrite its row on every
 * authenticated request, bounding write amplification from an otherwise-idle, polling tab. */
export const CONSOLE_SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
/** Active sessions kept at once; the oldest beyond this are revoked when a new one is created. */
export const CONSOLE_SESSION_MAX_ACTIVE = 20;

export type NewConsoleSession = Readonly<{
	tokenHash: string;
	csrfTokenHash: string;
	passwordHashFingerprint: string;
}>;

export type ConsoleSessionCreated = Readonly<{ id: string; expiresAt: Date }>;

/**
 * Creates a new console session row. The caller always mints a fresh random token before calling
 * this — a client-supplied cookie is never consulted on login — which is what prevents session
 * fixation. Beyond `maxActive` concurrently active sessions, the oldest (by `created_at`) are
 * revoked in the same transaction as this insert.
 */
export async function createConsoleSession(
	pool: pg.Pool,
	input: NewConsoleSession,
	now: Date,
	maxActive: number = CONSOLE_SESSION_MAX_ACTIVE,
): Promise<ConsoleSessionCreated> {
	const expiresAt = new Date(now.getTime() + CONSOLE_SESSION_ABSOLUTE_MS);
	return withTransaction(pool, async (tx) => {
		// Serializes creation-plus-eviction across concurrent logins: without this, two
		// transactions can each count the active rows before the other's insert is visible, both
		// conclude the cap is not yet exceeded, and both skip eviction — leaving more than
		// `maxActive` sessions active. The lock is released automatically at commit or rollback.
		await tx.client.query(
			"select pg_advisory_xact_lock(hashtext('agent-gateway:console-sessions'))",
		);
		const [inserted] = await tx.db
			.insert(consoleSessions)
			.values({
				tokenHash: input.tokenHash,
				csrfTokenHash: input.csrfTokenHash,
				passwordHashFingerprint: input.passwordHashFingerprint,
				createdAt: now,
				lastSeenAt: now,
				expiresAt,
			})
			.returning({ id: consoleSessions.id });
		if (inserted === undefined) {
			throw new Error("console session insert returned no row");
		}
		const active = await tx.db
			.select({ id: consoleSessions.id })
			.from(consoleSessions)
			.where(and(isNull(consoleSessions.revokedAt), gt(consoleSessions.expiresAt, now)))
			.orderBy(desc(consoleSessions.createdAt));
		const evicted = active.slice(maxActive).map((row) => row.id);
		if (evicted.length > 0) {
			await tx.db
				.update(consoleSessions)
				.set({ revokedAt: now, revokedReason: "session_cap" })
				.where(inArray(consoleSessions.id, evicted));
		}
		return { id: inserted.id, expiresAt };
	});
}

export type ConsoleSessionValid = Readonly<{ id: string; csrfTokenHash: string; expiresAt: Date }>;

/**
 * Validates a session by its token hash and slides its idle timeout. A request past
 * `expires_at`, more than `CONSOLE_SESSION_IDLE_MS` after the last one, already revoked, or
 * bound to a since-rotated password hash (`passwordHashFingerprint` no longer matching the
 * stored one) is invalid — `null`, never a thrown error, so a bad cookie is simply
 * unauthenticated. Validation itself is a read-only `SELECT`: `last_seen_at` is only written —
 * a separate, single-row `UPDATE` guarded by the same staleness check — once it is actually
 * older than `CONSOLE_SESSION_TOUCH_INTERVAL_MS`, so a session touched well within that interval
 * (an active tab polling the status endpoint, say) never dirties its row at all.
 */
export async function touchConsoleSession(
	pool: pg.Pool,
	tokenHash: string,
	now: Date,
	passwordHashFingerprint: string,
): Promise<ConsoleSessionValid | null> {
	const idleCutoff = new Date(now.getTime() - CONSOLE_SESSION_IDLE_MS);
	const touchThreshold = new Date(now.getTime() - CONSOLE_SESSION_TOUCH_INTERVAL_MS);
	const result = await pool.query<{
		id: string;
		csrf_token_hash: string;
		expires_at: Date;
		last_seen_at: Date;
	}>(
		`select id, csrf_token_hash, expires_at, last_seen_at
		   from console_sessions
		  where token_hash = $1
		    and revoked_at is null
		    and expires_at > $2
		    and last_seen_at > $3
		    and password_hash_fingerprint = $4`,
		[tokenHash, now, idleCutoff, passwordHashFingerprint],
	);
	const row = result.rows[0];
	if (row === undefined) {
		return null;
	}
	if (new Date(row.last_seen_at).getTime() < touchThreshold.getTime()) {
		// Guarded by the same staleness check it was just read under: a concurrent touch that
		// already slid this past the threshold makes this a no-op instead of a second write.
		await pool.query(
			"update console_sessions set last_seen_at = $2 where id = $1 and last_seen_at < $3",
			[row.id, now, touchThreshold],
		);
	}
	return { id: row.id, csrfTokenHash: row.csrf_token_hash, expiresAt: new Date(row.expires_at) };
}

/**
 * Mints and stores a new CSRF token hash for an already-authenticated session, returning nothing:
 * the caller already holds the raw token it generated and only needs it persisted (ADR-025) —
 * `GET /api/session` uses this so the SPA can recover a usable CSRF token after a reload without
 * the server ever storing anything but its hash.
 */
export async function rotateConsoleSessionCsrf(
	pool: pg.Pool,
	id: string,
	csrfTokenHash: string,
): Promise<void> {
	await pool.query("update console_sessions set csrf_token_hash = $2 where id = $1", [
		id,
		csrfTokenHash,
	]);
}

/** Revokes one session, idempotently (a second revoke of the same row is a no-op). */
export async function revokeConsoleSession(
	pool: pg.Pool,
	id: string,
	reason: string,
	now: Date,
): Promise<void> {
	await pool.query(
		"update console_sessions set revoked_at = $2, revoked_reason = $3 where id = $1 and revoked_at is null",
		[id, now, reason],
	);
}

/**
 * Revokes every currently active session: `gateway console password set` calls this when it has
 * database access, so a password rotation takes effect immediately rather than only once the
 * controller restarts and starts comparing sessions against the new `password_hash_fingerprint`.
 */
export async function revokeAllConsoleSessions(
	pool: pg.Pool,
	reason: string,
	now: Date,
): Promise<number> {
	const result = await pool.query(
		"update console_sessions set revoked_at = $1, revoked_reason = $2 where revoked_at is null",
		[now, reason],
	);
	return result.rowCount ?? 0;
}

/**
 * Deletes session rows nothing can use any more (expired or revoked). Hooked into the
 * controller's existing retention pass (`applyRetention`) rather than only running at login, so
 * rows do not accumulate between logins on a console nobody is actively using.
 */
export async function cleanupExpiredConsoleSessions(pool: pg.Pool, now: Date): Promise<number> {
	const result = await pool.query(
		"delete from console_sessions where expires_at <= $1 or revoked_at is not null",
		[now],
	);
	return result.rowCount ?? 0;
}
