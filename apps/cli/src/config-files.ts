import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";
import {
	type AgentConfig,
	AgentConfigSchema,
	OrganizationConfigSchema,
	RolePromptSchema,
} from "@agent-gateway/contracts";
import type { ConfigApplyInput } from "@agent-gateway/core";
import { sha256Hex } from "@agent-gateway/events";
import { z } from "zod";

export class ConfigFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigFileError";
	}
}

/**
 * A generous ceiling on any single file read directly from an operator-supplied directory or
 * `root` (`organization.yaml`, one agent file, `manifest.json`, a prompt file): comfortably above
 * any legitimate file, just enough to refuse an implausibly large one before it is read in full.
 * Prompt *text* is bounded further, by character count, separately and only for `config
 * import`/`config diff` (`checkPromptSizes`); this byte ceiling applies to every prompt read,
 * including `config apply`'s.
 */
export const MAX_CONFIG_FILE_BYTES = 1_000_000;

/**
 * Reads a prompt file inside `root`. `promptPath` is always `/`-separated and already excludes
 * `..` (`PromptPathSchema`), re-checked here defensively (an empty, `.` or `..` segment is refused
 * outright), so every segment below `root` is lstat'd in turn, never following a symlink: the file
 * itself, and every directory component leading to it, must be a real directory or (for the last
 * segment) a regular file no larger than {@link MAX_CONFIG_FILE_BYTES} — checked before anything is
 * read, so a FIFO cannot hang `readFileSync` waiting for a writer, and a huge file is refused
 * before its bytes are ever loaded into memory. A symlink is refused outright, even one that would
 * itself resolve back inside `root`: the same policy `checkImportDirectorySafety` already gives
 * every other entry of an imported directory.
 */
export function readPromptFile(root: string, promptPath: string): string {
	const realRoot = realpathSync(root);
	const segments = promptPath.split("/");
	let current = realRoot;
	for (const [index, segment] of segments.entries()) {
		// `PromptPathSchema` already excludes these, but `readPromptFile` is a safety boundary of
		// its own: an empty, `.` or `..` segment must never reach `join`, which would otherwise
		// walk back above `root` before the loop ever gets to lstat anything there.
		if (segment === "" || segment === "." || segment === "..") {
			throw new ConfigFileError(`prompt file '${promptPath}' resolves outside the config root`);
		}
		current = join(current, segment);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(current);
		} catch {
			throw new ConfigFileError(`prompt file '${promptPath}' does not exist under '${root}'`);
		}
		if (stat.isSymbolicLink()) {
			throw new ConfigFileError(`prompt file '${promptPath}' is a symlink; refusing to follow it`);
		}
		if (index < segments.length - 1) {
			if (!stat.isDirectory()) {
				throw new ConfigFileError(`prompt file '${promptPath}' does not exist under '${root}'`);
			}
			continue;
		}
		if (!stat.isFile()) {
			throw new ConfigFileError(`prompt file '${promptPath}' is not a regular file`);
		}
		if (stat.size > MAX_CONFIG_FILE_BYTES) {
			throw new ConfigFileError(
				`prompt file '${promptPath}' is ${stat.size} bytes, over the ${MAX_CONFIG_FILE_BYTES} byte limit`,
			);
		}
	}
	return readFileSync(current, "utf8");
}

