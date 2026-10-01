import { type ConsoleSnapshot, ConsoleSnapshotSchema } from "@agent-gateway/contracts";
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
