import {
	ConsoleAdoptCommitRequestSchema,
	type ConsoleAdoptCommitResponse,
	type ConsoleAdoptPreviewResponse,
	type ConsoleAgentToolsResponse,
	ConsoleAttachToolRequestSchema,
	type ConsoleAttachToolResponse,
	type ConsoleCatalogSecretAliasStatus,
	ConsoleCreateCustomToolRequestSchema,
	type ConsoleCreateCustomToolResponse,
	ConsoleDeleteCatalogEntryRequestSchema,
	type ConsoleDeleteCatalogEntryResponse,
	ConsoleDetachToolRequestSchema,
	type ConsoleDetachToolResponse,
	ConsoleEditCatalogEntryRequestSchema,
	type ConsoleEditCatalogEntryResponse,
	type ConsoleToolCatalogEntryDetailResponse,
	type ConsoleToolCatalogListResponse,
	ConsoleUpdateAttachmentRequestSchema,
	type ConsoleUpdateAttachmentResponse,
} from "@agent-gateway/contracts";
import {
	type ControlPlaneDeps,
	consoleAdoptCommit,
	consoleAdoptPreview,
	consoleAgentTools,
	consoleAttachTool,
	consoleCreateCustomTool,
	consoleDeleteCatalogEntry,
	consoleDetachTool,
	consoleEditCatalogEntry,
	consoleGetToolCatalogEntry,
	consoleListToolCatalog,
	consoleUpdateAttachment,
} from "@agent-gateway/core";
import { resolveCustomToolSecretPath, secretFileExists } from "@agent-gateway/service";
import type { z } from "zod";
import { CONSOLE_ACTOR } from "./console-management.ts";

// ---------------------------------------------------------------------------
// The Instruments & Utils hub's own management API (ADR-025/ADR-027): routes every
// `/api/tools*` and `/api/agents/:id/tools*` request to `@agent-gateway/core`'s own
// `console-tools.ts` read models and change-set translation. Pure routing and DTO shaping, exactly
// `console-management.ts`'s own convention — `console-server.ts` owns session, Origin and CSRF and
// calls `routeConsoleTools` only once a request has already passed every one of those checks.
//
// The one thing this file does that `console-tools.ts` (core) deliberately does not: read whether a
// custom tool's own named secret aliases are set. `core` depends on no filesystem access
// (`docs/project-structure.md`'s boundary); this process already reads secret files for other
// purposes (`console-server.ts`'s own password hash), so it enriches the entry-detail response with
// that one fact itself — never a value, only presence (ADR-027).
// ---------------------------------------------------------------------------

export type ManagementResult = Readonly<{ status: number; body: unknown }>;

export type ToolsManagementRequest = Readonly<{
	method: "GET" | "POST";
	pathname: string;
	bodyText: string;
	deps: ControlPlaneDeps;
	/** Where `gateway tools secret set <alias>` writes, read-only here (`CUSTOM_TOOL_SECRETS_DIR`);
	 * `undefined` defaults to the tool runner's own well-known mount path, the same default
	 * `resolveCustomToolSecretPath` already applies for every other caller. */
	customToolSecretsDir: string | undefined;
}>;

function notFound(message = "not found"): ManagementResult {
	return { status: 404, body: { error: message } };
}

function badRequest(message: string): ManagementResult {
	return { status: 400, body: { error: message } };
}

function staleConfiguration(currentRevisionId: number | null): ManagementResult {
	return {
		status: 409,
		body: {
			error: "the active configuration changed since this page was loaded",
			currentRevisionId,
		},
	};
}

type ParsedBody<T> =
	| Readonly<{ ok: true; data: T }>
	| Readonly<{ ok: false; result: ManagementResult }>;

/** Parses a POST body as JSON and validates it against `schema`: malformed JSON, an unknown field,
 * an oversized value or any other shape problem is a `400`, named in `error` — the same convention
 * `console-management.ts`'s own `parseBody` uses. */
