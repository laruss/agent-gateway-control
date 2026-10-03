import { z } from "zod";

/**
 * An owner's own HTTPS-backed tool (ADR-027's `custom_https` kind) and the fixed, image-shipped
 * utilities (`utility` kind). Both execute through the tool broker, always behind a human
 * approval (`packages/policy`'s `modeSupportedByKind`): a custom tool because it reaches an
 * external address the owner alone configured, a utility because the broker has no second,
 * approval-free execution path — see `docs/adr/027-tool-catalog.md`.
 */

// ---------------------------------------------------------------------------
// Secret aliases: never a value, only a name the tool runner resolves itself
// ---------------------------------------------------------------------------

/** Where the tool runner's custom-tool secrets are mounted: one file per alias, read-only to the
 * runner, written only by `gateway tools secret set <alias>`. */
export const CUSTOM_TOOL_SECRET_MOUNT = "/run/custom-tool-secrets/";

export const CustomToolSecretAliasSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z][a-z0-9_]*$/, "lowercase letters, digits, underscore, starting with a letter");
export type CustomToolSecretAlias = z.infer<typeof CustomToolSecretAliasSchema>;

// ---------------------------------------------------------------------------
// The fixed shape of a definition's one HTTPS call
// ---------------------------------------------------------------------------

export const CUSTOM_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const CustomHttpMethodSchema = z.enum(CUSTOM_HTTP_METHODS);
export type CustomHttpMethod = z.infer<typeof CustomHttpMethodSchema>;

/** Whether `method` can mutate state at the destination; only these require the definition to
 * declare an idempotency mechanism (ADR-027). */
export function customHttpMethodWrites(method: CustomHttpMethod): boolean {
	return method !== "GET";
}

/** Where a typed parameter or a secret is mapped into the request: a path placeholder, a query
 * key, a header, or a JSON body field. Never interpolated as a raw string — always one of these
 * explicit, encoded slots. */
export const CUSTOM_PARAM_SLOTS = ["path", "query", "header", "body"] as const;
export const CustomParamSlotSchema = z.enum(CUSTOM_PARAM_SLOTS);
export type CustomParamSlot = z.infer<typeof CustomParamSlotSchema>;

/** The wire name a slot actually uses: a path template's placeholder, a query key, a header name
 * or a JSON body field name. Restricted to common token characters, so a parameter can never
 * smuggle a second header, a line break or a stray '/' into the request through its own name. */
export const CustomSlotNameSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "letters, digits, '_' or '-', starting with a letter");
export type CustomSlotName = z.infer<typeof CustomSlotNameSchema>;

/** Headers a definition may never target directly: transport/identity headers the egress guard,
 * Node's own HTTP client, or the TLS layer already own. */
export const RESERVED_CUSTOM_HEADER_NAMES: ReadonlySet<string> = new Set([
	"host",
	"content-length",
	"content-type",
	"connection",
	"transfer-encoding",
	"upgrade",
	"te",
	"trailer",
	"expect",
]);

export function isReservedCustomHeaderName(name: string): boolean {
	return RESERVED_CUSTOM_HEADER_NAMES.has(name.toLowerCase());
}

/** A typed parameter's own name: what the agent fills in, independent of the slot it is mapped
 * into (a parameter named `priority` may fill a header, a query key or a body field). */
const CustomParamNameSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z][a-z0-9_]*$/, "lowercase letters, digits, underscore, starting with a letter");

const CustomParamBase = {
	name: CustomParamNameSchema,
	slot: CustomParamSlotSchema,
	slotName: CustomSlotNameSchema,
};

export const CustomStringParamSchema = z
	.strictObject({
		...CustomParamBase,
		type: z.literal("string"),
		minLength: z.int().min(0).max(2000).default(0),
		maxLength: z.int().min(1).max(2000).default(200),
	})
	.refine((param) => param.minLength <= param.maxLength, "minLength must be at most maxLength");

export const CustomNumberParamSchema = z
	.strictObject({
		...CustomParamBase,
		type: z.literal("number"),
		minimum: z.number().finite().optional(),
		maximum: z.number().finite().optional(),
	})
	.refine(
		(param) =>
			param.minimum === undefined || param.maximum === undefined || param.minimum <= param.maximum,
		"minimum must be at most maximum",
	);

export const CustomBooleanParamSchema = z.strictObject({
	...CustomParamBase,
	type: z.literal("boolean"),
});

