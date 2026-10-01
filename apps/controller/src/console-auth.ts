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

/** The literal shape a `CONSOLE_ORIGIN` value must have before it is handed to `URL` for parsing:
 * `scheme://host[:port]` only, nothing else. Excluding `/`, `?`, `#` and `@` up front rejects a
 * path, a query, a fragment and userinfo in one step; it also catches a trailing slash, which the
 * `URL` parser alone could not — `new URL("https://gateway.local")` and
 * `new URL("https://gateway.local/")` parse to the same `pathname` ("/", a special scheme's
 * default), so they are otherwise indistinguishable after the fact. */
const ORIGIN_SHAPE = /^https?:\/\/[^/?#@]+$/;

/** The only hosts an `http:` `CONSOLE_ORIGIN` may name: the session cookie is `__Host-`/`Secure`
 * (ADR-025) and so needs TLS in every other case, but a loopback origin is never carried over the
 * network regardless of scheme, which is what a local `console:dev` setup (Vite's own dev server,
 * `http://localhost:5173`) relies on. */
const HTTP_ORIGIN_ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1"]);

function invalidConsoleOrigin(value: string): Error {
	return new Error(
		`CONSOLE_ORIGIN '${value}' must be an origin like 'https://gateway.local' (scheme and host, no path)`,
	);
}

/**
 * Validates `CONSOLE_ORIGIN` at startup and canonicalizes it to the exact form a browser's
 * `Origin` header takes, so `originAllowed`'s later exact-string comparison actually matches one:
 * parsed with `URL`, whose `origin` serialization drops a default port (`:443` on `https:`, `:80`
 * on `http:`) a browser never sends either. A value that could never equal a browser's `Origin`
 * header in the first place (no scheme, a path, a query, a fragment, userinfo, a trailing slash)
 * is a configuration error, not a setting the listener silently starts with anyway and then
 * rejects every login and mutation against. An `http:` origin is refused unless its host is a
 * loopback address — the session cookie needs TLS everywhere else, and a misconfigured `http://`
 * pointed at a real host would otherwise carry it in the clear.
 */
export function assertConsoleOrigin(value: string): string {
	if (!ORIGIN_SHAPE.test(value)) {
		throw invalidConsoleOrigin(value);
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw invalidConsoleOrigin(value);
	}
	// Defends against a special scheme's own backslash-as-slash normalization (`URL` treats
	// `https://host\path` the same as `https://host/path`), which `ORIGIN_SHAPE` alone would not
	// catch since it only excludes forward slashes.
	if (
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw invalidConsoleOrigin(value);
	}
	if (url.protocol === "http:" && !HTTP_ORIGIN_ALLOWED_HOSTS.has(url.hostname)) {
		throw new Error(
			`CONSOLE_ORIGIN '${value}' must use 'https:' (the session cookie is '__Host-'/Secure); ` +
				"'http:' is only allowed for 'http://localhost' or 'http://127.0.0.1'",
		);
	}
	return url.origin;
}
