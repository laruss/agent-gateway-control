import { CONSOLE_PASSWORD_HASH_SECRET_FILE } from "@agent-gateway/contracts";
import {
	CONSOLE_SESSION_MAX_ACTIVE,
	createConsoleSession,
	revokeConsoleSession,
	rotateConsoleSessionCsrf,
	touchConsoleSession,
} from "@agent-gateway/core";
import { errorFields, type Logger } from "@agent-gateway/logging";
import {
	consolePasswordHashFingerprint,
	readSecretFile,
	resolveSecretPath,
	SettingError,
	secretFileState,
	verifyConsolePassword,
} from "@agent-gateway/service";
import type pg from "pg";
import {
	CSRF_HEADER_NAME,
	clearedSessionCookieHeader,
	csrfTokenMatches,
	hashSessionToken,
	originAllowed,
	parseCookieHeader,
	randomSessionToken,
	SESSION_COOKIE_NAME,
	sessionCookieHeader,
} from "./console-auth.ts";
import {
	DEFAULT_CONSOLE_STATIC_DIR,
	resolveConsoleStaticRoot,
	resolveStaticFile,
	staticContentType,
} from "./console-static.ts";
import type { ConsoleSnapshot, ConsoleStatusCache } from "./console-status.ts";

// ---------------------------------------------------------------------------
// The owner's console listener (ADR-025): a separate Bun.serve, authenticated with a server-side
// session cookie and CSRF-protected mutations instead of HTTP Basic (superseding that part of
// ADR-023). `/api/session` and `/api/status` are the console's JSON surface; every other `GET`/
// `HEAD` request is the React SPA's own static assets or its SPA-fallback `index.html`
// (`console-static.ts`) — the SPA itself renders the sign-in screen or the dashboard once it
// loads, so this listener no longer distinguishes an authenticated page from an unauthenticated
// one the way the server-rendered dashboard and its stand-in login form once did. Every response
// — success, error, even a 503 for a missing build — carries the same fixed set of security
// headers.
// ---------------------------------------------------------------------------

/** Failed logins share one bounded, global counter (ADR-023), never partitioned by a
 * client-supplied address (`X-Forwarded-For` and the like are never trusted for this). */
const LOGIN_FAILURE_WINDOW_MS = 60_000;
const MAX_LOGIN_FAILURES_PER_WINDOW = 10;

/** Argon2id verification is deliberately expensive (`console-auth.ts`); this bounds how many run
 * at once, so a burst of requests cannot turn that cost into unbounded memory pressure. */
const DEFAULT_MAX_CONCURRENT_VERIFICATIONS = 4;

/** Well past the longest JSON or form body a login ever needs (a password up to 256 UTF-16
 * units, plus field overhead); a larger body is refused — before it is even read when it is
 * declared via `Content-Length`, or as soon as reading it crosses this bound otherwise. */
const MAX_LOGIN_BODY_BYTES = 4096;

/** A hard ceiling Bun itself enforces, before any handler code runs, on any body this listener
 * will ever buffer — well above {@link MAX_LOGIN_BODY_BYTES}. `readBoundedText` already aborts a
 * chunked body long before this; this is the backstop against a future route, or a defect in
 * that function, reading further than it should. */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"cache-control": "no-store",
	// The React SPA (ADR-025's frontend section): no inline script or style, no eval, nothing
	// cross-origin. `style-src 'self'` covers the SPA's own built stylesheet; Radix's inline
	// `element.style.setProperty(...)` calls are CSSOM manipulation, which `style-src` does not
	// govern (only a `style="..."` attribute or a `<style>` element would be), so they are
	// unaffected by not having `'unsafe-inline'` here. `img-src` adds `data:` for the few small
	// inlined icons a component library like this tends to carry; everything else is `'self'` or
	// `'none'`.
	"content-security-policy":
		"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
	"x-content-type-options": "nosniff",
	// `same-origin`, not `no-referrer`: per the Fetch spec, a non-GET/HEAD, non-CORS-mode request
	// (a plain HTML form POST, in particular) sends `Origin: null` whenever the referrer policy in
	// effect is `no-referrer`, or is `same-origin` and the request is cross-origin. The console's
	// own login form posts to its own origin, so `same-origin` keeps that real Origin header on
	// the wire (`originAllowed` below needs it) while still sending no referrer at all, and no
	// Origin, to anything cross-site.
	"referrer-policy": "same-origin",
	"x-frame-options": "DENY",
};

