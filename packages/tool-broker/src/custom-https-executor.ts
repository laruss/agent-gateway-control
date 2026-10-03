import {
	CUSTOM_DEFINITION_VERSION_PARAM,
	type CustomHttpsDefinition,
	customToolEntryId,
	type ToolReceipt,
	withoutUnsafeCharacters,
} from "@agent-gateway/contracts";
import { redactForStorage } from "@agent-gateway/logging";
import { resolveCustomHttpRequest } from "@agent-gateway/policy";
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
 * A response body, bounded and free of control characters, never empty — the same shape every
 * other executor's own error text already keeps (`@agent-gateway/tool-broker`'s `tool-job.ts`).
 * Every resolved secret value is replaced outright first: a destination that echoes back a header
 * or query value it was sent (a provider's own debug response, an error page quoting the request)
 * must never hand a secret back to the model through the receipt it is this call's whole job to
 * report truthfully.
 */
function textPreview(text: string, secretValues: Iterable<string>): string {
	let scrubbed = text;
	for (const value of secretValues) {
		if (value !== "") {
			scrubbed = scrubbed.replaceAll(value, "<redacted>");
		}
	}
	return withoutUnsafeCharacters(redactForStorage(scrubbed, 500)).trim() || "(empty)";
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
	const definition = await deps.lookup(entryId, version);
	if (definition === null) {
		return {
			kind: "failed",
			error: `custom tool '${entryId}' version ${version} is no longer available`,
		};
	}
	// `customToolParamIssues` already refused a path-traversal attempt, an out-of-bounds value or
	// an undeclared parameter before this request was ever approved (`approvalPolicyIssues`) and
	// again at grant time (`executionIssues`); `resolveCustomHttpRequest` itself encodes every path
	// value into exactly one segment regardless, so even a value that reached this point some other
	// way (a forged job) can never escape its segment — encoding, not re-validation, is what keeps
	// this call itself safe.
	const resolved = resolveCustomHttpRequest(definition, job.actionParams);
	const secretValues = await resolvedSecretValues(definition, deps.secrets);

	const query = new URLSearchParams();
	for (const q of resolved.query) {
		query.append(q.name, String(q.value));
	}
	for (const name of resolved.secretQueryNames) {
		query.append(name, secretValues.get(`query:${name}`) ?? "");
	}
	const queryString = query.toString();
	const path = `${resolved.path}${queryString === "" ? "" : `?${queryString}`}`;

	const headers: Record<string, string> = {};
	for (const h of resolved.headers) {
		headers[h.name] = String(h.value);
	}
	for (const name of resolved.secretHeaderNames) {
		headers[name] = secretValues.get(`header:${name}`) ?? "";
	}
	if (definition.idempotency !== null) {
		headers[definition.idempotency.headerName] = context.idempotencyKey;
	}

	let body: string | null = null;
	if (definition.method !== "GET") {
		const bodyFields: Record<string, string | number | boolean> = { ...resolved.bodyFields };
		for (const name of resolved.secretBodyFieldNames) {
			bodyFields[name] = secretValues.get(`body:${name}`) ?? "";
		}
		if (Object.keys(bodyFields).length > 0) {
			body = JSON.stringify(bodyFields);
		}
	}

	const outcome = await deps.send({
		method: definition.method,
		host: definition.host,
		path,
		headers,
		body,
		timeoutMs: definition.responseLimits.timeoutMs,
		maxResponseBytes: definition.responseLimits.maxResponseBytes,
		allowedContentTypes: definition.responseLimits.allowedContentTypes,
	});
	// A throw from `deps.send` (a timeout or reset after the request was fully sent) propagates out
	// of this function unchanged — `processToolJob` records that as `unknown`, exactly as it
	// already does for any other executor that cannot tell what happened.
	if (outcome.kind === "failed") {
		return { kind: "failed", error: outcome.error };
	}
	if (outcome.response.status >= 400) {
		return {
			kind: "failed",
			error: `the destination answered ${outcome.response.status}: ${textPreview(outcome.response.body, secretValues.values())}`,
		};
	}
	const receipt: ToolReceipt = {
		status: outcome.response.status,
		body_preview: textPreview(outcome.response.body, secretValues.values()),
	};
	return { kind: "succeeded", receipt };
}
