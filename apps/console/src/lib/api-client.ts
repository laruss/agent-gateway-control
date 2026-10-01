import {
	type ConsoleAgentDetailResponse,
	ConsoleAgentDetailResponseSchema,
	type ConsoleAgentListResponse,
	ConsoleAgentListResponseSchema,
	type ConsoleCommitRequest,
	ConsoleCommitResponseSchema,
	type ConsolePreviewRequest,
	type ConsolePreviewResponse,
	ConsolePreviewResponseSchema,
	type ConsoleRevisionDiffResponse,
	ConsoleRevisionDiffResponseSchema,
	type ConsoleRevisionListResponse,
	ConsoleRevisionListResponseSchema,
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

async function request(path: string, init: RequestInit = {}): Promise<Response> {
	const method = (init.method ?? "GET").toUpperCase();
	const headers = new Headers(init.headers);
	if (method !== "GET" && method !== "HEAD" && csrfToken !== null) {
		headers.set(CSRF_HEADER, csrfToken);
	}
	return fetch(path, { ...init, method, headers, credentials: "same-origin" });
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
 * gone (401) is not an error here, since the end state — signed out — is what was asked for. */
export async function signOut(): Promise<void> {
	const response = await request("/api/session", { method: "DELETE" });
	setCsrfToken(null);
	if (response.status !== 204 && response.status !== 401) {
		throw new ApiError(response.status, await bodyText(response));
	}
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

export async function previewAgentChange(
	agentId: string,
	body: ConsolePreviewRequest,
): Promise<ConsolePreviewResponse> {
	const response = await request(`/api/agents/${encodeURIComponent(agentId)}/preview`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new ApiError(response.status, await bodyText(response));
	}
	return ConsolePreviewResponseSchema.parse(await response.json());
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

const ConflictBodySchema = z.strictObject({
	error: z.string(),
	currentRevisionId: z.int().positive().nullable(),
});
const InvalidBodySchema = z.strictObject({
	error: z.string(),
	problems: z.array(z.string()),
});

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
