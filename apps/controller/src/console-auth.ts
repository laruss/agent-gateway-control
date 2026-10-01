import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// HTTP-level session, CSRF and Origin helpers for the owner's console (ADR-025). Pure functions
// only: token generation and hashing, cookie header construction and parsing, and the Origin /
// `Sec-Fetch-Site` check that guards login and every mutation. `console-server.ts` is the only
// caller; it owns the database-backed session lifecycle (`@agent-gateway/core`'s
// `console-sessions.ts`) and the request routing that ties these together.
// ---------------------------------------------------------------------------

/** `__Host-` (RFC 6265bis): the browser enforces `Secure`, `Path=/` and no `Domain` attribute
 * itself, so a misconfigured cookie is simply refused rather than silently weakened. */
export const SESSION_COOKIE_NAME = "__Host-gw_session";

/** The name of the mutation header carrying the raw CSRF token (ADR-025's double-submit check). */
export const CSRF_HEADER_NAME = "x-csrf-token";

const TOKEN_BYTES = 32;

/** A fresh, unguessable token: used for both the session cookie's value and the CSRF token
 * returned in a login/session response body — the same shape, two different purposes. */
export function randomSessionToken(): string {
	return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** sha256 hex digest: the only form a session or CSRF token is ever stored in. */
export function hashSessionToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

function timingSafeStringEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a, "utf8");
	const bufB = Buffer.from(b, "utf8");
	return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * The CSRF token for one session, derived from its own raw session token rather than stored
 * anywhere: `base64url(HMAC-SHA256(key, "console-csrf:" + rawSessionToken))`. Deterministic for
 * the same session token and key, so every tab holding the same session cookie derives the same
 * value — unlike the rotating, server-stored token this replaces, opening or reloading a second
 * tab never invalidates another tab's copy. `key` is the controller's routing-key secret
 * (`GATEWAY_ROUTING_KEY`, read again for this derivation domain; see ADR-025): reusing it avoids
 * a secret file of its own, and the `"console-csrf:"` label keeps this derivation's input shape
 * (a plain prefixed string) from ever colliding with the routing signature's own input (a
 * canonical JSON object, `routing-props.ts`), which also never reaches the key under a
 * `"console-csrf:"`-prefixed input.
 */
export function deriveCsrfToken(key: string, rawSessionToken: string): string {
	return createHmac("sha256", key)
		.update(`console-csrf:${rawSessionToken}`, "utf8")
		.digest("base64url");
}

/** True when `header` is exactly the session's derived CSRF token. `null`/empty never matches. */
export function csrfTokenMatches(header: string | null, expected: string): boolean {
	if (header === null || header === "") {
		return false;
	}
	return timingSafeStringEqual(header, expected);
}

/** Reads one cookie by name from a `Cookie` request header; `null` if absent or there is none. */
export function parseCookieHeader(header: string | null, name: string): string | null {
	if (header === null) {
		return null;
	}
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator < 0) {
			continue;
		}
		if (part.slice(0, separator).trim() === name) {
			return part.slice(separator + 1).trim();
		}
	}
	return null;
}

/** The `Set-Cookie` header that establishes a session: host-only, HTTP-only, sent only over TLS
 * and only back to this origin's own requests (never a cross-site navigation or subrequest). */
export function sessionCookieHeader(token: string, maxAgeSeconds: number): string {
	return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Strict`;
}

/** The `Set-Cookie` header that clears the session cookie on logout. */
export function clearedSessionCookieHeader(): string {
	return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
}

/**
 * Exact `Origin` match plus, when the browser sends it, `Sec-Fetch-Site: same-origin` (ADR-025):
 * required on login (blocking cross-site login CSRF) and on every mutation. Never derived from
 * `X-Forwarded-*`: those name the edge proxy's own view of the request, not an authenticated
 * claim about where it actually came from.
 */
export function originAllowed(request: Request, configuredOrigin: string): boolean {
	if (request.headers.get("origin") !== configuredOrigin) {
		return false;
	}
	const secFetchSite = request.headers.get("sec-fetch-site");
	return secFetchSite === null || secFetchSite === "same-origin";
}

const ORIGIN_SHAPE = /^https?:\/\/[^/]+$/;

/** Validates `CONSOLE_ORIGIN` at startup: a value that could never equal a browser's `Origin`
 * header (no scheme, a path, a trailing slash) is a configuration error, not a setting the
 * listener silently starts with anyway and then rejects every login and mutation against. */
export function assertConsoleOrigin(value: string): string {
	if (!ORIGIN_SHAPE.test(value)) {
		throw new Error(
			`CONSOLE_ORIGIN '${value}' must be an origin like 'https://gateway.local' (scheme and host, no path)`,
		);
	}
	return value;
}
