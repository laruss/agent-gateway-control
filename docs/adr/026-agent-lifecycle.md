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
   |              |               |             |
   +--- failed <--+--- failed <---+             +--- (retry: stays retiring)
        (retry: pending again)

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
identity is refused the same way, whether or not that agent is still active. Every other committing
path that could still add an id back to the active configuration — a rollback or import's
`replace_bundle`, a plain `add_agent` — refuses one whose lifecycle is `retiring`/`retired` the same
way a commit already refuses *removing* a lifecycle-owned agent outside `requestAgentRetire`
(`rejectRetiredAgentReadditions`, the mirror of `rejectLifecycleOwnedRemovals`): naming
`gateway agents restore` instead of silently enabling a configuration nothing has actually
provisioned, and leaving that very restore failing "already exists" once it is finally tried.
`requestAgentRestore`'s own commit is the one trusted exception, the same way `requestAgentCreate`'s
own commit is trusted against `rejectUnownedBotSecretPaths`.

### One operation journal

`agent_lifecycle_operations` is an append-only journal, one row per lifecycle operation
(`create`, `retire`, `restore`, `reprovision`, `adopt`), naming who asked for it (`requested_by`,
`source`: a CLI session, the console, or an agent), an optional idempotency key, the configuration
revision it carried, the `generation` it pursues, its own state (`pending -> running -> {succeeded,
failed, cancelled}`), and `checkpoints` — ids and references only, never a token's value, filled in
by the provisioner as it completes each external step (a later decision adds the actual steps:
`bot_user_id`, `token_ref`, `team_joined`, `team`, `channels_joined`). A row `requestOperationRetry`
itself produces additionally names the operation it retried (`retry_of`, migration 0027), null for
every other kind of request — see "Retry", below, for why `kind` alone cannot serve the same
purpose. A database trigger enforces the append-only guarantee at the column level, the same way
the configuration journal's guard does (ADR-024): every identity column is immutable once written,
and only `state`, `checkpoints`, `error` and the timestamps besides `created_at` may ever change,
moving `state` forward only.

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
complete through `markProvisioning`/`completeOperation`/`failOperation`. `remove_agent` is this own
request's alone: every other committing path (a managed commit, `config apply`,
`setAgentEnabled`'s own disable-as-removal fallback) refuses to drop a lifecycle-owned agent that
is not already `retiring`/`retired` out of the active configuration, naming `gateway agents retire`
instead — dropping one any other way would leave its bot active in Mattermost and its lifecycle row
never reaching `retiring`, so it could neither be retired (its own `remove_agent` would find nothing
left to remove) nor restored (never `retired` either). Retiring one already missing from the active
configuration this way — a state only an earlier release's own bug could have left behind, since no
writer can produce it anymore — is tolerated rather than refused: its own `remove_agent` is skipped
(nothing left to commit), and every other cleanup step still runs, recovering it into the ordinary
`retiring` state like any other retire. Retiring an agent still only configured through a live
`config apply`/`import` since the last startup or CLI session adopted it (ADR-026's own adoption,
below) first runs that same adoption, so this request still finds a lifecycle row for it.

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
  this rule avoids. The same exclusion applies to the retired-cleanup half of the plan too (bots of
  agents no longer in the active configuration, deactivated and revoked wholesale): a lifecycle-
  owned agent's own `agents` row can outlive it leaving the active configuration the same way any
  other agent's does (ADR-024's retained-row case) while `requestAgentRetire`/`requestAgentRestore`
  are still working through it, so without this a bootstrap or reconcile run racing either would
  revoke a token the provisioner is mid-way through issuing, or deactivate a bot it just
  re-enabled — the provisioner's own `retire` operation is the one path trusted to clean that bot up.
  An agent is lifecycle-owned iff its own operation journal names at least one `create` or
  `restore` operation (never merely `adopt`, which the startup backfill writes for an agent the
  lifecycle never asked for): the database, not a `token_secret_file` prefix, is this decision's
  one source of truth, read by `mattermostPlan`'s caller (which has the database access
  `mattermostPlan` itself, a pure function, does not). A prefix is only ever an artifact of
  ownership and never the other way around: the managed-configuration service refuses a
  `/run/bot-secrets/` path in any committed configuration (a console patch, a CLI import) for an
  agent that is not lifecycle-owned, so YAML or a console edit can never claim the provisioner's
  own directory for an agent it does not own — nor can it redirect `token_secret_file` to anything
  else, once the agent is lifecycle-owned: the field is server-generated and immutable outside the
  provisioner's own writes (`requestAgentCreate`'s first issue, `requestAgentRestore`'s migration to
  it), refused the same way in both committing paths for any other edit that tries to change it.
