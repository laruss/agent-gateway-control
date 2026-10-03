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

### CSRF: a token derived from the session, never stored

- **The CSRF token is not a value the server stores at all.** It is derived, on every request
  that needs it, from the session's own raw token: `csrf = base64url(HMAC-SHA256(key,
  "console-csrf:" + rawSessionToken))`, where `key` is the controller's routing-key secret
  (`GATEWAY_ROUTING_KEY`, the same HMAC key `routing-props.ts` uses to sign a post's routing
  metadata) and `rawSessionToken` is the cookie value the request already carries. `deriveCsrfToken`
  (`apps/controller/src/console-auth.ts`) is the one function that computes it; nothing calls
  `createHash`/stores a second hash for this the way `token_hash` is stored for the session
  itself. `"console-csrf:"` is this derivation's own domain-separation label: the routing
  signature's own HMAC input is a canonical JSON object (`signedRoutingProps`), never a plain
  `"console-csrf:"`-prefixed string, so the two uses of the same key can never collide. Reusing
  the routing key avoids a secret file of its own; it is read again for this purpose, independent
  of whatever `OUTBOX_DELIVERY` mode the controller actually runs with (`main.ts`), since the
  console's own correctness must not depend on the Mattermost bridge being this process's
  delivery mode.
- **Deterministic, not rotating.** The same session token and key always derive the same CSRF
  value, so `GET /api/session`, login, and every mutation check all compute (or compare against)
  the identical value for as long as the session itself is valid — there is nothing to rotate,
  and so nothing for a second tab's own `GET /api/session` to invalidate. Two tabs sharing one
  session cookie (the only way two tabs share a session at all) always derive the same CSRF
  token; opening or reloading either one never invalidates the other's copy. The session table's
  `csrf_token_hash` column still exists (ADR-020's expand-migration guarantee: a release before
  this derivation rolls back to a schema it still understands) but is nullable and never written
  (migration `0023_console_csrf_derived`); nothing reads it either.
- **A forged or cross-session token still fails.** Deriving the expected value from the
  *request's own* session token (never from a client-supplied one) is what makes a token minted
  for one session reject on another's cookie, and a random guess reject outright — the same
  guarantees the rotating, hash-compared design had, from a different mechanism.

### Exact Origin, not inferred authority

- **`CONSOLE_ORIGIN`** is a new controller setting, e.g. `https://gateway.local` — the home
  server's default (`deploy/release/compose.yaml`, `gateway.env.example`). It is read and
  validated at start, alongside the password hash, so a malformed value fails the controller
  closed rather than starting a listener that would reject every login. `assertConsoleOrigin`
  also refuses an `http:` origin outright unless its host is `localhost`/`127.0.0.1` (`console:dev`'s
  own Vite dev server, the only legitimate case): the session cookie is `__Host-`/`Secure`
  (above), so an `http://` value pointed at a real host would otherwise carry it in the clear.
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
  the request carries, deriving the CSRF token as above; it needs no session of its own to call.
- **`DELETE /api/session`** revokes the session and clears the cookie; like every other mutation,
  it requires the exact Origin and a matching CSRF header.
- **Every other `/api/*` route requires a valid session**; `/api/status` is unchanged in shape,
  now returning `401` instead of challenging for Basic credentials.

### The Agents hub's management API

The console's first mutating surface beyond sessions: every agent's configuration, read from and
written through the shared `prepareChange`/`commitChange` service (ADR-024), never a direct
database write of its own. Every route below needs a valid session; a `POST` additionally needs
the exact Origin and a matching CSRF header, the same as `DELETE /api/session`. Request and
response bodies are explicit Zod schemas (`packages/contracts/src/console-management.ts`), shared
with the SPA; an unrecognized field, not just a wrong type, is a `400` (every object is a
`z.strictObject`). The routing itself (`apps/controller/src/console-management.ts`) is a plain
method/path/query/body dispatcher with no `Request`/`Response` of its own — `console-server.ts`
owns authentication, Origin and CSRF, and only calls it once a request has already passed every
one of those checks.

