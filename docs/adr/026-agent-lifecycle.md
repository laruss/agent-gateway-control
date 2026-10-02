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

### Retirement's cleanup

A retired agent can never act again. `requestAgentRetire` performs the Gateway-side half of that,
in the same transaction as its `remove_agent` commit:

- **Runs.** An active run (`queued`/`running`) is cancelled first, the same cancellation
  `gateway agent pause` performs (its worker stops the turn; its inbox entries return to
  `pending`, moving the agent through `paused` before the commit disables it — `disable` is a
  valid state-machine transition only from `idle`/`waiting`/`failed`/`paused`, never from
  `queued`/`running`).
- **Waits, approvals and tool actions.** Exactly like any agent leaving the active configuration:
  its active waits are cancelled, its pending approval requests withdrawn (the card is updated the
  same way any other withdrawal already shows it — `sweepApprovals`, triggered right after the
  transaction commits rather than waiting for the periodic sweep), its queued tool actions
  cancelled, and its running ones asked to stop (`cancel_requested_at`). A late report for one
  that does not stop in time, like a late run report, is dropped before publishing any effect.
- **Channel grants (ADR-022).** Every grant the agent still holds is tombstoned in the same
  transaction, not left for the membership synchronizer to notice on its own schedule: a retired
  agent must lose access through a channel nobody thought to revoke by hand too, and re-adding its
  bot to the same channel later must never silently re-grant it.
- **Outbox.** Its own pending deliveries (`pending`/`sending`) are moved to a new `cancelled`
  status, never sent as a retired agent, rather than left to fail against a deactivated bot or
  expire on their own schedule.
- **Late reports.** A run or tool report for an agent whose lifecycle status is `retiring` or
  `retired` is dropped — audited, never applied — before it would publish an effect (a post, a
  memory write, a wait or approval resolution): checked explicitly, by lifecycle status, not only
  inferred from the run's own `cancelled` status, since a report can race the retire transaction
  that set it.
- **Private memory.** Unreadable from the moment the agent retires: no turn can load it (the
  agent can never run again), and it is excluded from `gateway memory list` explicitly too, rather
  than relying only on the first guarantee. Left to the existing retention to expire on its own
  schedule — nothing here deletes it early. Shared memory the agent wrote and that was accepted
  stays: it is organization-owned, not the retiring agent's.
- **Kept.** Audit entries, identity rows, run history and already-sent messages are never touched.
- **The finance agent.** Refused, before anything is written, when the retiring agent is the
  organization's own `finance_agent_id`, unless the same request also names
  `reassignFinanceTo` — a different, currently configured agent — committed as a
  `set_finance_agent` change operation in the same change set as the `remove_agent`. Retiring the
  finance agent without reassigning it would otherwise leave the configuration naming one that no
  longer exists, something `validateConfigBundle` already refuses, but confusingly so; this names
  the actual rule and gives one request to satisfy it.

The Mattermost-side half is the provisioner's: a `retire` operation is now one more kind it drives
(alongside `create`/`restore`/`reprovision`, through its own checkpoints —
`tokens_revoked`, `bot_disabled`, `channels_left`, `token_file_deleted`), in the order
`bootstrapMattermost`'s own retirement of a replaced bot already uses: every access token revoked
and the bot account deactivated *first* (together, that ends all its access on their own), *then*
every channel it is currently a member of left (cosmetic from that point on — a crash partway
through leaves no working access behind, only channels still physically listing a deactivated,
token-less bot until the next pass finishes the list), and finally, only for a lifecycle-created
agent, its own `/run/bot-secrets/` token file removed (a bootstrap-managed agent's
`/run/secrets/` file is never touched — the CLI owns it; this only revokes the token server-side
and leaves the file for `gateway doctor` to report as stale). An agent retired before its
identity was ever resolved (still `pending`) has nothing Mattermost-side to clean up at all. A
step's failure is retried like provisioning any other operation; a permanent failure leaves the
agent `retiring` with `last_error`, surfaced by `gateway doctor`, same as any other kind. A
database rollback of the retire transaction alone never reactivates a Mattermost account that was
already deactivated by a provisioner pass that ran, committed its checkpoints and then had its own
database transaction (the lifecycle rows, not Mattermost) somehow undone by a later, unrelated
operation — nothing in this system does that, but it is worth naming: Mattermost's own state is
never inside any Gateway database transaction, so no Gateway rollback ever undoes it.

