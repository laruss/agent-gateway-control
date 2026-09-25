import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { intSetting, readSetting, requireSetting, SettingError } from "./settings.ts";

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
});
