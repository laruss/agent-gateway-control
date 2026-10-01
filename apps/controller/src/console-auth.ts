import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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

/** True when `header` is the raw CSRF token whose hash is `storedHash`. `null`/empty is never a
 * match, even against an (impossible) empty stored hash. */
export function csrfTokenMatches(header: string | null, storedHash: string): boolean {
	if (header === null || header === "") {
		return false;
	}
	return timingSafeStringEqual(hashSessionToken(header), storedHash);
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
