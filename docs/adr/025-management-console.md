# ADR-025. The management console: sessions, CSRF and exact Origin

- Status: Accepted
- Date: 2026-10-01
- Supersedes: [ADR-023](023-console-and-operator.md) (partially: authentication, and the console
  is no longer read-only)

## Context

ADR-023 gave the owner a read-only status page, authenticated with HTTP Basic against one
Argon2id hash: enough for a page nobody could change anything from. The console is becoming a
full management UI — agents, skills and tools hubs — that mutates configuration through the
shared `prepareChange`/`commitChange` service (ADR-024). A mutation needs an authentication
mechanism that can actually be logged out of, that a single stolen credential doesn't grant
forever, and that cannot be driven by a page the owner never opened. HTTP Basic gives none of
that: a browser caches it until the process exits, there is no server-side state to revoke, and
nothing stops a cross-site request from carrying it, since the browser attaches it to every
same-origin request automatically regardless of who asked for it.

This decision covers authentication and mutation protection only. The React/Vite/Tailwind/
shadcn/ui frontend that will actually show the hubs, and the management APIs it calls, are later
steps of this phase; this ADR exists first so every route added after it — including the first
one, a plain login form — is already behind the session and CSRF model the rest will reuse.

## Decision

### Sessions

- **`console_sessions`** (`packages/db/src/schema.ts`): `id`, `token_hash` (sha256 of a 32-byte
  random token — the raw token lives only in the cookie), `csrf_token_hash` (sha256 of a
  separate random token, see below), `password_hash_fingerprint` (sha256 of the console's
  Argon2id hash *file's own content* at the moment the session was created), `created_at`,
  `last_seen_at`, `expires_at`, `revoked_at`, `revoked_reason`.
- **Absolute lifetime 12 hours, idle timeout 30 minutes, sliding** on `last_seen_at`. Every
  authenticated request can extend a session, but `last_seen_at` is rewritten at most once a
  minute, so a tab polling the status endpoint does not turn into a write on every request.
  Validating a session is a read-only `SELECT` keyed on the token's hash, checking `revoked_at`,
  `expires_at`, the idle cutoff and the fingerprint together, so an invalid session is simply
  absent from the result; only when the row it finds is actually older than the one-minute touch
  interval does a second, single-row `UPDATE ... WHERE id = $1 AND last_seen_at < $threshold`
  slide it — guarded by the same staleness check it was just read under, so a session touched
  well within the interval never dirties its row, and a concurrent touch that already slid it
  makes a second one a no-op instead of a racing write.
- **A password rotation invalidates every session bound to the old hash without a database
  write.** `gateway console password set` writes a new Argon2id hash file; the controller reads
  that file once at start and derives `password_hash_fingerprint` from its content once, at
  listener start. A session created under the old file's content stops matching the moment the
  controller restarts with the new one — which the console password documentation already
  requires for a rotation to take effect. Because the CLI can usually also reach the database
  directly (it already does for most commands), `gateway console password set` additionally
  revokes every active session there and then, so the rotation does not have to wait for that
  restart when the CLI has that access; the fingerprint check is what makes revocation correct
  even when it does not.
- **At most 20 active sessions.** Creating one beyond the cap revokes the oldest (by
  `created_at`) in the same transaction as the insert — a single owner does not need unbounded
  concurrent logins, and an unrevoked trail of abandoned sessions is exactly what a cap and
  cleanup both exist to prevent. The insert, the count of currently active rows and the eviction
  it implies are serialized across concurrent logins by a transaction-scoped advisory lock
  (`pg_advisory_xact_lock`, released automatically at commit or rollback): without it, two
  logins racing each other can each count the active rows before the other's insert is visible,
  both conclude the cap is not yet exceeded, and both skip eviction, leaving more than 20 active.
- **Expired and revoked rows are deleted by the controller's existing retention pass**
  (`applyRetention`, hourly), not on a schedule of their own: they carry no content to redact,
  so this is hygiene, not the organization's configurable content retention. A login does not
  separately try to clean up on its own critical path.

### CSRF: a rotating, server-verified double-submit token

- **A per-session random token, distinct from the session token**, is returned to the client in
  the login and session-check JSON response bodies and required, raw, in an `X-CSRF-Token`
  header on every mutation; only its hash is ever stored (`csrf_token_hash`), compared in
  constant time against the hash of whatever header arrives.
- **`GET /api/session` rotates it.** Storing only a hash means the server cannot simply hand the
  original token back on a later request — there is nothing to hand back. Instead, every call to
  `GET /api/session` while authenticated mints a fresh token, stores its hash, and returns the
  new raw value. This is how a reloaded page (its in-memory copy of the token gone) recovers a
  token that still works, without the stored value ever being anything but a hash. The
  consequence is explicit: an older browser tab holding a token from before the most recent `GET
  /api/session` call (in another tab, or its own earlier load) finds its next mutation rejected
  and must re-fetch the session check first. For a single owner operating one console at a time,
  this is the right side to err on.

### Exact Origin, not inferred authority

- **`CONSOLE_ORIGIN`** is a new controller setting, e.g. `https://gateway.local` — the home
  server's default (`deploy/release/compose.yaml`, `gateway.env.example`). It is read and
  validated at start, alongside the password hash, so a malformed value fails the controller
  closed rather than starting a listener that would reject every login.
- **Login and every mutation require the request's `Origin` header to equal `CONSOLE_ORIGIN`
  exactly**, and, when the browser sends it, `Sec-Fetch-Site: same-origin`. Requiring it on login
  itself — not only on mutations after login — is what blocks cross-site login CSRF: a page on
  another origin that submits credentials (its own, to its own knowledge) into the console in the
  victim's browser, hoping the victim continues to use a session the attacker also knows the
  password to.
- **`Referrer-Policy: same-origin`, not ADR-023's `no-referrer`.** An exact-Origin check makes
  the `Origin` header load-bearing for the first time, and the Fetch spec ties that header to the
  referrer policy for exactly the requests this ADR depends on: a non-GET/HEAD, non-CORS-mode
  request (a plain HTML form `POST`, in particular) sends `Origin: null` whenever the referrer
  policy in effect is `no-referrer`, or is `same-origin` and the request is cross-origin. The
  console's own sign-in form posts JSON to its own origin via `fetch` (a CORS-mode request, so it
  always carries a real `Origin` regardless of referrer policy) rather than a plain HTML form
  `POST`, but the distinction still matters: `same-origin` keeps the real `Origin` header on any
  same-origin request while still sending no referrer, and no Origin, to anything cross-site — the
  same off-site leakage `no-referrer` was chosen to prevent — without depending on every request
  happening to be CORS-mode to get that.
