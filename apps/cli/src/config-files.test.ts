import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configBundleProblems } from "@agent-gateway/core";
import { sha256Hex } from "@agent-gateway/events";
import { describe, expect, it } from "vitest";
import {
	ConfigFileError,
	checkImportDirectorySafety,
	loadConfigDirectory,
	loadConfigDirectoryForImport,
	MAX_CONFIG_FILE_BYTES,
	readPromptFile,
} from "./config-files.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/** A valid, self-contained copy of the example configuration: `root` can equal `dir`. */
function validImportDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "gateway-import-"));
	cpSync(join(repoRoot, "config/examples"), dir, { recursive: true });
	mkdirSync(join(dir, "prompts"), { recursive: true });
	cpSync(join(repoRoot, "prompts/examples"), join(dir, "prompts/examples"), { recursive: true });
	return dir;
}

describe("config files", () => {
	it("loads and validates the example configuration with its prompts", () => {
		const input = loadConfigDirectory(join(repoRoot, "config/examples"), repoRoot);
		expect(input.agents.map((a) => a.id).sort()).toEqual([
			"developer",
			"director",
			"finance",
			"mail-follower",
			"operator",
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

	it("refuses a FIFO under a prompt path without hanging, even with --root separate from dir", () => {
		const root = mkdtempSync(join(tmpdir(), "gateway-root-fifo-"));
		mkdirSync(join(root, "prompts"), { recursive: true });
		const fifoPath = join(root, "prompts/evil-fifo.md");
		const mkfifo = Bun.spawnSync(["mkfifo", fifoPath]);
		if (!mkfifo.success) {
			throw new Error(`mkfifo failed: ${mkfifo.stderr.toString()}`);
		}
		expect(() => readPromptFile(root, "prompts/evil-fifo.md")).toThrow(/not a regular file/);
	}, 5_000);

	it("refuses a prompt that is a symlink, even one resolving back inside the root", () => {
		const root = mkdtempSync(join(tmpdir(), "gateway-root-symlink-"));
		mkdirSync(join(root, "prompts"), { recursive: true });
		writeFileSync(join(root, "prompts/real.md"), "real content");
		symlinkSync(join(root, "prompts/real.md"), join(root, "prompts/in-root-link.md"));
		expect(() => readPromptFile(root, "prompts/in-root-link.md")).toThrow(/symlink/);
	});

	it("refuses an oversized prompt file by its size on disk, before reading its content", () => {
		const root = mkdtempSync(join(tmpdir(), "gateway-root-big-"));
		mkdirSync(join(root, "prompts"), { recursive: true });
		writeFileSync(join(root, "prompts/big.md"), "x".repeat(MAX_CONFIG_FILE_BYTES + 1));
		expect(() => readPromptFile(root, "prompts/big.md")).toThrow(/byte limit/);
	});
});

describe("checkImportDirectorySafety", () => {
	it("accepts a valid, self-contained directory with no manifest.json", () => {
		const dir = validImportDir();
		expect(() => checkImportDirectorySafety(dir, dir)).not.toThrow();
	});

	it("refuses a FIFO anywhere in the tree, even with no manifest.json", () => {
		const dir = validImportDir();
		const fifoPath = join(dir, "prompts/examples/agents/evil-fifo");
		const mkfifo = Bun.spawnSync(["mkfifo", fifoPath]);
		if (!mkfifo.success) {
			throw new Error(`mkfifo failed: ${mkfifo.stderr.toString()}`);
		}
		expect(() => checkImportDirectorySafety(dir, dir)).toThrow(/not a regular file/);
	});

	it("refuses organization.yaml as a symlink", () => {
		const dir = validImportDir();
		const target = join(dir, "organization.yaml.real");
		cpSync(join(dir, "organization.yaml"), target);
		rmSync(join(dir, "organization.yaml"));
		symlinkSync(target, join(dir, "organization.yaml"));
		expect(() => checkImportDirectorySafety(dir, dir)).toThrow(ConfigFileError);
	});

	it("refuses an agent file that is a symlink", () => {
		const dir = validImportDir();
		const agentPath = join(dir, "agents", "research.yaml");
		const target = `${agentPath}.real`;
		cpSync(agentPath, target);
		rmSync(agentPath);
		symlinkSync(target, agentPath);
		expect(() => checkImportDirectorySafety(dir, dir)).toThrow(ConfigFileError);
	});

	it("refuses organization.yaml over the byte limit", () => {
		const dir = validImportDir();
		writeFileSync(join(dir, "organization.yaml"), "x".repeat(MAX_CONFIG_FILE_BYTES + 1));
		expect(() => checkImportDirectorySafety(dir, dir)).toThrow(/byte limit/);
	});

	it("accepts a manifest.json whose file set matches the directory exactly", () => {
		const dir = mkdtempSync(join(tmpdir(), "gateway-import-manifest-"));
		mkdirSync(join(dir, "agents"));
		const content = "organization.yaml content";
		writeFileSync(join(dir, "organization.yaml"), content);
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({ files: { "organization.yaml": sha256Hex(content) } }),
		);
		expect(() => checkImportDirectorySafety(dir, dir)).not.toThrow();
	});

	it("refuses a directory with a manifest.json when --root is not that same directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "gateway-import-manifest-root-"));
		mkdirSync(join(dir, "agents"));
		const content = "organization.yaml content";
		writeFileSync(join(dir, "organization.yaml"), content);
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({ files: { "organization.yaml": sha256Hex(content) } }),
		);
		const otherRoot = mkdtempSync(join(tmpdir(), "gateway-other-root-"));
		expect(() => checkImportDirectorySafety(dir, otherRoot)).toThrow(/--root must be/);
		// The very same directory, as its own root, is unaffected by this check.
		expect(() => checkImportDirectorySafety(dir, dir)).not.toThrow();
	});

	it("refuses a file on disk that a present manifest.json does not list", () => {
		const dir = validImportDir();
		const content = readFileSync(join(dir, "organization.yaml"), "utf8");
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({ files: { "organization.yaml": sha256Hex(content) } }),
		);
		expect(() => checkImportDirectorySafety(dir, dir)).toThrow(/not listed in manifest\.json/);
	});

	it("refuses a manifest.json whose recorded hash no longer matches the file", () => {
		const dir = validImportDir();
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({ files: { "organization.yaml": "f".repeat(64) } }),
		);
		expect(() => checkImportDirectorySafety(dir, dir)).toThrow(/hash mismatch/);
	});

	it("refuses a manifest.json naming a file that does not exist", () => {
		const dir = validImportDir();
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({ files: { "prompts/examples/missing.md": "f".repeat(64) } }),
		);
		expect(() => checkImportDirectorySafety(dir, dir)).toThrow(ConfigFileError);
	});

	it.each([
		["../victim.txt", "a leading .. segment"],
		["prompts/../../victim.txt", "an embedded .. that still escapes"],
		["/etc/passwd", "an absolute path"],
		["prompts//examples/organization-constitution.md", "a non-normalized path (double slash)"],
		["prompts/./organization-constitution.md", "a non-normalized path (a '.' segment)"],
	])("refuses a manifest key that is unsafe: %s (%s)", (key) => {
		const dir = validImportDir();
		const content = readFileSync(join(dir, "organization.yaml"), "utf8");
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({ files: { "organization.yaml": sha256Hex(content), [key]: "f".repeat(64) } }),
		);
		expect(() => checkImportDirectorySafety(dir, dir)).toThrow(/unsafe path/);
	});
});

