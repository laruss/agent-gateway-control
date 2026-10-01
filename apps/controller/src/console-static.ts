import { lstatSync, realpathSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Serving the console's own built assets (ADR-025's frontend): a small, dependency-free static
// file server for exactly the shape `vite build` produces — an `index.html` and a hashed
// `assets/` directory — plus the SPA fallback every other route needs. No directory listing, no
// range requests, no conditional requests: the console is a one-owner admin page, not a public
// CDN, and this is the smallest surface that serves it correctly and safely.
// ---------------------------------------------------------------------------

/** The path the release image bakes the built console into (`deploy/images/Dockerfile`);
 * overridden in development and tests to point at a fixture or a local build. */
export const DEFAULT_CONSOLE_STATIC_DIR = "/opt/agent-gateway/apps/console/dist";

export type ConsoleStaticRoot =
	| Readonly<{ kind: "ready"; root: string; indexHtml: string }>
	| Readonly<{ kind: "missing"; configuredDir: string }>;

/**
 * Resolves `configuredDir` once, at server start (the same choice `resolveConsolePasswordHash`
 * makes for the password hash): a missing or incomplete build is not a crash — the console's own
 * data API must keep working even without a frontend to serve — so this reports `"missing"`
 * instead of throwing, and the caller logs it once and serves a plain 503 for the UI only.
 */
export function resolveConsoleStaticRoot(configuredDir: string): ConsoleStaticRoot {
	let root: string;
	try {
		root = realpathSync(configuredDir);
	} catch {
		return { kind: "missing", configuredDir };
	}
	const indexHtml = join(root, "index.html");
	try {
		if (!statSync(indexHtml).isFile()) {
			return { kind: "missing", configuredDir };
		}
	} catch {
		return { kind: "missing", configuredDir };
	}
	return { kind: "ready", root, indexHtml };
}

/** Every path segment from `root` down to `candidate` must be a real directory or file, never a
 * symlink: a build output this controller did not produce itself has no business being served
 * through one, whatever it would resolve to. */
function containsSymlink(root: string, candidate: string): boolean {
	const relative = candidate
		.slice(root.length)
		.split(sep)
		.filter((segment) => segment !== "");
	let current = root;
	for (const segment of relative) {
		current = join(current, segment);
		if (lstatSync(current).isSymbolicLink()) {
			return true;
		}
	}
	return false;
}

/**
 * Resolves a request path to a file under `root`, or `null` when it would escape `root` (`..`
 * segments, an absolute-looking segment, a symlink anywhere along the way) or does not name an
 * existing regular file. `pathname` is the decoded request path (e.g. `/assets/index-abc.js`).
 */
export function resolveStaticFile(root: string, pathname: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	const candidate = resolve(root, `.${decoded}`);
	if (candidate !== root && !candidate.startsWith(root + sep)) {
		return null;
	}
	try {
		if (containsSymlink(root, candidate)) {
			return null;
		}
		if (!statSync(candidate).isFile()) {
			return null;
		}
	} catch {
		return null;
	}
	return candidate;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".txt": "text/plain; charset=utf-8",
};

/** `application/octet-stream` for anything unrecognized: never guessed from content, never left
 * without a `Content-Type` at all. */
export function staticContentType(path: string): string {
	return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}