### Restore

`requestAgentRestore` was already described above (`retired` -> `pending`, re-adding the last
recorded configuration that named the agent). Its own Mattermost-side provisioning needs no
special casing: a `restore` operation is a `create`-shaped lifecycle operation (`PROVISIONING_KINDS`
already includes it), and `ensureBot` already re-enables a disabled bot account it finds by
username (`existing.delete_at > 0` -> `enableBot`) before returning its id — the same bot the
retire step just deactivated. `ensureBotToken` likewise issues a fresh token unprompted: the
retire step already revoked every token the account had, so the restore operation's own (freshly
empty) checkpoints never find a working one to keep. The channel-joining loop re-adds it to every
channel its restored configuration now names. No new code needed any of this; it falls out of
`create`/`restore` already sharing one path through the provisioner.

### Assignments: a read model with provenance

An agent's channels come from two sources that account for them differently: `configured` (named
in its own `mattermost.allowed_channels`) and `granted` (an ADR-022 grant an owner or system admin
gave its bot directly — recorded with who granted it, when, and the post that is its evidence).
`loadAgentChannelAssignments` reads both, database-only, for `gateway agents channels <id>`; a
third provenance, `member-unauthorized` — the bot is a member Mattermost itself reports that is
neither — is live-only (it needs what the server actually has) and is not part of this read
model; a console page, or the CLI command itself, adds it from a live check the same way
`gateway mattermost reconcile` already does. Revoking a grant directly
(`gateway agents revoke-grant <id> <channel>`) tombstones it the same way retirement's own bulk
revoke does, and additionally queues a `reprovision` operation for a lifecycle-owned, `ready`
agent so the provisioner removes the bot from it without waiting for an unrelated configuration
change; a bootstrap-managed agent has no such operation, and is left to the membership
synchronizer's own next pass, which already removes a bot from a channel it has neither a grant
nor a configuration entry for.

### Lock order, across every writer that touches a lifecycle row

`markProvisioning`, `completeOperation` and `failOperation` (via `lockCurrentOperation`) always
lock an agent's `agent_lifecycle` row before its operation row. A configuration commit that queues
a `reprovision` for a lifecycle-owned agent now keeps the same order relative to the `agents`
table too: the lifecycle rows of every agent whose `allowed_channels` just changed are locked
*before* the commit locks the `agents` table itself (`writeConfigRevisionIn`'s own "every existing
agent row, locked in id order up front"), never after. Getting this backwards — as the first
version of `reprovision` queuing did — risks a genuine deadlock (Postgres 40P01): a concurrent
`completeOperation` for the very agent a commit is also touching locks the lifecycle row, then
(through `scheduleAgent`) the agent row; a commit that locks the agent row first and the lifecycle
row second, for the same agent, can wait on each other in a cycle. One global order —
`gateway_controls`, then lifecycle row(s), then agent row(s), then operation rows — holds
everywhere now: `requestAgentRetire`/`requestAgentRestore` already locked the lifecycle row before
their own configuration commit; `commitChangeIn` and `applyConfig` (config apply) now do too,
before either locks the `agents` table.

Queuing a `reprovision` also decides, under the same lock, what a concurrent edit does to an
operation already in flight: a `pending` one is left alone (the provisioner reads the agent's
configuration only *after* it claims the operation, never before, so whatever is pending when it
finally runs already covers every edit made up to that point); a `running` one is different — the
provisioner already read its own, now possibly stale, copy before claiming it, with no way to
safely revise that read mid-step — so it is cancelled and a fresh `pending` operation queued in
its place, the same way a superseded `create`/`restore` is already cancelled rather than left
stranded. The provisioner's own leaving-channels step (a `reprovision`'s own membership trim)
re-reads which channels are still allowed immediately before each removal, not once at the start
of its pass, since that loop calls Mattermost once per channel and may take a while: a grant made
mid-pass must still be honored by the very removal decision it would have prevented, not only by
the pass that runs after it.

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
