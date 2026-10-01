import { CONSOLE_PASSWORD_HASH_SECRET_FILE } from "@agent-gateway/contracts";
import { errorFields, type Logger } from "@agent-gateway/logging";
import {
	readSecretFile,
	resolveSecretPath,
	SettingError,
	secretFileState,
	verifyConsolePassword,
} from "@agent-gateway/service";
import { renderConsolePage } from "./console-render.ts";
import type { ConsoleSnapshot, ConsoleStatusCache } from "./console-status.ts";

// ---------------------------------------------------------------------------
// The owner's console listener (ADR-023): a separate Bun.serve, authenticated with HTTP Basic
// against one Argon2id hash, serving the same cached, read-only projection as HTML (`GET /`) and
// JSON (`GET /api/status`). No mutation route, no permissive CORS, and every response (success,
// error, or the 401 challenge itself) carries the same fixed set of security headers.
// ---------------------------------------------------------------------------

/** The console's one account; there is exactly one owner, so the name is fixed rather than
 * configurable. Never a Mattermost username or any other identity the rest of the Gateway uses. */
const OWNER_USERNAME = "owner";

/** Room for the longest password `gateway console password set` accepts (256 UTF-16 units, at
 * most 768 UTF-8 bytes), base64-encoded after `owner:` behind `Basic `: about 1,040 bytes. A
 * header past this is refused before it is even looked at. */
const MAX_AUTHORIZATION_HEADER_BYTES = 2048;

/** Failed logins share one bounded, global counter (ADR-023), never partitioned by a
 * client-supplied address (`X-Forwarded-For` and the like are never trusted for this). */
const LOGIN_FAILURE_WINDOW_MS = 60_000;
const MAX_LOGIN_FAILURES_PER_WINDOW = 10;

/** Argon2id verification is deliberately expensive (`console-auth.ts`); this bounds how many run
 * at once, so a burst of requests cannot turn that cost into unbounded memory pressure. */
const DEFAULT_MAX_CONCURRENT_VERIFICATIONS = 4;

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"cache-control": "no-store",
	"content-security-policy":
		"default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
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
const htmlResponse = (body: string, status: number) =>
	respond(body, status, "text/html; charset=utf-8");
const jsonResponse = (value: unknown, status: number) =>
	respond(JSON.stringify(value), status, "application/json; charset=utf-8");

function unauthorized(): Response {
	return textResponse("unauthorized", 401, {
		"www-authenticate": 'Basic realm="Agent Gateway", charset="UTF-8"',
	});
}

function tooManyRequests(waitMs: number): Response {
	const seconds = Math.max(1, Math.ceil(waitMs / 1000));
	return textResponse("too many attempts", 429, { "retry-after": String(seconds) });
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

type BasicCredentials = Readonly<{ username: string; password: string }>;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Parses `Authorization: Basic <base64(username:password)>`. Anything else — a different
 * scheme, non-base64 content, or a decoded value with no colon — is not a credential, not a
 * crash: `null`. */
function parseBasicAuth(header: string): BasicCredentials | null {
	const match = /^Basic\s+(\S+)$/i.exec(header.trim());
	if (match === null) {
		return null;
	}
	const token = match[1];
	if (token === undefined || !BASE64.test(token)) {
		return null;
	}
	const decoded = Buffer.from(token, "base64").toString("utf8");
	const separator = decoded.indexOf(":");
	if (separator < 0) {
		return null;
	}
	return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).length;
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
	cache: ConsoleStatusCache;
	log: Logger;
	clock?: () => Date;
	maxConcurrentVerifications?: number;
	/** Overrides `verifyConsolePassword` for tests only; production always uses the real one. */
	verifyPassword?: (password: string, hash: string) => Promise<boolean>;
}>;

export type RunningConsoleServer = Readonly<{ port: number; stop: () => Promise<void> }>;

/**
 * Starts the owner's console listener. Every request is authenticated before anything else
 * happens (before the cached projection is even read); only `GET /` and `GET /api/status` exist,
 * both read-only, both requiring the same credential.
 */
export function startConsoleServer(options: ConsoleServerOptions): RunningConsoleServer {
	const clock = options.clock ?? (() => new Date());
	const verify = options.verifyPassword ?? verifyConsolePassword;
	const gate = createVerificationGate(
		options.maxConcurrentVerifications ?? DEFAULT_MAX_CONCURRENT_VERIFICATIONS,
	);
	const limiter = createLoginLimiter(clock);

	async function authenticate(request: Request): Promise<Response | null> {
		const header = request.headers.get("authorization");
		if (header !== null && utf8ByteLength(header) > MAX_AUTHORIZATION_HEADER_BYTES) {
			return textResponse("bad request", 400);
		}
		const blockedMs = limiter.blockedFor();
		if (blockedMs !== null) {
			return tooManyRequests(blockedMs);
		}
		if (header === null) {
			return unauthorized();
		}
		const credentials = parseBasicAuth(header);
		if (credentials === null) {
			limiter.recordFailure();
			return unauthorized();
		}
		const verified = await gate.run(() => verify(credentials.password, options.passwordHash));
		if (verified === "busy") {
			return serviceBusy();
		}
		// Both the username and the Argon2id check run every time, so a wrong username takes the
		// same shape of work as a wrong password: neither ever short-circuits the other.
		const usernameOk = credentials.username === OWNER_USERNAME;
		if (!usernameOk || !verified) {
			limiter.recordFailure();
			return unauthorized();
		}
		return null;
	}

	async function handle(request: Request): Promise<Response> {
		const denied = await authenticate(request);
		if (denied !== null) {
			return denied;
		}
		const { pathname } = new URL(request.url);
		if (pathname !== "/" && pathname !== "/api/status") {
			return textResponse("not found", 404);
		}
		// HEAD is refused outright rather than answered with an empty body: this listener has
		// exactly two GET routes and nothing worth a conditional-request shortcut.
		if (request.method !== "GET") {
			return textResponse("method not allowed", 405, { allow: "GET" });
		}
		const snapshot: ConsoleSnapshot = await options.cache.get();
		const status = snapshot.state === "unavailable" ? 503 : 200;
		return pathname === "/api/status"
			? jsonResponse(snapshot, status)
			: htmlResponse(renderConsolePage(snapshot), status);
	}

	const server = Bun.serve({
		port: options.port,
		hostname: options.hostname,
		fetch: async (request) => {
			try {
				return await handle(request);
			} catch (error) {
				// Never the request itself (and so never its Authorization header) in the log.
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
