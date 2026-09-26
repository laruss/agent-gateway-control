import { realpathSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
	AgentIdSchema,
	type ToolName,
	type ToolPolicySnapshot,
	toolPatternCovers,
	UuidSchema,
} from "@agent-gateway/contracts";

/** Variables a runtime CLI needs to run at all; everything else of the worker stays behind. */
const PASSTHROUGH = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ", "USER"];

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

/**
 * The environment of a runtime process: the few basic variables from `source` plus the
 * adapter's own. The worker's database URL, its tokens and every other setting never reach a
 * runtime, which runs model-chosen commands.
 */
export function runtimeEnvironment(
	extra: Readonly<Record<string, string | undefined>>,
	source: EnvironmentSource = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of PASSTHROUGH) {
		const value = source[name];
		if (value !== undefined && value !== "") {
			env[name] = value;
		}
	}
	for (const [name, value] of Object.entries(extra)) {
		if (value !== undefined) {
			env[name] = value;
		}
	}
	return env;
}

/** A directory the worker owns, not a symlink someone else placed there. */
/**
 * Checks the workspace root once, e.g. when a worker starts, so a misconfigured root fails the
 * worker instead of every job.
 */
export async function checkWorkspaceRoot(root: string): Promise<void> {
	if (!isAbsolute(root)) {
		throw new Error(`workspace root '${root}' is not absolute`);
	}
	await ownDirectory(root);
}

async function ownDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const stat = await lstat(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`workspace path '${path}' is not a directory`);
	}
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		throw new Error(`workspace path '${path}' belongs to another user`);
	}
	if ((stat.mode & 0o022) !== 0) {
		throw new Error(`workspace path '${path}' is writable by other users`);
	}
}

/**
 * Creates the attempt's working directory, `<root>/<agent>/run-<run id>-<attempt>`, readable by
 * the worker user only and always empty: whatever a crashed earlier try of the same attempt
 * left is removed. The root and the agent directory must be real directories of the worker
 * user (a shared `/tmp` could hold someone else's). Returns the real path (runtimes compare
 * paths after resolving symlinks such as macOS `/tmp`).
 */
export async function createRunWorkspace(
	root: string,
	agentId: string,
	runId: string,
	attempt = 1,
): Promise<string> {
	if (!isAbsolute(root)) {
		throw new Error(`workspace root '${root}' is not absolute`);
	}
	if (!Number.isSafeInteger(attempt) || attempt < 1) {
		throw new Error(`invalid attempt ${attempt}`);
	}
	await ownDirectory(root);
	const agentDir = join(root, AgentIdSchema.parse(agentId));
	await ownDirectory(agentDir);
	const path = join(agentDir, `run-${UuidSchema.parse(runId)}-${attempt}`);
	await removeRunWorkspace(path);
	await mkdir(path, { mode: 0o700 });
	return realpath(path);
}

/**
 * The attempt's own temporary directory, inside its workspace: commands and the runtime's
 * scratch files go there instead of a shared `/tmp`, and it goes away with the workspace.
 */
export async function runTempDir(workspacePath: string): Promise<string> {
	const path = join(workspacePath, ".tmp");
	// Not recursive: after an abort the worker may already have removed the workspace, and it
	// must not come back.
	await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") {
			throw error;
		}
	});
	return path;
}

/**
 * The path a sandbox compares against: sandboxes match resolved paths, so a symlinked or
 * relative `CLAUDE_CONFIG_DIR` would otherwise stay readable. A missing path is kept as given.
 */
export function sandboxPath(path: string): string {
	try {
		return realpathSync(resolve(path));
	} catch {
		return resolve(path);
	}
}

/** Gives the owner full access to every directory below `path`, so it can be removed. */
async function restoreAccess(path: string, workspace = path): Promise<void> {
	const stat = await lstat(path).catch(() => null);
	if (stat === null || !stat.isDirectory()) {
		return;
	}
	// A directory swapped for a symlink after the check must not lead outside the workspace.
	const real = await realpath(path).catch(() => null);
	const root = await realpath(workspace).catch(() => workspace);
	if (real === null || (real !== root && !real.startsWith(`${root}/`))) {
		return;
	}
	await chmod(path, 0o700);
	for (const entry of await readdir(path)) {
		await restoreAccess(join(path, entry), workspace);
	}
}

/**
 * Removes a workspace, also after the model took the write bit off a directory in it (a plain
 * recursive `rm` fails then).
 */
export async function removeRunWorkspace(path: string): Promise<void> {
	try {
		await rm(path, { recursive: true, force: true });
	} catch {
		await restoreAccess(path);
		await rm(path, { recursive: true, force: true });
	}
}

/**
 * Gateway tool names that grant a runtime's built-in tools. Everything else an agent does
 * (posting, memory, mail, finance) goes through its structured result and the Gateway.
 */
export const NATIVE_TOOLS = {
	/** Read and search files of the workspace. */
	read: "repository.read",
	/** Create and edit files of the workspace; implies `read`. */
	write: "workspace.write",
	/**
	 * Run commands (tests, builds) in the workspace. Implies `read`, and commands may write the
	 * workspace (builds and tests do); the file-edit tools still need `write`.
	 */
	exec: "tests.run",
	webSearch: "web.search",
	webFetch: "web.fetch",
} as const satisfies Readonly<Record<string, ToolName>>;

export type NativeTool = keyof typeof NATIVE_TOOLS;
export type NativeToolGrants = Readonly<Record<NativeTool, boolean>>;

function granted(policy: ToolPolicySnapshot, tool: ToolName): boolean {
	const covered = (patterns: Readonly<string[]>) =>
		patterns.some((pattern) => toolPatternCovers(pattern, tool));
	// The lists never overlap; checking the others too keeps a malformed policy fail-closed.
	return covered(policy.allow) && !covered(policy.deny) && !covered(policy.requireHumanApproval);
}

/** Which built-in tools the run's policy grants. Fail-closed: unlisted means denied. */
export function nativeToolGrants(policy: ToolPolicySnapshot): NativeToolGrants {
	// Writing and running commands both read, and commands write: an explicit deny or approval
	// of reading or writing therefore withholds them too (fail-closed).
	const blocked = (tool: ToolName) =>
		[...policy.deny, ...policy.requireHumanApproval].some((pattern) =>
			toolPatternCovers(pattern, tool),
		);
	const readBlocked = blocked(NATIVE_TOOLS.read);
	const write = !readBlocked && granted(policy, NATIVE_TOOLS.write);
	const exec = !readBlocked && !blocked(NATIVE_TOOLS.write) && granted(policy, NATIVE_TOOLS.exec);
	return {
		read: write || exec || granted(policy, NATIVE_TOOLS.read),
		write,
		exec,
		webSearch: granted(policy, NATIVE_TOOLS.webSearch),
		webFetch: granted(policy, NATIVE_TOOLS.webFetch),
	};
}
