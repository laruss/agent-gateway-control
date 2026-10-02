import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	intSetting,
	readOptionalFileSetting,
	readSetting,
	requireSetting,
	requireSettingPreferEnv,
	SettingError,
} from "./settings.ts";

describe("settings", () => {
	it("prefers the secret file over the variable", () => {
		const dir = mkdtempSync(join(tmpdir(), "gateway-settings-"));
		const file = join(dir, "db_url");
		writeFileSync(file, "from-file\n");
		expect(readSetting("DATABASE_URL", { DATABASE_URL: "from-env", DATABASE_URL_FILE: file })).toBe(
			"from-file",
		);
		expect(readSetting("DATABASE_URL", { DATABASE_URL: "from-env" })).toBe("from-env");
	});

	it("fails clearly on missing or malformed values", () => {
		expect(() => requireSetting("X", {})).toThrow(SettingError);
		expect(intSetting("N", 3, {})).toBe(3);
		expect(intSetting("N", 3, { N: "8" })).toBe(8);
		expect(() => intSetting("N", 3, { N: "8x" })).toThrow(SettingError);
	});

	describe("readOptionalFileSetting", () => {
		it("reads a configured file, like readSetting", () => {
			const dir = mkdtempSync(join(tmpdir(), "gateway-settings-"));
			const file = join(dir, "admin_token");
			writeFileSync(file, "a-token\n");
			expect(
				readOptionalFileSetting("MATTERMOST_ADMIN_TOKEN", { MATTERMOST_ADMIN_TOKEN_FILE: file }),
			).toBe("a-token");
		});

		it("reads unset, not an error, when the configured file does not exist yet", () => {
			const dir = mkdtempSync(join(tmpdir(), "gateway-settings-"));
			expect(
				readOptionalFileSetting("MATTERMOST_ADMIN_TOKEN", {
					MATTERMOST_ADMIN_TOKEN_FILE: join(dir, "never-written"),
				}),
			).toBeUndefined();
		});

		it("still falls back to the plain variable with no _FILE set", () => {
			expect(
				readOptionalFileSetting("MATTERMOST_ADMIN_TOKEN", { MATTERMOST_ADMIN_TOKEN: "a-token" }),
			).toBe("a-token");
			expect(readOptionalFileSetting("MATTERMOST_ADMIN_TOKEN", {})).toBeUndefined();
		});
	});

	describe("requireSettingPreferEnv", () => {
		it(
			"an explicitly passed plain value wins even when _FILE is also configured but absent " +
				"(the fresh-install case: gateway-cli names MATTERMOST_ADMIN_TOKEN_FILE, but nothing has " +
				"written it yet, and requireSetting's own file-first precedence would ENOENT here)",
			() => {
				const dir = mkdtempSync(join(tmpdir(), "gateway-settings-"));
				expect(
					requireSettingPreferEnv("MATTERMOST_ADMIN_TOKEN", {
						MATTERMOST_ADMIN_TOKEN: "from-env",
						MATTERMOST_ADMIN_TOKEN_FILE: join(dir, "never-written"),
					}),
				).toBe("from-env");
			},
		);

		it("an explicitly passed plain value wins over a _FILE that does exist", () => {
			const dir = mkdtempSync(join(tmpdir(), "gateway-settings-"));
			const file = join(dir, "admin_token");
			writeFileSync(file, "from-file\n");
			expect(
				requireSettingPreferEnv("MATTERMOST_ADMIN_TOKEN", {
					MATTERMOST_ADMIN_TOKEN: "from-env",
					MATTERMOST_ADMIN_TOKEN_FILE: file,
				}),
			).toBe("from-env");
		});

		it("falls back to the file when no plain value is set", () => {
			const dir = mkdtempSync(join(tmpdir(), "gateway-settings-"));
			const file = join(dir, "admin_token");
			writeFileSync(file, "from-file\n");
			expect(
				requireSettingPreferEnv("MATTERMOST_ADMIN_TOKEN", { MATTERMOST_ADMIN_TOKEN_FILE: file }),
			).toBe("from-file");
		});

		it("fails clearly when neither is set", () => {
			const dir = mkdtempSync(join(tmpdir(), "gateway-settings-"));
			expect(() =>
				requireSettingPreferEnv("MATTERMOST_ADMIN_TOKEN", {
					MATTERMOST_ADMIN_TOKEN_FILE: join(dir, "never-written"),
				}),
			).toThrow(SettingError);
			expect(() => requireSettingPreferEnv("MATTERMOST_ADMIN_TOKEN", {})).toThrow(SettingError);
		});
	});
});
