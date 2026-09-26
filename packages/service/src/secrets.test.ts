import { mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSecretFile, resolveSecretPath, secretFileState, writeSecretFile } from "./secrets.ts";
import { SettingError } from "./settings.ts";

describe("secret files", () => {
	it("maps configured references into a secrets directory", () => {
		expect(resolveSecretPath("/run/secrets/mm_developer_token", undefined)).toBe(
			"/run/secrets/mm_developer_token",
		);
		expect(resolveSecretPath("/run/secrets/mm_developer_token", "/tmp/s")).toBe(
			"/tmp/s/mm_developer_token",
		);
		expect(() => resolveSecretPath("/etc/passwd", undefined)).toThrow(SettingError);
		expect(() => resolveSecretPath("/run/secrets/a/../b", undefined)).toThrow(SettingError);
	});

	it("writes owner-only files, replaces atomically and refuses symlinks", () => {
		const dir = mkdtempSync(join(tmpdir(), "gateway-secrets-"));
		const path = join(dir, "nested", "token");
		writeSecretFile(path, "first");
		expect(readSecretFile(path)).toBe("first");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		writeSecretFile(path, "second");
		expect(readSecretFile(path)).toBe("second");

		const target = join(dir, "elsewhere");
		writeFileSync(target, "x");
		const link = join(dir, "link");
		symlinkSync(target, link);
		expect(() => writeSecretFile(link, "leak")).toThrow(SettingError);
		expect(secretFileState(path)).toBe("private");
		expect(secretFileState(link)).toBe("symlink");
		expect(secretFileState(target)).toBe("exposed");
		expect(secretFileState(join(dir, "none"))).toBe("missing");
	});

	it("rejects empty secrets", () => {
		const dir = mkdtempSync(join(tmpdir(), "gateway-secrets-"));
		const path = join(dir, "empty");
		writeFileSync(path, "\n");
		expect(() => readSecretFile(path)).toThrow(SettingError);
	});
});
