import {
	CUSTOM_DEFINITION_VERSION_PARAM,
	type CustomHttpsDefinition,
	CustomHttpsDefinitionSchema,
	customHttpMethodWrites,
	customToolEntryId,
	TOOL_RECEIPT_TEXT_MAX,
	type ToolReceipt,
	toVerbatimPreview,
	writeStatusIsAmbiguous,
} from "@agent-gateway/contracts";
import { redactText } from "@agent-gateway/logging";
import { encodedQueryParams, resolveCustomHttpRequest } from "@agent-gateway/policy";
import type { EgressOutcome, EgressRequest } from "./egress.ts";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor.ts";

/**
 * Executes one approved `custom_https` action (ADR-027): resolves the immutable definition
 * version the approval was granted against, resolves the model's own parameters and the
 * definition's named secrets into the one HTTPS request it describes, and sends it through the
 * egress guard. Nothing here reads the catalog's *current* state — grant-time policy already
 * refused anything whose definition moved on since the request was made
 * (`customDefinitionVersionIssues`); execution only ever uses the exact version it was approved
 * against, fetched by id, never "whatever is current now".
 */

/** The one immutable fact the runner is allowed to read about a `custom_https` entry: one
 * version's own definition, by (entry id, version) — never the entry's current state. Backed by
 * `gateway_custom_tool_definition`, a narrow `SECURITY DEFINER` function symmetrical with
 * `gateway_begin_tool_action` (ADR-018): the runner's role may call it and read nothing else of
 * the catalog. */
export type CustomToolDefinitionLookup = (
	entryId: string,
	version: number,
) => Promise<CustomHttpsDefinition | null>;

/** A {@link CustomToolDefinitionLookup} over raw stored definitions: each one is parsed, not
 * trusted as typed, so the schema's defaults fill fields a definition stored before they existed
 * lacks (e.g. `responseLimits.includeBodyPreview`). */
export function parsedDefinitionLookup(
	load: (entryId: string, version: number) => Promise<object | null>,
): CustomToolDefinitionLookup {
	return async (entryId, version) => {
		const stored = await load(entryId, version);
		return stored === null ? null : CustomHttpsDefinitionSchema.parse(stored);
	};
}

/** Resolves a secret alias to its value, from the runner's own secrets directory. Throws (never
 * returns a placeholder) when the alias has no file: a custom tool missing its secret cannot be
 * silently half-executed. */
export type SecretResolver = (alias: string) => Promise<string>;

export type CustomHttpsExecutorDeps = Readonly<{
	lookup: CustomToolDefinitionLookup;
	secrets: SecretResolver;
	/**
	 * Sends the resolved request. In production, the runner's own composition root binds this to
	 * `sendEgressRequest` with its real DNS resolver — the SSRF/DNS-rebinding guard
	 * (`resolvePinnedAddress`) runs there, once, on every call, never skippable from here. Tests
	 * bind it directly to `sendPinnedRequest` against a local test server's already-known loopback
	 * address: this executor only ever builds the request, never decides whether an address is
	 * reachable, so its own tests do not need a real SSRF-eligible destination to exercise request
	 * building, secret substitution and response handling.
	 */
	send: (request: EgressRequest) => Promise<EgressOutcome>;
}>;

export type CustomHttpsJob = Readonly<{
	actionType: string;
	actionParams: Readonly<{ name: string; value: string }[]>;
}>;

/**
 * Every form this executor itself could put a resolved secret value on the wire in, besides the
 * raw value: URL-encoded the way a query value is built (`encodeURIComponent`) and the way
 * `URLSearchParams` itself would encode it (space as `+`, not `%20`), JSON-string-escaped the way
 * a body field is (quotes and backslashes escaped), and base64/base64url, which nothing here emits
 * directly but a destination's own echo (a debug response, a provider that base64-decodes a
 * header for logging) might still surface. Empty values are skipped: `"".replaceAll("", x)` would
 * otherwise splice `x` between every character of the text.
 */
function secretEncodings(value: string): Readonly<string[]> {
	if (value === "") {
		return [];
	}
	const formUrlEncoded = new URLSearchParams([["v", value]]).toString().slice("v=".length);
	const jsonEscaped = JSON.stringify(value).slice(1, -1);
	const buffer = Buffer.from(value, "utf8");
	return [
		value,
		encodeURIComponent(value),
		formUrlEncoded,
		jsonEscaped,
		buffer.toString("base64"),
		buffer.toString("base64url"),
	];
}