- **`GET /api/agents`** / **`GET /api/agents/:id`** — a read model built fresh from the active
  snapshot each time (`consoleListAgents`/`consoleShowAgent`, `packages/core/src/services/
  console-management.ts`), never a client-supplied database id beyond the id used in the URL
  itself. The detail response's `mattermost.tokenSecretFile` is shown as metadata — a path is not
  a credential — but is not a field the patch DTO below accepts; a client cannot set it.
- **`POST /api/agents/:id/preview`** / **`POST /api/agents/:id/commit`** — body `{baseRevisionId,
  changes}` (`commit` also carries a client-generated `idempotencyKey` UUID and an optional
  `reason`). `changes` is an `AgentPatch`: only the fields the editor's tabs actually expose
  (display name, enabled, role prompt, runtime, wake rules, allowed channels, the three tool
  lists, `observe_system`) — never the whole `AgentConfig` shape, and never a field this phase's
  editor has no tab for (the Mattermost identity, memory namespaces, concurrency). `planAgentPatch`
  translates it into the change operations `prepareChange`/`commitChange` already understand:
  `update_agent` with the patch merged onto the agent's current definition, `set_role_prompt` when
  the prompt changed, or — when the patch is `{enabled}` alone — `set_agent_enabled` through the
  same disable-with-fallback-to-`remove_agent` path `gateway agent disable` uses (a retained
  agent whose own stored configuration no longer validates cannot be fixed by flipping its
  `enabled` flag alone; the fallback is resolved once, by `resolveEnabledChangeSet`, and shared by
  `preview` and `commit` alike, so the console sees it — "removes the agent from the
  configuration" in `impact` — before ever committing it). **Both routes require the request's
  `baseRevisionId` to equal the revision actually active right now**, the editor's own loaded
  view: `preview` refuses a mismatch with `409` and the current revision id instead of silently
  computing a diff against the live state in its place, building its own plan from the agent's
  current live definition once that equality is confirmed (the same definition `baseRevisionId`
  was just confirmed to name). `commit` instead builds its plan from the snapshot `baseRevisionId`
  itself names directly — immutable and content-addressed, so the *same* `(baseRevisionId, changes)`
  pair always recomputes the identical change set no matter what the live configuration has become
  since; `commitChange`'s own conflict check (inside its transaction lock) is what still refuses a
  genuinely stale, non-retried base the same way preview does. `preview` returns `200` with the
  diff, any validation `problems`, and `impact` — a short list of consequences needing explicit
  confirmation before a commit proceeds: destructive or authority-reducing ones (disables the
  agent, removes a channel, removes a tool grant, removes `observe_system`, removes a tool's deny
  rule or its human-approval requirement) and authority-*increasing* ones just as much (enables
  the agent, adds a channel, grants a tool, grants `observe_system`) — derived from the
  before/after agent definitions directly rather than the structural diff's `fieldPaths` (which
  names only that a list changed, never what left or joined it). `commit` returns `200` on success
  (including a replayed idempotency key: a retry after a lost response carries the same
  `baseRevisionId` and the same `changes`, so it recomputes the identical change set and
  `commitChange`'s own idempotency check replays the original commit's own recorded result exactly
  — a live-state-dependent plan could instead disagree with its own first attempt purely because
  an unrelated, intervening change had moved live state on, and risk "the same key, a different
  change set"), `409` with the current revision id on a stale base, and `422` with `problems` for
  anything invalid — whether caught by `prepareChange` before committing or only at commit time (a
  run-in-progress protection, `AdminError`s `commitChange`/`writeConfigRevisionIn` can still
  raise).
- **`GET /api/config/revisions`** / **`GET /api/config/revisions/:id/diff`** — the journal's own
  history (`listConfigRevisions`, unchanged) and a structural diff of one revision against its
  parent (`consoleRevisionDiff`, reusing `configDiff`) for any recorded revision, not only the
  currently active one.
- **The agent lifecycle (ADR-026).** `POST /api/agents` (create), `POST /api/agents/:id/retry`,
  `POST /api/agents/:id/retire`, `POST /api/agents/:id/restore`, `GET /api/agents/:id/lifecycle`,
  `GET /api/agents/:id/channels` and `POST /api/agents/:id/channels/revoke` sit under this exact
  same session/CSRF/exact-Origin regime — every `POST` needs the exact Origin and a matching CSRF
  header, every route needs a valid session, the same as `preview`/`commit` above. ADR-026 is
  their own authority for what each one does and returns; this ADR's own authority is only that
  they are reached, authenticated and protected the same way every other mutating route here is —
  no new mechanism, no exception carved out for them.
- **The Instruments & Utils hub's management API (ADR-027), the same way.** `GET /api/tools` /
  `GET /api/tools/:entryId` (the catalog list and an entry's own detail — version history, attached
  agents, and, for a `custom_https` entry, which secret aliases it needs and whether each is set,
  a boolean only, never a value); `POST /api/tools` (create a `custom_https` entry),
  `POST /api/tools/:entryId/edit` (publish a new version — name/description for a built-in, the
  full definition for a `custom_https` entry), `POST /api/tools/:entryId/delete` (removes every
  agent's attachment of it atomically, reporting which agents lost it); `GET /api/agents/:id/tools`
  (requested attachments against effective, compiled access), `POST /api/agents/:id/tools/attach`/
  `detach`/`update`, and `GET`/`POST /api/agents/:id/tools/adopt` ("Adopt into the tools hub"'s own
  dry-run preview and commit). Attach/detach/update/adopt always commit through
  `prepareChange`/`commitChange` exactly like the Agents hub's own routes above, carrying
  `source: "console"`, and so are always covered by `gateway config rollback`. Create and edit
  (`POST /api/tools`, `POST /api/tools/:entryId/edit`) are not: a catalog entry's own row and
  version history are not part of any config revision at all, so these two never call
  `prepareChange`/`commitChange` and carry no `source` of their own. Delete is both: it commits
  through `prepareChange`/`commitChange` (carrying `source: "console"`) only when something is
  actually attached (nothing to clear otherwise commits nothing), while the entry's own
  `deleted_at`/tombstone are written directly, outside any revision, every time. ADR-027 is the
  authority for the catalog and compiler rules these translate into change operations for, and for
  exactly which of these routes commit a revision at all; this ADR remains the authority only for
  how they are reached and protected. One thing these routes alone
  need beyond `ControlPlaneDeps`: whether a named secret alias is actually set, read from the same
  read-only mount `gateway tools secret set` writes through — `apps/controller/src/console-tools.ts`
  (the routing layer, not `@agent-gateway/core`, which stays filesystem-free) resolves this itself,
  never the catalog service.
- **Actor and source.** Every commit this surface makes carries `source: "console"` (reserved for
  exactly this by ADR-024) and `actor: "console:owner"` — a fixed string, since the console has
  exactly one account and no per-user identity of its own (ADR-023/025). `gateway config history`
  already prints both fields verbatim, which is what makes a console-made change distinguishable
  from a CLI apply or a management agent's own commits without any further change to that command.
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
  Vite plugin; the plain declarative `<BrowserRouter>`/`<Routes>`/`<Route>` JSX is the smaller,
  more direct fit over a data router (`createBrowserRouter`), and the controller's own SPA
  fallback (above) is what makes every deep link work regardless of which router renders it. One
  consequence of not using a data router: `useBlocker` (blocking in-app navigation away from an
  unsaved form) needs one and so is not available; the Agents hub's editor (below) guards its own
  "back to Agents" action with a plain confirm dialog instead, and relies on `beforeunload` for
  closing the tab or reloading — not a blanket block of every possible navigation away from an
  unsaved edit.
- **Data fetching: TanStack Query for the status poll, a small typed fetch wrapper
  (`lib/api-client.ts`) underneath it for everything.** The wrapper owns the transport concerns
  shared by every call — same-origin credentials, the `X-CSRF-Token` header on mutations, parsing
  every response against the shared Zod contracts below, and reporting every `401` to a single
  handler the session layer registers (`setUnauthorizedHandler`), the same fallback-to-sign-in
  behavior the status poll's own query already had, now shared by the Agents hub's list, its
  editor and its preview/commit calls too, instead of each needing its own wiring. A mutation
  refused with a `403` naming the CSRF token (another tab signed in anew since this one captured
  its copy, or the routing key it derives from rotated) refreshes the token from one session check
  and retries the same request once before giving up. Query earns its place only for the status
  poll specifically: `refetchInterval` plus its own stale/error/pending state already is the 15 s
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
- **CSP: `script-src 'self'; style-src 'self'; style-src-elem 'self' 'unsafe-inline'`, no
  `'unsafe-inline'` on script and no `'unsafe-eval'` anywhere.** Vite's production build emits no
  inline `<script>` (confirmed by inspecting the built `index.html`) and
  `build.modulePreload.polyfill: false` removes the one inline snippet Vite would otherwise add.
  shadcn/ui's components are built on Radix primitives, which do set `element.style` directly in
  JavaScript (visibility, positioning) — that is CSSOM manipulation, which no `style-src*`
  directive governs (only a `style="..."` HTML attribute or a `<style>` element would be), so it
  needed no loosening. A `<style>` element is a real exception, though: Radix's scroll lock (every
  popover-based component with a modal overlay — `Dialog`, `AlertDialog`, `Select` — the Agents
  hub's editor and its "review changes" dialog all use at least one) inserts one, with static,
  never attacker-influenced content, while open. `style-src-elem 'unsafe-inline'` allows exactly
  that element and nothing else: a `style="..."` attribute is still refused (no
  `style-src-attr 'unsafe-inline'`, and `style-src-attr` falls back to the unchanged `style-src`),
  and no cross-origin stylesheet is allowed either. Confirmed by loading the signed-in dashboard
  and the Agents hub's editor (open the dialog, apply a change) in a real browser, zero CSP
  violations reported, before and after this directive was added (its absence was caught by that
  exact reproduction, not assumed safe). `img-src 'self' data:` and `font-src 'self'` are the only
  other additions beyond ADR-023's original policy, for the small inlined icons a component
  library tends to carry and for the SPA's own fonts, should it ever ship any (today it ships
  none; the system font stack is used throughout). One thing did need an explicit change, not a
  CSP exception: Zod builds each object schema's fast parser at construction time by probing
  whether `new Function(...)` works, catching the resulting error itself when it doesn't — but the
  browser still reports that caught throw as a `script-src` violation before the catch runs.
  `z.config({ jitless: true })` (`apps/console/src/lib/zod-config.ts`, imported first, before
  anything that constructs a schema) skips the probe entirely; this is Zod's own documented fix
  for exactly this CSP interaction, not a workaround of ours.
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
- **Storing the CSRF token (or its hash) at all, rotated on every `GET /api/session`.** This was
  the original decision here; superseded once a second tab's own `GET /api/session` turned out to
  invalidate the first tab's still-in-use token (a real, reported problem, not a hypothetical
  one), since rotation and multi-tab correctness are in direct tension: storing a value that can
  be rotated at all means some request, somewhere, is holding a copy that is about to go stale.
  Deriving the token from the session instead (above) needs nothing stored and so has nothing to
  rotate; a second tab's check computes the identical value instead of minting a new one.
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
- A CSRF token derived from a revoked or expired session's own token is simply never checked
  against anything live: `authenticate` (session validation) runs first and already returns
  unauthenticated before any CSRF comparison happens, so there is no separate staleness window
  for the CSRF value the way the earlier rotating design had. A tab's copy can only go wrong by
  no longer having a valid session at all, which a `401` already reports as such.
- The Agents hub's management API (`console-management.ts`, both the controller's routing module
  and core's read models/change-set translation) reuses `prepareChange`/`commitChange` entirely:
  it adds no new way to write configuration, only a bounded, typed patch DTO translated into the
  same change operations `gateway agent enable|disable` and `config import` already produce. A
  commit's `source: "console"` is a value ADR-024 already reserved for this; no migration or
  `CHECK` constraint changed to add it.