function respond(
	body: string,
	status: number,
	contentType: string,
	headers: Readonly<Record<string, string>> = {},
): Response {
	return new Response(body, {
		status,
		headers: { ...SECURITY_HEADERS, "content-type": contentType, ...headers },
	});
}

const textResponse = (
	body: string,
	status: number,
	headers: Readonly<Record<string, string>> = {},
) => respond(body, status, "text/plain; charset=utf-8", headers);
const jsonResponse = (
	value: unknown,
	status: number,
	headers: Readonly<Record<string, string>> = {},
) => respond(JSON.stringify(value), status, "application/json; charset=utf-8", headers);

const unauthenticated = () => textResponse("unauthorized", 401);
const forbidden = (message: string) => textResponse(message, 403);
const badRequest = (message: string) => textResponse(message, 400);

function tooManyRequests(waitMs: number): Response {
	const seconds = Math.max(1, Math.ceil(waitMs / 1000));
	return textResponse("too many attempts", 429, {
		"retry-after": String(seconds),
	});
}

function payloadTooLarge(): Response {
	return textResponse("payload too large", 413);
}

function serviceBusy(): Response {
	return textResponse("busy", 503, { "retry-after": "1" });
}

/**
 * Reads and validates the console's password hash: the file must exist, be private (mode 0600,
 * not a symlink, not group/world readable) and non-empty. Anything else is a fail-closed
 * configuration error rather than a listener that would otherwise start unauthenticated or
 * reject to a stale/garbled hash silently.
 */
export function resolveConsolePasswordHash(secretsDir?: string): string {
	const path = resolveSecretPath(CONSOLE_PASSWORD_HASH_SECRET_FILE, secretsDir);
	const state = secretFileState(path);
	if (state !== "private") {
		const reason = state === "missing" ? "is missing" : `is ${state} (must be private, mode 0600)`;
		throw new SettingError(
			`console password hash '${path}' ${reason}; run 'gateway console password set' first`,
		);
	}
	return readSecretFile(path);
}

type BoundedBody = Readonly<{ ok: true; text: string }> | Readonly<{ ok: false }>;

/**
 * Reads a request body as UTF-8 text, refusing it (`{ ok: false }`) before or after reading when
 * it exceeds `maxBytes`: by its declared `Content-Length` if present, before a byte is read, and
 * otherwise by the bytes actually read off `request.body` as they arrive. A chunked request
 * carries no `Content-Length` at all, so that case is read incrementally and its reader
 * cancelled the moment the running total exceeds `maxBytes` — never buffered in full first, the
 * way `request.text()` would.
 */
async function readBoundedText(request: Request, maxBytes: number): Promise<BoundedBody> {
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		const length = Number(declared);
		if (!Number.isFinite(length) || length > maxBytes) {
			return { ok: false };
		}
	}
	const body = request.body;
	if (body === null) {
		return { ok: true, text: "" };
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel("body too large");
			return { ok: false };
		}
		chunks.push(value);
	}
	return { ok: true, text: Buffer.concat(chunks, total).toString("utf8") };
}

/** `{"password": "..."}`; anything else (malformed JSON, a missing or non-string field) is not a
 * credential, not a crash: `null`. */
function passwordFromJson(text: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return null;
	}
	const password = (parsed as Record<string, unknown>).password;
	return typeof password === "string" ? password : null;
}