export const CustomEnumParamSchema = z.strictObject({
	...CustomParamBase,
	type: z.literal("enum"),
	values: z.array(z.string().min(1).max(100)).min(1).max(50),
});

/** One typed parameter of a custom tool: string/number/boolean/enum with bounds, mapped
 * explicitly into one slot (ADR-027) — never evaluated, never interpolated outside that slot. */
export const CustomToolParamSchema = z.discriminatedUnion("type", [
	CustomStringParamSchema,
	CustomNumberParamSchema,
	CustomBooleanParamSchema,
	CustomEnumParamSchema,
]);
export type CustomToolParam = z.infer<typeof CustomToolParamSchema>;

export const MAX_CUSTOM_TOOL_PARAMS = 16;
export const MAX_CUSTOM_TOOL_SECRET_SLOTS = 4;

/** A secret the definition names by alias, mapped into one slot; the runner alone resolves the
 * alias to a value, from its own secrets directory — the value never reaches this definition, the
 * model, the database, logs, approvals or an error. */
export const CustomToolSecretSlotSchema = z.strictObject({
	alias: CustomToolSecretAliasSchema,
	slot: CustomParamSlotSchema,
	slotName: CustomSlotNameSchema,
});
export type CustomToolSecretSlot = z.infer<typeof CustomToolSecretSlotSchema>;

/** The provider's idempotency mechanism: a header name the runner sends the action's stored
 * idempotency key under. Required for every write (ADR-018's idempotency key, ADR-027's rule that
 * a write without one is refused as a definition). */
export const CustomToolIdempotencySchema = z.strictObject({ headerName: CustomSlotNameSchema });
export type CustomToolIdempotency = z.infer<typeof CustomToolIdempotencySchema>;

const MimeTypeSchema = z
	.string()
	.min(3)
	.max(100)
	.regex(
		/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i,
		"mime type like 'application/json'",
	);

export const CustomToolResponseLimitsSchema = z.strictObject({
	/** The response is read incrementally and aborted the moment it would exceed this. */
	maxResponseBytes: z.int().min(1).max(5_000_000).default(65_536),
	/** The `Content-Type` (media type only, parameters ignored) the response must declare. */
	allowedContentTypes: z.array(MimeTypeSchema).min(1).max(16),
	/** A hard deadline on the whole call (connect through response body), milliseconds. */
	timeoutMs: z.int().min(1000).max(60_000).default(10_000),
	/** `false`: the receipt never carries a body preview at all, whatever the response — an
	 * owner's own choice for a destination whose body is never worth showing an agent (it might
	 * itself be sensitive, even scrubbed of this definition's own named secrets). Scrubbing a
	 * destination's echo is best-effort regardless (`textPreview`, `@agent-gateway/tool-broker`);
	 * this is the one way to make that question not matter at all. Defaults to on, unchanged from
	 * every definition that predates this field. */
	includeBodyPreview: z.boolean().default(true),
});
export type CustomToolResponseLimits = z.infer<typeof CustomToolResponseLimitsSchema>;

/** A DNS hostname only — never a literal address. A definition that named `127.0.0.1` would still
 * be caught at execution time (the egress guard classifies every literal and resolved address
 * alike), but a real hostname is the only destination this is meant to express. */
export const CustomHttpsHostSchema = z
	.string()
	.min(1)
	.max(253)
	.regex(
		/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i,
		"a DNS hostname like 'api.example.com'",
	);

/** A path template: placeholders in `{curly braces}`, one per path-slot parameter, substituted
 * only with that parameter's own (bounded, encoded) value — never free string interpolation. */
export const CustomHttpsPathTemplateSchema = z
	.string()
	.min(1)
	.max(500)
	.regex(
		/^\/[A-Za-z0-9._~%-]*(\/[A-Za-z0-9._~%-]*|\{[A-Za-z][A-Za-z0-9_-]*\})*$/,
		"a path starting with '/'",
	)
	.refine((template) => !template.includes(".."), "a path template must not contain '..'");

/** Every `{placeholder}` a path template names, in order, duplicates included (checked
 * elsewhere). */
export function pathTemplatePlaceholders(template: string): Readonly<string[]> {
	return [...template.matchAll(/\{([A-Za-z][A-Za-z0-9_-]*)\}/g)].map((match) => match[1] ?? "");
}