- **Never `X-Forwarded-*`.** Those headers name the edge proxy's own view of the request; the
  console's listener sees the connection Caddy actually made to it and nothing upstream of that
  is treated as an authenticated claim about where a request came from.

### Routes

- **`POST /api/session`** (JSON `{password}`): verifies the password the same Argon2id way as
  before, then mints a new session unconditionally — a client-supplied cookie on the request is
  never consulted, which is what rules out session fixation — and sets
  `Set-Cookie: __Host-gw_session=...; Path=/; Secure; HttpOnly; SameSite=Strict`, returning
  `{csrfToken, expiresAt}`. The `__Host-` prefix, with `Path=/`, `Secure` and no `Domain`
  attribute, makes the cookie host-only at the browser's own enforcement, not only by
  convention.
- **`GET /api/session`** reports `{authenticated, csrfToken?, expiresAt?}` for whatever cookie
  the request carries, rotating the CSRF token as above; it needs no session of its own to call.
- **`DELETE /api/session`** revokes the session and clears the cookie; like every other mutation,
  it requires the exact Origin and a matching CSRF header.
- **Every other `/api/*` route requires a valid session**; `/api/status` is unchanged in shape,
  now returning `401` instead of challenging for Basic credentials.
- **`GET`/`HEAD` on every non-`/api/*` path serves the React SPA**, built by the frontend step
  below: `/assets/*` is the build's own content-hashed files (`Cache-Control: public,
  max-age=31536000, immutable`), and every other path — `/`, a deep link like `/agents`, anything
  the SPA's own router recognizes — gets the same `index.html` (`Cache-Control: no-store`), which
  then renders the sign-in screen or the dashboard once it loads, from its own session check. No
  route gates `/` on a session any more; the SPA itself refuses to show anything but the sign-in
  screen until `GET /api/session` says who, if anyone, is signed in. A missing or incomplete
  build (`console-static.ts`) logs once and serves a plain `503` for the UI only — `/api/*` keeps
  working.
- **HTTP Basic is removed outright.** `gateway` (the CLI) never authenticated against the
  console; nothing else depended on it continuing to exist alongside sessions, and one
  authentication mechanism is simpler to reason about than two.

### The frontend

- **React 19, TypeScript, Vite 8, Tailwind CSS v4 and shadcn/ui** (`apps/console`, a bun
  workspace), built to static assets the controller serves from this same listener
  (`console-static.ts`) — no separate frontend service, no additional deploy artifact or
  published port. `deploy/images/Dockerfile` builds it in its own stage (`console-build`, dev
  dependencies included) and copies only the built `dist/` into the `gateway` image; the
  production `bun install --production` stage never installs Vite, React or Tailwind.
- **Routing: React Router**, not TanStack Router. Four top-level pages (Overview, Agents, Skills,
  Instruments & utils) and a sign-in screen do not need file-based route generation or its own
  Vite plugin; `createBrowserRouter`'s JSX form is the smaller, more direct fit, and the
  controller's own SPA fallback (above) is what makes every deep link work regardless of which
  router renders it.
- **Data fetching: TanStack Query for the status poll, a small typed fetch wrapper
  (`lib/api-client.ts`) underneath it for everything.** The wrapper owns the transport concerns
  shared by every call — same-origin credentials, the `X-CSRF-Token` header on mutations, parsing
  every response against the shared Zod contracts below, and turning a `401` into the one
  `ApiError` kind the session layer reacts to. Query earns its place only for the status poll
  specifically: `refetchInterval` plus its own stale/error/pending state already is the 15 s
  polling and stale-snapshot handling this page needs, instead of this app reimplementing that
  state machine by hand for one endpoint. Sign-in and sign-out stay plain `async` calls through
  the same wrapper; they are one-shot actions, not cached data.
- **Shared response types, not duplicated ones.** `ConsoleStatus` and everything under it
  (`ConsoleTask`, `ConsoleContext`, `ConsoleAgent`, `ConsoleRun`, `ConsoleAlert`) and the
  `ConsoleSnapshot` envelope `/api/status` actually returns are now Zod schemas in
  `@agent-gateway/contracts` (`console-status.ts`), re-exported from `@agent-gateway/core` for
  its existing callers. The console parses every `/api/status` and `/api/session` response
  against these schemas at the fetch boundary; a response that does not match is a parse error,
  never silently trusted shaped JSON.
- **CSP: `script-src 'self'; style-src 'self'`, no `'unsafe-inline'` or `'unsafe-eval'`
  anywhere.** Vite's production build emits no inline `<script>` (confirmed by inspecting the
  built `index.html`) and `build.modulePreload.polyfill: false` removes the one inline snippet
  Vite would otherwise add. shadcn/ui's components are built on Radix primitives, which do set
  `element.style` directly in JavaScript (visibility, positioning) — but that is CSSOM
  manipulation, which `style-src` governs only for a `style="..."` HTML attribute or a `<style>`
  element, never for script setting `element.style.foo` — so it needed no loosening at all,
  confirmed by loading the signed-in dashboard in a real browser with zero CSP violations
  reported. `img-src 'self' data:` and `font-src 'self'` are the only other additions beyond
  ADR-023's original policy, for the small inlined icons a component library tends to carry and
  for the SPA's own fonts, should it ever ship any (today it ships none; the system font stack is
  used throughout). One thing did need an explicit change, not a CSP exception: Zod builds each
  object schema's fast parser at construction time by probing whether `new Function(...)` works,
  catching the resulting error itself when it doesn't — but the browser still reports that caught
  throw as a `script-src` violation before the catch runs. `z.config({ jitless: true })`
  (`apps/console/src/lib/zod-config.ts`, imported first, before anything that constructs a
  schema) skips the probe entirely; this is Zod's own documented fix for exactly this CSP
  interaction, not a workaround of ours.
- **`.claude/rules/basic-rules.md`'s shadcn exception, written for ADR-023's plain HTML page, is
  removed.** The SPA this section describes has fully replaced the server-rendered dashboard and
  its stand-in login form; every page in this repository now follows the shadcn-first rule the
  same way.

## Alternatives

- **Stateless, signed session tokens (e.g. a JWT).** Rejected: revocation (logout, a password
  rotation, the active-session cap) needs a server-side list of what is currently valid; a
  self-contained signed token cannot be individually invalidated without also keeping that same
  list, at which point the signature buys nothing a random token's hashed lookup does not already
  give.
- **Storing the CSRF token itself, not just its hash.** Rejected even though the token is handed
  to the client anyway and so is not secret from it: storing every credential-shaped value
  hashed, without exception, is a simpler invariant to keep than "hash this one, but not that
  one, because of how it is used." Rotating it on every `GET /api/session` instead keeps that
  invariant and still lets the client recover a working token after a reload.
- **A separate server-side `/login` route.** Rejected: the controller serves the same
  `index.html` for every non-`/api/*` path regardless of authentication state (above); the SPA's
  own router, not the server, decides whether that renders the sign-in screen or the dashboard,
  so a second server-side route for login would duplicate a decision the client already makes.
- **Keeping HTTP Basic and adding CSRF on top.** Rejected: Basic has no server-side session to
  revoke, no logout a page can trigger, and no way to expire on its own; CSRF protection without
  a revocable session underneath it does not address why Basic was insufficient in the first
  place.

## Consequences

- Every authenticated request now does one indexed database statement (the combined
  validate-and-slide-idle-timeout update); login and logout add session rows and revocations.
  This is new load the read-only page never had, but it is one small, indexed statement per
  request against a database already handling far more throughput elsewhere.
- Nearly every console behavior now depends on `console_sessions`, so the console's own test
  suite moved from a plain unit suite to an integration one (`console.integration.test.ts`,
  against a real PostgreSQL); only `resolveConsolePasswordHash`, which touches no session state,
  remains a unit test.
- `console_sessions` is an expand migration (ADR-020): a release before this one does not know
  the table exists and does not need it; rolling back to it means HTTP Basic against the same
  password hash file resumes working exactly as ADR-023 left it, and the session rows left
  behind are simply inert until a later upgrade re-reads them under their own expiry rules.
- A reloaded browser tab's in-memory CSRF token can go stale if another tab (or an earlier load
  of the same one) has since called `GET /api/session`; the fix is the same call, which the SPA
  already makes once on every load (`SessionProvider`) and whenever a 401 sends it back to the
  sign-in screen. It does not yet retry a single failed mutation automatically after refreshing
  the token — a stale-tab 403 surfaces as a clear, typed error (`ApiError.kind === "forbidden"`)
  rather than being silently retried; this is a candidate for a later pass, not a correctness
  gap, since the 12-hour/30-minute session itself is what makes a tab's token stale in the first
  place, and whatever triggered that has already made the mutation it was attempting stale too.