/** A bounded gate on concurrent Argon2id verifications: over the limit, `run` returns `"busy"`
 * immediately rather than queueing (queueing would just move the same memory pressure into a
 * backlog instead of bounding it). */
function createVerificationGate(limit: number) {
	let inFlight = 0;
	return {
		async run<T>(work: () => Promise<T>): Promise<T | "busy"> {
			if (inFlight >= limit) {
				return "busy";
			}
			inFlight += 1;
			try {
				return await work();
			} finally {
				inFlight -= 1;
			}
		},
	};
}

/** The global failed-login counter: a sliding window over `LOGIN_FAILURE_WINDOW_MS`, never keyed
 * by any per-client identity. */
function createLoginLimiter(clock: () => Date) {
	let failures: number[] = [];
	return {
		/** Milliseconds until a slot frees up, or `null` when a login attempt may proceed. */
		blockedFor(): number | null {
			const now = clock().getTime();
			failures = failures.filter((at) => now - at < LOGIN_FAILURE_WINDOW_MS);
			const oldest = failures[0];
			if (failures.length < MAX_LOGIN_FAILURES_PER_WINDOW || oldest === undefined) {
				return null;
			}
			return Math.max(0, LOGIN_FAILURE_WINDOW_MS - (now - oldest));
		},
		recordFailure(): void {
			failures.push(clock().getTime());
		},
	};
}

export type ConsoleServerOptions = Readonly<{
	port: number;
	hostname: string;
	/** Already read and validated (`resolveConsolePasswordHash`); never re-read per request, the
	 * same choice `gateway console password set` documents ("restart ... to apply it"). */
	passwordHash: string;
	/** The exact `Origin` every login and mutation must carry (ADR-025), e.g.
	 * `https://gateway.local` — `assertConsoleOrigin` in the caller validates its shape. */
	origin: string;
	/** Where `console_sessions` rows live; this listener is the only writer and reader of them. */
	pool: pg.Pool;
	cache: ConsoleStatusCache;
	log: Logger;
	/** The built console SPA's own directory (`vite build`'s `dist`); defaults to the path the
	 * release image bakes it into. A missing or incomplete build is logged once and served as a
	 * plain 503 for the UI only — `/api/*` is unaffected. */
	staticDir?: string;
	clock?: () => Date;
	maxConcurrentVerifications?: number;
	/** Active sessions kept at once; the oldest beyond this are revoked on the next login. */
	maxActiveSessions?: number;
	/** Overrides `verifyConsolePassword` for tests only; production always uses the real one. */
	verifyPassword?: (password: string, hash: string) => Promise<boolean>;
}>;

export type RunningConsoleServer = Readonly<{
	port: number;
	stop: () => Promise<void>;
}>;

type LoginOutcome =
	| Readonly<{ kind: "ok"; token: string; csrfToken: string; expiresAt: Date }>
	| Readonly<{ kind: "invalid" }>
	| Readonly<{ kind: "rate-limited"; waitMs: number }>
	| Readonly<{ kind: "busy" }>;

type AuthenticatedSession = Readonly<{
	id: string;
	csrfTokenHash: string;
	expiresAt: Date;
}>;

/**
 * Starts the owner's console listener. `/api/status` serves the projection as JSON, `/api/session`
 * the session lifecycle; every route but login and the session check requires an authenticated
 * session, and every mutation additionally requires the exact configured Origin and a matching
 * CSRF header. Every other `GET`/`HEAD` request serves the built SPA (`console-static.ts`): its
 * own `assets/*`, or `index.html` as the fallback for any other path — the SPA decides for
 * itself, once loaded, whether to show the sign-in screen or the dashboard.
 */