function parseYaml(path: string) {
	try {
		return Bun.YAML.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ConfigFileError(
			`cannot parse '${path}': ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function issues(path: string, error: z.ZodError) {
	return error.issues.map(
		(issue) => `${path}: ${issue.path.map(String).join(".")}: ${issue.message}`,
	);
}

/**
 * Loads `<dir>/organization.yaml` and `<dir>/agents/*.yaml`, validates each file, and resolves
 * prompt files relative to `root`.
 */
export function loadConfigDirectory(dir: string, root: string): ConfigApplyInput {
	const problems: string[] = [];
	const organizationPath = join(dir, "organization.yaml");
	const organization = OrganizationConfigSchema.safeParse(parseYaml(organizationPath));
	if (!organization.success) {
		problems.push(...issues(organizationPath, organization.error));
	}
	const agents: AgentConfig[] = [];
	const agentsDir = join(dir, "agents");
	for (const file of readdirSync(agentsDir)
		.filter((name) => name.endsWith(".yaml"))
		.sort()) {
		const path = join(agentsDir, file);
		const agent = AgentConfigSchema.safeParse(parseYaml(path));
		if (agent.success) {
			agents.push(agent.data);
		} else {
			problems.push(...issues(path, agent.error));
		}
	}
	if (!organization.success || problems.length > 0) {
		throw new ConfigFileError(`configuration is invalid:\n- ${problems.join("\n- ")}`);
	}
	const rolePrompts: Record<string, string> = {};
	for (const agent of agents) {
		rolePrompts[agent.id] = readPromptFile(root, agent.prompts.role_file);
	}
	return {
		organization: organization.data,
		agents,
		constitution: readPromptFile(root, organization.data.organization.constitution_file),
		rolePrompts,
	};
}

function assertSafeToRead(path: string, what: string): void {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		throw new ConfigFileError(`${what} '${path}' does not exist`);
	}
	if (stat.isSymbolicLink()) {
		throw new ConfigFileError(`${what} '${path}' is a symlink; import refuses to follow it`);
	}
	if (stat.isDirectory()) {
		return;
	}
	if (!stat.isFile()) {
		throw new ConfigFileError(`${what} '${path}' is not a regular file`);
	}
	if (stat.size > MAX_CONFIG_FILE_BYTES) {
		throw new ConfigFileError(
			`${what} '${path}' is ${stat.size} bytes, over the ${MAX_CONFIG_FILE_BYTES} byte limit`,
		);
	}
}

/**
 * `..`, an absolute path, or a non-normalized path (`a//b.md`, `a/./b.md`) would let a
 * manifest-listed path resolve outside the directory it describes once joined with it — `posix`
 * is used explicitly (manifest paths are always `/`-separated, never the host's own separator).
 * `normalize` alone would not catch a leading, unresolvable `..` (`../victim.txt` is already in
 * normalized form), hence the separate segment check.
 */
function isSafeManifestKey(key: string): boolean {
	if (key === "" || key.startsWith("/") || posix.normalize(key) !== key) {
		return false;
	}
	return !key.split("/").includes("..");
}

/**
 * Every non-directory entry under `dir`, as a path relative to it (`a/b.md`) — a regular file, a
 * symlink, or anything else a filesystem can hold (a FIFO, a socket, a device) — found by
 * recursing into real directories only. A symlinked directory is reported as a path of its own,
 * never descended into. Reporting every kind of entry, not only files and symlinks, means nothing
 * can hide from `checkImportDirectorySafety`'s own walk, which refuses anything that is not a
 * plain file or directory before it is ever opened.
 */
function walkFiles(dir: string, prefix = ""): string[] {
	const results: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) {
			results.push(...walkFiles(join(dir, entry.name), rel));
			continue;
		}
		results.push(rel);
	}
	return results;
}

/**
 * `manifest.json`'s own shape, as `config export` writes it (`buildExportFiles`): only `files` is
 * read here, but the other fields are real too — `.loose()` leaves them alone rather than
 * rejecting a manifest for carrying them.
 */
const ConfigManifestSchema = z.looseObject({
	files: z.record(z.string(), z.string()).optional(),
});

/**
 * Path safety for `config import`/`config diff`, beyond `readPromptFile`'s existing root
 * containment check (prompt paths are validated there; `PromptPathSchema` itself already excludes
 * `..`): `organization.yaml`, `agents/*.yaml` must be regular files or directories, never a
 * symlink, and bounded in size. Every entry anywhere in the directory — manifest or not — is
 * walked and checked the same way, so a FIFO, a socket or a device is refused wherever it sits,
 * before it is ever opened. When a `manifest.json` an earlier `config export` wrote is present,
 * `root` must be `dir` itself (an export's prompt paths are relative to the directory it was
 * written into, not wherever `--root` happens to point — ADR-024), every file it lists must still
 * hash to what it recorded, and the directory must contain nothing else: a file `config export`
 * would not have written is refused rather than silently picked up. Every manifest key must itself
 * be a safe relative path (`isSafeManifestKey`) before it is ever joined with `dir`. A hand-written
 * directory with no manifest is accepted as-is (whatever `root` is), once every entry in it has
 * passed the walk.
 */
