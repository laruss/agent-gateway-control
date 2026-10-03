import { CONSOLE_PASSWORD_HASH_SECRET_FILE } from "@agent-gateway/contracts";
import {
	CONSOLE_SESSION_MAX_ACTIVE,
	type ControlPlaneDeps,
	createConsoleSession,
	revokeConsoleSession,
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
import {
	CSRF_HEADER_NAME,
	clearedSessionCookieHeader,
	csrfTokenMatches,
	deriveCsrfToken,
	hashSessionToken,
	originAllowed,
	parseCookieHeader,
	randomSessionToken,
	SESSION_COOKIE_NAME,
	sessionCookieHeader,
} from "./console-auth.ts";
import {
	badRequest,
	forbidden,
	jsonResponse,
	payloadTooLarge,
	readBoundedText,
	respond,
	SECURITY_HEADERS,
	textResponse,
	unauthenticated,
} from "./console-http.ts";
import { MAX_MANAGEMENT_BODY_BYTES, routeConsoleManagement } from "./console-management.ts";
import {
	DEFAULT_CONSOLE_STATIC_DIR,
	resolveConsoleStaticRoot,
	resolveStaticFile,
	staticContentType,
} from "./console-static.ts";
import type { ConsoleSnapshot, ConsoleStatusCache } from "./console-status.ts";
import { isAgentToolsPath, routeConsoleTools } from "./console-tools.ts";

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

function tooManyRequests(waitMs: number): Response {
	const seconds = Math.max(1, Math.ceil(waitMs / 1000));
	return textResponse("too many attempts", 429, {
		"retry-after": String(seconds),
	});
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
	/** The control plane this listener reads and writes: `deps.pool` is where `console_sessions`
	 * rows live (this listener is their only writer and reader); the Agents hub's management API
	 * (`console-management.ts`) uses the rest of `deps` to preview and commit configuration
	 * changes through the same `prepareChange`/`commitChange` service the CLI uses. */
	deps: ControlPlaneDeps;
	/** The controller-held key the console's CSRF token is derived from (ADR-025): the routing
	 * key (`GATEWAY_ROUTING_KEY`), reused under its own HMAC label (`deriveCsrfToken`) rather than
	 * a secret file of its own. */
	csrfKey: string;
	cache: ConsoleStatusCache;
	log: Logger;
	/** The built console SPA's own directory (`vite build`'s `dist`); defaults to the path the
	 * release image bakes it into. A missing or incomplete build is logged once and served as a
	 * plain 503 for the UI only — `/api/*` is unaffected. */
	staticDir?: string;
	/** Where `gateway tools secret set <alias>` writes (`CUSTOM_TOOL_SECRETS_DIR`), read-only here
	 * so the Instruments & Utils hub can show whether a custom tool's own named secret aliases are
	 * set — never a value, only presence (ADR-027). Left unset, the tool runner's own well-known
	 * mount path (`resolveCustomToolSecretPath`'s own default) is assumed, same as every other
	 * caller. */
	customToolSecretsDir?: string;
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
	/** Derived from the request's own raw session cookie (`deriveCsrfToken`), never stored — see
	 * ADR-025. Identical across every tab holding the same session cookie. */
	csrfToken: string;
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
		const created = await createConsoleSession(
			options.deps.pool,
			{
				tokenHash: hashSessionToken(token),
				passwordHashFingerprint: fingerprint,
			},
			clock(),
			maxActiveSessions,
		);
		return {
			kind: "ok",
			token,
			csrfToken: deriveCsrfToken(options.csrfKey, token),
			expiresAt: created.expiresAt,
		};
	}

	async function authenticate(request: Request): Promise<AuthenticatedSession | null> {
		const token = parseCookieHeader(request.headers.get("cookie"), SESSION_COOKIE_NAME);
		if (token === null) {
			return null;
		}
		const session = await touchConsoleSession(
			options.deps.pool,
			hashSessionToken(token),
			clock(),
			fingerprint,
		);
		if (session === null) {
			return null;
		}
		return {
			id: session.id,
			expiresAt: session.expiresAt,
			csrfToken: deriveCsrfToken(options.csrfKey, token),
		};
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
			// Derived fresh from the session cookie every time (`deriveCsrfToken`), never stored and
			// never rotated: every tab holding this same cookie — this one, another one, or this same
			// tab after a reload — derives the identical value, so a second tab's own `GET
			// /api/session` never invalidates the first's copy (ADR-025).
			return jsonResponse(
				{
					authenticated: true,
					csrfToken: session.csrfToken,
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
			if (!csrfTokenMatches(request.headers.get(CSRF_HEADER_NAME), session.csrfToken)) {
				return forbidden("missing or invalid CSRF token");
			}
			await revokeConsoleSession(options.deps.pool, session.id, "logout", clock());
			return respond("", 204, "text/plain; charset=utf-8", {
				"set-cookie": clearedSessionCookieHeader(),
			});
		}
		return textResponse("method not allowed", 405, {
			allow: "GET, POST, DELETE",
		});
	}

	/**
	 * The Agents hub's management API (`console-management.ts`) and the Instruments & Utils hub's
	 * own (`console-tools.ts`): every route needs a valid session, and — `GET`/`HEAD` read the
	 * active configuration, nothing more — a mutation (`POST`) additionally needs the exact
	 * configured Origin and a matching CSRF header, exactly like `DELETE /api/session` above.
	 * Neither routing module ever sees a `Request`: each is handed a parsed method/path/query/body
	 * and returns a status plus a JSON-serializable body. `isAgentToolsPath` is what tells an
	 * agent's own `/tools*` sub-path apart from the rest of `/api/agents/*`, which
	 * `console-management.ts` still owns.
	 */
	async function handleManagement(request: Request, pathname: string): Promise<Response> {
		const session = await authenticate(request);
		if (session === null) {
			return unauthenticated();
		}
		const method = request.method;
		if (method !== "GET" && method !== "POST") {
			return textResponse("method not allowed", 405, { allow: "GET, POST" });
		}
		if (method === "POST") {
			if (!originAllowed(request, options.origin)) {
				return forbidden("origin not allowed");
			}
			if (!csrfTokenMatches(request.headers.get(CSRF_HEADER_NAME), session.csrfToken)) {
				return forbidden("missing or invalid CSRF token");
			}
		}
		let bodyText = "";
		if (method === "POST") {
			if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
				return badRequest("expected application/json");
			}
			const bounded = await readBoundedText(request, MAX_MANAGEMENT_BODY_BYTES);
			if (!bounded.ok) {
				return payloadTooLarge();
			}
			bodyText = bounded.text;
		}
		if (pathname.startsWith("/api/tools") || isAgentToolsPath(pathname)) {
			const result = await routeConsoleTools({
				method,
				pathname,
				bodyText,
				deps: options.deps,
				customToolSecretsDir: options.customToolSecretsDir,
			});
			return jsonResponse(result.body, result.status);
		}
		const url = new URL(request.url);
		const result = await routeConsoleManagement({
			method,
			pathname,
			search: url.searchParams,
			bodyText,
			deps: options.deps,
		});
		return jsonResponse(result.body, result.status);
	}

	async function handle(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === "/api/status") {
			return handleStatus(request);
		}
		if (pathname === "/api/session") {
			return handleSession(request);
		}
		if (
			pathname.startsWith("/api/agents") ||
			pathname.startsWith("/api/config/") ||
			pathname.startsWith("/api/tools")
		) {
			return handleManagement(request, pathname);
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
