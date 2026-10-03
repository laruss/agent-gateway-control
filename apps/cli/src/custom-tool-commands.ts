import { readFileSync } from "node:fs";
import { CustomHttpsDefinitionSchema } from "@agent-gateway/contracts";
import {
	type ControlPlaneDeps,
	createCustomHttpsTool,
	editCatalogEntry,
} from "@agent-gateway/core";
import { writeSecretFile } from "@agent-gateway/service";
import type { HiddenLineReader } from "./console-commands.ts";

export class CustomToolCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CustomToolCommandError";
	}
}

export type CustomToolSecretSetOptions = Readonly<{
	alias: string;
	/** The secret file, already resolved against the custom-tool secrets directory in effect
	 * (`resolveCustomToolSecretPath`). */
	secretPath: string;
	reader: HiddenLineReader;
}>;

/**
 * `gateway tools secret set <alias>`: hidden entry, confirmed, written verbatim to the alias's own
 * file under the tool runner's custom-tool secrets mount — the same `console password set`/
 * `mattermost admin-token set` pattern (refuses anything but an interactive terminal, so the
 * secret can never arrive as a command argument or an environment variable, and is never printed
 * or included in an error). Unlike a console password, nothing here is hashed: a custom tool's
 * secret is a credential the destination itself expects verbatim (an API key, a bearer token).
 */
export async function customToolSecretSet(
	options: CustomToolSecretSetOptions,
	print: (line: string) => void,
): Promise<void> {
	if (!options.reader.isTTY) {
		throw new CustomToolCommandError("stdin is not a terminal; run this from an interactive shell");
	}
	const value = await options.reader.readLine(`Secret for '${options.alias}': `);
	if (value.length === 0) {
		throw new CustomToolCommandError("the secret must not be empty");
	}
	const confirmation = await options.reader.readLine("Confirm: ");
	if (value !== confirmation) {
		throw new CustomToolCommandError("the two entries did not match; nothing was changed");
	}
	writeSecretFile(options.secretPath, value);
	print(
		`secret '${options.alias}' set at ${options.secretPath}; restart the tool runner ` +
			"(bin/agw restart gateway-tool-runner) to pick it up",
	);
}

/** Parses and validates a definition file against `CustomHttpsDefinitionSchema`, with a
 * CLI-friendly error listing every problem at once — the same definition `createCustomHttpsTool`/
 * `editCatalogEntry` would refuse regardless, surfaced here before any database round trip. */
function readDefinitionFile(path: string) {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new CustomToolCommandError(
			`'${path}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const result = CustomHttpsDefinitionSchema.safeParse(parsed);
	if (!result.success) {
		throw new CustomToolCommandError(
			`'${path}' is not a valid custom HTTPS tool definition:\n- ${result.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
				.join("\n- ")}`,
		);
	}
	return result.data;
}

export type CreateCustomToolOptions = Readonly<{
	entryId: string;
	name: string;
	description: string;
	definitionFile: string;
	actor: string;
}>;

/** `gateway tools custom create <entry-id> --name <name> --description <text> --definition
 * <file.json>`: defines a new owner-managed HTTPS tool (ADR-027). The definition file is the same
 * JSON shape `gateway tools custom edit` and `config export`'s catalog data read and write. */
export async function createCustomTool(
	deps: ControlPlaneDeps,
	options: CreateCustomToolOptions,
): Promise<void> {
	await createCustomHttpsTool(deps, {
		entryId: options.entryId,
		name: options.name,
		description: options.description,
		httpsDefinition: readDefinitionFile(options.definitionFile),
		actor: options.actor,
	});
}

export type EditCustomToolOptions = Readonly<{
	entryId: string;
	name?: string;
	description?: string;
	definitionFile?: string;
	actor: string;
}>;

/** `gateway tools custom edit <entry-id> [--name <name>] [--description <text>] [--definition
 * <file.json>]`: publishes a new immutable version (ADR-027) — any approval still pending against
 * the entry's previous version is refused at grant time, never silently executed against this
 * one. */
export async function editCustomTool(
	deps: ControlPlaneDeps,
	options: EditCustomToolOptions,
): Promise<void> {
	await editCatalogEntry(deps, {
		entryId: options.entryId,
		actor: options.actor,
		...(options.name === undefined ? {} : { name: options.name }),
		...(options.description === undefined ? {} : { description: options.description }),
		...(options.definitionFile === undefined
			? {}
			: { httpsDefinition: readDefinitionFile(options.definitionFile) }),
	});
}
