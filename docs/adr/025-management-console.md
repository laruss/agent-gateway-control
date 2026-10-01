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
  Validating and sliding a session is one `UPDATE ... RETURNING` keyed on the token's hash,
  checking `revoked_at`, `expires_at`, the idle cutoff and the fingerprint together, so an
  invalid session is simply absent from the result rather than a separate read followed by a
  racing write.
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
  cleanup both exist to prevent.
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
- **Never `X-Forwarded-*`.** Those headers name the edge proxy's own view of the request; the
  console's listener sees the connection Caddy actually made to it and nothing upstream of that
  is treated as an authenticated claim about where a request came from.

### Routes, until the SPA replaces this page

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
- **`GET /` and `POST /` carry the dashboard and its own login, until the SPA lands.** The SPA
  shell will need to be reachable without a session to show a login screen at all, so this
  decision resolves that the same way now: `GET /` renders the existing dashboard when the
  request carries a valid session, and a plain login form otherwise — never a mix of the two,
  never any dashboard data before authentication. `POST /` accepts the form's
  `application/x-www-form-urlencoded` body (a password field), because a script-free HTML form
  cannot post JSON and the CSP (`default-src 'none'`) forbids an inline script that would encode
  one; on success it sets the cookie and replies with a `303` redirect back to `/`, the same
  flow the SPA will eventually replace wholesale rather than extend.
- **HTTP Basic is removed outright.** `gateway` (the CLI) never authenticated against the
  console; nothing else depended on it continuing to exist alongside sessions, and one
  authentication mechanism is simpler to reason about than two.

### The frontend, decided here and built next

- **React, TypeScript, Vite, Tailwind and shadcn/ui**, in a new frontend workspace, built to
  static assets the controller serves from this same listener — no separate frontend service,
  no additional deploy artifact or published port. This is the shape the next step of this phase
  builds; this decision states it now because every route already being added (login, session
  check, status) is written to be the API surface that SPA calls, not a page of its own that a
  later rewrite discards.
- **`.claude/rules/basic-rules.md`'s shadcn exception, written for ADR-023's plain HTML page,
  ends once that SPA replaces the server-rendered dashboard and login form.** Until it does, the
  pages this decision adds (the login form in particular) are held to the same plain-HTML,
  no-build-step rule as the dashboard they sit beside, for the same reason ADR-023 gave: a
  one-owner page does not earn a component library before it has a framework to put one in.

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
- **A separate `/login` route.** Rejected: the SPA shell will serve exactly one page at `/`
  regardless of authentication state; building the stand-in login page at that same path now
  means the eventual SPA replaces one route's behavior, not two.
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
  of the same one) has since called `GET /api/session`; the fix is the same call, not a page
  reload, and the SPA is expected to make it automatically before retrying a failed mutation.
