import {
	type ConsoleAgentChannelsResponse,
	ConsoleAgentChannelsResponseSchema,
	type ConsoleAgentCreateRequest,
	ConsoleAgentCreateResponseSchema,
	type ConsoleAgentDetailResponse,
	ConsoleAgentDetailResponseSchema,
	type ConsoleAgentLifecycleResponse,
	ConsoleAgentLifecycleResponseSchema,
	type ConsoleAgentListResponse,
	ConsoleAgentListResponseSchema,
	type ConsoleAgentRestoreRequest,
	ConsoleAgentRestoreResponseSchema,
	type ConsoleAgentRetireRequest,
	ConsoleAgentRetireResponseSchema,
	type ConsoleAgentRetryRequest,
	ConsoleAgentRetryResponseSchema,
	type ConsoleCommitRequest,
	ConsoleCommitResponseSchema,
	type ConsolePreviewRequest,
	type ConsolePreviewResponse,
	ConsolePreviewResponseSchema,
	type ConsoleRevisionDiffResponse,
	ConsoleRevisionDiffResponseSchema,
	type ConsoleRevisionListResponse,
	ConsoleRevisionListResponseSchema,
	ConsoleRevokeGrantResponseSchema,
	type ConsoleSnapshot,
	ConsoleSnapshotSchema,
} from "@agent-gateway/contracts";
import { z } from "zod";

// ---------------------------------------------------------------------------
// A small typed fetch wrapper around the console's own API (ADR-025): every request is
// same-origin with `credentials: "same-origin"` (no cross-origin call is ever made, and no
// cookie is ever sent anywhere else); every non-GET request carries the current CSRF token,
// held only in memory (never `localStorage`, never a cookie this script can read — the session
// cookie itself is `HttpOnly`). Every response this module hands back has already been parsed
// against a Zod schema, never trusted as shaped JSON on the caller's say-so.
// ---------------------------------------------------------------------------

const CSRF_HEADER = "X-CSRF-Token";

/** The CSRF token the last successful login or session check returned; `null` before either has
 * happened, or after sign-out. Module-level, not React state: it is transport plumbing, not
 * something a render ever needs to react to. */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
	csrfToken = token;
}

/** The token currently held, for a caller that needs to capture it at a specific moment (the
 * session layer's own startup-race guard, `session-context.tsx`) rather than only ever setting
 * it. */
export function getCsrfToken(): string | null {
	return csrfToken;
}

/** Registered once, by `SessionProvider`: every request below reports a `401` here the same way
 * `useConsoleStatus` already reports its own to the session layer, so every other query (the
 * Agents hub's list, its editor, its preview/commit calls) falls back to the sign-in screen
 * together instead of each one needing its own `isUnauthorized`/`reportUnauthorized` wiring. */
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
	unauthorizedHandler = handler;
}

/** Bumped on every sign-in and sign-out. A request records the generation it started under
 * (`request`, below) and reports a `401` only if that generation is still the current one: a
 * request begun under an old session that resolves after a newer sign-in already succeeded (slow
 * network, a tab left open) must not sign the fresh session back out. */
let sessionGeneration = 0;

/** What a failed request becomes for every caller: an HTTP status, the server's own (bounded)
 * body text, and which of the console's own documented cases it falls into, so a caller can
 * show the right thing — sign in again, a clear "forbidden"/"conflict" message, or a generic
 * failure — without re-deriving it from the status code itself. */
export class ApiError extends Error {
	readonly status: number;
	readonly kind: "unauthorized" | "forbidden" | "conflict" | "rate-limited" | "busy" | "error";

	constructor(status: number, body: string) {
		super(body.length > 0 ? body : `request failed with status ${status}`);
		this.name = "ApiError";
		this.status = status;
		this.kind =
			status === 401
				? "unauthorized"
				: status === 403
					? "forbidden"
					: status === 409
						? "conflict"
						: status === 429
							? "rate-limited"
							: status === 503
								? "busy"
								: "error";
	}
}

