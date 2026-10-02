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

### Automated Mattermost provisioning

Automated provisioning needs a Mattermost credential the Gateway did not have before this:
Mattermost documents that bots cannot create other bots, so an agent's own bot token can never
bootstrap the next one, and the admin token `gateway mattermost bootstrap` uses is a human's
temporary loan, revoked right after. The credential is a **dedicated, non-bot Mattermost
system-admin account**, created once by the owner (`docs/operations/mattermost.md`), whose
personal access token is stored read-only in controller secrets — broad account authority,
constrained in code to exactly the actions provisioning performs, never handed to a model:

- **Secrets.** The admin token is `secrets/controller/mattermost_admin_token`
  (`MATTERMOST_ADMIN_TOKEN_FILE`), read-only to the controller and written only by
  `gateway mattermost admin-token set|rotate`, which run through the CLI container's existing
  read-write mount of that same directory; `gateway-cli` also reads `MATTERMOST_ADMIN_TOKEN_FILE`
  (read-only, same file) so `gateway doctor`'s `mattermost_provisioning` check sees exactly what
  the controller sees. A lifecycle-created agent's own bot token is generated server-side — never
  a path a client chooses (rejected outright, not silently overridden, when a create request names
  one; `AgentCreateMattermostInputSchema` carries no `token_secret_file` field at all) — under a
  second, distinct directory, `secrets/controller-bots` (`/run/bot-secrets` in the container),
  which the controller mounts read-write (it is the only writer of the tokens it provisions
  there) and `gateway-cli` mounts read-only, its own override for that mount (`BOT_SECRETS_DIR`,
  defaulting to `/run/bot-secrets`) always kept apart from `SECRETS_DIR`'s own override of
  `/run/secrets/` (`resolveSecretPath`, `@agent-gateway/service`) — collapsing the two would
  resolve a lifecycle-created agent's token into the wrong directory. Bundle validation reserves
  the admin token's own path (`/run/secrets/mattermost_admin_token`) the same way it already
  reserves the routing key's: no bot's `token_secret_file` may equal either. Every token file is
  written atomically (a temporary file in the same directory, `fsync`, then renamed over the
  target, mode 0600) and never logged.
- **Bootstrap and reconcile never touch a lifecycle-owned agent.** `gateway mattermost
  bootstrap`/`reconcile` build their plan from every configured agent, but skip any that is
  lifecycle-owned: that bot is the provisioner's own to create, token and reconcile, through its
  own checkpoints (`agent_lifecycle_operations`, `gateway agents operations`), never bootstrap's —
  revoking or rewriting a token the provisioner is mid-way through issuing is exactly the conflict
  this rule avoids. An agent is lifecycle-owned iff its own operation journal names at least one
  `create` or `restore` operation (never merely `adopt`, which the startup backfill writes for an
  agent the lifecycle never asked for): the database, not a `token_secret_file` prefix, is this
  decision's one source of truth, read by `mattermostPlan`'s caller (which has the database access
  `mattermostPlan` itself, a pure function, does not). A prefix is only ever an artifact of
  ownership and never the other way around: the managed-configuration service refuses a
  `/run/bot-secrets/` path in any committed configuration (a console patch, a CLI import) for an
  agent that is not lifecycle-owned, so YAML or a console edit can never claim the provisioner's
  own directory for an agent it does not own.
