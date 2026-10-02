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

const SECRET_MOUNTS: Readonly<string[]> = [SECRET_MOUNT, BOT_SECRET_MOUNT];

/**
 * The file behind a configured secret reference (`/run/secrets/<name>` or
 * `/run/bot-secrets/<name>`). With `secretsDir` (local development, bootstrap output) the same
 * name is looked up there instead, regardless of which mount it names: both are flat directories
 * of distinctly-named files, and development has no reason to keep them apart.
 */
export function resolveSecretPath(ref: string, secretsDir: string | undefined): string {
	const mount = SECRET_MOUNTS.find((candidate) => ref.startsWith(candidate));
	if (mount === undefined || basename(ref) !== ref.slice(mount.length)) {
		throw new SettingError(
			`secret reference '${ref}' is not a file under ${SECRET_MOUNT} or ${BOT_SECRET_MOUNT}`,
		);
	}
	return secretsDir === undefined ? ref : join(secretsDir, basename(ref));
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
