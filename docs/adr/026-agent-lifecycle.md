# ADR-026. Agent lifecycle: durable provisioning state, separate from desired configuration

- Status: Accepted
- Date: 2026-10-02

## Context

Today, creating an agent means writing a YAML file, running `gateway config apply`, then
`gateway mattermost bootstrap` with a temporary admin token, then `gateway mattermost reconcile`
to confirm it worked. Nothing records that a bot was ever created for an agent id beyond the
`mattermost_identities` row bootstrap happens to leave behind, and nothing stops the same id from
being configured again after its bot has been retired — bootstrap would simply adopt whatever
account (or none) it finds. An owner creating or retiring agents from the console needs the
Gateway itself to drive that provisioning, with a durable record of what is wanted, what is
actually done, and what to do next after a crash mid-way. This decision introduces that record —
the lifecycle and provisioning *status* of an agent's Mattermost identity, tracked apart from its
desired configuration — and the operations that change it. It makes no Mattermost call of its own;
automated provisioning is a later decision, which this one anticipates and prepares storage for.

`commitChange`/`prepareChange` (ADR-024) already give configuration a prepare/commit path with a
revision journal, conflict detection and idempotency. An agent's *provisioning* status is a
different axis entirely: `agents.enabled` says whether the owner wants the agent to run; it says
nothing about whether a bot account, a token and channel memberships actually exist for it yet.
Conflating the two would make an agent schedulable the instant its configuration is committed,
before anything about it exists in Mattermost at all.

## Decision

### Desired configuration vs provisioning status

An agent's configuration (`AgentConfig`, in the configuration journal) states what is *wanted*:
its role, its runtime, its permissions, whether it is enabled. A separate `agent_lifecycle` row
states what is *actually provisioned*, one row per agent id ever created through this service or
adopted from a pre-existing configuration:

- `pending` — desired, nothing provisioned yet.
- `reconciling` — a provisioning operation is actively running.
- `ready` — provisioned and schedulable.
- `failed` — the last operation did not succeed; a bounded `last_error` names why, never a secret.
- `retiring` — retirement has been requested and its configuration change committed; cleanup has
  not finished.
- `retired` — terminal.

```
pending ----> reconciling ----> ready ----> retiring ----> retired
   |              |               |
   +--- failed <--+--- failed <---+
        (retry: reconciling again, later work)

retired ----> pending   (restore: re-adds the last known configuration)
```

A `generation` column on `agent_lifecycle`, bumped by every desired-state change (`create`,
`retire`, `restore`, and later `reprovision`), and an `operation_id` naming the operation currently
(or last) pursuing it, are what let a stale worker's own completion be told apart from a live one
(below).

### Scheduling only when ready

The scheduler already refuses to start a run for a disabled or paused agent. It now refuses one
for an agent whose lifecycle status is not `ready`, in exactly the same place and the same way —
the event stays in the inbox, recorded but not run, until the status becomes `ready` and something
wakes the agent again (`completeOperation` does so itself; the periodic sweep is the backstop for
everything else). An agent with no `agent_lifecycle` row at all — only possible for a database
whose adoption backfill (below) has not run yet — is unaffected: scheduling behaves exactly as it
did before this table existed.

### Immutable ids, never reused

An agent id is never reused. `requestAgentCreate` refuses an id that already has an
`agent_lifecycle` row in any status, including `retired`: a retired agent's bot, its audit trail
and its memory stay attributed to exactly the id that earned them, never silently inherited by an
unrelated later agent of the same name. A Mattermost username already used by another agent's
identity is refused the same way, whether or not that agent is still active.

### One operation journal

`agent_lifecycle_operations` is an append-only journal, one row per lifecycle operation
(`create`, `retire`, `restore`, `reprovision`, `adopt`), naming who asked for it (`requested_by`,
`source`: a CLI session, the console, or an agent), an optional idempotency key, the configuration
revision it carried, the `generation` it pursues, its own state (`pending -> running -> {succeeded,
failed, cancelled}`), and `checkpoints` — ids and references only, never a token's value, filled in
by the provisioner as it completes each external step (a later decision adds the actual steps:
`bot_user_id`, `token_ref`, `team_joined`, `channels_joined`). A database trigger enforces the
append-only guarantee at the column level, the same way the configuration journal's guard does
(ADR-024): every identity column is immutable once written, and only `state`, `checkpoints`,
`error` and the timestamps besides `created_at` may ever change, moving `state` forward only.

`requestAgentCreate` validates the request — the id's format, that it is unused, that the
Mattermost username is free, that the resolved runtime adapter has a fresh, ready worker on this
deployment (`runtime_workers`, migration 0007) — then, in one transaction, commits an `add_agent`
change set (`enabled: true`) through the same `commitChangeIn` the managed-configuration service
uses and records the agent `pending` with a `create` operation `pending`. A failure anywhere in
that transaction — an invalid configuration, a duplicate id discovered under the lock — rolls back
the configuration change and the lifecycle rows together; nothing is ever left half-written. No
runtime adapter is assumed: when the request leaves the runtime unset, it defaults to the
deployment's Codex settings — adapter `codex`, and the one model every already-enabled Codex agent
agrees on, or none when they disagree or none is set. Concurrency is fixed at one active run per
agent, the same bound every other agent already has.

`requestAgentRetire` commits a `remove_agent` change set and moves the lifecycle row to
`retiring` with a `retire` operation `pending`, in the same transaction. The actual cleanup —
cancelling runs, waits and approvals, deactivating the bot, revoking its token — is later work;
this decision only records the desired state and an operation id for that work to resume and
complete through `markProvisioning`/`completeOperation`/`failOperation`.

