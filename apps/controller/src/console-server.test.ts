import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashConsolePassword } from "@agent-gateway/service";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConsolePasswordHash } from "./console-server.ts";

// ---------------------------------------------------------------------------
// `resolveConsolePasswordHash` is the only part of the console listener that needs no database,
// so it is the only part left as a plain unit test (ADR-025); every authenticated route now
// depends on `console_sessions`, exercised against a real PostgreSQL in
// `console.integration.test.ts`.
// ---------------------------------------------------------------------------

const PASSWORD = "unit test console password";

describe("resolveConsolePasswordHash", () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir !== null) {
			rmSync(dir, { recursive: true, force: true });
			dir = null;
		}
	});

	it("fails closed when the hash file is missing", () => {
		const created = mkdtempSync(join(tmpdir(), "console-hash-"));
		dir = created;
		expect(() => resolveConsolePasswordHash(created)).toThrow(/missing/);
	});

	it("fails closed when the hash file is exposed (not private)", async () => {
		const created = mkdtempSync(join(tmpdir(), "console-hash-"));
		dir = created;
		const path = join(created, "console_password_hash");
		await Bun.write(path, "$argon2id$not-really-checked-here");
		chmodSync(path, 0o644); // group/world readable: intentionally not private.
		expect(() => resolveConsolePasswordHash(created)).toThrow(/private/);
	});

	it("reads the hash once it is written privately", async () => {
		const created = mkdtempSync(join(tmpdir(), "console-hash-"));
		dir = created;
		const path = join(created, "console_password_hash");
		const hash = await hashConsolePassword(PASSWORD);
		await Bun.write(path, hash);
		chmodSync(path, 0o600);
		expect(resolveConsolePasswordHash(created)).toBe(hash);
	});
});
