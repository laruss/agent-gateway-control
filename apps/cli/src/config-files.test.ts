import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configBundleProblems } from "@agent-gateway/core";
import { describe, expect, it } from "vitest";
import { ConfigFileError, loadConfigDirectory, readPromptFile } from "./config-files.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("config files", () => {
	it("loads and validates the example configuration with its prompts", () => {
		const input = loadConfigDirectory(join(repoRoot, "config/examples"), repoRoot);
		expect(input.agents.map((a) => a.id).sort()).toEqual([
			"developer",
			"director",
			"finance",
			"mail-follower",
			"research",
		]);
		expect(input.constitution.length).toBeGreaterThan(0);
		expect(Object.keys(input.rolePrompts).sort()).toEqual(input.agents.map((a) => a.id).sort());
		expect(configBundleProblems(input)).toEqual([]);
	});

	it("refuses prompt files that resolve outside the root", () => {
		const outside = mkdtempSync(join(tmpdir(), "gateway-outside-"));
		writeFileSync(join(outside, "secret.md"), "not a prompt");
		const root = mkdtempSync(join(tmpdir(), "gateway-root-"));
		mkdirSync(join(root, "prompts"));
		writeFileSync(join(root, "prompts", "ok.md"), "fine");
		symlinkSync(join(outside, "secret.md"), join(root, "prompts", "link.md"));

		expect(readPromptFile(root, "prompts/ok.md")).toBe("fine");
		expect(() => readPromptFile(root, "prompts/link.md")).toThrow(ConfigFileError);
		expect(() => readPromptFile(root, "../outside.md")).toThrow(ConfigFileError);
		expect(() => readPromptFile(root, "prompts/missing.md")).toThrow(ConfigFileError);
	});
});
