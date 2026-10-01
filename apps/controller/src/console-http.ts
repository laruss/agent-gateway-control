// ---------------------------------------------------------------------------
// Generic HTTP response helpers for the owner's console (ADR-025), shared between
// `console-server.ts` (sessions, static assets) and `console-management.ts` (the Agents hub API):
// a module of its own so neither imports the other. Every response carries the same fixed set of
// security headers; nothing here knows about sessions, CSRF or any particular route.
// ---------------------------------------------------------------------------

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"cache-control": "no-store",
	// The React SPA (ADR-025's frontend section): no inline script, no eval, nothing cross-origin.
	// `style-src 'self'` covers the SPA's own built stylesheet and `style-src-attr` (falling back
	// to it, since it is not named separately): Radix's inline `element.style.setProperty(...)`
	// calls are CSSOM manipulation, which no `style-src*` directive governs (only a `style="..."`
	// attribute or a `<style>` element would be), so they are unaffected by not having
	// `'unsafe-inline'` here. `style-src-elem` is named separately, and does get it: Radix's own
	// scroll lock (Dialog, AlertDialog, Select — every component built on a popover that disables
	// background scrolling while open) inserts a `<style>` element with static, never
	// attacker-influenced content (a scrollbar-width compensation rule); this is Radix's own
	// documented CSP interaction, not a workaround of ours, and it widens nothing else: a `style=`
	// attribute injected into the page is still refused. `img-src` adds `data:` for the few small
	// inlined icons a component library like this tends to carry; everything else is `'self'` or
	// `'none'`.
	"content-security-policy":
		"default-src 'none'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
	"x-content-type-options": "nosniff",
	// `same-origin`, not `no-referrer`: per the Fetch spec, a non-GET/HEAD, non-CORS-mode request
	// (a plain HTML form POST, in particular) sends `Origin: null` whenever the referrer policy in
	// effect is `no-referrer`, or is `same-origin` and the request is cross-origin. The console's
	// own login form posts JSON to its own origin via `fetch`, so `same-origin` keeps that real
	// `Origin` header on the wire (`originAllowed` needs it) while still sending no referrer at
	// all, and no Origin, to anything cross-site.
	"referrer-policy": "same-origin",
	"x-frame-options": "DENY",
};

export function respond(
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

export const textResponse = (
	body: string,
	status: number,
	headers: Readonly<Record<string, string>> = {},
) => respond(body, status, "text/plain; charset=utf-8", headers);

export const jsonResponse = (
	value: unknown,
	status: number,
	headers: Readonly<Record<string, string>> = {},
) => respond(JSON.stringify(value), status, "application/json; charset=utf-8", headers);

export const unauthenticated = (): Response => textResponse("unauthorized", 401);
export const forbidden = (message: string): Response => textResponse(message, 403);
export const badRequest = (message: string): Response => textResponse(message, 400);

export function payloadTooLarge(): Response {
	return textResponse("payload too large", 413);
}

export type BoundedBody = Readonly<{ ok: true; text: string }> | Readonly<{ ok: false }>;

/**
 * Reads a request body as UTF-8 text, refusing it (`{ ok: false }`) before or after reading when
 * it exceeds `maxBytes`: by its declared `Content-Length` if present, before a byte is read, and
 * otherwise by the bytes actually read off `request.body` as they arrive. A chunked request
 * carries no `Content-Length` at all, so that case is read incrementally and its reader
 * cancelled the moment the running total exceeds `maxBytes` — never buffered in full first, the
 * way `request.text()` would.
 */
export async function readBoundedText(request: Request, maxBytes: number): Promise<BoundedBody> {
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
