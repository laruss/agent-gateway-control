import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type {
	AgentConfig,
	ChangeSetInput,
	ConfigDiffAgent,
	OrganizationConfig,
} from "@agent-gateway/contracts";
import {
	AdminError,
	activeConfigRevisionId,
	type ChangePreview,
	type CommitChangeResult,
	type ControlPlaneDeps,
	commitChange,
	configSnapshotBundle,
	findConfigRevisionByIdempotencyKey,
	inTransaction,
	listConfigRevisions,
	loadActiveBundle,
	prepareChange,
} from "@agent-gateway/core";
import { canonicalHash, sha256Hex } from "@agent-gateway/events";
import { ConfigFileError, loadConfigDirectoryForImport } from "./config-files.ts";

const ORGANIZATION_FILE = "organization.yaml";
const AGENTS_DIR = "agents";
/** `manifest.json`'s own shape version, independent of `CONFIG_SNAPSHOT_FORMAT`. */
const MANIFEST_FORMAT = 1;

/** A bundle in plain, writable-array shape, as every `replace_bundle` change set needs it. */
type ReplaceableBundle = Readonly<{
	organization: OrganizationConfig;
	agents: Readonly<AgentConfig[]>;
	constitution: string;
	rolePrompts: Readonly<Record<string, string>>;
}>;

/**
 * Built from the canonical bundle (agents sorted by id, the same `configSnapshotBundle` every
 * commit hashes), not `bundle`'s own array order: `config import`/`config diff` read agent files
 * off disk in filename order, so renaming one would otherwise change this change set's own hash
 * (`commitChange`'s `changeHash`, guarding idempotency-key reuse) without changing anything the
 * configuration actually means, rejecting a legitimate retry as a key reused for "a different"
 * change set.
 */
function replaceBundleChangeSet(bundle: ReplaceableBundle): ChangeSetInput {
	return [{ type: "replace_bundle", bundle: configSnapshotBundle(bundle) }];
}

// ---------------------------------------------------------------------------
// Writing an export directory
// ---------------------------------------------------------------------------