`requestAgentRestore` moves a `retired` agent back to `pending`, re-adding its configuration from
the most recent recorded revision whose snapshot still named it (found by a jsonb containment
query over the configuration journal, rather than reconstructed by hand), with a `restore`
operation. A retired agent whose own historical configuration is no longer available — lost to
an upgrade from a release before the configuration journal existed — cannot be restored this way;
nothing here invents configuration that was never actually retained.

`markProvisioning`, `completeOperation` and `failOperation` are the state machine later
provisioning work drives: `markProvisioning` moves a `pending` operation to `running` (and the
agent to `reconciling`, unless it is a `retire`); `completeOperation` moves it to `succeeded` and
the agent to `ready` (`retired` for a `retire`), clearing `last_error` and waking the agent so any
inbox work that arrived while it waited runs without waiting for the periodic sweep;
`failOperation` moves it to `failed` and the agent to `failed`, recording a bounded error. All
three refuse an operation that is no longer its agent's current one: a request superseded by a
later one (a retire issued while a create was still provisioning, say) bumps `generation` and
replaces `operation_id`, and a stale worker's eventual completion of the old operation id is
refused rather than silently applied to a request nobody is waiting on anymore. A query helper
lists every operation left `running`: exactly what a controller resumes after a restart.

### Adoption of existing agents

Every agent in the active configuration snapshot that has no `agent_lifecycle` row yet is adopted:
`ready`, with a `succeeded` `adopt` operation recording the active revision at adoption time. This runs exactly
like `ensureConfigHistory` (ADR-024) — an idempotent TypeScript function, not a migration, called
at controller startup and at the start of every CLI session that touches a schema-compatible
database. Adoption never holds an agent back: an agent added through `config import` or
`config apply` runs exactly as before, its Mattermost identity still provisioned by
`gateway mattermost bootstrap`; only an agent created through the lifecycle waits in `pending` for
the provisioning its create requested — so an agent already adopted, including one later retired, is never touched again, and a
database with no active configuration at all does nothing. History before this release is not
reconstructed beyond what the active configuration and `mattermost_identities` already hold, the
same honesty ADR-024 already commits to for configuration history.

### What later work adds

Automated provisioning needs a Mattermost credential the Gateway does not have today: Mattermost
documents that bots cannot create other bots, so an agent's own bot token can never bootstrap the
next one, and the admin token `gateway mattermost bootstrap` uses today is a human's temporary
loan, revoked right after. The decision this ADR commits to for that later work is a **dedicated,
non-bot Mattermost system-admin account**, created once by the owner, whose personal access token
is stored read-only in controller secrets — broad account authority, constrained in code to
exactly the actions provisioning performs, never handed to a model. Because Mattermost access
tokens do not expire on their own, the token is rotated on a fixed schedule through
create-verify-switch-revoke: a new token is created and verified to work before the old one is
switched out of use, and only then is the old one revoked — a crash between any two of those steps
leaves a token that still works, never a provisioning path with no working credential at all.
Retirement's cleanup — cancelling an agent's runs, waits and approvals, deactivating its bot,
revoking its token, reconciling channel memberships — resumes through the same `agent_lifecycle`/
`agent_lifecycle_operations` rows this decision defines, via `markProvisioning`/`completeOperation`/
`failOperation`: that later work changes what runs between `requestAgentRetire` and
`completeOperation`, not the state machine itself.

## Alternatives

- **Track provisioning status on `agents` itself, alongside `enabled`.** Rejected: `agents` is the
  configuration projection `writeConfigRevisionIn` upserts wholesale on every change; folding a
  provisioning state machine into the same row would make a configuration change and a
  provisioning transition the same write, when they need independent locking, independent
  idempotency and independent failure handling (a provisioning crash must never roll back a
  configuration commit that already succeeded).
- **Reuse the configuration journal's own revision/source vocabulary for lifecycle operations.**
  Considered and partly adopted: a lifecycle request's `source` (`cli`/`console`/`agent`) maps onto
  the existing `ConfigRevisionSource` (`cli_apply`/`console`/`agent`) when the operation commits a
  configuration change, so the journal remains the one place that distinguishes a console edit
  from a CLI one. A separate, narrower enum for the operation journal's own `source` column was
  kept rather than widened to include `backfill`/`rollback`/`import`, none of which name a surface
  capable of asking for a lifecycle operation.
- **Reconstruct a retired agent's configuration from `agents`' own stale row instead of the
  configuration journal.** Rejected: `agents` retains only the *last* configuration an agent had
  before leaving the active bundle (ADR-024's own retained-row case), which a validation change
  since may have made invalid; the journal's own immutable snapshots are the one place a
  previously-valid configuration is guaranteed to still parse exactly as it did when it was active.

## Consequences

- An agent created through this service never creates a worker container: the runtime adapter
  named in its configuration must already have a ready worker, the same shared pool every other
  agent of that adapter uses.
- A configuration commit and a provisioning transition are independent failures: a console or CLI
  create can commit its configuration change and then crash before any provisioning work starts,
  leaving the agent `pending` indefinitely until something (a retry, later work's own supervisor)
  notices and calls `markProvisioning` again. This decision defines the rows that make that
  recovery possible; it does not itself add the supervisor.
- `agent_lifecycle_operations` grows without bound, like the configuration journal and the audit
  log; nothing here adds its own retention pass.
- A release before this one does not know these tables exist (ADR-020's expand-migration
  guarantee): rolling back to it loses nothing it ever read, and re-upgrading re-runs the adoption
  backfill exactly as it would on a fresh database.