/**
 * An owner's own HTTPS-backed tool: a fixed destination and method, typed parameters mapped
 * explicitly into encoded slots, named secrets the runner alone resolves, and response limits.
 * Immutable per catalog entry version (ADR-027): editing one publishes a new version, and an
 * approval hashed against an earlier version is refused at grant time once the entry has moved on
 * (`customDefinitionVersionIssues`, `@agent-gateway/policy`).
 */
export const CustomHttpsDefinitionSchema = z.strictObject({
	host: CustomHttpsHostSchema,
	pathTemplate: CustomHttpsPathTemplateSchema,
	method: CustomHttpMethodSchema,
	parameters: z.array(CustomToolParamSchema).max(MAX_CUSTOM_TOOL_PARAMS),
	secretSlots: z.array(CustomToolSecretSlotSchema).max(MAX_CUSTOM_TOOL_SECRET_SLOTS),
	idempotency: CustomToolIdempotencySchema.nullable(),
	responseLimits: CustomToolResponseLimitsSchema,
});
export type CustomHttpsDefinition = z.infer<typeof CustomHttpsDefinitionSchema>;

/**
 * Everything wrong with a definition on its own terms — never the database, never a config schema
 * dependent on it — so creating or editing one refuses before a version is ever stored. Pure.
 */
export function customHttpsDefinitionProblems(
	definition: CustomHttpsDefinition,
): Readonly<string[]> {
	const problems: string[] = [];
	const placeholders = pathTemplatePlaceholders(definition.pathTemplate);
	const placeholderSet = new Set(placeholders);
	if (placeholders.length !== placeholderSet.size) {
		problems.push("the path template names the same placeholder more than once");
	}
	const pathParamNames = new Set(
		definition.parameters.filter((param) => param.slot === "path").map((param) => param.slotName),
	);
	for (const placeholder of placeholderSet) {
		if (!pathParamNames.has(placeholder)) {
			problems.push(`path template placeholder '{${placeholder}}' has no matching path parameter`);
		}
	}
	for (const name of pathParamNames) {
		if (!placeholderSet.has(name)) {
			problems.push(`path parameter '${name}' has no '{${name}}' placeholder in the path template`);
		}
	}
	for (const param of definition.parameters) {
		if (param.name === CUSTOM_DEFINITION_VERSION_PARAM) {
			problems.push(
				`parameter '${param.name}' is reserved for the controller's own definition-version pin`,
			);
		}
	}
	// Every (slot, slotName) pair must be unique across parameters, secret slots and the
	// idempotency header: two sources writing the same header or body field would make the actual
	// request ambiguous, and a parameter or secret quietly aliasing the idempotency header could
	// override the value the runner sends there. Header names are compared case-insensitively
	// (HTTP header names are never case-sensitive); every other slot is compared exactly.
	const slotKeys = new Map<string, string>();
	const claim = (slot: string, slotName: string, who: string) => {
		const key = slot === "header" ? `${slot}:${slotName.toLowerCase()}` : `${slot}:${slotName}`;
		const owner = slotKeys.get(key);
		if (owner !== undefined) {
			problems.push(`${who} and ${owner} both target ${slot} '${slotName}'`);
		} else {
			slotKeys.set(key, who);
		}
	};
	if (definition.idempotency !== null) {
		claim("header", definition.idempotency.headerName, "the idempotency header");
	}
	for (const param of definition.parameters) {
		if (param.slot === "path" && !/^[A-Za-z][A-Za-z0-9_]*$/.test(param.slotName)) {
			problems.push(`path parameter '${param.name}': slot name must match a '{placeholder}' name`);
		}
		if (param.slot === "header" && isReservedCustomHeaderName(param.slotName)) {
			problems.push(`parameter '${param.name}': '${param.slotName}' is a reserved header`);
		}
		if (param.slot === "body" && definition.method === "GET") {
			problems.push(`parameter '${param.name}': a GET request has no body`);
		}
		claim(param.slot, param.slotName, `parameter '${param.name}'`);
	}
	for (const secret of definition.secretSlots) {
		if (secret.slot === "path") {
			problems.push(`secret '${secret.alias}': a path segment must not come from a secret`);
		}
		if (secret.slot === "header" && isReservedCustomHeaderName(secret.slotName)) {
			problems.push(`secret '${secret.alias}': '${secret.slotName}' is a reserved header`);
		}
		if (secret.slot === "body" && definition.method === "GET") {
			problems.push(`secret '${secret.alias}': a GET request has no body`);
		}
		claim(secret.slot, secret.slotName, `secret '${secret.alias}'`);
	}
	const aliasCounts = new Map<string, number>();
	for (const secret of definition.secretSlots) {
		aliasCounts.set(secret.alias, (aliasCounts.get(secret.alias) ?? 0) + 1);
	}
	for (const [alias, count] of aliasCounts) {
		if (count > 1) {
			problems.push(`secret alias '${alias}' is used more than once`);
		}
	}
	const writes = customHttpMethodWrites(definition.method);
	if (writes && definition.idempotency === null) {
		problems.push(
			`'${definition.method}' writes and must declare an idempotency header; a write cannot be saved without one`,
		);
	}
	if (!writes && definition.idempotency !== null) {
		problems.push("a GET has nothing to make idempotent; remove the idempotency header");
	}
	if (
		definition.idempotency !== null &&
		isReservedCustomHeaderName(definition.idempotency.headerName)
	) {
		problems.push(`the idempotency header '${definition.idempotency.headerName}' is reserved`);
	}
	return problems;
}