async function bodyText(response: Response): Promise<string> {
	try {
		// Error bodies are always small (plain-text status words, ADR-025); still bounded in case a
		// future route grows a larger one.
		const text = await response.text();
		return text.slice(0, 2000);
	} catch {
		return "";
	}
}

function rawRequest(path: string, init: RequestInit, method: string): Promise<Response> {
	const headers = new Headers(init.headers);
	if (method !== "GET" && method !== "HEAD" && csrfToken !== null) {
		headers.set(CSRF_HEADER, csrfToken);
	}
	return fetch(path, { ...init, method, headers, credentials: "same-origin" });
}

/**
 * Every call in this module goes through here. Two cross-cutting concerns beyond attaching the
 * CSRF header (`rawRequest`):
 *
 * - A mutation refused with `403 "... CSRF token"` (another tab signed in anew since this one
 *   captured its token, or the controller's routing key rotated) refreshes the token from a
 *   session check and retries the same request exactly once; a session check that itself fails,
 *   or a 403 still there after the retry, hands back the original/retried response as-is — never
 *   a second retry.
 * - A final `401` (this session is no longer valid) reports to {@link setUnauthorizedHandler}'s
 *   handler, so the whole app falls back to the sign-in screen together — but only if this
 *   request's own session generation (captured before the fetch) is still current: a 401 that
 *   arrives after a newer sign-in or sign-out must not act on a session that already moved on.
 */
async function request(path: string, init: RequestInit = {}): Promise<Response> {
	const generation = sessionGeneration;
	const method = (init.method ?? "GET").toUpperCase();
	let response = await rawRequest(path, init, method);
	if (method !== "GET" && method !== "HEAD" && response.status === 403) {
		const text = (await response.clone().text()).toLowerCase();
		if (text.includes("csrf")) {
			try {
				await checkSession();
				response = await rawRequest(path, init, method);
			} catch {
				// Could not even refresh the session check (a network failure, say); the original 403
				// is still the most accurate answer to hand back.
			}
		}
	}
	if (response.status === 401 && generation === sessionGeneration) {
		unauthorizedHandler?.();
	}
	return response;
}

const SessionCheckSchema = z.discriminatedUnion("authenticated", [
	z.strictObject({
		authenticated: z.literal(true),
		csrfToken: z.string().min(1),
		expiresAt: z.iso.datetime({ offset: true }),
	}),
	z.strictObject({ authenticated: z.literal(false) }),
]);
export type SessionCheck = z.infer<typeof SessionCheckSchema>;

/** `GET /api/session`: never itself a 401 (ADR-025) — an absent or invalid cookie is a normal
 * `{authenticated: false}` body, not an error. Rotates and captures a fresh CSRF token whenever
 * it reports `authenticated: true`, which is how a reloaded tab recovers one. */
export async function checkSession(): Promise<SessionCheck> {
	const response = await request("/api/session");
	if (!response.ok) {
		throw new ApiError(response.status, await bodyText(response));
	}
	const check = SessionCheckSchema.parse(await response.json());
	setCsrfToken(check.authenticated ? check.csrfToken : null);
	return check;
}

const LoginSuccessSchema = z.strictObject({
	csrfToken: z.string().min(1),
	expiresAt: z.iso.datetime({ offset: true }),
});

export type SignInOutcome =
	| Readonly<{ kind: "ok"; expiresAt: string }>
	| Readonly<{ kind: "invalid" }>
	| Readonly<{ kind: "rate-limited"; retryAfterSeconds: number | null }>
	| Readonly<{ kind: "busy" }>
	| Readonly<{ kind: "forbidden" }>;

/** `POST /api/session`. Every outcome ADR-025 documents is a case here, not an exception: only a
 * genuinely unexpected status throws. */