- **The provisioner.** A controller loop, alongside its other periodic work, takes
  `pending`/`running` `create`/`restore`/`reprovision` operations and drives each one through its
  steps — resolve or create the bot by username (refusing to adopt a stranger's account: a regular
  user, a bot with elevated roles, or — for a fresh `create` with no identity of its own recorded
  yet — a plain bot at that username neither this agent's own `mattermost_identities` row nor any
  admin account this Gateway has ever provisioned under (`owner_id`, current or past — the same
  rotation-tolerant history retirement's own recovery already trusts, below) can account for, so an
  unrelated integration's bot sharing the same username is never silently taken over and its tokens
  revoked, and a resumed `create` never fails permanently merely because an operator rotated the
  provisioning admin account in the meantime), issue it an access token, add it to the team and its
  configured channels, record its resolved account the way bootstrap already does — persisting a
  checkpoint in `agent_lifecycle_operations.checkpoints` right after each external step and never
  holding a database transaction across a Mattermost call. Every pass runs holding a session-level
  Postgres advisory lock of its own, taken for the whole pass and skipped (never waited for) when
  already held: two overlapping controllers — one still draining its own pass during an upgrade,
  say — must never drive the same operation's steps at once, one revoking the fresh token the
  other just issued. A controller restart resumes every `running` operation from its last
  checkpoint; a step already checkpointed is not repeated. With no admin token configured, the loop
  stays idle and every such operation simply stays `pending`, surfaced by `gateway doctor` rather
  than treated as a failure.
  Recording the resolved account (`mattermost_identities`, bootstrap's own counterpart) is checked
  and replayed every pass, not only the one that first resolves the bot: a crash between
  persisting the `bot_user_id` checkpoint and that write completing must never let the operation
  reach `completeOperation` with no identity ever recorded.
- **Membership reprovisioning.** When a committed configuration change (any path: a console patch,
  a CLI import) alters a lifecycle-owned, `ready` agent's `allowed_channels`, the same transaction
  queues a `reprovision` operation — deduped against one already `pending` for that agent, rather
  than queuing a second. Changing the organization's own Mattermost team queues one for *every*
  current, lifecycle-owned, `ready` agent the same way, team membership being exactly as much this
  step's own concern as a channel is; an agent still `pending`/`reconciling` (a `create`/`restore`
  still provisioning it) is left alone either way — its own operation already owns reconciling its
  membership once, from whatever the configuration is by the time it reaches that step.

  Every `create`/`restore`/`reprovision` operation converges the bot's team and channel membership
  onto desired state computed fresh from **live** Mattermost state on every pass, rather than from
  its own checkpoints — crash-safe without a cleanup checkpoint of its own, since nothing is ever
  decided from one: the bot's current teams are listed (`users/{id}/teams`); the configured team is
  joined if missing, and every other team the bot is a live member of is left outright
  (`removeTeamMember`, the same way `bootstrapMattermost`'s own "one team only" step already does,
  without leaving the old team's channels first — Mattermost ends a user's membership in every
  channel of a team the moment it ends their membership in the team itself) — an ADR-022 grant is
  never consulted for a team being left this way, only for the configured one, since a grant only
  ever means anything within the team the organization actually manages. The bot's current channels
  in the configured team are then listed; every configured channel it is not already a member of is
  joined, and every channel it is a member of that is neither configured nor actively granted
  (ADR-022, checked fresh immediately before each removal, never once at the start of the pass, so a
  grant made mid-pass is still honored) is left — the same convergence for every operation kind, so
  a channel a committed edit took away mid-flight is left exactly like one a `reprovision` already
  removes, and one the same edit added is joined the same way, with no separate "join only" step.
  `team_joined`/`channels_joined` (channel ids, deduplicated, bounded the same way
  `allowed_channels` itself is) are written purely as this pass's own progress markers — reset at
  the start of every pass, read by nothing deciding whether a step still needs doing, only by
  `completeOperation`'s own fence, below, and by `gateway agents operations`. Finally, the bot's own
  team and channel membership roles are normalized back to a plain member wherever an existing
  membership somehow carries more (`team_admin`/`channel_admin` — granted by hand in Mattermost, or
  left over from an earlier manual change), the same role normalization `bootstrapMattermost`
  already applies to a bulk-managed bot, before the operation is ever allowed to declare the agent
  ready.

  A channel not yet resolved in the Mattermost bridge's own directory (brand new, say) is left for a
  later pass to pick up once it resolves, the same as before; `completeOperation` itself closes the
  remaining gap — a config edit, or a team change, committed between the provisioner's own last
  fresh read and this very call — still holding the same `agent_lifecycle` row lock every config
  writer takes before queuing a `reprovision` (`lockLifecycleRows`): for a `create`/`restore`, it
  compares the agent's current `allowed_channels` (resolved to channel ids the same way the
  provisioner itself resolves them) and the organization's current team against what the operation's
  own checkpoints record having actually joined, and queues a `reprovision` in the same transaction
  on any difference — a configured channel name the bridge has not resolved yet counts as a
  difference too, never silently dropped from the comparison — rather than leaving the agent `ready`
  with a membership nothing would otherwise ever revisit. A concurrent commit touching this same
  agent cannot slip past this check either way: it must lock the same row first, so it either
  already happened (and this read sees it) or waits for this transaction to finish (and finds the
  agent already `ready`, queuing its own `reprovision` the ordinary way). The queued operation is
  later driven by the provisioner like any other: keep the bot's existing token if it still works
  (verified with it, `users/me`, before ever reissuing), then the same live convergence above. Unlike
  `create`/`restore`, a `reprovision` operation never moves its agent out of `ready` — on any of its
  transitions, a permanent failure included: `markProvisioning` leaves the agent `ready` while the
  operation runs, `completeOperation` leaves it `ready` once it finishes, and `failOperation` leaves
  it `ready` too (recording `last_error` and the failed operation itself, still visible and
  retryable) rather than the generic `failed` a stuck `create`/`restore` means — a membership-only
  change is never a reason to pause scheduling, whatever became of it. `requestOperationRetry` keeps
  the same rule: a failed `reprovision`'s retry leaves the agent `ready` throughout, never passing it
  through `pending` the way a retried `create`/`restore` does.
