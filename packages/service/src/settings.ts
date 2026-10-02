import { readFileSync } from "node:fs";

export class SettingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SettingError";
	}
}

export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Reads a setting. `<NAME>_FILE` (a Docker/Compose secret file) wins over `<NAME>`, so secrets
 * never have to live in plain environment variables.
 */
export function readSetting(name: string, env: Environment = process.env): string | undefined {
	const file = env[`${name}_FILE`];
	if (file !== undefined && file !== "") {
		return readFileSync(file, "utf8").trim();
	}
	const value = env[name];
	return value === undefined || value === "" ? undefined : value;
}

/**
 * Like `readSetting`, but a configured `<NAME>_FILE` that does not exist yet reads as unset
 * rather than throwing: unlike every other secret file this codebase mounts (created before
 * anything ever reads it), the dedicated Mattermost admin token's file is legitimately absent on
 * a deployment that has not set one up yet (ADR-026) — the container always names the path, the
 * operator decides whether anything is there. Any other read failure (permission denied, say)
 * still throws: only a missing file reads as "not configured".
 */
export function readOptionalFileSetting(
	name: string,
	env: Environment = process.env,
): string | undefined {
	const file = env[`${name}_FILE`];
	if (file === undefined || file === "") {
		return readSetting(name, env);
	}
	try {
		const value = readFileSync(file, "utf8").trim();
		return value === "" ? undefined : value;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

export function requireSetting(name: string, env: Environment = process.env): string {
	const value = readSetting(name, env);
	if (value === undefined) {
		throw new SettingError(`setting ${name} (or ${name}_FILE) is required`);
	}
	return value;
}

export function intSetting(name: string, fallback: number, env: Environment = process.env): number {
	const value = readSetting(name, env);
	if (value === undefined) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || String(parsed) !== value) {
		throw new SettingError(`setting ${name} must be an integer, got '${value}'`);
	}
	return parsed;
}