export function checkImportDirectorySafety(dir: string, root: string): void {
	assertSafeToRead(dir, "config directory");
	assertSafeToRead(join(dir, "organization.yaml"), "organization file");
	const agentsDir = join(dir, "agents");
	assertSafeToRead(agentsDir, "agents directory");
	for (const file of readdirSync(agentsDir).filter((name) => name.endsWith(".yaml"))) {
		assertSafeToRead(join(agentsDir, file), "agent file");
	}

	const entries = walkFiles(dir);
	for (const path of entries) {
		assertSafeToRead(join(dir, path), "directory entry");
	}

	const manifestPath = join(dir, "manifest.json");
	if (!existsSync(manifestPath)) {
		return;
	}
	if (realpathSync(root) !== realpathSync(dir)) {
		throw new ConfigFileError(
			`'${dir}' has a manifest.json (an export is self-contained): --root must be '${dir}' itself, not '${root}'`,
		);
	}
	let manifestJson: unknown;
	try {
		manifestJson = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new ConfigFileError(
			`cannot parse 'manifest.json': ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const parsedManifest = ConfigManifestSchema.safeParse(manifestJson);
	if (!parsedManifest.success) {
		throw new ConfigFileError(
			`manifest.json is invalid:\n- ${issues("manifest.json", parsedManifest.error).join("\n- ")}`,
		);
	}
	const listed = parsedManifest.data.files ?? {};
	for (const relativePath of Object.keys(listed)) {
		if (!isSafeManifestKey(relativePath)) {
			throw new ConfigFileError(`manifest.json lists an unsafe path '${relativePath}'`);
		}
	}
	for (const [relativePath, expectedHash] of Object.entries(listed)) {
		const filePath = join(dir, relativePath);
		let content: string;
		try {
			content = readFileSync(filePath, "utf8");
		} catch {
			throw new ConfigFileError(`manifest.json names '${relativePath}', which is missing`);
		}
		if (sha256Hex(content) !== expectedHash) {
			throw new ConfigFileError(`manifest.json hash mismatch for '${relativePath}'`);
		}
	}
	const listedPaths = new Set(Object.keys(listed));
	for (const path of entries) {
		if (path !== "manifest.json" && !listedPaths.has(path)) {
			throw new ConfigFileError(
				`'${path}' exists under '${dir}' but is not listed in manifest.json; a manifest present means the file set must match it exactly`,
			);
		}
	}
}

/**
 * Bounded text, reusing the same limit `set_role_prompt` enforces (`RolePromptSchema`), so a
 * directory cannot carry a constitution or role prompt the managed-config service would refuse
 * anyway once `config import` turns it into a `replace_bundle` change set.
 */
function checkPromptSizes(input: ConfigApplyInput): string[] {
	const problems: string[] = [];
	const constitution = RolePromptSchema.safeParse(input.constitution);
	if (!constitution.success) {
		problems.push(
			...constitution.error.issues.map((issue) => `organization constitution: ${issue.message}`),
		);
	}
	for (const [agentId, prompt] of Object.entries(input.rolePrompts)) {
		const parsed = RolePromptSchema.safeParse(prompt);
		if (!parsed.success) {
			problems.push(
				...parsed.error.issues.map((issue) => `agent ${agentId} role prompt: ${issue.message}`),
			);
		}
	}
	return problems;
}

/**
 * `loadConfigDirectory` with the additional checks `config diff`/`config import` need: path
 * safety (symlinks, non-regular files, bounded sizes, a manifest's hashes) and bounded prompt
 * text. `config validate`/`config apply` are unaffected and keep using `loadConfigDirectory`
 * directly.
 */
export function loadConfigDirectoryForImport(dir: string, root: string): ConfigApplyInput {
	checkImportDirectorySafety(dir, root);
	const input = loadConfigDirectory(dir, root);
	const problems = checkPromptSizes(input);
	if (problems.length > 0) {
		throw new ConfigFileError(`configuration is invalid:\n- ${problems.join("\n- ")}`);
	}
	return input;
}