- **Failure handling.** A step's failure is permanent — `failOperation`, with a redacted message,
  moving the agent to `failed` (or leaving a `reprovision`'s own agent `ready`, just above) — only
  when a retry could never fix it: the bot's username is taken by an account that is not plausibly
  the Gateway's own, or the admin token is rejected or lacks permission. Anything else (an
  unreachable or momentarily failing Mattermost) is left for the loop's next pass; a token response
  lost between being created and being written is recovered by revoking every token the bot has
  that is not the one now in its file and issuing a fresh one.
- **Admin account exclusion.** The admin account is resolved from its own token (`users/me`) and
  excluded from routing exactly like the listener bot: a post by it, should one ever happen, never
  wakes an agent and is recorded without addressing anyone. It is never one of
  `owner_mattermost_usernames`, so it already cannot decide an approval through that path; keeping
  it out of that list is the owner's own responsibility (documented, not enforced in code, since
  nothing marks an owner username as "this one is also the admin account").
- **Rotation.** Mattermost access tokens do not expire on their own, so the admin token is rotated
  by hand on a fixed schedule (every 90 days) through create-verify-switch-revoke: a new token,
  tagged with a fixed description (`agent-gateway-admin`), is created for the same account and
  verified to work before the current file is switched to it, and only then is every *other* token
  carrying that same description revoked — never one without it, since the account's admin may also
  hold personal access tokens of its own that have nothing to do with the Gateway, which rotation
  must never touch. A crash between any two of those steps leaves a token that still works, never a
  provisioning path with no working credential at all, and a re-run after such a crash simply
  revokes whatever the interrupted attempt left stranded, since nothing but the file itself says
  which token is current. `admin-token set`/`rotate`'s own create-verify-switch(-revoke) sequence
  runs holding a session-level Postgres advisory lock of its own, failing fast rather than waiting
  when another run against the same account already holds it: unserialized, two overlapping runs
  could each revoke the token the other just minted before ever writing it, leaving the file holding
  one already revoked. The account's tokens are listed a page at a time until a page comes back
  short, so an account with more of them than one page holds is still seen in full; revoking is
  itself listed and repeated, bounded, until none of its own remain but the newly written token. A
  rotation that ends up revoking none of them prints a warning rather than reporting success
  plainly: ordinarily that just means an earlier rotation's own crash left nothing of its own
  stranded, but it is also exactly what a token in the file that was never tagged in the first place
  would produce, every single time, so it is called out rather than folded into an
  identical-looking "0 revoked" success line.

  The very first token on the account — entered by hand in Mattermost, then given to
  `gateway mattermost admin-token set` — is never trusted to already carry this rotation's own
  description (an operator names it however they like in Mattermost): `admin-token set` itself now
  runs the very same create-verify-switch dance described here, minting and tagging its own token
  from the pasted one before ever writing the file, and revokes the pasted token right away when the
  account held exactly that one token to begin with — the only case it is unambiguous which one was
  just entered. An account that already held more than one is left untouched instead, named in a
  warning, the same "never guess" rule this rotation's own "token without that description" case
  already follows. This closes what used to be this scheme's one acknowledged gap: a hand-entered
  token `admin-token set` once wrote verbatim, never tagged, so no later rotation's own
  description-scoped revoke could ever find it — now minted and tagged (and, ordinarily, revoked
  outright) the moment it is first set, rather than merely documented as the operator's own standing
  responsibility.

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
  expire on their own schedule. A `cancelled` item ages out of content retention on the same rule
  as a `dead` one (`outbox_dead_days`): it is never redriven either, and is otherwise forgotten by
  every other retention step.