describe("loadConfigDirectoryForImport", () => {
	it("loads the same configuration loadConfigDirectory would, for a valid directory", () => {
		const dir = validImportDir();
		const direct = loadConfigDirectory(dir, dir);
		const forImport = loadConfigDirectoryForImport(dir, dir);
		expect(forImport).toEqual(direct);
	});

	it("refuses a missing prompt file", () => {
		const dir = validImportDir();
		rmSync(join(dir, "prompts/examples/organization-constitution.md"));
		expect(() => loadConfigDirectoryForImport(dir, dir)).toThrow(ConfigFileError);
	});

	it("refuses a role prompt that resolves outside the root through a symlink", () => {
		const dir = validImportDir();
		const outside = mkdtempSync(join(tmpdir(), "gateway-import-outside-"));
		writeFileSync(join(outside, "secret.md"), "not a prompt");
		const researchPrompt = join(dir, "prompts/examples/agents/research.md");
		rmSync(researchPrompt);
		symlinkSync(join(outside, "secret.md"), researchPrompt);
		expect(() => loadConfigDirectoryForImport(dir, dir)).toThrow(ConfigFileError);
	});

	it("refuses a role prompt over the bound RolePromptSchema enforces elsewhere", () => {
		const dir = validImportDir();
		writeFileSync(join(dir, "prompts/examples/agents/research.md"), "a".repeat(50_001));
		expect(() => loadConfigDirectoryForImport(dir, dir)).toThrow(ConfigFileError);
	});
});
