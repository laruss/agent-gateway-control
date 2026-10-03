import {
	type ActionParam,
	CUSTOM_DEFINITION_VERSION_PARAM,
	type CustomHttpMethod,
	type CustomHttpsDefinition,
	type CustomToolParam,
} from "@agent-gateway/contracts";

/**
 * Validating a model's parameters against a `custom_https` definition, resolving them into the
 * exact HTTPS request the tool runner will send, and the one rule that invalidates a stale
 * approval: all pure, no IO, so every SSRF-adjacent decision here is unit-tested without a
 * server, a database or a tool runner (ADR-027).
 */

// ---------------------------------------------------------------------------
// Typed parameter validation
// ---------------------------------------------------------------------------

/** Characters a path-location value must never carry, however it is typed: percent-encoding a
 * value already keeps it inside its one path segment, but a value that is itself `.`/`..` or
 * contains a separator is refused outright rather than merely encoded, so a path traversal attempt
 * is a validation failure, never a request to somewhere unexpected. */
function hasSeparatorOrControlCharacter(value: string): boolean {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || value[i] === "/" || value[i] === "\\") {
			return true;
		}
	}
	return false;
}

function pathValueIssue(paramName: string, value: string): string | null {
	if (value === "" || value === "." || value === ".." || hasSeparatorOrControlCharacter(value)) {
		return `parameter '${paramName}': a path value must not be empty, '.', '..', or contain '/' or '\\'`;
	}
	return null;
}

const NUMBER_PATTERN = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

function typedValueIssues(param: CustomToolParam, value: string): Readonly<string[]> {
	const problems: string[] = [];
	if (param.slot === "path") {
		const issue = pathValueIssue(param.name, value);
		if (issue !== null) {
			problems.push(issue);
		}
	}
	switch (param.type) {
		case "string": {
			const min = param.minLength;
			const max = param.maxLength;
			if (value.length < min || value.length > max) {
				problems.push(`parameter '${param.name}' must be between ${min} and ${max} characters`);
			}
			break;
		}
		case "number": {
			if (!NUMBER_PATTERN.test(value)) {
				problems.push(`parameter '${param.name}' must be a number`);
				break;
			}
			const n = Number(value);
			if (param.minimum !== undefined && n < param.minimum) {
				problems.push(`parameter '${param.name}' must be at least ${param.minimum}`);
			}
			if (param.maximum !== undefined && n > param.maximum) {
				problems.push(`parameter '${param.name}' must be at most ${param.maximum}`);
			}
			break;
		}
		case "boolean":
			if (value !== "true" && value !== "false") {
				problems.push(`parameter '${param.name}' must be 'true' or 'false'`);
			}
			break;
		case "enum":
			if (!param.values.includes(value)) {
				problems.push(`parameter '${param.name}' must be one of ${param.values.join(", ")}`);
			}
			break;
	}
	return problems;
}

/**
 * What is wrong with a model's `actionParams` against `definition`'s own typed parameters: each
 * missing or invalid value, and any name the definition does not declare — the model's own
 * `CUSTOM_DEFINITION_VERSION_PARAM` is the one name this never flags, since the controller adds
 * it, not the model. Pure; the only gate between an agent's proposed call and a request ever being
 * resolved (`resolveCustomHttpRequest` assumes its input already passed this).
 */
export function customToolParamIssues(
	definition: CustomHttpsDefinition,
	actionParams: Readonly<ActionParam[]>,
): Readonly<string[]> {
	const problems: string[] = [];
	const given = new Map(actionParams.map((param) => [param.name, param.value]));
	const declared = new Set(definition.parameters.map((param) => param.name));
	for (const param of definition.parameters) {
		const value = given.get(param.name);
		if (value === undefined) {
			problems.push(`parameter '${param.name}' is missing`);
			continue;
		}
		problems.push(...typedValueIssues(param, value));
	}
	for (const name of given.keys()) {
		if (name !== CUSTOM_DEFINITION_VERSION_PARAM && !declared.has(name)) {
			problems.push(`parameter '${name}' is not part of this tool`);
		}
	}
	return problems;
}

// ---------------------------------------------------------------------------
// Resolving the actual request: every value mapped into its one declared slot
// ---------------------------------------------------------------------------

export type ResolvedCustomSlot = Readonly<{ name: string; value: string | number | boolean }>;

/**
 * The exact HTTPS request `definition` and `actionParams` resolve to, split by where each value
 * must go. Secret-filled slots carry their wire name only (`secretQueryNames`/
 * `secretHeaderNames`/`secretBodyFieldNames`): the alias is resolved, and the value spliced in,
 * only by the tool runner itself, from its own secrets directory — nothing here, including the
 * approval card and the immutable hash, ever sees a secret's value. `path` is already fully
 * resolved and percent-encoded: every path parameter's value becomes exactly one path segment,
 * however it is composed, so it can never introduce one of its own.
 */