function parseBody<S extends z.ZodType>(schema: S, text: string): ParsedBody<z.infer<S>> {
	let json: unknown;
	try {
		json = text.length === 0 ? undefined : JSON.parse(text);
	} catch {
		return { ok: false, result: badRequest("malformed JSON body") };
	}
	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		const message = parsed.error.issues
			.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
			.join("; ");
		return { ok: false, result: badRequest(message) };
	}
	return { ok: true, data: parsed.data };
}

// ---------------------------------------------------------------------------
// /api/tools: the hub's own catalog surface
// ---------------------------------------------------------------------------

async function listRoute(deps: ControlPlaneDeps): Promise<ManagementResult> {
	const response: ConsoleToolCatalogListResponse = await consoleListToolCatalog(deps);
	return { status: 200, body: response };
}

function secretAliasStatuses(
	entry: ConsoleToolCatalogEntryDetailResponse["entry"],
	secretsDir: string | undefined,
): Readonly<ConsoleCatalogSecretAliasStatus[]> {
	const definition = entry.currentVersion.httpsDefinition;
	if (definition === null) {
		return [];
	}
	return definition.secretSlots.map((slot) => ({
		alias: slot.alias,
		set: secretFileExists(resolveCustomToolSecretPath(slot.alias, secretsDir)),
	}));
}

async function entryDetailRoute(
	deps: ControlPlaneDeps,
	entryId: string,
	secretsDir: string | undefined,
): Promise<ManagementResult> {
	const core = await consoleGetToolCatalogEntry(deps, entryId);
	if (core === null) {
		return notFound(`catalog entry '${entryId}' not found`);
	}
	const response: ConsoleToolCatalogEntryDetailResponse = {
		entry: core.entry,
		versions: [...core.versions],
		attachedAgents: [...core.attachedAgents],
		legacyGrantingAgents: [...core.legacyGrantingAgents],
		secretAliases: [...secretAliasStatuses(core.entry, secretsDir)],
	};
	return { status: 200, body: response };
}

async function createToolRoute(
	deps: ControlPlaneDeps,
	bodyText: string,
): Promise<ManagementResult> {
	const parsed = parseBody(ConsoleCreateCustomToolRequestSchema, bodyText);
	if (!parsed.ok) {
		return parsed.result;
	}
	const result = await consoleCreateCustomTool(deps, parsed.data, CONSOLE_ACTOR);
	if (result.kind === "invalid") {
		return { status: 422, body: { error: "the definition is invalid", problems: result.problems } };
	}
	const response: ConsoleCreateCustomToolResponse = { entry: result.entry };
	return { status: 200, body: response };
}

async function editToolRoute(
	deps: ControlPlaneDeps,
	entryId: string,
	bodyText: string,
): Promise<ManagementResult> {
	const parsed = parseBody(ConsoleEditCatalogEntryRequestSchema, bodyText);
	if (!parsed.ok) {
		return parsed.result;
	}
	const result = await consoleEditCatalogEntry(deps, entryId, parsed.data, CONSOLE_ACTOR);
	if (result.kind === "not-found") {
		return notFound(`catalog entry '${entryId}' not found`);
	}
	if (result.kind === "conflict") {
		return {
			status: 409,
			body: {
				error: "this entry was edited elsewhere since this page was loaded",
				currentVersion: result.currentVersion,
			},
		};
	}
	if (result.kind === "invalid") {
		return { status: 422, body: { error: "the edit is invalid", problems: result.problems } };
	}
	const response: ConsoleEditCatalogEntryResponse = { entry: result.entry };
	return { status: 200, body: response };
}

async function deleteToolRoute(
	deps: ControlPlaneDeps,
	entryId: string,
	bodyText: string,
): Promise<ManagementResult> {
	const parsed = parseBody(ConsoleDeleteCatalogEntryRequestSchema, bodyText);
	if (!parsed.ok) {
		return parsed.result;
	}
	const result = await consoleDeleteCatalogEntry(
		deps,
		entryId,
		CONSOLE_ACTOR,
		parsed.data.expectedAttachedAgentIds,
	);
	if (result.kind === "not-found") {
		return notFound(`catalog entry '${entryId}' not found`);
	}
	if (result.kind === "conflict") {
		return staleConfiguration(result.currentRevisionId);
	}
	if (result.kind === "would_widen") {
		return {
			status: 422,
			body: {
				error: "deleting this entry would widen one or more agents' effective permissions",
				widenings: result.widenings,
			},
		};
	}
	if (result.kind === "invalid") {
		return { status: 422, body: { error: "the delete is invalid", problems: result.problems } };
	}
	const response: ConsoleDeleteCatalogEntryResponse = {
		entryId,
		affectedAgentIds: [...result.affectedAgentIds],
	};
	return { status: 200, body: response };
}

