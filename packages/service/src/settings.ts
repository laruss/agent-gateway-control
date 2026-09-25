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