export type ResolvedCustomRequest = Readonly<{
	method: CustomHttpMethod;
	host: string;
	/** Percent-encoded, absolute, no query string. */
	path: string;
	query: Readonly<ResolvedCustomSlot[]>;
	secretQueryNames: Readonly<string[]>;
	headers: Readonly<ResolvedCustomSlot[]>;
	secretHeaderNames: Readonly<string[]>;
	bodyFields: Readonly<Record<string, string | number | boolean>>;
	secretBodyFieldNames: Readonly<string[]>;
}>;

function typedValue(param: CustomToolParam, raw: string): string | number | boolean {
	switch (param.type) {
		case "number":
			return Number(raw);
		case "boolean":
			return raw === "true";
		default:
			return raw;
	}
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_-]*)\}/g;

/** Substitutes every `{placeholder}` with its path parameter's value, percent-encoded into
 * exactly one path segment — the value can never itself introduce a `/`, a `..` segment or any
 * character the encoding would not keep literal. */
function resolvePath(
	definition: CustomHttpsDefinition,
	values: ReadonlyMap<string, string>,
): string {
	return definition.pathTemplate.replaceAll(PLACEHOLDER, (_, name: string) =>
		encodeURIComponent(values.get(name) ?? ""),
	);
}

/**
 * Resolves `actionParams` (already passing `customToolParamIssues`) against `definition` into the
 * concrete request the tool runner sends. Pure and total: given valid input, it never throws.
 */
export function resolveCustomHttpRequest(
	definition: CustomHttpsDefinition,
	actionParams: Readonly<ActionParam[]>,
): ResolvedCustomRequest {
	const given = new Map(
		actionParams
			.filter((param) => param.name !== CUSTOM_DEFINITION_VERSION_PARAM)
			.map((param) => [param.name, param.value]),
	);
	const query: ResolvedCustomSlot[] = [];
	const headers: ResolvedCustomSlot[] = [];
	const bodyFields: Record<string, string | number | boolean> = {};
	for (const param of definition.parameters) {
		if (param.slot === "path") {
			continue;
		}
		const value = typedValue(param, given.get(param.name) ?? "");
		if (param.slot === "query") {
			query.push({ name: param.slotName, value });
		} else if (param.slot === "header") {
			headers.push({ name: param.slotName, value });
		} else {
			bodyFields[param.slotName] = value;
		}
	}
	const byName = (a: ResolvedCustomSlot, b: ResolvedCustomSlot) => (a.name < b.name ? -1 : 1);
	const secretsOf = (slot: "query" | "header" | "body") =>
		definition.secretSlots
			.filter((secret) => secret.slot === slot)
			.map((secret) => secret.slotName)
			.sort();
	return {
		method: definition.method,
		host: definition.host,
		path: resolvePath(definition, given),
		query: [...query].sort(byName),
		secretQueryNames: secretsOf("query"),
		headers: [...headers].sort(byName),
		secretHeaderNames: secretsOf("header"),
		bodyFields,
		secretBodyFieldNames: secretsOf("body"),
	};
}

/** A short, secret-free, human-readable rendering of `resolved` — never a value behind a secret
 * slot, only the name it will be filled under — for the approval card's own summary and the
 * runner's logs. Deterministic: the same resolved request always renders the same text. */
export function customRequestSummary(resolved: ResolvedCustomRequest): string {
	const query = [
		...resolved.query.map((q) => `${q.name}=${q.value}`),
		...resolved.secretQueryNames.map((name) => `${name}=<secret>`),
	].sort();
	const headers = [
		...resolved.headers.map((h) => h.name),
		...resolved.secretHeaderNames.map((name) => `${name}(secret)`),
	].sort();
	const body = [
		...Object.entries(resolved.bodyFields).map(([name, value]) => `${name}=${String(value)}`),
		...resolved.secretBodyFieldNames.map((name) => `${name}=<secret>`),
	].sort();
	const parts = [
		`${resolved.method} https://${resolved.host}${resolved.path}${query.length > 0 ? `?${query.join("&")}` : ""}`,
		headers.length > 0 ? `headers=[${headers.join(",")}]` : null,
		body.length > 0 ? `body={${body.join(",")}}` : null,
	];
	return parts.filter((part): part is string => part !== null).join(" ");
}

// ---------------------------------------------------------------------------
// A definition edited after approval invalidates it
// ---------------------------------------------------------------------------

/**
 * Why a request pinned to `requestedVersion` can no longer be granted against an entry whose
 * current version is `currentVersion`: the definition was edited (a new version published) since
 * the request was made, so what would actually run is not what was shown and hashed. Pure; the
 * grant-time re-check calls it alongside `customToolParamIssues` against the *current* definition.
 */
export function customDefinitionVersionIssues(
	requestedVersion: number,
	currentVersion: number,
): Readonly<string[]> {
	return requestedVersion === currentVersion
		? []
		: [
				`this custom tool was edited (version ${requestedVersion} -> ${currentVersion}) since the request was made; it must be requested again`,
			];
}
