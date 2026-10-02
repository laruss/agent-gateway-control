/**
 * Argon2id hashing for the console's one owner password (ADR-023): only this hash is ever
 * stored, never the password, and the CLI (`gateway console password set`) and the controller's
 * session login (ADR-025) share this module so both sides agree on what a valid hash looks like.
 * Bun hashes and verifies Argon2id natively (`Bun.password`), so no dependency is needed for it.
 */

import { createHash } from "node:crypto";

/** Short enough to type at a prompt, long enough to matter for a single owner credential. The
 * maximum, in UTF-16 units, also sizes the controller's Authorization header limit. */
export const CONSOLE_PASSWORD_MIN_LENGTH = 12;
export const CONSOLE_PASSWORD_MAX_LENGTH = 256;

/**
 * OWASP's current Argon2id minimum (one lane, 19 MiB, two passes). This credential is checked
 * on every console request but hashed only when the owner rotates it, so the cost is picked for
 * that minimum rather than tuned for throughput.
 */
const MEMORY_COST_KIB = 19_456;
const TIME_COST = 2;

/** Hashes a console owner password as Argon2id. Never logs or returns the password itself. */
export async function hashConsolePassword(password: string): Promise<string> {
	return Bun.password.hash(password, {
		algorithm: "argon2id",
		memoryCost: MEMORY_COST_KIB,
		timeCost: TIME_COST,
	});
}

/**
 * Verifies a candidate password against a stored Argon2id hash. A hash Bun cannot parse (wrong
 * algorithm, a corrupted or truncated secret file) fails the check instead of throwing: a
 * malformed stored hash must never turn into a crash, only a rejected login.
 */
export async function verifyConsolePassword(password: string, hash: string): Promise<boolean> {
	try {
		return await Bun.password.verify(password, hash);
	} catch {
		return false;
	}
}

/**
 * A stable fingerprint of the Argon2id hash file's own content (ADR-025): every console session
 * stores the fingerprint in effect when it was created, so a rotated password — a changed hash
 * file — makes every session bound to the old one stop matching on its very next request, without
 * any database write of its own. Never reversible to the hash or the password; only ever compared
 * for equality.
 */
export function consolePasswordHashFingerprint(hash: string): string {
	return createHash("sha256").update(hash, "utf8").digest("hex");
}