// ---------------------------------------------------------------------------
// /api/agents/:id/tools: the agent capability editor's own surface
// ---------------------------------------------------------------------------

async function agentToolsRoute(deps: ControlPlaneDeps, agentId: string): Promise<ManagementResult> {
	const response: ConsoleAgentToolsResponse | null = await consoleAgentTools(deps, agentId);
	if (response === null) {
		return notFound(`agent '${agentId}' not found`);
	}
	return { status: 200, body: response };
}

async function attachRoute(
	deps: ControlPlaneDeps,
	agentId: string,
	bodyText: string,
): Promise<ManagementResult> {
	const parsed = parseBody(ConsoleAttachToolRequestSchema, bodyText);
	if (!parsed.ok) {
		return parsed.result;
	}
	const result = await consoleAttachTool(deps, agentId, parsed.data, CONSOLE_ACTOR);
	if (result.kind === "conflict") {
		return staleConfiguration(result.currentRevisionId);
	}
	if (result.kind === "invalid") {
		return { status: 422, body: { error: "the attachment is invalid", problems: result.problems } };
	}
	const response: ConsoleAttachToolResponse = {
		revisionId: result.revisionId,
		hash: result.hash,
		noop: result.noop,
		replayed: result.replayed,
		activeRevisionId: result.activeRevisionId,
		legacyConversion: result.legacyConversion,
	};
	return { status: 200, body: response };
}

async function detachRoute(
	deps: ControlPlaneDeps,
	agentId: string,
	bodyText: string,
): Promise<ManagementResult> {
	const parsed = parseBody(ConsoleDetachToolRequestSchema, bodyText);
	if (!parsed.ok) {
		return parsed.result;
	}
	const result = await consoleDetachTool(deps, agentId, parsed.data, CONSOLE_ACTOR);
	if (result.kind === "conflict") {
		return staleConfiguration(result.currentRevisionId);
	}
	if (result.kind === "would_widen") {
		return {
			status: 422,
			body: {
				error: "detaching this entry would widen the agent's effective permissions",
				widenings: result.widenings,
				acceptWidening: result.acceptWidening,
			},
		};
	}
	if (result.kind === "invalid") {
		return { status: 422, body: { error: "the detach is invalid", problems: result.problems } };
	}
	const response: ConsoleDetachToolResponse = {
		revisionId: result.revisionId,
		hash: result.hash,
		noop: result.noop,
		replayed: result.replayed,
		activeRevisionId: result.activeRevisionId,
	};
	return { status: 200, body: response };
}

async function updateAttachmentRoute(
	deps: ControlPlaneDeps,
	agentId: string,
	bodyText: string,
): Promise<ManagementResult> {
	const parsed = parseBody(ConsoleUpdateAttachmentRequestSchema, bodyText);
	if (!parsed.ok) {
		return parsed.result;
	}
	const result = await consoleUpdateAttachment(deps, agentId, parsed.data, CONSOLE_ACTOR);
	if (result.kind === "conflict") {
		return staleConfiguration(result.currentRevisionId);
	}
	if (result.kind === "invalid") {
		return { status: 422, body: { error: "the update is invalid", problems: result.problems } };
	}
	const response: ConsoleUpdateAttachmentResponse = {
		revisionId: result.revisionId,
		hash: result.hash,
		noop: result.noop,
		replayed: result.replayed,
		activeRevisionId: result.activeRevisionId,
	};
	return { status: 200, body: response };
}