- **Runtime sessions.** Its stored provider session (`runtime_sessions`) is ended unconditionally,
  the same call a changed channel grant already makes (`endAgentRuntimeSessions`) — not only as a
  side effect of the channel grants just tombstoned above, which may have been none at all: a
  restored agent must never resume a pre-retirement conversation thread merely because its own
  `session_policy` is `resumable-if-available`.
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
token-less bot until the next pass finishes the list) — `channels_left` itself trimmed to its own
schema bound (64 ids, the most recently left kept) whenever a pass's own live membership exceeds
it, since a retiring bot's live channels, unlike a configured agent's `allowed_channels`, are never
bounded by anything this release controls (ADR-022 grants, channels added by hand): trimming the
stored checkpoint never undoes a removal already made, or repeats one Mattermost itself no longer
lists the bot a member of, so it costs at most a little redundant work on a later pass, never a
channel left behind — and finally, only for a lifecycle-created
agent, its own `/run/bot-secrets/` token file removed (a bootstrap-managed agent's
`/run/secrets/` file is never touched — the CLI owns it; this only revokes the token server-side
and leaves the file for `gateway doctor` to report as stale). An agent retired before its
identity was ever resolved (still genuinely `pending`, nothing ever provisioned) has nothing
Mattermost-side to clean up at all — but a resolved identity that was never *recorded* is not the
same thing: a `create`/`restore` operation can checkpoint `bot_user_id` and then be superseded by
this very retire, or simply crash, before `setAgentBotUser` ever wrote it. Retirement recovers that
id from the superseded operation's own checkpoints (they survive being cancelled) before ever
concluding there is nothing to do, and only as a last resort falls back to looking the account up
by the agent's configured username — never adopting one that is not plausibly the Gateway's own
plain bot, the same check `ensureBot` itself applies before ever creating or adopting one, except
that the account's own `owner_id` is checked against every admin account this Gateway has ever
recorded for itself (the current one, plus every one a prior `directory.set` on
`#provisioning-admin` ever audited), not only the current one: a bot this Gateway created under an
admin account an operator has since rotated away from (`gateway mattermost admin-token set`
pointed at a different account) is still recognized as its own. An `owner_id` that matches none of
them still skips cleanup (never adopts an unproven account), but logs a visible warning and a
checkpoint (`owner_unverified`) `gateway doctor` surfaces, rather than the quiet log this skip used
to get unconditionally — this Gateway's own admin-rotation history, had any of it been lost, could
in principle have vindicated the very same bot. A
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

