import {
	type ConsoleAgentListResponse,
	ConsoleCommitRequestSchema,
	type ConsoleCommitResponse,
	ConsolePreviewRequestSchema,
	type ConsolePreviewResponse,
	type ConsoleRevisionDiffResponse,
	type ConsoleRevisionListResponse,
} from "@agent-gateway/contracts";
import {
	type ControlPlaneDeps,
	commitAgentPatch,
	consoleListAgents,
	consoleRevisionDiff,
	consoleShowAgent,
	listConfigRevisions,
	previewAgentPatch,
} from "@agent-gateway/core";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// The Agents hub's management API (ADR-025): routes every `/api/agents*`/`/api/config/revisions*`
// request to the read models and the change-set translation in `@agent-gateway/core`'s own
// `console-management.ts`. Pure routing and DTO shaping — no `Request`/`Response`, no session,
// Origin or CSRF concern (`console-server.ts` owns all of that and calls `routeConsoleManagement`
// only once a request has already passed every one of those checks).
// ---------------------------------------------------------------------------

/** Comfortably above a 50,000-character role prompt JSON-escaped in the worst case (every
 * character as a `\uXXXX` escape, 6 bytes), plus the patch's other, much smaller fields. */
export const MAX_MANAGEMENT_BODY_BYTES = 400_000;

/** The console has exactly one account (ADR-025): every commit it makes is attributed to this
 * fixed actor, distinguishable in `gateway config history` by both this string and its own
 * `source: "console"` (ADR-024's reserved source for this surface). */
export const CONSOLE_ACTOR = "console:owner";

const DEFAULT_REVISIONS_LIMIT = 50;
const MAX_REVISIONS_LIMIT = 200;

export type ManagementResult = Readonly<{ status: number; body: unknown }>;

export type ManagementRequest = Readonly<{
	method: "GET" | "POST";
	pathname: string;
	/** `new URL(request.url).searchParams`'s own type: named this way, rather than the ambient
	 * `URLSearchParams`, because this program's globals (`@types/bun`, no DOM lib) and Node's own
	 * (pulled in transitively) declare two incompatible shapes of that same name. */
	search: InstanceType<typeof URL>["searchParams"];
	bodyText: string;
	deps: ControlPlaneDeps;
}>;

function notFound(message = "not found"): ManagementResult {
	return { status: 404, body: { error: message } };
}

function badRequest(message: string): ManagementResult {
	return { status: 400, body: { error: message } };
}

type ParsedBody<T> =
	| Readonly<{ ok: true; data: T }>
	| Readonly<{ ok: false; result: ManagementResult }>;

/** Parses a POST body as JSON and validates it against `schema`: malformed JSON, an unknown
 * field, an oversized value or any other shape problem is a `400`, named in `error`. */
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

async function listAgentsRoute(deps: ControlPlaneDeps): Promise<ManagementResult> {
	const response: ConsoleAgentListResponse = { agents: [...(await consoleListAgents(deps))] };
	return { status: 200, body: response };
}

async function showAgentRoute(deps: ControlPlaneDeps, agentId: string): Promise<ManagementResult> {
	const response = await consoleShowAgent(deps, agentId);
	if (response === null) {
		return notFound(`agent '${agentId}' not found`);
	}
	return { status: 200, body: response };
}

async function previewRoute(
	deps: ControlPlaneDeps,
	agentId: string,
	bodyText: string,
): Promise<ManagementResult> {
	const parsed = parseBody(ConsolePreviewRequestSchema, bodyText);
	if (!parsed.ok) {
		return parsed.result;
	}
	const result = await previewAgentPatch(deps, agentId, parsed.data.changes);
	if (result.kind === "not-found") {
		return notFound(`agent '${agentId}' not found`);
	}
	const response: ConsolePreviewResponse = {
		baseRevisionId: result.preview.baseRevisionId,
		baseHash: result.preview.baseHash,
		newHash: result.preview.newHash,
		noop: result.preview.noop,
		diff: result.preview.diff,
		problems: [...result.preview.problems],
		impact: [...result.impact],
	};
	return { status: 200, body: response };
}