- **The provisioner.** A controller loop, alongside its other periodic work, takes
  `pending`/`running` `create`/`restore`/`reprovision` operations and drives each one through its
  steps — resolve or create the bot by username (refusing to adopt a stranger's account), issue it
  an access token, add it to the team and its configured channels, record its resolved account the
  way bootstrap already does — persisting a checkpoint in `agent_lifecycle_operations.checkpoints`
  right after each external step and never holding a database transaction across a Mattermost call.
  A controller restart resumes every `running` operation from its last checkpoint; a step already
  checkpointed is not repeated. With no admin token configured, the loop stays idle and every such
  operation simply stays `pending`, surfaced by `gateway doctor` rather than treated as a failure.
  Recording the resolved account (`mattermost_identities`, bootstrap's own counterpart) is checked
  and replayed every pass, not only the one that first resolves the bot: a crash between
  persisting the `bot_user_id` checkpoint and that write completing must never let the operation
  reach `completeOperation` with no identity ever recorded.
- **Membership reprovisioning.** When a committed configuration change (any path: a console patch,
  a CLI import) alters a lifecycle-owned, `ready` agent's `allowed_channels`, the same transaction
  queues a `reprovision` operation — deduped against one already `pending` for that agent, rather
  than queuing a second — which the provisioner later drives like any other: keep the bot's
  existing token if it still works (verified with it, `users/me`, before ever reissuing), join
  every channel now configured, and leave every channel no longer configured, except one an owner
  or admin granted the bot directly (ADR-022) — checked from the grant records, never assumed, so
  a grant made after the operation was queued still holds. Unlike `create`/`restore`, a
  `reprovision` operation never moves its agent out of `ready`: a membership-only change is never a
  reason to pause scheduling, so `markProvisioning` leaves the agent `ready` while the operation
  runs, and `completeOperation` leaves it `ready` once it finishes.
- **Failure handling.** A step's failure is permanent — `failOperation`, with a redacted message,
  moving the agent to `failed` — only when a retry could never fix it: the bot's username is taken
  by an account that is not plausibly the Gateway's own, or the admin token is rejected or lacks
  permission. Anything else (an unreachable or momentarily failing Mattermost) is left for the
  loop's next pass; a token response lost between being created and being written is recovered by
  revoking every token the bot has that is not the one now in its file and issuing a fresh one.
- **Admin account exclusion.** The admin account is resolved from its own token (`users/me`) and
  excluded from routing exactly like the listener bot: a post by it, should one ever happen, never
  wakes an agent and is recorded without addressing anyone. It is never one of
  `owner_mattermost_usernames`, so it already cannot decide an approval through that path; keeping
  it out of that list is the owner's own responsibility (documented, not enforced in code, since
  nothing marks an owner username as "this one is also the admin account").
- **Rotation.** Mattermost access tokens do not expire on their own, so the admin token is rotated
  by hand on a fixed schedule (every 90 days) through create-verify-switch-revoke: a new token is
  created for the same account and verified to work before the current file is switched to it, and
  only then is every other token the account has revoked — a crash between any two of those steps
  leaves a token that still works, never a provisioning path with no working credential at all, and
  a re-run after such a crash simply revokes whatever the interrupted attempt left stranded, since
  nothing but the file itself says which token is current. The account's tokens are listed a page
  at a time until a page comes back short, so an account with more of them than one page holds is
  still seen in full; revoking is itself listed and repeated, bounded, until only the newly written
  token remains.

Retirement's cleanup — cancelling an agent's runs, waits and approvals, deactivating its bot,
revoking its token, reconciling channel memberships — is not part of this decision: it resumes
through the same `agent_lifecycle`/`agent_lifecycle_operations` rows, via the same
`markProvisioning`/`completeOperation`/`failOperation`, later work that changes what runs between
`requestAgentRetire` and `completeOperation`, not the state machine itself.

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
  leaving the agent `pending` until the provisioner's own next pass notices the operation it left
  `pending` and calls `markProvisioning` itself (no admin token configured leaves it `pending`
  rather than failed, which is its own kind of "notices and does nothing yet").
- `agent_lifecycle_operations` grows without bound, like the configuration journal and the audit
  log; nothing here adds its own retention pass.
- A release before this one does not know these tables exist (ADR-020's expand-migration
  guarantee): rolling back to it loses nothing it ever read, and re-upgrading re-runs the adoption
  backfill exactly as it would on a fresh database.