async function adoptPreviewRoute(
	deps: ControlPlaneDeps,
	agentId: string,
): Promise<ManagementResult> {
	const response: ConsoleAdoptPreviewResponse | null = await consoleAdoptPreview(
		deps,
		agentId,
		CONSOLE_ACTOR,
	);
	if (response === null) {
		return notFound(`agent '${agentId}' not found`);
	}
	return { status: 200, body: response };
}

async function adoptCommitRoute(
	deps: ControlPlaneDeps,
	agentId: string,
	bodyText: string,
): Promise<ManagementResult> {
	const parsed = parseBody(ConsoleAdoptCommitRequestSchema, bodyText);
	if (!parsed.ok) {
		return parsed.result;
	}
	const result = await consoleAdoptCommit(
		deps,
		agentId,
		CONSOLE_ACTOR,
		parsed.data.baseRevisionId,
		parsed.data.expectedConversionHash,
		parsed.data.idempotencyKey,
		parsed.data.reason,
	);
	if (result.kind === "not-found") {
		return notFound(`agent '${agentId}' not found`);
	}
	if (result.kind === "conflict") {
		return staleConfiguration(result.currentRevisionId);
	}
	if (result.kind === "invalid") {
		return { status: 422, body: { error: "adoption is invalid", problems: result.problems } };
	}
	const response: ConsoleAdoptCommitResponse = {
		agentId: result.agentId,
		alreadyHubManaged: result.alreadyHubManaged,
		baseRevisionId: result.baseRevisionId,
		unresolved: result.unresolved,
		before: result.before,
		after: result.after,
		attachments: result.attachments,
		conversionHash: result.conversionHash,
		problems: result.problems,
		commit: result.commit,
	};
	return { status: 200, body: response };
}

/** True for `/api/agents/<id>/tools` and every sub-path beneath it — the one slice of the
 * `/api/agents/*` surface `console-tools.ts` (this file), not `console-management.ts`, routes. */
export function isAgentToolsPath(pathname: string): boolean {
	return /^\/api\/agents\/[^/]+\/tools(\/|$)/.test(pathname);
}

/**
 * Routes one already-authenticated, already Origin/CSRF-checked `/api/tools*` or
 * `/api/agents/:id/tools*` request. Every path this does not recognize, or a method it does not
 * support on a path it does, is a plain `404`.
 */
export async function routeConsoleTools(
	request: ToolsManagementRequest,
): Promise<ManagementResult> {
	const { method, pathname, bodyText, deps, customToolSecretsDir } = request;
	const segments = pathname.split("/").filter((segment) => segment.length > 0);
	// segments[0] is always "api".
	if (segments[1] === "tools") {
		if (segments.length === 2) {
			if (method === "GET") {
				return listRoute(deps);
			}
			return method === "POST" ? createToolRoute(deps, bodyText) : notFound();
		}
		const entryId = segments[2];
		if (entryId === undefined) {
			return notFound();
		}
		if (segments.length === 3) {
			return method === "GET" ? entryDetailRoute(deps, entryId, customToolSecretsDir) : notFound();
		}
		if (segments.length === 4 && method === "POST") {
			if (segments[3] === "edit") {
				return editToolRoute(deps, entryId, bodyText);
			}
			if (segments[3] === "delete") {
				return deleteToolRoute(deps, entryId, bodyText);
			}
		}
		return notFound();
	}
	if (segments[1] === "agents") {
		const agentId = segments[2];
		if (agentId === undefined || segments[3] !== "tools") {
			return notFound();
		}
		if (segments.length === 4) {
			return method === "GET" ? agentToolsRoute(deps, agentId) : notFound();
		}
		if (segments.length === 5) {
			const action = segments[4];
			if (action === "adopt") {
				if (method === "GET") {
					return adoptPreviewRoute(deps, agentId);
				}
				return method === "POST" ? adoptCommitRoute(deps, agentId, bodyText) : notFound();
			}
			if (method !== "POST") {
				return notFound();
			}
			if (action === "attach") {
				return attachRoute(deps, agentId, bodyText);
			}
			if (action === "detach") {
				return detachRoute(deps, agentId, bodyText);
			}
			if (action === "update") {
				return updateAttachmentRoute(deps, agentId, bodyText);
			}
		}
		return notFound();
	}
	return notFound();
}
