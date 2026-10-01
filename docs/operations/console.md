# The owner's console

A management console for one owner: today, a status page showing which agents are running, what
they are doing, how deep the queues are, what alerts are firing, today's budgets, and the
Gateway's own context measurements. The read-only design is [ADR-023](../adr/023-console-and-operator.md);
session authentication, CSRF and exact Origin checks are [ADR-025](../adr/025-management-console.md),
which also replaces ADR-023's HTTP Basic. The operator agent that answers the same "what's going
on" question in Mattermost is in [the observability guide](observability.md#the-console) and its
own section below.

## Enabling it

The console is off by default. On the home server it needs: a password, `CONSOLE_ORIGIN` left at
its default, the setting turned on, and Caddy already proxying `gateway.local`. A first install
gets that from [home-server.md](home-server.md#mattermost) already; turning the console on after
an upgrade from an older home server kit needs an extra step first, in
[UPGRADE.md](../../deploy/release/UPGRADE.md#upgrading-to-030).

1. Set the password (hidden entry, confirmed twice; only its Argon2id hash is written, to
   `secrets/controller/console_password_hash`, mode `0600`):

   ```bash
   bin/agw run --rm gateway-cli gateway console password set
   ```

2. Turn it on in `gateway.env`:

   ```bash
   CONSOLE_ENABLED=true
   ```

   `CONSOLE_ORIGIN` already defaults to `https://gateway.local` in `gateway.env.example`; change
   it only together with whatever Caddy site actually serves the console, since every login and
   mutation is refused unless the browser's `Origin` header matches it exactly.

3. Apply it: `CONSOLE_ENABLED` is a `gateway.env` change, and `docker compose restart` does not
   re-read an updated `.env` file, only recreating the container does:

   ```bash
   bin/agw up -d gateway-controller
   ```

The controller reads the password hash once, at start; it refuses to start at all if
`CONSOLE_ENABLED=true` and the hash file is missing, empty, or not private (mode `0600`, no
symlink, not group- or world-readable), or if `CONSOLE_ORIGIN` is not a plain origin (scheme and
host, no path) or is `http://` pointed at anything other than `localhost`/`127.0.0.1` (the session
cookie is `__Host-`/`Secure`; only a loopback origin — `console:dev`'s own Vite dev server — is
exempt from needing TLS). This is deliberate: a half-configured console must never end up serving
unauthenticated, or silently skip only the console and start everything else.

**Rotating the password** writes a new hash file and, when the CLI can also reach the database,
revokes every active session immediately; either way, a plain restart (`bin/agw restart
gateway-controller`) is enough to make sure, since the controller also stops accepting any
session created under the old hash the moment it restarts with the new one. There is one
account; it is never a Mattermost username or any other identity the rest of the Gateway uses.

## Opening it

`https://gateway.local`, from any device on the home network that already trusts the home
server's Caddy root certificate (the same one trusted for `mattermost.local`; see
[home-server.md](home-server.md#mattermost)). It is a single-page app (React, ADR-025's frontend
section): visiting it loads the same page regardless of path, which checks its own session and
shows a sign-in screen (just a password field — there is no username any more) or the dashboard.
Signing in sets a session cookie good for 12 hours, or 30 minutes of inactivity, whichever comes
first. **Sign out** from the sidebar, or by calling `DELETE /api/session` directly (see below).

There is no host port: the controller's listener binds only its own alias on the `agent-mm`
network (`gateway-console`, port 8084), the same network Caddy and Mattermost share. Nothing on
`agent-control` (the workers, connectors and tool runner) can reach it, and nothing outside the
home server's LAN can either, unless the home server's own network is exposed further.

Routes:

| Route | Method | Needs | What it does |
|---|---|---|---|
| `/assets/*` | `GET`/`HEAD` | — | The SPA's own built, content-hashed files; `Cache-Control: public, max-age=31536000, immutable`. |
| any other non-`/api/*` path | `GET`/`HEAD` | — | The SPA's `index.html` (`Cache-Control: no-store`) — `/`, `/agents`, any deep link the SPA's own router recognizes. A missing build logs once and serves a plain `503` here only; `/api/*` is unaffected. |
| `/api/session` | `GET` | — | `{authenticated, csrfToken?, expiresAt?}` for the current cookie; the CSRF token is derived fresh from it when authenticated, never rotated. |
| `/api/session` | `POST` | exact Origin | JSON `{password}`; returns `{csrfToken, expiresAt}` and sets the cookie. |
| `/api/session` | `DELETE` | session, exact Origin, CSRF header | Logs out: revokes the session and clears the cookie. |
| `/api/status` | `GET` | session | The same projection as JSON, for scripting or a quick `curl` once signed in. |
| `/api/agents`, `/api/agents/:id` | `GET` | session | Every agent, or one agent's full editable configuration — see "Managing agents" below. |
| `/api/agents/:id/preview`, `/api/agents/:id/commit` | `POST` | session, exact Origin, CSRF header | Preview or commit a configuration change to one agent. |
| `/api/config/revisions`, `/api/config/revisions/:id/diff` | `GET` | session | The configuration's revision history, and a structural diff of one revision against its parent. |

Every response — success, a failure, even a `503` for a missing build — carries
`Cache-Control: no-store` (except the SPA's own immutable assets above), a restrictive CSP
(`default-src 'none'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self';
frame-ancestors 'none'` — no inline script anywhere, no `unsafe-eval`; `style-src-elem`'s
`unsafe-inline` is narrow and documented in ADR-025, for Radix's own scroll-lock `<style>` element,
never for an inline `style="..."` attribute), `X-Content-Type-Options: nosniff`,
`Referrer-Policy: same-origin` and `X-Frame-Options: DENY`. There is no permissive CORS. A
mutation (`POST`/`DELETE`) additionally requires the request's `Origin` header to equal
`CONSOLE_ORIGIN` exactly, and, when the browser sends it, `Sec-Fetch-Site: same-origin`; a
logout additionally requires the raw CSRF token `GET`/`POST /api/session` returned, in an
`X-CSRF-Token` header, matching the value the server derives from the session's own cookie
(ADR-025) — nothing is stored for this, so two tabs sharing one session always agree on the same
token, and neither one's own session check invalidates the other's copy.

Scripting a login without a browser:

```bash
curl -s -c cookies.txt -H 'content-type: application/json' -H 'origin: https://gateway.local' \
  -d '{"password":"..."}' https://gateway.local/api/session
curl -s -b cookies.txt https://gateway.local/api/status
```

## Managing agents

The Agents hub (`/agents`) lists every agent in the active configuration and lets the owner edit
an existing one; creating or deleting an agent is not available from the console yet (`gateway
config apply`/`import` still does that). An agent disabled and retained outside the active
configuration (`gateway agent disable` falling back to `remove_agent` for a stale, no-longer-valid
row — see the Overview tab's note below) is left out of this list entirely, consistent with its
own detail route, which 404s for it the same way. Open an agent from the list to its editor, which
has one tab per group of fields:

| Tab | Editable fields |
|---|---|
| Overview | Display name, enabled, plus the agent's current state and recent runs (from the same `/api/status` data the overview page shows — not a separate query). Disabling a *retained* agent whose own stored configuration no longer validates falls back to removing it from the configuration outright (the same fallback `gateway agent disable` already has); the preview's "impact" list says so before applying. |
| Instructions | The role prompt (monospace, bounded at 50,000 characters, the same limit `set_role_prompt` enforces everywhere else). |
| Runtime | Runtime adapter, model (clearing the field back to blank removes the override, falling back to the runtime adapter's own default — not merely leaving the stored value untouched), session policy, timeout. |
| Assignments | Allowed Mattermost channels (from the organization's own configured list), wake rules (event type and an optional target agent). |
| Permissions | The three tool-pattern lists (`tools_allow`, `tools_require_human_approval`, `tools_deny`) and `observe_system`. |
| History | Revisions that touched this agent, each with its own diff. |

The Mattermost identity (bot username, token secret path), memory namespaces, concurrency and any
configured budget are shown but not editable here — there is no tab for them yet.

Edits accumulate in a local draft (only the fields actually touched, never a whole snapshot);
nothing is sent until **Review changes** is clicked, which shows a preview (the exact diff
`prepareChange` computes, ADR-024) before anything is written. Destructive or authority-reducing
consequences (disabling the agent, removing a channel, removing a tool grant, removing
`observe_system` or a deny rule, removing a tool's human-approval requirement) *and*
authority-increasing ones (enabling the agent, adding a channel, granting a tool or
`observe_system`) alike appear in the preview's own "impact" list and must be acknowledged before
**Apply** is enabled. Applying commits through the same `prepareChange`/`commitChange` service
every other configuration surface uses:

- **A conflict** — the editor's own loaded revision is no longer the one actually active, because
  someone else (another tab, `gateway config apply`/`import`, an agent's own commit) committed a
  change to the same agent since this edit began — is refused with `409` and the revision that is
  now active, at preview time already (never silently previewed against that newer state in the
  stale view's place) and, redundantly, at commit time too. **Reload and try again** re-reads the
  agent's current configuration and rebases the draft onto it: a field the owner did not touch is
  unaffected either way, a touched field whose own value did *not* change upstream survives
  unchanged (to be re-previewed against the fresh state), and a touched field that *also* changed
  upstream is dropped from the draft with a visible notice — the owner's own edit to that one
  field is never silently applied over someone else's conflicting change to the very same field.
- **An invalid change** (a business-rule problem — a configuration-breaking change, or a
  protection like "pause a running agent before disabling it") is reported inline, with the
  server's own message; nothing is written.
- Applying twice with the same idempotency key (a retried request after a dropped response, say)
  replays the first commit's own recorded result rather than writing a second revision: the change
  being applied is always recomputed from the configuration as it stood at the draft's own base
  revision, never from whatever is live at the moment of the request, so a retry recomputes the
  identical change every time and replays correctly even if something else has changed the agent
  again in the meantime, rather than risking a spurious "the same key, a different change set"
  refusal.

Every commit the console makes is a normal, auditable configuration revision: `gateway config
history` shows it with `source: console` and `actor: console:owner`, the same way a `cli_apply`
or an `import` shows up, and `gateway config export`/`diff`/`rollback` all see it exactly as they
would any other revision — a console edit is not a separate kind of change the CLI's own tooling
has to special-case. `config apply`/`import` from a YAML directory continue to work unchanged and
independently of anything edited from the console; whichever happened most recently is simply the
configuration that is now active, visible in the same journal either way.

## Building and running it in development

`apps/console` is its own bun workspace (React, Vite, Tailwind CSS v4, shadcn/ui):

- **`bun run console:build`** — `vite build` into `apps/console/dist` (gitignored); this is the
  only thing the release image actually uses (`deploy/images/Dockerfile`'s `console-build`
  stage). No source maps, hashed asset filenames, no inline script in the built `index.html`.
- **`bun run console:dev`** — a Vite dev server with hot reload, proxying `/api/*` to a running
  controller's console listener (default `http://127.0.0.1:8084`; override with
  `CONSOLE_DEV_PROXY_TARGET`) so the same relative API calls the built app makes work unchanged.
  Start a controller with the console enabled first (`CONSOLE_ENABLED=true`,
  `CONSOLE_ORIGIN=http://localhost:5173` to match Vite's own dev origin, a password set the same
  way as any other environment, and `GATEWAY_ROUTING_KEY` set regardless of `OUTBOX_DELIVERY` —
  the console's CSRF derivation reuses it independently of whether this controller is actually
  running the Mattermost bridge) and point this at it.
- Unit tests for the console live alongside its source (`*.test.tsx`, React Testing Library +
  happy-dom) and run as part of `bun run test` like everything else; `bun run fix`/`check`
  typecheck it too (`tsc -b apps/console`, its own project — a browser app needs the DOM lib and
  Vite's own `types`, which do not belong in the same `tsc` program as the backend's `@types/bun`
  globals, so it is checked as a second, separate program).

## What each section shows

The page refreshes itself every 15 seconds (a plain `<meta http-equiv="refresh">`; there is no
client-side script). The data behind it is a single collection shared by every request and
cached for the same 15 seconds, so an outage never means one database round trip per visitor.

- **Top summary:** the kill switch, approvals pending, tool actions in an unknown state, outbox
  items pending and dead, and how many agents were left out of the page by its own bound
  (`omittedAgents`) — the list never grows without limit just because the Gateway does.
- **Alerts:** every condition firing right now (the same keys `gateway doctor` and
  `gateway_alert_firing` show), with when each started.
- **Agents:** one card per agent, each with its state and how long it has held it, its runtime
  adapter and model, today's token and cost budget (against the configured daily limit, when
  one exists), its pending inbox count, its current task (status, attempt, trigger, channel,
  thread, queued/started/deadline timestamps) or "No current task", any waits it holds, and the
  context measurements below.
- **Recent runs:** a table of the latest runs across every agent: status, outcome, error code,
  trigger, timestamps and the last attempt's reported tokens.
- **Queues:** waiting and active job counts per queue, and the age of the oldest waiting job;
  a dead letter queue is marked with a `DLQ` pill.
- **Footer:** runtime availability per adapter, and the last successful time of each
  maintenance task (retention, the recorded backup check).

Never shown, on the page or in the JSON: message bodies, run summaries, memory content, wait
conditions in prose, or anything credential-bearing. This is the same metadata/content boundary
`SystemStatus` itself carries (ADR-023) — the console renders exactly that shape of fact, never
more.

## Context measurements

Per agent, instead of a context-window fill percentage:

| Measurement | What it is |
|-------------|------------|
| Input bytes / cap | the serialized turn input's size against the Gateway's 2 MiB cap (ADR-019) |
| Recent-replies chars / budget | the thread's recent-replies budget, separate from the root and summary budgets |
| Root chars / cap | the root post's own character cap |
| Summary chars / limit | the thread summary's character limit |
| Memory chars / budget (items) | shared and private memory folded into the turn, against its budget, and how many items |
| Last attempt input / cached input / output tokens | what the runtime reported for the run's **last** attempt only |
| 7-day max input tokens | the largest last-attempt input token count retained over the last 7 days |
| Omitted thread posts, pending events | what the fold left out and what is still queued for the agent |
| Model | the provider model id, when the runtime reports one |

There is no context-window percentage anywhere on this page, and there never will be: the
Gateway does not know a provider's context window size, and computing one against an unknown
denominator would fabricate a precision the Gateway does not have. A runtime that sums several
internal model calls into one reported total (Codex, for instance) is shown as that runtime's
own total, not decomposed. None of this is a live or authoritative token count — it is the
Gateway's own character budgets and the last stored attempt's own usage report, not a substitute
for one.

## Limits and troubleshooting

- **`401 unauthorized`:** no session cookie, or an expired/revoked/wrong-password one. The SPA
  itself shows the sign-in screen once its own session check comes back this way, instead of a
  browser dialog; signing in again is all that's needed. Check the password was actually set
  (`console_password_hash` exists) and the controller picked it up: `bin/agw up -d
  gateway-controller` after first turning `CONSOLE_ENABLED` on, `bin/agw restart
  gateway-controller` after only rotating the password.
- **`403` on sign-in or a mutation:** the request's `Origin` header did not exactly equal
  `CONSOLE_ORIGIN`, carried `Sec-Fetch-Site: cross-site`, or its `X-CSRF-Token` header was missing
  or did not match. A browser pointed at anything other than `CONSOLE_ORIGIN` itself (a different
  hostname, `http://` instead of `https://`, a port) always gets this; a plain `curl` needs the
  matching `-H 'origin: ...'` shown above. The SPA itself recovers on its own from a stale CSRF
  token specifically (another tab signed in again after this one's own copy was captured, or the
  controller's routing key — which the token derives from — rotated): it refreshes the token from
  one session check and retries the request once before showing anything; only a `403` that
  persists past that retry, or one naming the Origin instead, reaches the owner as an error.
- **`429 too many attempts` (with `Retry-After`):** failed logins share one bounded, global
  counter — ten failures per minute, across every client, not partitioned by address. A
  password-guessing attempt from anywhere blocks the owner too, along with the attacker;
  there is nothing to reset, only wait out the window.
- **`502` from Caddy:** either `CONSOLE_ENABLED` is `false` (the controller starts with no
  console listener at all) or the controller is down. Caddy's route to a missing console is
  harmless — it just means nobody reaches it until the controller and its console setting are
  both in order.
- **The stale banner:** the last successful collection is shown with its own timestamp, marked
  stale, because the most recent one failed or ran too long. The page (and `/api/status`) still
  return `200`. Check the controller's logs and the database.
- **The unavailable page (HTTP `503`):** no collection has ever succeeded since the controller
  started. This is different from stale: there is no last-known snapshot to fall back to yet.
- **`503 busy`:** too many concurrent login attempts are already verifying their password hash
  (Argon2id is deliberately expensive); retry shortly.
- **A plain-text `503` on the page itself (not on `/api/*`):** the built SPA is missing or
  incomplete at the directory `CONSOLE_STATIC_DIR` names (default the path the release image
  bakes it into). The controller logs this once at start and keeps serving `/api/*` normally —
  only the UI is affected. In the release image this should never happen
  (`deploy/images/Dockerfile` builds it in); in development, run `bun run console:build` first.
- A login body larger than expected (well past the longest password `gateway console password
  set` accepts, plus field overhead) is refused with `400` before anything is parsed.
- **Signed out sooner than expected:** sessions are capped at 20 active at once (creating one
  beyond that revokes the oldest), idle out after 30 minutes of no request, and expire
  absolutely after 12 hours regardless of activity. Signing in again is the only recovery; none
  of this is configurable per ADR-025's threat model (one owner, one browser at a time).

## The operator agent

The default `operator` example agent (`config/examples/agents/operator.yaml`) answers the same
"what's going on" question inside Mattermost, from `permissions.observe_system` rather than the
console's own projection — see [the operator's own section](observability.md#the-console) and
[releases.md](releases.md#the-v2-compatibility-rule) for what rolling back past this release
needs.
