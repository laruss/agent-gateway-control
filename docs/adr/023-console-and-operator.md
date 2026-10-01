# ADR-023. The owner's console and the operator agent's system status

- Status: Accepted
- Date: 2026-09-30

## Context

The owner sees the Gateway only through Mattermost, `gateway health`/`doctor` and JSON logs
(ADR-019). None of these is a live, at-a-glance view of what is running right now, and no agent
can answer "what's going on" from real data: an agent asked that question has nothing but its own
turn to reason from. The owner wants a page to glance at from any device on the home network, and
a default agent that can be asked the same question in Mattermost and answer from the Gateway's
own state instead of guessing.

Two existing boundaries must hold for both: the metadata/content boundary that keeps a turn from
carrying message text across channels it isn't allowed in (ADR-022), and the size and versioning
discipline the turn input already has (ADR-009, ADR-010, ADR-019's 2 MiB cap). Mutating anything
from the console or through this permission is out of scope: both are read-only.

## Decision

### The console

- **Read-only, controller-rendered, server-side HTML.** No client framework, no build step: the
  controller escapes every dynamic value itself and serves plain markup. This is an explicit
  exception to the shadcn-first UI rule, noted where that rule lives
  (`.claude/rules/basic-rules.md`): a single static, read-only, one-owner status page does not
  earn a component library or a frontend build the project has never otherwise needed.
- **A separate listener,** joined to Caddy as a local site (`https://gateway.local`) through the
  home server's existing reverse proxy (ADR-021), reusing its `local_certs` authority. The
  controller publishes no host port for it; only Caddy, inside the VM's network, reaches it.
- **HTTP Basic authentication for one owner account.** The password is never stored: only its
  Argon2id hash, in a controller secret, written by a hidden-entry CLI command. Failed attempts
  are rate-limited behind one bounded, global counter (`429` with `Retry-After`); every response,
  success or failure, carries `Cache-Control: no-store`, a restrictive CSP, `nosniff`,
  `no-referrer` and frame protection. No permissive CORS, no mutation route, nothing
  credential-bearing in a log or an error body.
- **A bounded, cached, read-only collection,** refreshed on a short cycle (seconds, not
  real-time), shared by every request so an outage does not mean one collection per visitor. A
  failed or slow collection is shown as stale (with its last-known timestamp) or unavailable,
  never silently as an empty, healthy system.
- **What it shows:** agent states, current tasks, recent runs, waits, queue depths, alerts,
  configured budgets, and the context measurements below — never message bodies, run summaries
  reproduced verbatim beyond what is already public to the owner, or credentials.

### The operator agent and `observe_system`

- **A new permission,** `permissions.observe_system` (`packages/contracts/src/agent-config.ts`),
  boolean, off by default. When an agent's configuration sets it, the scheduler collects
  `SystemStatus` (`packages/contracts/src/system-status.ts`) and hands it to that agent's turn.
  A default example agent, the operator, ships with it enabled, Codex, ordinary replies in its
  existing channels, and no other grant: no shell, filesystem, web, admin or execution tool, no
  shared-memory write.
- **The metadata/content boundary.** `SystemStatus` carries operational metadata only: agent
  ids and states, run ids, statuses, attempts and trigger types, queue depths, alert keys and
  timestamps, maintenance task names, token and cost counts. It never carries message text,
  thread content, run summaries, wait conditions, memory content, secrets or provider session
  identifiers. Every list is bounded (`SYSTEM_STATUS_LIMITS`), and every field is a Gateway-made
  identifier, a count, a timestamp or an enumerated code, never free text — the schema itself,
  not only the query that fills it, keeps content out.
- **Why this does not cross ADR-022's channel boundaries.** ADR-022 bounds what a turn may carry
  about *conversations*: posts, threads and summaries of channels an agent isn't granted.
  `SystemStatus` is not conversation content from any channel; it is the same shape of
  operational fact `gateway health` and `gateway doctor` already show an operator outside any
  channel, for every agent, not only ones sharing the observing agent's channels. That is
  intentional, and exactly why it is its own explicit, off-by-default permission rather than
  something every agent receives automatically: it is a deliberate grant of visibility across the
  whole Gateway's operation, not a channel grant, and must be given knowingly to one read-only
  agent rather than inherited from being added to a channel.
- **It grants no action.** `observe_system` only appends a data field to the turn's input; it
  changes nothing the agent may do. Tool policy, wait matching and memory-write authority are
  unaffected, and an operator turn's result passes through the same authority checks as any
  other turn (ADR-009).

### Turn input version 2

- `AgentTurnInput.schemaVersion` is `1 | 2`. Version 1 is every turn and is unchanged in shape.
  Version 2 adds `systemStatus`; a version 1 input never carries it and a version 2 input always
  does, enforced by a cross-field check, since structural JSON Schema cannot express an
  either-or between a discriminant and a field's presence (ADR-010). `AgentTurnResult`'s own
  schema version is untouched: this is an input-only change.
- **Rollback consequence.** An older release's `AgentTurnInputSchema` accepts only version 1 and
  rejects a version 2 run job outright. This is not a database migration concern — no column or
  certified history changes for the input's own sake — but a release-compatibility one distinct
  from ADR-020's schema certification: config and queued-input compatibility. Rolling back past
  this release requires turning `observe_system` off and settling or cancelling outstanding
  version 2 work first, so no version 2 job is left for a release that cannot read it.

### Context measurements

- Neither the console nor a turn's own status ever shows a context-window fill percentage: the
  Gateway does not know a provider's context window size, and a synthesized percentage against an
  unknown denominator would fabricate a precision the Gateway does not have.
- What is shown instead are separate, labeled measurements: the Gateway's own character budgets
  (thread, summary and memory each have their own limit — the recent-replies budget is distinct
  from the root and summary budgets), the serialized turn input's size in bytes against the 2 MiB
  cap (ADR-019), and the tokens a runtime reported for the run's **last attempt**. A runtime that
  sums several internal model calls into one reported total (Codex, for instance) is shown as
  that runtime's own total, not decomposed by the Gateway. None of these is a live or authoritative
  token count, and an attempt retried before the last stored one is not reconstructed from
  history.

## Alternatives

- **A separate console frontend service or build.** Adds a deploy artifact, a build step and a
  second surface for a single owner's page; the scale of the need does not justify it.
- **Session cookies instead of HTTP Basic.** Needs a session store and CSRF handling for a
  single-user, read-only page; Basic authentication behind Argon2id and rate limiting is simpler
  and enough for this threat model.
- **Every agent receiving system visibility implicitly.** Rejected: visibility across every
  agent's state and the whole queue is strictly more than any channel grant conveys (ADR-022), so
  it must be its own explicit, off-by-default, per-agent permission.

## Consequences

- An operator agent can answer "what's running" truthfully without the owner opening a terminal,
  but only for the one agent explicitly marked `observe_system: true`; the permission is visible
  in configuration review the same way a tool grant is.
- Because version 2 is refused entirely rather than silently downgraded, a rollback past this
  release must first ensure no version 2 work is outstanding; this is a deploy-runbook step, not
  a schema one, and is rehearsed like any other upgrade/rollback path.
- The console depends on Caddy and the home server's existing TLS; setting a console password
  alone does not expose it anywhere the reverse proxy isn't already wired to reach it.
- Character and byte measurements describe the Gateway's own budgets and can diverge from what a
  given model's own tokenizer would count; they are not a substitute for a runtime's own usage
  report.
- A restrictive Gateway-token charset (letters, digits and a few separators) fits every other
  field of `SystemStatus`, but not a provider's model name or a runtime's version string, which
  may legitimately contain spaces, `+` or parentheses; those two fields are typed as bounded
  strings, the same shape used for them elsewhere in the contracts, instead of the restrictive
  charset.
