# The owner's console

A read-only status page for one owner: which agents are running, what they are doing, how deep
the queues are, what alerts are firing, today's budgets, and the Gateway's own context
measurements. The design is [ADR-023](../adr/023-console-and-operator.md); the operator agent
that answers the same question in Mattermost is in
[the observability guide](observability.md#the-console) and its own section below.

## Enabling it

The console is off by default. On the home server it needs three things: a password, the
setting turned on, and Caddy already proxying `gateway.local`. A first install gets that from
[home-server.md](home-server.md#mattermost) already; turning the console on after an upgrade
from an older home server kit needs an extra step first, in
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

3. Apply it: `CONSOLE_ENABLED` is a `gateway.env` change, and `docker compose restart` does not
   re-read an updated `.env` file, only recreating the container does:

   ```bash
   bin/agw up -d gateway-controller
   ```

The controller reads the password hash once, at start; it refuses to start at all if
`CONSOLE_ENABLED=true` and the hash file is missing, empty, or not private (mode `0600`, no
symlink, not group- or world-readable). This is deliberate: a half-configured console must
never end up serving unauthenticated, or silently skip only the console and start everything
else.

**Rotating the password** is different: only the hash file's content changes, and the
controller still reads it just once at start, so a plain restart is enough to pick it up — run
`gateway console password set` again, then `bin/agw restart gateway-controller`. There is one
account, fixed to the username `owner`; it is never a Mattermost username or any other identity
the rest of the Gateway uses.

## Opening it

`https://gateway.local`, from any device on the home network that already trusts the home
server's Caddy root certificate (the same one trusted for `mattermost.local`; see
[home-server.md](home-server.md#mattermost)). The browser's own HTTP Basic dialog asks for the
username (`owner`) and the password just set.

There is no host port: the controller's listener binds only its own alias on the `agent-mm`
network (`gateway-console`, port 8084), the same network Caddy and Mattermost share. Nothing on
`agent-control` (the workers, connectors and tool runner) can reach it, and nothing outside the
home server's LAN can either, unless the home server's own network is exposed further.

Two routes exist, both read-only and both requiring the same credential: `GET /` (the HTML
page below) and `GET /api/status` (the same projection as JSON, for scripting or a quick
`curl`). Every response — success, a failure, even the `401` challenge itself — carries
`Cache-Control: no-store`, a restrictive CSP, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`. There is no permissive CORS and no
mutation route of any kind.

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

- **`401 unauthorized`:** no `Authorization` header, or a wrong username/password. The browser
  re-prompts on its own; check the password was actually set (`console_password_hash` exists)
  and the controller picked it up: `bin/agw up -d gateway-controller` after first turning
  `CONSOLE_ENABLED` on, `bin/agw restart gateway-controller` after only rotating the password.
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
- A request with an `Authorization` header longer than expected (well past the longest password
  `gateway console password set` accepts) is refused with `400` before anything is parsed.

## The operator agent

The default `operator` example agent (`config/examples/agents/operator.yaml`) answers the same
"what's going on" question inside Mattermost, from `permissions.observe_system` rather than the
console's own projection — see [the operator's own section](observability.md#the-console) and
[releases.md](releases.md#the-v2-compatibility-rule) for what rolling back past this release
needs.