export async function signIn(password: string): Promise<SignInOutcome> {
	const response = await request("/api/session", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password }),
	});
	if (response.status === 200) {
		const body = LoginSuccessSchema.parse(await response.json());
		setCsrfToken(body.csrfToken);
		sessionGeneration += 1;
		return { kind: "ok", expiresAt: body.expiresAt };
	}
	if (response.status === 401) {
		return { kind: "invalid" };
	}
	if (response.status === 403) {
		return { kind: "forbidden" };
	}
	if (response.status === 429) {
		const header = response.headers.get("retry-after");
		const seconds = header === null ? null : Number(header);
		return {
			kind: "rate-limited",
			retryAfterSeconds: Number.isFinite(seconds) ? seconds : null,
		};
	}
	if (response.status === 503) {
		return { kind: "busy" };
	}
	throw new ApiError(response.status, await bodyText(response));
}

/** `DELETE /api/session`. Idempotent from the caller's point of view: a session that is already
 * gone (401) is not an error here, since the end state — signed out — is what was asked for. The
 * token is cleared only once the session actually is gone (204 or 401): a 403/5xx leaves the
 * session (and so the token that is still good for it) exactly as it was, the same way
 * `SessionProvider` leaves its own state alone on anything but those two statuses. */
export async function signOut(): Promise<void> {
	const response = await request("/api/session", { method: "DELETE" });
	if (response.status === 204 || response.status === 401) {
		setCsrfToken(null);
		sessionGeneration += 1;
		return;
	}
	throw new ApiError(response.status, await bodyText(response));
}

/** `GET /api/status`: a 401 is a real error here (unlike the session check) — it means whatever
 * session this tab thought it had is no longer valid, and the caller should fall back to
 * sign-in. A `503` still carries a parseable `ConsoleSnapshot` body (`state: "unavailable"`, see
 * `console-status.ts`), so it is parsed the same way as a `200`, not treated as a transport
 * failure. */
export async function fetchConsoleStatus(): Promise<ConsoleSnapshot> {
	const response = await request("/api/status");
	if (response.status === 401) {
		throw new ApiError(401, await bodyText(response));
	}
	if (!response.ok && response.status !== 503) {
		throw new ApiError(response.status, await bodyText(response));
	}
	return ConsoleSnapshotSchema.parse(await response.json());
}

// ---------------------------------------------------------------------------
// The Agents hub (ADR-025): every route here needs a signed-in session (a 401 is a real error,
// same as `fetchConsoleStatus`), and every mutation carries the CSRF header automatically
// (`request`, above). `preview` never fails with a "the change is invalid" outcome of its own —
// `ConsolePreviewResponse.problems` carries that instead, for the caller to show inline — so only
// a transport-level failure (401, a shape error the server itself could not have sent for a
// well-formed request, 5xx) throws `ApiError` here.
// ---------------------------------------------------------------------------

export async function fetchAgentsList(): Promise<ConsoleAgentListResponse> {
	const response = await request("/api/agents");
	if (!response.ok) {
		throw new ApiError(response.status, await bodyText(response));
	}
	return ConsoleAgentListResponseSchema.parse(await response.json());
}

export async function fetchAgentDetail(agentId: string): Promise<ConsoleAgentDetailResponse> {
	const response = await request(`/api/agents/${encodeURIComponent(agentId)}`);
	if (!response.ok) {
		throw new ApiError(response.status, await bodyText(response));
	}
	return ConsoleAgentDetailResponseSchema.parse(await response.json());
}

const ConflictBodySchema = z.strictObject({
	error: z.string(),
	currentRevisionId: z.int().positive().nullable(),
});
const InvalidBodySchema = z.strictObject({
	error: z.string(),
	problems: z.array(z.string()),
});

/** `POST /api/agents/:id/preview`'s own documented outcomes (ADR-025): `conflict` (409) means
 * `baseRevisionId` is not the revision actually active right now — the editor's own loaded view,
 * never silently computed against the live state in its place — and is a case the review dialog
 * reacts to directly (the same "reload and try again" state a 409 from `commit` shows), never a
 * generic `ApiError`. */
export type PreviewAgentOutcome =
	| Readonly<{ kind: "ok"; preview: ConsolePreviewResponse }>
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>;