One thing restore itself does change: the agent's `token_secret_file` always migrates to the
provisioner's own, server-generated `defaultBotSecretFile` path, as part of the very same
`add_agent` change set the restore commits (never a separate step — config and lifecycle stay
consistent). This matters for an agent that was adopted (bootstrap-managed) before it was ever
retired: its historical configuration still names its old `/run/secrets/...` file, read-only to
the controller, whose token the retire step above already revoked server-side. Restoring that
reference unchanged would leave `ensureBotToken` unable to write the fresh token the provisioner
issues — stuck `reconciling` forever, and by then also skipped by `gateway mattermost bootstrap`
for having become lifecycle-owned. The old `/run/secrets/...` file is simply stale from here on:
nothing reads or deletes it; `gateway doctor` has no way to tell it apart from one still in use, so
an operator who no longer needs it removes it by hand. A lifecycle-created agent's own path is
already `defaultBotSecretFile`, so the migration changes nothing for it.

The restored configuration's own permissions change too, when the agent was the organization's
finance agent back when it retired (retiring it required reassigning the role away first, so it
never is, by the time of a restore): its historical permissions, valid while it still held that
role, are normalized the way any other non-finance agent's are (`defaultAgentPermissions`'s own
baseline) — any finance-touching `tools_allow`/`tools_require_human_approval` entry dropped,
`finance.*` added to `tools_deny` — since restoring them unchanged would otherwise fail
`validateConfigBundle`'s own finance rule the moment it restores to anyone but today's finance
agent. `requestAgentRestore` accepts an optional `makeFinanceAgent` flag instead: given, it
reassigns the role back to the restored agent atomically (`set_finance_agent`, the same change set
as the restore's own `add_agent`) and keeps its historical permissions unchanged, trusting them to
already be finance-shaped — `validateConfigBundle` still refuses the commit if they are not. The
agent the role moves *from* gives it up in the very same change set, its own permissions normalized
the identical way (`update_agent`, preserving every other field) — otherwise the organization would
be left with two agents holding finance tools at once (the outgoing one, and the restored one), and
`validateConfigBundle`'s own finance rule would refuse the commit for naming a finance agent that is
not the only one still allowed to hold them.

### Retry

`requestOperationRetry` asks for a fresh attempt of an agent's own current operation: refused
unless that operation is actually `failed` — a `create`/`restore`/`reprovision` that left the
agent `failed` (`failOperation`'s own path for any of those kinds), or a `retire` whose own
cleanup failed permanently, leaving the agent `retiring` with `last_error` rather than the generic
`failed` (`failOperation`'s own doc comment). It queues a *new* operation of the same kind, never
resurrects the failed row itself: the operation journal is append-only (its own guard trigger
only ever lets `state` move forward, migration 0025), so a terminal row can never become `pending`
again in place, the same reason a superseded `create`/`restore` is cancelled and replaced rather
than rewound. The new operation carries the failed one's own checkpoints forward — a step the
provisioner already completed (the bot resolved, a token issued, every channel but one joined) is
not repeated, only resumed, the same way a controller restart resumes a `running` operation from
its last checkpoint. The agent itself moves back to `pending` (the state a fresh
`create`/`restore`/`reprovision` starts from, and `markProvisioning` reconciles from there as
usual) — except a retiring agent, which stays `retiring` throughout, matching `markProvisioning`'s
own rule for a `retire` operation; `last_error` is cleared either way, since this is a fresh
attempt, not a continuation of the one that failed. The new row itself records which operation it
retried (`retry_of`, migration 0027): `kind` alone cannot tell a retry-created `create` operation
apart from a fresh one `requestAgentCreate` itself produced — both carry the identical kind — so a
repeated `idempotencyKey` is replayed only once `retry_of` also says the row it found was actually
this request's own kind of result; one some other request (`requestAgentCreate`/
`requestAgentRetire`/`requestAgentRestore`) produced instead is refused the same "already used for
a different request" way a key reused across any other two of these kinds already is. A genuine
repeat replays the first call's own result, the same convention every other lifecycle request
already follows. `gateway agents retry <id>` is its CLI surface; the console's agent page shows the same
action next to the agent's own actionable failure message, live checkpoints as they complete while
an operation is in flight (polling `GET /api/agents/:id/lifecycle`), and a progress view for
`pending`/`reconciling`.

### The console's own lifecycle routes

The owner's console (ADR-025) drives the same four requests above, plus the read models they need,
through its existing session/CSRF/exact-Origin-protected `/api/agents*` surface
(`apps/controller/src/console-management.ts`), never a new authentication mechanism or a direct
database write of its own:

- **`POST /api/agents`** — `{idempotencyKey, id, displayName, allowedChannels, rolePrompt,
  runtime?}`, the console's own narrower create DTO (`ConsoleAgentCreateRequestSchema`,
  `packages/contracts/src/console-management.ts`): the bot username (always the agent id), its
  wake rule (a mention in any of its own channels), concurrency and private memory namespace are
  never client-supplied, built the same way `gateway agents create` already assembles them
  (`buildAgentCreateRequest`). `runtime.adapter`, when given, is offered from the deployment's own
  *qualified* list — an adapter with a fresh, ready worker right now (`runtimeHealth`), not the
  full static enum `GET /api/agents`'s own editor-facing `knownRuntimeAdapters` offers for an
  *existing* agent's Runtime tab (which must still show whatever it is already configured with,
  ready or not). Its own permissions are left to `requestAgentCreate`'s existing
  `defaultAgentPermissions` fallback (`tools_allow: ["mattermost.post"]`, `tools_deny: ["finance.*"]`
  unless it is the organization's own finance agent, same as the CLI) — the new bot can already post
  in Mattermost the moment it is ready, never a field this create request exposes directly; granting
  it any further tool still goes through the existing preview/commit flow afterward.
- **`POST /api/agents/:id/retry`**, **`POST /api/agents/:id/retire`** (`{reason?,
  reassignFinanceTo?}`), **`POST /api/agents/:id/restore`** — thin bodies, each carrying only its
  own `idempotencyKey` and whatever `requestAgentRetire` itself needs; unlike `preview`/`commit`,
  none of these take a client-supplied `baseRevisionId` to check against: they are never asked to
  apply against a specific, previously loaded configuration snapshot the way editing an agent's own
  definition is — they always act on whatever is live, the same way the CLI's own
  `gateway agents retire|restore|retry` already do. A stale page is instead caught by each
  request's own business-rule refusal (`AdminError`, surfaced as `422` with `problems`) — "already
  retired", "not failed, nothing to retry" — which names the actual problem more specifically than
  a bare conflict would; the rare `ManagementConflictError` a configuration-history backfill racing
  this very request can still raise (`commitWithinLock`'s own internal retry) is still mapped to
  `409`, the same as every other mutating route.
- **`GET /api/agents/:id/lifecycle`** — `{status, generation, lastError, statusChangedAt,
  retiredAt, operations}`: the agent's own `agent_lifecycle` row plus its operation journal,
  newest first, each with its `checkpoints` and (already redacted and bounded at write time,
  `redactForStorage`) `error` — never the journal's own identity columns
  (`requestedBy`/`source`/`idempotencyKey`/`configRevisionId`/`generation`), operator detail the
  console's progress view has no use for. `404` when the agent has no lifecycle row at all (only
  possible before the startup adoption backfill has run).
- **`GET /api/agents/:id/channels`** — the same `configured`/`granted` provenance read model
  `gateway agents channels <id>` prints (`loadAgentChannelAssignments`), database-only; never the
  live `member-unauthorized` check `gateway mattermost reconcile` performs.
- **`POST /api/agents/:id/channels/revoke`** (`{channelId}`) — tombstones a directly granted
  channel the same way `gateway agents revoke-grant <id> <channel>` does; idempotent (a channel
  nothing was ever granted for is a no-op, `channelName: null`, never an error).

Every route above is reachable only once an agent already exists (`POST /api/agents` aside); the
console's own agents list stays the one place a retiring or retired agent remains reachable at all
once its `remove_agent` commit has taken it out of the active configuration snapshot
`GET /api/agents/:id` itself still reads from (which 404s for it, same as any other agent outside
that snapshot) — the list includes it anyway, filterable, specifically so its own Restore action
stays reachable; its agent page falls back to this same lifecycle/channels data (no editable
configuration, since there is none to show) the moment its own detail fetch 404s this way.

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