// ---------------------------------------------------------------------------
// Packaged utilities: a typed input/output, a bounded size, nothing else
// ---------------------------------------------------------------------------

/** `utility.text-transform`'s own operations: deterministic, side-effect-free string transforms.
 * `trim`/`reverse` never grow the input; `slugify` is bounded by its own, explicit truncation
 * below. `upper`/`lower` are Unicode case mapping, not a 1:1 character substitution, and *can*
 * grow it (`"ß".toUpperCase()` is `"SS"`, twice as long) — the one case the executor
 * (`@agent-gateway/tool-broker`'s `utilityExecutor`) checks for itself, since nothing short of
 * actually running the transform can bound it here. */
export const TEXT_TRANSFORM_OPERATIONS = ["trim", "upper", "lower", "slugify", "reverse"] as const;
export const TextTransformOperationSchema = z.enum(TEXT_TRANSFORM_OPERATIONS);
export type TextTransformOperation = z.infer<typeof TextTransformOperationSchema>;

/** The longest input `utility.text-transform` accepts. Not by itself a bound on the *output*
 * (see `TEXT_TRANSFORM_OPERATIONS`'s own doc comment) — the executor checks that separately,
 * against `TOOL_RECEIPT_TEXT_MAX`. */
export const TEXT_TRANSFORM_MAX_INPUT_LENGTH = 400;

/** The built-in utility this release ships: fixed code, a typed input, a bounded, side-effect-free
 * output — proving the packaged-utility path (ADR-027), never an arbitrary worker command. */
export const UTILITY_TEXT_TRANSFORM = "utility.text-transform" as const;

export function textTransform(operation: TextTransformOperation, text: string): string {
	switch (operation) {
		case "trim":
			return text.trim();
		case "upper":
			return text.toUpperCase();
		case "lower":
			return text.toLowerCase();
		case "reverse":
			return [...text].reverse().join("");
		case "slugify":
			return text
				.trim()
				.toLowerCase()
				.replaceAll(/[^a-z0-9]+/g, "-")
				.replaceAll(/^-+|-+$/g, "")
				.slice(0, TEXT_TRANSFORM_MAX_INPUT_LENGTH);
	}
}

// ---------------------------------------------------------------------------
// Addressing a `custom_https` entry as an action type, and pinning an approval to a version
// ---------------------------------------------------------------------------

/** A `custom_https` catalog entry's own action type: `custom.<entry-id>` (ADR-027) — the tool
 * broker's `custom` namespace serves every one of these, resolving the specific entry dynamically
 * rather than through a statically registered executor. */
export function customToolActionType(entryId: string): string {
	return `custom.${entryId}`;
}

/** The catalog entry id a `custom.<entry-id>` action type names, or null when `actionType` is not
 * one (a different namespace, or malformed). Never trusted on its own: the caller re-validates
 * `entryId` against the catalog, exactly like any other id read off a request. */
export function customToolEntryId(actionType: string): string | null {
	return actionType.startsWith("custom.") ? actionType.slice("custom.".length) : null;
}

/**
 * The synthetic action parameter an approval's own hash and card carry alongside a model's real
 * parameters, naming which definition version the request was resolved against. The controller
 * adds it when a `needs_human` request names a `custom_https` action, never the model; a
 * definition edited since (a new version published) no longer matches the entry's *current*
 * version, which is exactly what invalidates a stale approval at grant time (ADR-027).
 */
export const CUSTOM_DEFINITION_VERSION_PARAM = "custom_tool_definition_version";