/**
 * Scrubs every resolved secret value — and the forms above — from `text`, case-sensitively, out
 * before it is ever read into a receipt or an error. The one choke point every outcome text passes
 * through on its way out of this executor: a success preview, a failure or unknown message, any
 * error string. Best-effort against a destination that happens to echo the credential back in its
 * own response (a provider's own debug page, an error quoting the request) — a genuinely hostile
 * destination already holds the value this call sent it and learns nothing more from a scrub
 * failing to catch some further transformation of it.
 */
function scrubSecrets(text: string, secretValues: Iterable<string>): string {
	let scrubbed = text;
	for (const value of secretValues) {
		for (const form of secretEncodings(value)) {
			scrubbed = scrubbed.replaceAll(form, "<redacted>");
		}
	}
	return scrubbed;
}

/**
 * A response body, scrubbed, generically redacted (`@agent-gateway/logging`'s own secret-looking
 * patterns, for anything beyond this call's own named secrets), collapsed to a single line safe
 * for a `ToolReceipt` field (`toVerbatimPreview`, `@agent-gateway/contracts`) and bounded to
 * `TOOL_RECEIPT_TEXT_MAX` — never empty.
 */
function textPreview(text: string, secretValues: Iterable<string>): string {
	return toVerbatimPreview(redactText(scrubSecrets(text, secretValues)), TOOL_RECEIPT_TEXT_MAX);
}

/** `definition`'s own choice, not this call's: `includeBodyPreview: false` withholds a body
 * preview unconditionally, success or failure alike — the one way an owner can make "does this
 * destination's body ever belong in front of the agent" not depend on how well a scrub works. */
function renderBodyPreview(
	definition: CustomHttpsDefinition,
	body: string,
	secretValues: Iterable<string>,
): string {
	return definition.responseLimits.includeBodyPreview
		? textPreview(body, secretValues)
		: "(preview disabled by this tool's definition)";
}

async function resolvedSecretValues(
	definition: CustomHttpsDefinition,
	secrets: SecretResolver,
): Promise<ReadonlyMap<string, string>> {
	const values = new Map<string, string>();
	for (const slot of definition.secretSlots) {
		values.set(`${slot.slot}:${slot.slotName}`, await secrets(slot.alias));
	}
	return values;
}