async function commitRoute(
	deps: ControlPlaneDeps,
	agentId: string,
	bodyText: string,
): Promise<ManagementResult> {
	const parsed = parseBody(ConsoleCommitRequestSchema, bodyText);
	if (!parsed.ok) {
		return parsed.result;
	}
	const { baseRevisionId, changes, idempotencyKey, reason } = parsed.data;
	const result = await commitAgentPatch(
		deps,
		agentId,
		baseRevisionId,
		changes,
		idempotencyKey,
		CONSOLE_ACTOR,
		reason,
	);
	if (result.kind === "not-found") {
		return notFound(`agent '${agentId}' not found`);
	}
	if (result.kind === "invalid") {
		return { status: 422, body: { error: "the change is invalid", problems: result.problems } };
	}
	if (result.kind === "conflict") {
		return {
			status: 409,
			body: {
				error: "the active configuration changed since this change was prepared",
				currentRevisionId: result.currentRevisionId,
			},
		};
	}
	const response: ConsoleCommitResponse = {
		revisionId: result.result.revisionId,
		hash: result.result.hash,
		noop: result.result.noop,
		replayed: result.result.replayed,
		activeRevisionId: result.result.activeRevisionId,
	};
	return { status: 200, body: response };
}

async function listRevisionsRoute(
	deps: ControlPlaneDeps,
	search: ManagementRequest["search"],
): Promise<ManagementResult> {
	const raw = search.get("limit");
	let limit = DEFAULT_REVISIONS_LIMIT;
	if (raw !== null) {
		const parsedLimit = Number(raw);
		if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_REVISIONS_LIMIT) {
			return badRequest(`limit must be an integer between 1 and ${MAX_REVISIONS_LIMIT}`);
		}
		limit = parsedLimit;
	}
	const revisions = await listConfigRevisions(deps, limit);
	const response: ConsoleRevisionListResponse = {
		revisions: revisions.map((revision) => ({
			id: revision.id,
			createdAt: revision.createdAt.toISOString(),
			actor: revision.actor,
			source: revision.source,
			reason: revision.reason,
			snapshotHashPrefix: revision.snapshotHash.slice(0, 12),
			parentRevisionId: revision.parentRevisionId,
		})),
	};
	return { status: 200, body: response };
}

async function diffRoute(deps: ControlPlaneDeps, idParam: string): Promise<ManagementResult> {
	const id = Number(idParam);
	if (!Number.isInteger(id) || id <= 0) {
		return badRequest("revision id must be a positive integer");
	}
	const result = await consoleRevisionDiff(deps, id);
	if (result === null) {
		return notFound(`revision ${id} not found`);
	}
	const response: ConsoleRevisionDiffResponse = {
		revisionId: id,
		parentRevisionId: result.parentRevisionId,
		diff: result.diff,
	};
	return { status: 200, body: response };
}

/**
 * Routes one already-authenticated, already Origin/CSRF-checked management request. Every path
 * this does not recognize, or a method it does not support on a path it does, is a plain `404` —
 * this surface has no route a client should be retrying with a different method.
 */
export async function routeConsoleManagement(
	request: ManagementRequest,
): Promise<ManagementResult> {
	const { method, pathname, search, bodyText, deps } = request;
	const segments = pathname.split("/").filter((segment) => segment.length > 0);
	// segments[0] is always "api" (console-server.ts only ever routes `/api/agents*` and
	// `/api/config/*` here).
	if (segments[1] === "agents") {
		if (segments.length === 2) {
			return method === "GET" ? listAgentsRoute(deps) : notFound();
		}
		const agentId = segments[2];
		if (agentId === undefined) {
			return notFound();
		}
		if (segments.length === 3) {
			return method === "GET" ? showAgentRoute(deps, agentId) : notFound();
		}
		if (segments.length === 4 && method === "POST") {
			if (segments[3] === "preview") {
				return previewRoute(deps, agentId, bodyText);
			}
			if (segments[3] === "commit") {
				return commitRoute(deps, agentId, bodyText);
			}
		}
		return notFound();
	}
	if (segments[1] === "config" && segments[2] === "revisions") {
		if (segments.length === 3) {
			return method === "GET" ? listRevisionsRoute(deps, search) : notFound();
		}
		const revisionId = segments[3];
		if (
			segments.length === 5 &&
			segments[4] === "diff" &&
			method === "GET" &&
			revisionId !== undefined
		) {
			return diffRoute(deps, revisionId);
		}
		return notFound();
	}
	return notFound();
}
