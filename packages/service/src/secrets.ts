import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { SettingError } from "./settings.ts";

/** Where configuration expects secret files (Docker/Compose secrets): the controller's own
 * read-only mount, managed by the operator (bootstrap-created agents, the admin token, ...). */
export const SECRET_MOUNT = "/run/secrets/";

/** The controller's read-write mount for tokens it provisions itself (ADR-026): lifecycle-created
 * agents' bot tokens, generated server-side and never configured by a client. */
export const BOT_SECRET_MOUNT = "/run/bot-secrets/";

/**
 * The file behind a configured secret reference (`/run/secrets/<name>` or
 * `/run/bot-secrets/<name>`). `secretsDir` overrides where a `/run/secrets/` reference is looked
 * up instead (local development, bootstrap output); `botSecretsDir` does the same for a
 * `/run/bot-secrets/` one, separately — the two mounts are distinct directories in production
 * (the controller's read-only, operator-managed secrets vs. its own read-write provisioned-token
 * directory), so collapsing both into one override directory would resolve a lifecycle-created
 * agent's token into the wrong place. Left unset, `botSecretsDir` defaults to `secretsDir`, so a
 * single flattened directory standing in for both mounts (development and tests that never had
 * two directories to begin with) still works without naming it twice.
 */
export function resolveSecretPath(
	ref: string,
	secretsDir: string | undefined,
	botSecretsDir: string | undefined = secretsDir,
): string {
	if (ref.startsWith(SECRET_MOUNT)) {
		return resolveWithinMount(ref, SECRET_MOUNT, secretsDir);
	}
	if (ref.startsWith(BOT_SECRET_MOUNT)) {
		return resolveWithinMount(ref, BOT_SECRET_MOUNT, botSecretsDir);
	}
	throw new SettingError(
		`secret reference '${ref}' is not a file under ${SECRET_MOUNT} or ${BOT_SECRET_MOUNT}`,
	);
}

function resolveWithinMount(ref: string, mount: string, dir: string | undefined): string {
	if (basename(ref) !== ref.slice(mount.length)) {
		throw new SettingError(
			`secret reference '${ref}' is not a file under ${SECRET_MOUNT} or ${BOT_SECRET_MOUNT}`,
		);
	}
	return dir === undefined ? ref : join(dir, basename(ref));
}

/** Where a custom HTTPS tool's own secrets are mounted (ADR-027): one file per alias, read-only
 * to the tool runner, written only by `gateway tools secret set <alias>`. A third mount, distinct
 * from both `SECRET_MOUNT` (the controller's operator-managed config) and `BOT_SECRET_MOUNT` (the
 * controller's own provisioned-token directory) — none of the three are interchangeable. */
export const CUSTOM_TOOL_SECRET_MOUNT = "/run/custom-tool-secrets/";

/**
 * The file behind one alias's custom-tool secret: `basename`-only, so an alias naming anything but
 * a single path segment (a traversal attempt included) is refused, the same way `resolveSecretPath`
 * already refuses one for `/run/secrets/`/`/run/bot-secrets/`. `dir` overrides the mount directory
 * for local development and tests, exactly like `resolveSecretPath`'s own `secretsDir`.
 */
export function resolveCustomToolSecretPath(alias: string, dir: string | undefined): string {
	if (basename(alias) !== alias || alias === "") {
		throw new SettingError(`secret alias '${alias}' must be a single path segment`);
	}
	return dir === undefined ? join(CUSTOM_TOOL_SECRET_MOUNT, alias) : join(dir, alias);
}

/** Reads a secret file; an empty file is an error, never an empty credential. */
export function readSecretFile(path: string): string {
	const value = readFileSync(path, "utf8").trim();
	if (value === "") {
		throw new SettingError(`secret file '${path}' is empty`);
	}
	return value;
}

/**
 * How an existing secret file is kept: `private` is a regular file only its owner can read;
 * `exposed` is readable or writable by others; `symlink` points elsewhere.
 */
export type SecretFileState = "missing" | "private" | "exposed" | "symlink";

export function secretFileState(path: string): SecretFileState {
	if (!secretFileExists(path)) {
		return "missing";
	}
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) {
		return "symlink";
	}
	return stat.isFile() && (stat.mode & 0o077) === 0 ? "private" : "exposed";
}

export function secretFileExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Writes a secret with mode 0600 atomically: a new temporary file in the same directory, then a
 * rename over the target. A symlink at the target is refused, so a planted link cannot redirect
 * the credential elsewhere.
 */
export function writeSecretFile(path: string, value: string): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (secretFileExists(path) && lstatSync(path).isSymbolicLink()) {
		throw new SettingError(`refusing to write secret through the symlink '${path}'`);
	}
	const temporary = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	const fd = openSync(temporary, "wx", 0o600);
	try {
		writeSync(fd, `${value}\n`);
		fsyncSync(fd);
	} catch (error) {
		closeSync(fd);
		rmSync(temporary, { force: true });
		throw error;
	}
	closeSync(fd);
	renameSync(temporary, path);
}

/**
 * Removes a secret file, idempotently (a repeat, or a file already gone, is not an error): the
 * lifecycle provisioner's own retire step, for a lifecycle-created agent's `/run/bot-secrets/`
 * token file, once its server-side token is already revoked (ADR-026). Never called for a
 * `/run/secrets/` reference — that mount is an operator's own, read-only to the controller.
 */
export function deleteSecretFile(path: string): void {
	rmSync(path, { force: true });
}