export async function executeCustomHttpsAction(
	job: CustomHttpsJob,
	deps: CustomHttpsExecutorDeps,
	context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
	const entryId = customToolEntryId(job.actionType);
	if (entryId === null) {
		return { kind: "failed", error: `'${job.actionType}' is not a custom tool action` };
	}
	const versionParam = job.actionParams.find(
		(param) => param.name === CUSTOM_DEFINITION_VERSION_PARAM,
	);
	const version = versionParam === undefined ? Number.NaN : Number(versionParam.value);
	if (!Number.isInteger(version) || version < 1) {
		return { kind: "failed", error: "the job carries no valid definition version" };
	}
	if (context.signal.aborted) {
		return { kind: "failed", error: "cancelled before the tool definition was read" };
	}
	const definition = await deps.lookup(entryId, version);
	if (definition === null) {
		return {
			kind: "failed",
			error: `custom tool '${entryId}' version ${version} is no longer available`,
		};
	}
	if (context.signal.aborted) {
		return { kind: "failed", error: "cancelled before secrets were resolved" };
	}
	let path: string;
	let headers: Record<string, string>;
	let body: string | null;
	let secretValues: ReadonlyMap<string, string>;
	try {
		// `customToolParamIssues` already refused a path-traversal attempt, an out-of-bounds value or
		// an undeclared parameter before this request was ever approved (`approvalPolicyIssues`) and
		// again at grant time (`executionIssues`); `resolveCustomHttpRequest` itself encodes every path
		// value into exactly one segment regardless, so even a value that reached this point some other
		// way (a forged job) can never escape its segment — encoding, not re-validation, is what keeps
		// this call itself safe.
		const resolved = resolveCustomHttpRequest(definition, job.actionParams);
		// A missing secret file throws here (`SecretResolver`'s own contract); caught below.
		secretValues = await resolvedSecretValues(definition, deps.secrets);

		const query = encodedQueryParams(resolved.query);
		for (const name of resolved.secretQueryNames) {
			query.append(name, secretValues.get(`query:${name}`) ?? "");
		}
		const queryString = query.toString();
		path = `${resolved.path}${queryString === "" ? "" : `?${queryString}`}`;

		headers = {};
		for (const h of resolved.headers) {
			headers[h.name] = String(h.value);
		}
		for (const name of resolved.secretHeaderNames) {
			headers[name] = secretValues.get(`header:${name}`) ?? "";
		}
		if (definition.idempotency !== null) {
			headers[definition.idempotency.headerName] = context.idempotencyKey;
		}

		body = null;
		if (definition.method !== "GET") {
			const bodyFields: Record<string, string | number | boolean> = { ...resolved.bodyFields };
			for (const name of resolved.secretBodyFieldNames) {
				bodyFields[name] = secretValues.get(`body:${name}`) ?? "";
			}
			if (Object.keys(bodyFields).length > 0) {
				body = JSON.stringify(bodyFields);
			}
		}
	} catch (error) {
		// Nothing has been sent yet — a missing secret file (`SecretResolver` throws rather than
		// substituting a placeholder) or any other failure preparing the request is a clean, known
		// `failed`, never left to propagate into `processToolJob`'s `unknown` (reserved for after a
		// request may actually have reached the destination, ADR-018). No secret value was ever
		// resolved here (preparation failed before any `resolvedSecretValues` call could return one),
		// so there is nothing yet to scrub this message against.
		return {
			kind: "failed",
			error: `could not prepare the request: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	if (context.signal.aborted) {
		return { kind: "failed", error: "cancelled before the request was sent" };
	}
	let outcome: EgressOutcome;
	try {
		outcome = await deps.send({
			method: definition.method,
			host: definition.host,
			path,
			headers,
			body,
			timeoutMs: definition.responseLimits.timeoutMs,
			maxResponseBytes: definition.responseLimits.maxResponseBytes,
			allowedContentTypes: definition.responseLimits.allowedContentTypes,
			signal: context.signal,
		});
	} catch (error) {
		// A throw from `deps.send` (a timeout, a cancellation or a reset after the request was fully
		// sent) propagates out of this function — `processToolJob` records that as `unknown`, exactly
		// as it already does for any other executor that cannot tell what happened — but scrubbed
		// first: this is still an outcome text, the same choke point every other one passes through.
		throw new Error(
			scrubSecrets(error instanceof Error ? error.message : String(error), secretValues.values()),
		);
	}
	if (outcome.kind === "failed") {
		return { kind: "failed", error: scrubSecrets(outcome.error, secretValues.values()) };
	}
	// A 3xx is decided in `sendPinnedRequest` itself (`egress.ts`), before this point: redirects are
	// never followed, and the decision (a clean `failed` for a `GET`, `unknown` for a write already
	// sent) does not depend on the response's content type or body the way the rest of this
	// function's own classification does — a redirect commonly carries neither at all.
	if (outcome.response.status >= 400) {
		const preview = renderBodyPreview(definition, outcome.response.body, secretValues.values());
		if (
			customHttpMethodWrites(definition.method) &&
			writeStatusIsAmbiguous(outcome.response.status)
		) {
			// A 5xx (or 408) answer to a write already fully sent does not prove the destination
			// never acted on it — the same ambiguity a redirect, or a connection error, after sending
			// already carries; report it the same way, as `unknown` (a throw here, caught by
			// `processToolJob`), never a clean `failed` a caller might safely retry.
			throw new Error(
				`the destination answered ${outcome.response.status} after the write was sent, so whether it took effect is unknown: ${preview}`,
			);
		}
		return {
			kind: "failed",
			error: `the destination answered ${outcome.response.status}: ${preview}`,
		};
	}
	const receipt: ToolReceipt = {
		status: outcome.response.status,
		body_preview: outcome.response.bodyWithheld
			? "(withheld: the destination's content type was not one this tool allows)"
			: renderBodyPreview(definition, outcome.response.body, secretValues.values()),
	};
	return { kind: "succeeded", receipt };
}