export async function previewAgentChange(
	agentId: string,
	body: ConsolePreviewRequest,
	signal?: AbortSignal,
): Promise<PreviewAgentOutcome> {
	const response = await request(`/api/agents/${encodeURIComponent(agentId)}/preview`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		...(signal === undefined ? {} : { signal }),
	});
	if (response.status === 409) {
		const parsed = ConflictBodySchema.parse(await response.json());
		return { kind: "conflict", currentRevisionId: parsed.currentRevisionId };
	}
	if (!response.ok) {
		throw new ApiError(response.status, await bodyText(response));
	}
	return { kind: "ok", preview: ConsolePreviewResponseSchema.parse(await response.json()) };
}

/** `POST /api/agents/:id/commit`'s own documented outcomes (ADR-025): `conflict` (409, a stale
 * base revision) and `invalid` (422, a business-rule problem only visible at commit time) are
 * cases the editor's save flow reacts to directly, never generic `ApiError`s — only an
 * unexpected status (401, a malformed request the preview step should already have caught, 5xx)
 * throws. */
export type CommitAgentOutcome =
	| Readonly<{
			kind: "ok";
			revisionId: number;
			hash: string;
			noop: boolean;
			replayed: boolean;
			activeRevisionId: number | null;
	  }>
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>;

export async function commitAgentChange(
	agentId: string,
	body: ConsoleCommitRequest,
): Promise<CommitAgentOutcome> {
	const response = await request(`/api/agents/${encodeURIComponent(agentId)}/commit`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (response.status === 409) {
		const parsed = ConflictBodySchema.parse(await response.json());
		return { kind: "conflict", currentRevisionId: parsed.currentRevisionId };
	}
	if (response.status === 422) {
		const parsed = InvalidBodySchema.parse(await response.json());
		return { kind: "invalid", problems: parsed.problems };
	}
	if (!response.ok) {
		throw new ApiError(response.status, await bodyText(response));
	}
	const data = ConsoleCommitResponseSchema.parse(await response.json());
	return { kind: "ok", ...data };
}

export async function fetchConfigRevisions(limit: number): Promise<ConsoleRevisionListResponse> {
	const response = await request(`/api/config/revisions?limit=${limit}`);
	if (!response.ok) {
		throw new ApiError(response.status, await bodyText(response));
	}
	return ConsoleRevisionListResponseSchema.parse(await response.json());
}

export async function fetchConfigRevisionDiff(
	revisionId: number,
): Promise<ConsoleRevisionDiffResponse> {
	const response = await request(`/api/config/revisions/${revisionId}/diff`);
	if (!response.ok) {
		throw new ApiError(response.status, await bodyText(response));
	}
	return ConsoleRevisionDiffResponseSchema.parse(await response.json());
}

// ---------------------------------------------------------------------------
// Lifecycle (ADR-026): create, retry, retire, restore; an agent's own status and operation
// journal; its channel assignments with provenance, and revoking one directly. `conflict`/
// `invalid` are typed outcomes the caller reacts to directly, the same convention
// `previewAgentChange`/`commitAgentChange` already use — only a transport-level failure throws.
// ---------------------------------------------------------------------------

export type CreateAgentOutcome =
	| Readonly<{ kind: "ok"; agentId: string; operationId: string; revisionId: number }>
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>;

export async function createAgent(body: ConsoleAgentCreateRequest): Promise<CreateAgentOutcome> {
	const response = await request("/api/agents", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (response.status === 409) {
		const parsed = ConflictBodySchema.parse(await response.json());
		return { kind: "conflict", currentRevisionId: parsed.currentRevisionId };
	}
	if (response.status === 422) {
		const parsed = InvalidBodySchema.parse(await response.json());
		return { kind: "invalid", problems: parsed.problems };
	}
	if (!response.ok) {
		throw new ApiError(response.status, await bodyText(response));
	}
	const data = ConsoleAgentCreateResponseSchema.parse(await response.json());
	return { kind: "ok", ...data };
}

export type RetireAgentOutcome =
	| Readonly<{ kind: "ok"; operationId: string; revisionId: number }>
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>;

export async function retireAgent(
	agentId: string,
	body: ConsoleAgentRetireRequest,
): Promise<RetireAgentOutcome> {
	const response = await request(`/api/agents/${encodeURIComponent(agentId)}/retire`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (response.status === 409) {
		const parsed = ConflictBodySchema.parse(await response.json());
		return { kind: "conflict", currentRevisionId: parsed.currentRevisionId };
	}
	if (response.status === 422) {
		const parsed = InvalidBodySchema.parse(await response.json());
		return { kind: "invalid", problems: parsed.problems };
	}
	if (!response.ok) {
		throw new ApiError(response.status, await bodyText(response));
	}
	const data = ConsoleAgentRetireResponseSchema.parse(await response.json());
	return { kind: "ok", ...data };
}

export type RestoreAgentOutcome =
	| Readonly<{ kind: "ok"; operationId: string; revisionId: number }>
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>;

export async function restoreAgent(
	agentId: string,
	body: ConsoleAgentRestoreRequest,
): Promise<RestoreAgentOutcome> {
	const response = await request(`/api/agents/${encodeURIComponent(agentId)}/restore`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (response.status === 409) {
		const parsed = ConflictBodySchema.parse(await response.json());
		return { kind: "conflict", currentRevisionId: parsed.currentRevisionId };
	}
	if (response.status === 422) {
		const parsed = InvalidBodySchema.parse(await response.json());
		return { kind: "invalid", problems: parsed.problems };
	}
	if (!response.ok) {
		throw new ApiError(response.status, await bodyText(response));
	}
	const data = ConsoleAgentRestoreResponseSchema.parse(await response.json());
	return { kind: "ok", ...data };
}

export type RetryOperationOutcome =
	| Readonly<{ kind: "ok"; operationId: string; operationKind: string }>
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>;

export async function retryOperation(
	agentId: string,
	body: ConsoleAgentRetryRequest,
): Promise<RetryOperationOutcome> {
	const response = await request(`/api/agents/${encodeURIComponent(agentId)}/retry`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (response.status === 409) {
		const parsed = ConflictBodySchema.parse(await response.json());
		return { kind: "conflict", currentRevisionId: parsed.currentRevisionId };
	}
	if (response.status === 422) {
		const parsed = InvalidBodySchema.parse(await response.json());
		return { kind: "invalid", problems: parsed.problems };
	}
	if (!response.ok) {
		throw new ApiError(response.status, await bodyText(response));
	}
	const data = ConsoleAgentRetryResponseSchema.parse(await response.json());
	return { kind: "ok", operationId: data.operationId, operationKind: data.kind };
}

/** `GET /api/agents/:id/lifecycle`: null for a 404 (no `agent_lifecycle` row at all), never
 * thrown — an agent list entry always has one, so this is only reachable from a stale link. */
export async function fetchAgentLifecycle(
	agentId: string,
): Promise<ConsoleAgentLifecycleResponse | null> {
	const response = await request(`/api/agents/${encodeURIComponent(agentId)}/lifecycle`);
	if (response.status === 404) {
		return null;
	}
	if (!response.ok) {
		throw new ApiError(response.status, await bodyText(response));
	}
	return ConsoleAgentLifecycleResponseSchema.parse(await response.json());
}

export async function fetchAgentChannels(agentId: string): Promise<ConsoleAgentChannelsResponse> {
	const response = await request(`/api/agents/${encodeURIComponent(agentId)}/channels`);
	if (!response.ok) {
		throw new ApiError(response.status, await bodyText(response));
	}
	return ConsoleAgentChannelsResponseSchema.parse(await response.json());
}

export async function revokeAgentChannelGrant(agentId: string, channelId: string) {
	const response = await request(`/api/agents/${encodeURIComponent(agentId)}/channels/revoke`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ channelId }),
	});
	if (!response.ok) {
		throw new ApiError(response.status, await bodyText(response));
	}
	return ConsoleRevokeGrantResponseSchema.parse(await response.json());
}