export function startConsoleServer(options: ConsoleServerOptions): RunningConsoleServer {
	const clock = options.clock ?? (() => new Date());
	const verify = options.verifyPassword ?? verifyConsolePassword;
	const gate = createVerificationGate(
		options.maxConcurrentVerifications ?? DEFAULT_MAX_CONCURRENT_VERIFICATIONS,
	);
	const limiter = createLoginLimiter(clock);
	const fingerprint = consolePasswordHashFingerprint(options.passwordHash);
	const maxActiveSessions = options.maxActiveSessions ?? CONSOLE_SESSION_MAX_ACTIVE;
	const staticRoot = resolveConsoleStaticRoot(options.staticDir ?? DEFAULT_CONSOLE_STATIC_DIR);
	if (staticRoot.kind === "missing") {
		options.log.error("console UI assets are missing; serving a plain 503 for the UI only", {
			configuredDir: staticRoot.configuredDir,
		});
	}

	async function attemptLogin(password: string): Promise<LoginOutcome> {
		const blockedMs = limiter.blockedFor();
		if (blockedMs !== null) {
			return { kind: "rate-limited", waitMs: blockedMs };
		}
		const verified = await gate.run(() => verify(password, options.passwordHash));
		if (verified === "busy") {
			return { kind: "busy" };
		}
		if (!verified) {
			limiter.recordFailure();
			return { kind: "invalid" };
		}
		// A fresh token is always minted here; nothing about the request (including any cookie it
		// already carries) is ever consulted, which is what rules out session fixation.
		const token = randomSessionToken();
		const csrfToken = randomSessionToken();
		const created = await createConsoleSession(
			options.pool,
			{
				tokenHash: hashSessionToken(token),
				csrfTokenHash: hashSessionToken(csrfToken),
				passwordHashFingerprint: fingerprint,
			},
			clock(),
			maxActiveSessions,
		);
		return { kind: "ok", token, csrfToken, expiresAt: created.expiresAt };
	}

	async function authenticate(request: Request): Promise<AuthenticatedSession | null> {
		const token = parseCookieHeader(request.headers.get("cookie"), SESSION_COOKIE_NAME);
		if (token === null) {
			return null;
		}
		return touchConsoleSession(options.pool, hashSessionToken(token), clock(), fingerprint);
	}

	function sessionMaxAgeSeconds(expiresAt: Date): number {
		return Math.max(0, Math.round((expiresAt.getTime() - clock().getTime()) / 1000));
	}

	/** `public, max-age=31536000, immutable`: every file under `assets/` is named for its own
	 * content hash (`vite build`), so a given URL's bytes never change — the browser never needs
	 * to revalidate it, only ever to fetch a new URL when the content actually changes. */
	const STATIC_ASSET_CACHE = "public, max-age=31536000, immutable";

	function staticFileResponse(
		path: string,
		cacheControl: string,
		method: "GET" | "HEAD",
	): Response {
		const file = Bun.file(path);
		const headers: Record<string, string> = {
			...SECURITY_HEADERS,
			"content-type": staticContentType(path),
			"cache-control": cacheControl,
		};
		if (method === "HEAD") {
			headers["content-length"] = String(file.size);
			return new Response(null, { status: 200, headers });
		}
		return new Response(file, { status: 200, headers });
	}

	/**
	 * Every `GET`/`HEAD` request that is not `/api/*`: the SPA's own built assets
	 * (`/assets/*`, long-cached and immutable, content-hashed by `vite build`) or `index.html` as
	 * the fallback for every other path, `no-store` — deep links work because any path the SPA's
	 * own router recognizes gets the same `index.html`, which then renders the right page
	 * client-side. A missing build serves a plain 503 here only; `/api/*` is never affected.
	 */
	function handleStatic(request: Request, pathname: string): Response {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return textResponse("method not allowed", 405, { allow: "GET, HEAD" });
		}
		const method = request.method;
		if (staticRoot.kind === "missing") {
			return textResponse("console UI assets are not installed", 503);
		}
		if (pathname.startsWith("/assets/")) {
			const file = resolveStaticFile(staticRoot.root, pathname);
			if (file === null) {
				return textResponse("not found", 404);
			}
			return staticFileResponse(file, STATIC_ASSET_CACHE, method);
		}
		return staticFileResponse(staticRoot.indexHtml, "no-store", method);
	}

	async function handleStatus(request: Request): Promise<Response> {
		if (request.method !== "GET") {
			return textResponse("method not allowed", 405, { allow: "GET" });
		}
		const session = await authenticate(request);
		if (session === null) {
			return unauthenticated();
		}
		const snapshot: ConsoleSnapshot = await options.cache.get();
		const status = snapshot.state === "unavailable" ? 503 : 200;
		return jsonResponse(snapshot, status);
	}

	async function handleSession(request: Request): Promise<Response> {
		if (request.method === "GET") {
			const session = await authenticate(request);
			if (session === null) {
				return jsonResponse({ authenticated: false }, 200);
			}
			// Rotated on every check, never returned twice: the stored value is always only a hash,
			// so this is how the SPA recovers a usable CSRF token after a reload instead of the
			// server ever handing back the one it minted at login.
			const csrfToken = randomSessionToken();
			await rotateConsoleSessionCsrf(options.pool, session.id, hashSessionToken(csrfToken));
			return jsonResponse(
				{
					authenticated: true,
					csrfToken,
					expiresAt: session.expiresAt.toISOString(),
				},
				200,
			);
		}
		if (request.method === "POST") {
			if (!originAllowed(request, options.origin)) {
				return forbidden("origin not allowed");
			}
			if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
				return badRequest("expected application/json");
			}
			const bounded = await readBoundedText(request, MAX_LOGIN_BODY_BYTES);
			if (!bounded.ok) {
				return payloadTooLarge();
			}
			const password = passwordFromJson(bounded.text);
			if (password === null) {
				return badRequest("missing password");
			}
			const outcome = await attemptLogin(password);
			if (outcome.kind === "rate-limited") {
				return tooManyRequests(outcome.waitMs);
			}
			if (outcome.kind === "busy") {
				return serviceBusy();
			}
			if (outcome.kind === "invalid") {
				return jsonResponse({ error: "invalid credentials" }, 401);
			}
			return jsonResponse(
				{
					csrfToken: outcome.csrfToken,
					expiresAt: outcome.expiresAt.toISOString(),
				},
				200,
				{
					"set-cookie": sessionCookieHeader(outcome.token, sessionMaxAgeSeconds(outcome.expiresAt)),
				},
			);
		}
		if (request.method === "DELETE") {
			const session = await authenticate(request);
			if (session === null) {
				return unauthenticated();
			}
			if (!originAllowed(request, options.origin)) {
				return forbidden("origin not allowed");
			}
			if (!csrfTokenMatches(request.headers.get(CSRF_HEADER_NAME), session.csrfTokenHash)) {
				return forbidden("missing or invalid CSRF token");
			}
			await revokeConsoleSession(options.pool, session.id, "logout", clock());
			return respond("", 204, "text/plain; charset=utf-8", {
				"set-cookie": clearedSessionCookieHeader(),
			});
		}
		return textResponse("method not allowed", 405, {
			allow: "GET, POST, DELETE",
		});
	}

	async function handle(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === "/api/status") {
			return handleStatus(request);
		}
		if (pathname === "/api/session") {
			return handleSession(request);
		}
		if (pathname.startsWith("/api/")) {
			return textResponse("not found", 404);
		}
		return handleStatic(request, pathname);
	}

	const server = Bun.serve({
		port: options.port,
		hostname: options.hostname,
		maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
		fetch: async (request) => {
			try {
				return await handle(request);
			} catch (error) {
				// Never the request itself (and so never a password or a cookie) in the log.
				options.log.error("console request failed", errorFields(error));
				return textResponse("internal error", 500);
			}
		},
	});
	return {
		port: server.port ?? options.port,
		stop: async () => {
			await server.stop(true);
		},
	};
}