function yamlText(value: unknown): string {
	return `${Bun.YAML.stringify(value, null, 2)}\n`;
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

/**
 * Resolves `root`'s parent directory to its real, symlink-free path, confirming it already
 * exists as a directory. Export never creates missing ancestor directories; working from the
 * resolved parent (rather than `root`'s own, possibly symlinked, parent) means every later
 * sibling path built from it — the temp directory, the swap target, `root` itself — is anchored
 * to a location no symlink can redirect.
 */
function realParentDir(root: string): string {
	const parent = dirname(root);
	let resolved: string;
	try {
		resolved = realpathSync(parent);
	} catch {
		throw new ConfigFileError(
			`'${parent}' does not exist; create it before exporting into '${root}'`,
		);
	}
	if (!lstatSync(resolved).isDirectory()) {
		throw new ConfigFileError(`'${parent}' is not a directory`);
	}
	return resolved;
}

/**
 * Ensures every directory component between `root` (a freshly created, empty directory — the
 * export's own temp directory, never an operator-chosen one) and `dir` is itself a real
 * directory, checked one component at a time with `lstat`. Climbing from `dir` up to the first
 * existing ancestor, as an earlier version of this function did, would accept a symlink anywhere
 * below that ancestor transparently — `lstat` on a path resolves every intermediate symlink
 * except the final component, so the first existing ancestor found while climbing can look like a
 * normal directory even when a symlink deeper in the tree (between it and `root`) actually
 * redirects writes elsewhere. Creates whatever is missing, top-down, with mode 0755.
 */
function ensureRealDir(root: string, dir: string): void {
	const rel = relative(root, dir);
	if (rel === "") {
		return;
	}
	if (rel === ".." || rel.startsWith(`..${sep}`)) {
		throw new ConfigFileError(`refusing to write outside '${root}' at '${dir}'`);
	}
	let current = root;
	for (const segment of rel.split(sep)) {
		current = join(current, segment);
		const stat = lstatOrUndefined(current);
		if (stat === undefined) {
			mkdirSync(current, { mode: 0o755 });
			continue;
		}
		if (stat.isSymbolicLink()) {
			throw new ConfigFileError(`refusing to write through a symlink at '${current}'`);
		}
		if (!stat.isDirectory()) {
			throw new ConfigFileError(`'${current}' exists and is not a directory`);
		}
	}
}

/** Refuses an existing symlink at `path` itself, then writes `content` with mode 0644. */
function writeExportFile(root: string, path: string, content: string): void {
	ensureRealDir(root, dirname(path));
	const stat = lstatOrUndefined(path);
	if (stat?.isSymbolicLink() === true) {
		throw new ConfigFileError(`refusing to write through a symlink at '${path}'`);
	}
	writeFileSync(path, content, { mode: 0o644 });
}

/**
 * Sets `files[path]` to `content`, refusing a second, different value for the same path: two
 * agents can share a `role_file` (or share it with the constitution) in a snapshot stored before
 * commits enforced that sharers must agree (see `configBundleProblems`) — export must not then
 * silently keep only one of their texts.
 */
function setFileContent(files: Map<string, string>, path: string, content: string): void {
	const existing = files.get(path);
	if (existing !== undefined && existing !== content) {
		throw new ConfigFileError(
			`'${path}' would be written with two different contents (shared by more than one agent, or with the constitution); refusing to export`,
		);
	}
	files.set(path, content);
}

/**
 * The whole export, in memory: `organization.yaml`, `agents/<id>.yaml`, and every prompt file —
 * the constitution and each role prompt, kept verbatim at the exact path the bundle's own
 * `constitution_file`/`role_file` field already names (so nothing in the bundle's own content is
 * rewritten, and its hash is untouched by exporting it) — plus `manifest.json`. Every validation,
 * including a path two agents (or an agent and the constitution) share with different text
 * (`setFileContent`), happens here, before anything touches disk. Returns paths in a stable,
 * sorted order.
 */
function buildExportFiles(
	organization: OrganizationConfig,
	agents: Readonly<AgentConfig[]>,
	constitution: string,
	rolePrompts: Readonly<Record<string, string>>,
	revisionId: number,
	hash: string,
): Readonly<[string, string][]> {
	const files = new Map<string, string>();
	files.set(ORGANIZATION_FILE, yamlText(organization));
	setFileContent(files, organization.organization.constitution_file, constitution);
	for (const agent of [...agents].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
		files.set(`${AGENTS_DIR}/${agent.id}.yaml`, yamlText(agent));
		setFileContent(files, agent.prompts.role_file, rolePrompts[agent.id] ?? "");
	}
	const manifestFiles: Record<string, string> = {};
	for (const [path, content] of files) {
		manifestFiles[path] = sha256Hex(content);
	}
	files.set(
		"manifest.json",
		`${JSON.stringify(
			{
				format: MANIFEST_FORMAT,
				revision_id: revisionId,
				snapshot_hash: hash,
				files: manifestFiles,
			},
			null,
			2,
		)}\n`,
	);
	return [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

export type ConfigExportOptions = Readonly<{
	dir: string;
	/** A specific revision to export; the active one when null. */
	revisionId: number | null;
}>;

/**
 * Writes the revision's snapshot as a config directory `loadConfigDirectory` reads back to the
 * exact same bundle hash. Those prompt paths are relative to whatever root the original import
 * used, which this export cannot know, so importing this directory back needs `--root` set to
 * this same directory — the same way an operator already runs
 * `gateway config apply /config --root /config` against a mounted `/config`. Two exports of the
 * same revision are byte-for-byte identical: the manifest carries no timestamp.
 *
 * The whole export is built and validated in memory first (`buildExportFiles`), failing before
 * anything touches disk. The target must not exist, or must already be an empty real directory —
 * anything else (a non-empty directory, a file, a symlink) is refused outright; export never
 * deletes or reuses existing content, so choosing a new directory or removing the old one is on
 * the operator. A target that does not exist yet is built off to the side, in a fresh directory
 * `mkdtemp` creates next to it (so the final step is a same-filesystem rename, atomic on this
 * host), given its published mode (0755 — `mkdtemp` itself creates 0700) just before that rename
 * installs it; a failure before the rename leaves nothing at the target and removes the temp
 * directory. An existing empty target is written into directly, with the same per-component
 * checks.
 */
export async function configExport(
	deps: ControlPlaneDeps,
	options: ConfigExportOptions,
	print: (line: string) => void,
): Promise<void> {
	const revisionId = options.revisionId ?? (await activeConfigRevisionId(deps));
	if (revisionId === null) {
		throw new AdminError("there is no active configuration to export");
	}
	const { bundle, hash } = await inTransaction(deps, ({ tx }) =>
		loadActiveBundle(tx.db, revisionId),
	);
	const { organization } = bundle;
	if (organization === null || hash === null) {
		throw new AdminError(`internal: revision ${revisionId} resolved to an empty bundle`);
	}
	// `commitChange`/`applyConfig` now refuse a `rolePrompts` entry for an agent the bundle does
	// not configure; a snapshot stored before that rule could still have one. Export only ever
	// writes a configured agent's role prompt, so silently proceeding here would re-import to a
	// different, smaller `rolePrompts` map and a different hash than this snapshot's own.
	const configuredAgentIds = new Set(bundle.agents.map((agent) => agent.id));
	const orphanedRolePrompts = Object.keys(bundle.rolePrompts).filter(
		(agentId) => !configuredAgentIds.has(agentId),
	);
	if (orphanedRolePrompts.length > 0) {
		throw new ConfigFileError(
			`revision ${revisionId}'s snapshot has role prompt(s) for agent(s) it does not configure: ` +
				`${orphanedRolePrompts.join(", ")}; refusing to export`,
		);
	}
	const files = buildExportFiles(
		organization,
		bundle.agents,
		bundle.constitution,
		bundle.rolePrompts,
		revisionId,
		hash,
	);

	const requested = resolve(options.dir);
	const parent = realParentDir(requested);
	const root = join(parent, basename(requested));

	const targetStat = lstatOrUndefined(root);
	if (targetStat?.isSymbolicLink()) {
		throw new ConfigFileError(`refusing to write through a symlink at '${root}'`);
	}
	if (targetStat !== undefined && !targetStat.isDirectory()) {
		throw new ConfigFileError(`'${root}' exists and is not a directory`);
	}
	if (targetStat !== undefined && readdirSync(root).length > 0) {
		throw new ConfigFileError(
			`'${root}' is not empty; choose a new directory, or remove it yourself first`,
		);
	}

	if (targetStat === undefined) {
		const tempDir = mkdtempSync(join(parent, ".gateway-config-export-"));
		try {
			for (const [path, content] of files) {
				writeExportFile(tempDir, join(tempDir, path), content);
			}
			// `mkdtemp` creates the directory mode 0700; the published directory must be the usual
			// 0755 a directory `mkdir` itself would get.
			chmodSync(tempDir, 0o755);
			renameSync(tempDir, root);
		} catch (error) {
			rmSync(tempDir, { recursive: true, force: true });
			throw error;
		}
	} else {
		for (const [path, content] of files) {
			writeExportFile(root, join(root, path), content);
		}
	}
	print(`exported revision ${revisionId} (${hash}) to ${root}`);
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

function formatDiffAgent(agent: ConfigDiffAgent): string {
	if (agent.kind === "added") {
		return `  + ${agent.agentId} (added)`;
	}
	if (agent.kind === "removed") {
		return `  - ${agent.agentId} (removed)`;
	}
	const parts: string[] = [];
	if (agent.fieldPaths.length > 0) {
		parts.push(agent.fieldPaths.join(", "));
	}
	if (agent.rolePrompt.changed) {
		parts.push(`role prompt ${agent.rolePrompt.beforeSize} -> ${agent.rolePrompt.afterSize} chars`);
	}
	return `  ~ ${agent.agentId}: ${parts.length > 0 ? parts.join("; ") : "(unchanged)"}`;
}

/** The structural diff `config diff`/`config rollback` print by default (not `--json`). */
export function formatConfigDiff(preview: ChangePreview): string {
	const lines: string[] = [
		`base revision: ${preview.baseRevisionId ?? "(none)"}${preview.baseHash === null ? "" : ` ${preview.baseHash}`}`,
		`new hash:      ${preview.newHash}`,
		preview.noop
			? "no changes: committing this would write nothing"
			: "this would write a new revision",
		...preview.diff.agents.map(formatDiffAgent),
	];
	if (preview.diff.organizationFieldPaths.length > 0) {
		lines.push(`organization: ${preview.diff.organizationFieldPaths.join(", ")}`);
	}
	if (preview.diff.constitution.changed) {
		lines.push(
			`constitution: ${preview.diff.constitution.beforeSize} -> ${preview.diff.constitution.afterSize} chars`,
		);
	}
	if (preview.problems.length > 0) {
		lines.push("problems:", ...preview.problems.map((problem) => `  - ${problem}`));
	}
	return lines.join("\n");
}

export type ConfigDiffOptions = Readonly<{ dir: string; root: string; json: boolean }>;

/**
 * Loads `dir` and previews it as a `replace_bundle` change against the active configuration,
 * through the same `prepareChange` a console would use. Read-only. Returns whether the directory
 * validates (a caller reports a non-zero exit when it does not); `config import` of the same
 * directory refuses the same unsafe paths this already does.
 */
export async function configDiffCommand(
	deps: ControlPlaneDeps,
	options: ConfigDiffOptions,
	print: (line: string) => void,
): Promise<boolean> {
	const input = loadConfigDirectoryForImport(options.dir, options.root);
	const preview = await prepareChange(deps, replaceBundleChangeSet(input));
	print(options.json ? JSON.stringify(preview, null, 2) : formatConfigDiff(preview));
	return preview.problems.length === 0;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export type ConfigImportOptions = Readonly<{
	dir: string;
	root: string;
	/** From `--expected-revision`; null when the flag was not given. */
	expectedRevision: number | null;
	reason: string | null;
	actor: string;
}>;

/**
 * `replace_bundle` of `dir` via `commitChange`, source `import`. On a database with an active
 * revision, `expectedRevision` is required (refused otherwise, naming the current revision so the
 * operator runs `config diff` first) — unless this exact import (same directory content, no
 * `expectedRevision`) already committed and is still the active revision: its response may simply
 * have been lost before the caller saw it, so that commit is replayed instead of refusing a
 * legitimate retry. A fresh database with no active configuration accepts a null one. The
 * idempotency key is derived from the base revision and the directory's own content hash, so
 * retrying the same import after a transient failure replays the first commit instead of writing
 * a second revision.
 */
export async function configImport(
	deps: ControlPlaneDeps,
	options: ConfigImportOptions,
	print: (line: string) => void,
): Promise<CommitChangeResult> {
	const input = loadConfigDirectoryForImport(options.dir, options.root);
	const contentHash = canonicalHash(configSnapshotBundle(input));
	let baseRevisionId: number | null;
	let idempotencyKey: string;
	if (options.expectedRevision !== null) {
		baseRevisionId = options.expectedRevision;
		idempotencyKey = `import:${baseRevisionId}:${contentHash}`;
	} else {
		const noExpectedRevisionKey = `import:none:${contentHash}`;
		const active = await activeConfigRevisionId(deps);
		if (active !== null) {
			const replay = await findConfigRevisionByIdempotencyKey(deps, noExpectedRevisionKey);
			if (replay !== null && replay.id === active) {
				print(
					`import already committed as revision ${replay.id} (${replay.hash}); replaying that result`,
				);
				return {
					revisionId: replay.id,
					hash: replay.hash,
					noop: false,
					replayed: true,
					activeRevisionId: replay.id,
				};
			}
			throw new AdminError(
				`--expected-revision is required: the active revision is ${active}; run 'gateway config diff ${options.dir} --root ${options.root}' first`,
			);
		}
		baseRevisionId = null;
		idempotencyKey = noExpectedRevisionKey;
	}
	const result = await commitChange(deps, {
		changeSet: replaceBundleChangeSet(input),
		baseRevisionId,
		idempotencyKey,
		actor: options.actor,
		source: "import",
		...(options.reason === null ? {} : { reason: options.reason }),
	});
	if (result.replayed) {
		print(`import already committed as revision ${result.revisionId} (${result.hash})`);
		printSupersededWarning(result, options.dir, options.root, print);
	} else {
		print(
			result.noop
				? `import is a no-op: revision ${result.revisionId} (${result.hash}) already matches`
				: `imported as revision ${result.revisionId} (${result.hash})`,
		);
	}
	return result;
}

/**
 * When a replayed `commitChange` result's `revisionId` is no longer the active revision —
 * something else committed since the original commit this replays — a clear, explicit warning:
 * replaying silently reports a revision that may no longer describe the running configuration.
 * The exit code stays 0 (see `runCommand`'s dispatch): the original commit already succeeded: this
 * is informational, not a failure for the caller to act on before anything else proceeds.
 */
function printSupersededWarning(
	result: CommitChangeResult,
	dir: string,
	root: string,
	print: (line: string) => void,
): void {
	if (result.activeRevisionId !== result.revisionId) {
		print(
			`warning: revision ${result.activeRevisionId ?? "(none)"} is now active, superseding it; ` +
				`run 'gateway config diff ${dir} --root ${root}' to see what changed since`,
		);
	}
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

export type ConfigRollbackOptions = Readonly<{
	/** The revision whose snapshot becomes the content of the new revision this commits. */
	revisionId: number;
	expectedRevision: number;
	reason: string | null;
	actor: string;
}>;

/**
 * Commits a new revision (source `rollback`) whose content is `revisionId`'s own snapshot,
 * through the same `prepareChange`/`commitChange` path any other change set uses — never a
 * pointer reset. Prints the diff against the current active configuration before committing (the
 * CLI is non-interactive; `expectedRevision` already guards against committing over a change made
 * since the operator last looked). Refuses a target revision whose snapshot is unavailable.
 */
export async function configRollback(
	deps: ControlPlaneDeps,
	options: ConfigRollbackOptions,
	print: (line: string) => void,
): Promise<CommitChangeResult> {
	const { bundle, hash } = await inTransaction(deps, ({ tx }) =>
		loadActiveBundle(tx.db, options.revisionId),
	);
	const { organization } = bundle;
	if (organization === null || hash === null) {
		throw new AdminError(`internal: revision ${options.revisionId} resolved to an empty bundle`);
	}
	const changeSet = replaceBundleChangeSet({
		organization,
		agents: bundle.agents,
		constitution: bundle.constitution,
		rolePrompts: bundle.rolePrompts,
	});
	const preview = await prepareChange(deps, changeSet);
	print(formatConfigDiff(preview));
	const result = await commitChange(deps, {
		changeSet,
		baseRevisionId: options.expectedRevision,
		actor: options.actor,
		source: "rollback",
		...(options.reason === null ? {} : { reason: options.reason }),
	});
	print(
		result.noop
			? `rollback is a no-op: revision ${result.revisionId} (${result.hash}) already matches`
			: `rolled back to revision ${options.revisionId}'s content as new revision ${result.revisionId} (${result.hash})`,
	);
	return result;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** `config history`: the most recent revisions, newest first, with a shortened snapshot hash. */
export async function configHistory(
	deps: ControlPlaneDeps,
	limit: number,
	print: (line: string) => void,
): Promise<void> {
	const revisions = await listConfigRevisions(deps, limit);
	print(
		JSON.stringify(
			revisions.map((revision) => ({
				id: revision.id,
				createdAt: revision.createdAt.toISOString(),
				actor: revision.actor,
				source: revision.source,
				reason: revision.reason,
				snapshotHash: revision.snapshotHash.slice(0, 12),
				parentRevisionId: revision.parentRevisionId,
			})),
			null,
			2,
		),
	);
}
