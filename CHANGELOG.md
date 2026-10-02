# Changelog

All notable changes are documented here. The project follows Semantic Versioning.

## [Unreleased]

### Added

- Creating an agent no longer needs `gateway mattermost bootstrap` with a temporary admin token.
  A dedicated, non-bot Mattermost system-admin account's personal access token, stored read-only
  in the controller's secrets (`gateway mattermost admin-token set`, validated against Mattermost;
  `gateway mattermost admin-token rotate` for its own create-verify-switch-revoke rotation, every
  90 days), lets the controller provision a new agent's bot itself: a background provisioner
  resolves or creates the bot, issues it an access token (written to a server-generated file under
  a new, controller-owned secrets directory — never a path a client chooses), adds it to the team
  and its configured channels, and records its account, resuming from a checkpoint after any
  restart. `gateway agents create <id> --display-name ... --role-prompt-file ...` starts this;
  `gateway agents operations [--agent <id>]` lists each operation's state, checkpoints and error.
  With no admin token configured, new agents simply wait, surfaced by `gateway doctor`. Existing
  bootstrap-created agents and `gateway mattermost bootstrap` itself are unchanged. (ADR-026)
- Retiring an agent (`requestAgentRetire`) now cleans up fully, both in the Gateway and in
  Mattermost (ADR-026). In the same transaction as its `remove_agent` configuration change: an
  active run is cancelled (its worker stops the turn, exactly like pausing); its waits are
  cancelled and its pending approvals, queued tool actions and running tool actions' own
  cancellation are requested (the approval card is updated the same way any other withdrawal shows
  it); every channel it was ever granted directly is revoked, so re-adding its bot later never
  silently re-grants it; its pending Mattermost deliveries are blocked rather than sent as a
  retired agent (a new `cancelled` outbox status). A late run or tool report for a retiring or
  already-retired agent is dropped before publishing any effect (a post, a memory write, a wait),
  audited either way. Retiring the organization's configured finance agent is refused unless the
  same request also reassigns the role to another configured agent (`reassignFinanceTo`). Audit
  entries, identity rows, run history and already-sent messages are kept; the agent's private
  memory becomes unreadable (excluded from `gateway memory list` too) and is left to the existing
  retention to expire, while shared memory it wrote and that was accepted stays, organization-
  owned. A `retire` lifecycle operation is now executable by the provisioner: it removes the bot
  from every channel, revokes its access tokens, deactivates it, and — only for a lifecycle-
  created agent — removes its local token file (a bootstrap-managed agent's own file is left alone
  and reported stale); a permanent failure leaves the agent `retiring` with `last_error` for
  `gateway doctor` to surface. `requestAgentRestore` (already available) is now fully provisioned
  again by the same background loop: the bot is re-enabled, a fresh token issued, and it rejoins
  its channels.
- An agent's channels now have a provenance read model: `configured` (named in its own
  `allowed_channels`) or `granted` (an ADR-022 grant — by whom, when, which post is its evidence).
  `gateway agents channels <id>` lists them; `gateway agents revoke-grant <id> <channel>` revokes
  one directly, removing the bot from it through the lifecycle provisioner (a lifecycle-owned
  agent) or the membership synchronizer's own next pass (a bootstrap-managed one).
  `gateway agents retire <id>` and `gateway agents restore <id>` are now CLI commands too.
- `gateway agents retry <id>` (and the console's own Retry action) queues a fresh attempt of an
  agent's own current operation once it is `failed` — a `create`/`restore`/`reprovision` that
  failed, or a `retire` whose cleanup failed permanently — carrying forward whatever it already
  checkpointed, so a step already done is not repeated. The operation journal stays append-only: a
  retry queues a new operation rather than resurrecting the failed row. (ADR-026)
- The owner's console can now create, retire, restore and retry an agent directly, alongside
  editing one: a "New agent" dialog (id, display name, channels, role prompt, an optional runtime
  adapter/model from the deployment's own qualified — ready-worker — list); a lifecycle status
  badge and a live progress view (polling each checkpoint as the provisioner completes it) on the
  agent page; a Retire confirmation stating what it cancels and that it is reversible, requiring a
  finance-role reassignment when the agent is the organization's finance agent and warning (never
  blocking) for a system-flagged one; Restore for a retired agent, which stays listed (filterable)
  specifically so that action is reachable; and a channel assignments view (configured vs granted,
  with who/when/evidence) with a Revoke action for a directly granted one. Every new mutating route
  (`POST /api/agents`, `.../retry`, `.../retire`, `.../restore`, `.../channels/revoke`) sits under
  the existing session/CSRF/exact-Origin protection and carries its own idempotency key; the two
  new read routes (`GET .../lifecycle`, `GET .../channels`) need only a valid session. Creating an
  agent here, like the CLI, never creates a worker container, and the console and CLI both keep
  working with zero agents ready. (ADR-025, ADR-026)

### Fixed

- `gateway config apply`'s whole-bundle replace now goes through the same checks a managed-
  configuration commit (a console patch, a CLI import) already did: a `/run/bot-secrets/` token
  path is refused for an agent that is not lifecycle-owned, and a lifecycle-owned, `ready` agent
  whose `allowed_channels` changed gets a `reprovision` operation queued the same way. Queuing a
  `reprovision` (from either path) now locks the affected agents' lifecycle rows before their
  `agents` rows, matching the lock order `completeOperation` already takes, so the two can never
  deadlock against each other; a config edit that lands while the provisioner is already mid-flight
  on a `reprovision` now cancels that run and queues a fresh one, rather than risking the edit being
  silently folded into — and lost by — an operation that already read a stale configuration. The
  provisioner's own leaving-channels step now re-checks active grants immediately before each
  channel removal, rather than once at the start of its pass, so a grant made mid-pass is still
  honored.
- A channel edit landing while a `create`/`restore` operation was still in flight (`reconciling`)
  could be lost entirely: the provisioner read the agent's channel list once, right after claiming
  the operation, and the edit's own commit never queued a `reprovision` for an agent that was not
  yet `ready`. It now reloads the configuration once more, immediately before completing, and joins
  any channel a concurrent edit added — narrowing the gap to the reload itself rather than the
  whole operation's own duration.
- Changing the organization's own Mattermost team produced no `reprovision` for any agent whose own
  `allowed_channels` had not also changed in the same commit, so lifecycle-owned bots never joined
  the new team. Both committing paths (a managed commit, `config apply`) now queue one for every
  current, lifecycle-owned, `ready` agent when the team changes, not only ones with a channel diff.
- Restoring a former finance agent failed whole-bundle validation (its historical permissions still
  allowed finance tools, never required to deny them while it held the role) unless the request
  also reassigns the role back to it (`makeFinanceAgent`, new); by default its permissions are now
  normalized the same way a fresh non-finance agent's are instead of failing the restore outright.
- A `reprovision` operation that failed permanently moved its agent to `failed`, stopping the
  scheduler over nothing worse than a membership change it could not finish — contradicting its own
  documented rule that a `reprovision` never moves an agent out of `ready`. It now leaves the agent
  `ready` on a permanent failure (recording `last_error` and the failed operation, still visible and
  retryable) and keeps it `ready` through a retry too, never passing it through `pending` the way a
  retried `create`/`restore` does.
- A config write outside `requestAgentRetire` itself (a managed commit, `config apply`,
  `setAgentEnabled`'s own disable-as-removal fallback) could drop a lifecycle-owned agent that was
  not yet `retiring`/`retired` out of the active configuration, leaving its bot active in
  Mattermost and its lifecycle row stuck — unretireable (its own `remove_agent` found nothing left
  to remove) and unrestorable (never reaching `retired`). Every such path now refuses the write,
  naming `gateway agents retire` instead; retiring an agent already missing from the configuration
  this way (a state only an older release's own bug could have left behind) is now tolerated —
  its own `remove_agent` is skipped and every other cleanup step still runs.
- `gateway doctor`'s `mattermost_provisioning` check counted a pending/running `create`, `restore`
  or `reprovision` as waiting on the admin token, but not a `retire` — driven by the very same,
  equally idle tick with no token configured. It now counts a waiting `retire` too.
- The lifecycle provisioner wrote the resolved admin account's directory entry, and a `directory.set`
  audit row with it, on every tick (every few seconds) even when the account had not changed; it now
  writes (and audits) only when it actually has.
- The console's agent page hid retirement progress entirely while a `retire` operation was actually
  in flight (`pending`/`running`): unlike `create`/`restore`/`reprovision`, a `retire` leaves the
  agent `retiring` throughout rather than passing it through `reconciling`, which the panel had not
  accounted for. It now shows the same live checkpoint progress for an in-flight (or retried) retire.
- A fresh `create`'s own bot resolution (`ensureBot`) adopted any existing plain Mattermost bot at
  the agent's chosen username unconditionally, including one this Gateway never created — an
  unrelated integration's bot sharing the same name, say — and the next step would revoke its
  existing access tokens. It now adopts an existing bot only when it is already this agent's own
  recorded identity or was created by this Gateway's own admin account; anything else is a
  permanent "username taken" failure. `restore` and `reprovision`, and `gateway mattermost
  bootstrap`'s own bulk reconcile, are unchanged.
- `gateway mattermost admin-token rotate` revoked every personal access token the admin account
  had, not only ones it created itself — an unrelated token the same account happened to hold would
  be silently revoked too. It now revokes only tokens carrying its own description
  (`agent-gateway-admin`); the very first token on the account, entered by hand through
  `admin-token set`, is never one of those, so the first rotation after it leaves that one alone
  (revoke it yourself, the same as the bootstrap admin token).
- `requestOperationRetry`'s idempotency-key replay checked only that a reused key named the same
  agent, not the same kind of operation — unlike `requestAgentCreate`/`requestAgentRetire`/
  `requestAgentRestore`, which all also check their own fixed kind. It now refuses a key already
  used for a different kind of operation on the same agent too.
- `gateway outbox list --status` rejected `cancelled` (added for a retired agent's own blocked
  deliveries), since its own list of accepted values was a second copy that never picked it up. It
  now validates against the one shared, authoritative list.
- Retirement's own last-resort bot recovery (looking an agent's bot up by its configured username
  when neither its recorded identity nor its own create/restore checkpoints ever named one) adopted
  any plain bot at that username, including one this Gateway never created — the same guard
  `ensureBot` already applies to a fresh `create`, missing here. It now accepts a username-only
  match only when the bot's `owner_id` names this Gateway's own admin account; anything else skips
  Mattermost-side cleanup for that agent entirely (nothing of its own to clean up) rather than
  revoking a stranger's tokens and disabling its account, and says why in the log.
- A `create`/`restore` operation's own channel-reload before completing only ever added a channel a
  concurrent edit introduced, never noticed one the same edit took away, and never accounted for the
  organization's own Mattermost team changing mid-run at all (its `team_joined`/`channels_joined`
  checkpoints, scoped to the team it started against, were treated as already done for the new one
  too). `completeOperation` itself now compares the agent's current `allowed_channels` and Mattermost
  team against what the operation's own checkpoints record having actually joined, still holding the
  same lifecycle-row lock every config writer takes, and queues a `reprovision` on any difference in
  the same transaction; a resumed operation whose checkpoints turn out to be scoped to a team the
  organization has since moved away from rejoins the current one instead of skipping steps already
  marked done for the old one, and a `reprovision`'s own membership step now leaves the old team's
  channels (and the team itself) once the bot has rejoined the current one.
- Restoring a retired agent dropped every permission field this service does not itself rewrite
  (`observe_system`, say) when normalizing a former finance agent's permissions for anyone else,
  since the normalization built a new object from only the three tool-pattern fields it touches
  instead of adjusting those fields on a copy of the original. It now preserves every other field.
- Restoring a retired agent with `makeFinanceAgent` reassigned the finance role to it atomically but
  left the agent the role moved *from* still holding finance tools, which whole-bundle validation
  then refused (only one agent may hold them at a time). The outgoing finance agent's permissions
  are now normalized in the very same change set, the same way a restored former finance agent's own
  are when it is not reclaiming the role.
- The console's lifecycle panel rendered nothing at all for a failed `reprovision` (no error, no
  Retry button) and for one still running, since a `reprovision` never moves its agent out of
  `ready` the way `create`/`restore`/`retire` do, which the panel's own visibility and retry-
  eligibility checks had not accounted for. It now shows both the same way it already does for the
  statuses a `create`/`restore`/`retire` operation runs under. `gateway doctor` also gains a
  `lifecycle_failures` check (any agent whose own current lifecycle operation is `failed`), so a
  failed `reprovision` — invisible from the agent's own status alone — is visible from the CLI too.
- `gateway mattermost admin-token set` stored a hand-entered token exactly as pasted, carrying
  whatever description the operator gave it in Mattermost; `admin-token rotate`'s own revoke pass
  only ever matches its own description, so the first rotation after `set` never revoked it, leaving
  it working indefinitely. `admin-token set` now runs the same create-verify-switch dance `rotate`
  already does, minting and tagging its own token from the pasted one before ever writing the file,
  and revokes the pasted token outright when the account held exactly that one token to begin with
  (unambiguous); an account that already held more than one is left untouched instead, named in a
  warning. `admin-token rotate` now also warns, rather than reporting success plainly, whenever it
  ends up revoking 0 tokens.
- `requestOperationRetry`'s idempotency-key replay matched a reused key by agent and operation kind
  alone, which could not tell its own retry-created row apart from a `requestAgentCreate`/
  `requestAgentRetire`/`requestAgentRestore` row that merely happens to carry the same kind (a
  retry's own operation always carries the kind it retried, never a kind of its own) — a key one of
  those other requests already used could be wrongly "replayed" as a retry. Each retry-created
  operation now records which failed operation it retried (`retry_of`); a key is replayed only when
  the row it finds is actually one. Reusing a key first used by a retry queued before this release
  (`retry_of` added by this same release's migration; such a row keeps it `NULL` forever) is a
  one-time exception: it is no longer replayed and instead queues a fresh operation — still safe (an
  agent's own current operation can only ever be retried once it is `failed`), just not a silent
  replay of the exact call that key first made.
- The lifecycle provisioner's own membership reconciliation (`create`/`restore`/`reprovision`) is
  redesigned to converge on live Mattermost state every pass instead of trusting its own checkpoints
  to say what still needs doing, closing several ways it could get stuck or drift: an old team's
  cleanup depending on a directory lookup the bridge itself clears on team resolution (so it never
  ran); an in-memory "stale team" flag that a crash lost, leaving the bot never actually joined to a
  team change nor ever leaving the old one; a team change queuing a reprovision whose own empty
  checkpoints never recognized the team as stale; and a channel checkpoint keyed by name that could
  accumulate past its own stored-shape limit across two reads of a changing configuration and fail
  to read back at all. The bot's live team and channel memberships are now listed and reconciled
  directly on every pass (join what is configured and missing, leave what is neither configured nor
  actively granted, in the configured team and every other one alike); checkpoints are kept only as
  progress markers for `gateway agents operations` and `completeOperation`'s own end-of-run fence,
  reset at the start of every pass, by channel id rather than name.
- An existing Gateway-owned bot's `team_admin`/`channel_admin` membership roles (granted by hand in
  Mattermost, or left over from an earlier manual change) were never reset by the lifecycle
  provisioner the way `gateway mattermost bootstrap` already resets them for a bootstrap-managed
  bot. The provisioner now normalizes a lifecycle-owned bot's own team and channel membership roles
  back to a plain member the same way, before ever declaring the agent ready.
- A rollback, import or any other whole-bundle `add_agent`/`replace_bundle` commit could re-add an
  agent id whose lifecycle was still `retiring`/`retired`, leaving the configuration enabled for an
  agent nothing had actually provisioned — and leaving `gateway agents restore` itself failing
  "already exists" the moment an operator then tried to restore it the sanctioned way. Every
  committing path now refuses this the same way it already refuses dropping a lifecycle-owned agent
  outside `gateway agents retire`, naming `gateway agents restore` instead; `requestAgentRestore`'s
  own commit is unaffected (it is the one sanctioned way to do this).
- Retirement's own last-resort bot recovery refused a Gateway-owned bot whose `owner_id` named an
  earlier provisioning admin account, after an operator rotated `gateway mattermost admin-token set`
  to a different one: cleanup was skipped as if the bot were an unrelated integration's, even though
  this Gateway created it. It now accepts any admin account id this Gateway has ever recorded for
  itself, not only the current one; a bot that still matches none of them skips cleanup the same way
  (never adopts an unproven account) but now logs a visible warning and a `gateway doctor`-visible
  checkpoint, since this Gateway's own admin-rotation history, had any of it been lost, could in
  principle have vindicated the very same bot.
- `gateway mattermost admin-token set`/`rotate` left a freshly minted token on the account,
  unrevoked and unused, when it failed to verify against the same account it was just created for
  (the one case nothing was supposed to have changed). Both now revoke it before raising the error.
- The lifecycle provisioner's pass was serialized only within one controller process: two
  overlapping controllers (a rolling upgrade, say) could each process the same operation at once,
  one revoking the fresh token the other had just issued and leaving the agent `ready` with a
  revoked token file. Every pass now runs holding a Postgres session-level advisory lock for its
  whole duration; a pass that cannot claim it skips that tick entirely, left for whichever
  controller already holds it.
- `gateway mattermost admin-token set`/`rotate` run concurrently against the same account could
  each revoke the other's freshly minted token before it was ever written, leaving the file holding
  one already revoked. Both commands now hold a database advisory lock for their own
  create-verify-write-revoke sequence and fail fast, with a clear message, when another run already
  holds it.
- Bootstrap's and reconcile's retired-cleanup plan still named a lifecycle-owned agent whose own
  `agents` row had not yet aged out (a `retire` or `restore` still working through it), so a
  bootstrap or reconcile run racing either could revoke a token the provisioner was mid-way through
  issuing, or deactivate a bot it had just re-enabled. The plan now excludes a lifecycle-owned agent
  from retired cleanup the same way it already excludes one from the active bot list — the
  provisioner owns its Mattermost-side cleanup either way.
- A managed commit or `config apply` could redirect a lifecycle-owned agent's
  `mattermost.token_secret_file` to a different path, leaving Mattermost delivery reading a file
  the provisioner never wrote a token to. The field is server-generated and immutable for a
  lifecycle-owned agent in both committing paths now, the same way `/run/bot-secrets/` itself is
  already refused for one the lifecycle does not own; `requestAgentRestore`'s own migration of it
  to the provisioner's path remains the one trusted exception.
- A fresh `create`'s own bot resolution (`ensureBot`) checked a candidate bot's `owner_id` against
  only the *current* provisioning admin account, so a resumed create whose bot had been created
  under an admin account an operator had since rotated away from failed permanently with "username
  taken" — even though the bot was this Gateway's own. It now checks every admin account this
  Gateway has ever recorded for itself, the same rotation-tolerant history retirement's own
  recovery already trusted.
- A retiring agent's own `channels_left` checkpoint could grow past its own contract bound: a
  bot's live channel memberships (ADR-022 grants, channels added by hand) are never bounded the way
  a configured agent's `allowed_channels` is, so retiring one that belonged to more than 64 live
  channels wrote an array the console's lifecycle page and `gateway agents operations` could no
  longer parse back. Every checkpoint write now trims `channels_joined`/`channels_left` to their
  own schema bound before it is ever stored, keeping the most recently added ids; no cleanup is
  ever skipped by this, since what still needs joining or leaving is always decided from a live
  Mattermost check, never from this array.
- `gateway doctor`'s `lifecycle_retire_ownership` check failed doctor outright for a legitimate,
  confirmed outcome (a retiring agent's configured username belonged to an account this Gateway
  never created, so its Mattermost-side cleanup was rightly skipped) and its detail text described
  that outcome as unresolved ("could not be confirmed either way") when it is in fact a definite
  one. It is now a warning that never fails doctor, with detail text naming the outcome correctly.

## [0.5.0] - 2026-10-02

### Added

- The owner's console gains server-side sessions (ADR-025): a database-backed session cookie
  (`__Host-gw_session`; 30-minute idle timeout, 12-hour absolute lifetime, at most 20 active
  sessions at once), a CSRF token derived from the session on every check (never stored, so a
  second tab's own session check can never invalidate the first tab's token) required on every
  mutation, and a new `CONSOLE_ORIGIN` setting every login and mutation must match exactly. A
  sign-in page replaces the browser's HTTP Basic dialog; `gateway console password set` now also
  revokes every active session when it can reach the database.
- The owner's console is now a React single-page app (`apps/console`: React 19, Vite, Tailwind
  CSS v4, shadcn/ui, TanStack Query, React Router; ADR-025's frontend section), replacing the
  server-rendered dashboard and its stand-in sign-in form. It covers everything the old page
  showed (agent states, tasks, recent runs, queues, alerts, budgets, context measurements,
  stale/unavailable states) and adds navigation for the Agents, Skills and Instruments & utils
  hubs. Served under a strict CSP with no inline script anywhere and no `unsafe-eval`
  (`script-src 'self'; style-src 'self'; style-src-elem 'self' 'unsafe-inline'` — the last for
  Radix's own scroll-lock `<style>` element, never an inline `style` attribute); built in its own
  Docker stage with only the static output copied into the release image. `bun run console:build`
  builds it, `bun run console:dev` runs it against a local controller.
- The Agents hub (`/agents`): a list of every configured agent (state, runtime and model, channel
  count, last run) and an editor for an existing one (creating or deleting an agent is still a
  YAML + `gateway config apply`/`import` operation), with one tab per group of fields — Overview
  (display name, enabled), Instructions (role prompt), Runtime (adapter, model, session policy,
  timeout), Assignments (allowed channels, wake rules), Permissions (the three tool-pattern lists,
  `observe_system`) and History (the revisions that touched this agent, each with its own diff).
  Edits accumulate in a local draft; "Review changes" previews the exact diff and an "impact" list
  of destructive or authority-reducing consequences (disabling the agent, removing a channel, a
  tool grant, a deny rule or a human-approval requirement, removing `observe_system`) *and*
  authority-increasing ones just as much (enabling the agent, adding a channel, granting a tool or
  `observe_system`) that must be acknowledged before applying. New management
  API (`GET/POST /api/agents*`, `GET /api/config/revisions*`) translates the editor's bounded
  patch DTO into the same `prepareChange`/`commitChange` change operations (ADR-024) every other
  configuration surface uses, committing with `source: console` and `actor: console:owner` —
  visible in `gateway config history` exactly like any other revision. A stale base is a `409`
  naming the current revision; a business-rule problem (including a run-in-progress protection) is
  a `422` with the server's own message; a repeated idempotency key replays its first commit's
  result.

### Fixed

- Channel grants (ADR-022): a grant is recorded before the listener joins the channel, so
  `gateway mattermost reconcile` never reports the listener as an unauthorized member of a
  channel whose grant was already decided; the listener's membership of every granted channel is
  re-checked on each pass, after the grant is re-validated, so a transient failure or a restart
  between granting and joining heals itself.
- The console's sign-out no longer signs the owner out locally on a failed `DELETE /api/session`
  (a 403, a 500, a network error): the session cookie is still valid in that case, so the UI now
  keeps the signed-in state and lets the caller show a retryable error instead of lying about
  being signed out.
- A direct `/sign-in` load's startup session check could resolve "unauthenticated" after a
  sign-in submitted in the meantime had already won, undoing it; a sign-in now supersedes that
  startup check's own, by-then-stale result.
- The overview page's "could not load" banner no longer hides the last-known status snapshot
  when a poll fails after an earlier one succeeded; the retained data and its timestamp are shown
  together with the failure, and the data-less error view appears only when nothing has ever
  loaded.
- The Agents hub's optimistic concurrency was defeated: the editor committed a change with the
  revision the *preview response* reported rather than the one it had actually loaded, and preview
  itself always computed against the live configuration regardless of a stale base — together, a
  commit between opening the editor and applying a change was silently reverted instead of
  refused. Preview and commit alike now refuse a non-current base with `409`; "Reload and try
  again" re-fetches the agent and rebases the draft onto it, keeping every edit whose own field
  did not also change upstream and discarding (with a visible notice) one that did.
- A commit retried under the same idempotency key after an unrelated, intervening change to the
  same agent could be refused as "the same key, a different change set": the retry recomputed its
  plan against the agent's now-different *live* state rather than the request's own claimed base,
  so an unrelated field the patch never touched could still shift the computed change set between
  the two attempts. The plan is now built from the agent's definition at `baseRevisionId` itself
  (immutable, content-addressed), which a retry always repeats identically, letting it replay
  correctly regardless of what has happened to the live configuration meanwhile.
- Disabling a retained agent whose own stored configuration no longer validates (ADR-024's
  disable-with-fallback-to-`remove_agent`) always failed from the console with a `422`: the
  fallback that `gateway agent disable` already has was never reachable through
  `commitAgentPatch`, which rejected the plain disable's own validation problems before the
  fallback ran. Preview now computes and shows the fallback too ("removes the agent from the
  configuration" in `impact`), and commit executes it.
- The Agents hub's list included an agent retained, disabled, outside the active configuration,
  whose own detail route already 404s; it is now left out of the list for the same reason.
- `runtime.model` could not be cleared back to the runtime adapter's own default from the console:
  clearing the field sent nothing at all (`undefined` is dropped by `JSON.stringify`), which the
  server reads as "unchanged". The patch contract's `runtime.model` now accepts an explicit `null`
  meaning "remove the override".
- A wake rule's target-agent picker kept the previous target when "(no specific target)" was
  selected, instead of actually clearing it.
- A `401` from the Agents hub's list, its editor or its preview/commit calls left the console
  showing an error while the sidebar still said "signed in"; every request now reports its own
  `401` to the same session layer the status poll already did, falling back to the sign-in screen
  consistently.
- A stale startup session check still overwrote the CSRF token a concurrent sign-in had already
  captured (the state-level race this was already fixed for above; the token itself was a
  separate clobber that survived it), and sign-out cleared the held token even when the server
  refused the logout (a `403`/`5xx`), leaving a signed-in tab unable to make another mutation
  until it reloaded. Both are now guarded the same way the session state itself already was.
- A mutation refused with a `403` naming an invalid CSRF token (another tab signed in anew, or the
  controller's routing key rotated) now refreshes the token from one session check and retries
  the same request once, instead of failing immediately.
- `CONSOLE_ORIGIN` accepted any `http://` value, including one pointed at a real host, even though
  the session cookie is `__Host-`/`Secure` and so needs TLS everywhere but a loopback address; it
  is now refused at start unless the host is `localhost`/`127.0.0.1`.
- `ConsoleAgentDetailSchema`'s role prompt field required at least one character, but the server
  legitimately returns an empty one for an agent that has never had a role prompt set — the
  detail page failed to open for it. Empty is now accepted.
- The release image's production dependency install picked up React, Radix UI, Vite, Tailwind,
  TanStack Query and the console's other frontend dependencies (declared under `dependencies`
  rather than `devDependencies`, so a workspace-wide `bun install --production` installed them
  too, even though nothing in the runtime image ever imports or runs them — only `apps/console`'s
  separately built, static `dist/` output ships). They are now `devDependencies`, as the frontend
  build step already assumed.

## [0.4.0] - 2026-10-01

### Added

- Managed configuration (ADR-024): PostgreSQL is now the authoritative configuration store.
  Every applied configuration is kept as an immutable, content-addressed snapshot (organization,
  agents, constitution and resolved role prompts), and every change is a row in an append-only
  revision journal with its actor, source, parent and generation. `config_versions` and the
  `agents` rows remain the projections an older release reads.
- A shared prepare/commit path for configuration changes: a change set is previewed as a
  deterministic structural diff against a base revision, then committed only if that base is
  still active (otherwise a conflict naming the current revision), with an optional idempotency
  key that replays an earlier commit instead of applying it twice.
- `gateway config export|diff|import|history|rollback|ack`. `export` writes a revision as a
  self-contained, byte-for-byte reproducible directory with a `manifest.json` of file hashes;
  `diff` previews a directory against the active revision; `import` commits it and, once a
  configuration is active, requires `--expected-revision`; `rollback` commits an earlier
  revision's content as a new revision; `ack` acknowledges a change recorded from outside the
  history.
- Configuration changed by an older release during a rollback interval (`config apply`,
  `agents enable|disable`) is recorded on the next start as a `backfill` revision of what is
  actually running, logged, raised as the `config:backfill` alert and reported by
  `gateway doctor` until acknowledged or superseded.
- `gateway backup check --restore-test` verifies configuration history on a restore: the active
  revision exists and every snapshot still hashes to its own key. Backups taken before this
  release still verify.

### Changed

- `gateway agents enable|disable` is now a configuration change recorded in the revision
  history, so a later import of the same content no longer silently reverts it.
- `gateway config apply` still works unchanged, but is deprecated in favour of
  `config diff` followed by `config import --expected-revision`.
- Configuration validation is stricter on every path: role prompts and the constitution are
  bounded and text-checked the same way everywhere, agents sharing a prompt file must have the
  same prompt text, and every role prompt must belong to a configured agent.

### Fixed

- Home server: `setup-guest.sh` restarts avahi before the mDNS alias publishers and fails unless
  both `mattermost.local` and `gateway.local` resolve to the VM's address, so a re-run no longer
  leaves the names unresolvable.

## [0.3.0] - 2026-10-01

### Added

- The owner's console (ADR-023): a read-only status page for agent states, current tasks,
  recent runs, waits, queue depths, alerts, budgets and context measurements, refreshed every
  15 seconds. Off by default (`CONSOLE_ENABLED`); `gateway console password set` writes one
  Argon2id-hashed owner password (hidden entry, confirmed twice); HTTP Basic authentication, a
  global rate limit on failed logins, and a fixed set of security headers on every response. On
  the home server kit, served at `https://gateway.local` through Caddy, the same certificate
  authority already trusted for `mattermost.local`; the controller publishes no host port and
  binds only its own network alias, unreachable from the workers, connectors or tool runner.
  See [docs/operations/console.md](docs/operations/console.md).
- The `operator` example agent (`config/examples/agents/operator.yaml`): answers "what's going
  on" in Mattermost from `permissions.observe_system`, a new permission that hands an agent's
  turn the Gateway's own `SystemStatus` (agent states, run ids, queue depths, alert keys, token
  and cost counts — operational metadata only, never message content). Off by default; the
  operator has no other grant (only `mattermost.post`, `memory.write` denied) and cannot change
  anything itself — it points the owner at the `gateway` command to run instead.
- `AgentTurnInput.schemaVersion` `2`, carrying `systemStatus` for an agent that observes the
  system; version 1 is unchanged. An older release rejects a version 2 job outright, and a
  configuration with `permissions.observe_system` set; see `deploy/release/ROLLBACK.md` and
  [docs/operations/releases.md](docs/operations/releases.md#the-v2-compatibility-rule) for what
  rolling back past this release needs.

### Changed

- A run's displayed last-attempt usage (`agent_runs.usage`) now reflects a retried attempt too,
  not only a run's first one: the console and an observing agent's `SystemStatus` both show the
  last attempt's own reported tokens, whichever attempt that was. The budget ledger itself is
  unaffected by this change: it already booked every attempt before and after.
- An explicit `memory.write` deny now also removes every writable memory namespace, private and
  shared, not only the tool call itself: an agent denied `memory.write` is left with no
  namespace to propose a memory write into at all.

## [0.2.1] - 2026-09-30

### Fixed

- A worker stops a turn as soon as its run is cancelled (a pause, `runs cancel`, `kill-all`).
  It only noticed the cancel at the turn's deadline: the runtime worked on, spending tokens,
  and held the worker's slot, so the agent's next work waited up to the run timeout. Found by
  the failure drills on the home server.

### Added

- `scripts/soak/drills.sh`: failure drills for a restored copy of the home server, and
  `home-server/guest/restore.sh` to restore the whole server from a backup archive.

## [0.2.0] - 2026-09-30

### Added

- The home server kit (`home-server/` in the bundle, ADR-021): a Lima VM template for an
  Apple silicon Mac (Ubuntu 24.04, Docker Engine by exact versions, Rosetta, bridged LAN
  address, start at boot), the guest setup (fixed LAN address, mDNS name, egress firewall
  unit), the Mattermost 11.7 ESR stack with its own PostgreSQL and Caddy TLS, and daily
  encrypted backups of the whole server copied off the VM by a LaunchDaemon.
- Channel grants (ADR-022): an owner or a system admin adds an agent's bot to a channel in
  Mattermost, and within seconds the agent works there, without configuration or a command;
  removing the bot takes the channel back. An add by anyone else, another agent's bot
  included, is refused: the bot leaves and the alerts channel says who added it. The agent
  sees nothing posted before its add. `allowed_channels` is optional.
- `bin/egress-firewall.sh`: an nftables table that leaves the Gateway's egress bridge only the
  public internet and the host's DNS resolvers.

### Fixed

- The Codex worker image carries Codex's code-mode host (`codex-code-mode-host`, pinned by
  SHA-256 like the CLI). Codex 0.156 runs the model's shell commands through it; without it
  no command ran, so an agent granted `tests.run` could not run tests or builds.
- The turn prompt says that shell commands may create and change files in the working
  directory; "create and edit files: not available" made models refuse builds and tests
  that write files when only `tests.run` was granted.
- `gateway runtime doctor` shows the model's reply when its sandboxed-command check fails.
- The binaries of the Codex worker image belong to root, not to the uid of the upstream
  archive.

### Changed

- The `egress` network's bridge is named `agw-egress`, so host firewall rules can match it.
  Upgrading from 0.1.x recreates the network: stop the stack with `bin/agw down` (volumes are
  kept) before `bin/agw up -d`.

## [0.1.1] - 2026-09-30

### Fixed

- The release workflow checks anonymous pulls of each platform's image by its own digest.
  Pulling the second platform through the index collided with the first in Docker's image
  store, so 0.1.0 stopped before its GitHub Release; its images are in GHCR but the release
  was never published. Install 0.1.1.

## [0.1.0] - 2026-09-30

### Added

- The release pipeline (ADR-020):
  - release images `agent-gateway` (controller, CLI, Gmail connector, tool runner, mock
    worker) and `agent-gateway-worker-codex`, reproducible bit for bit from pinned
    inputs (base image digest, Debian snapshot, `bun.lock`, checksummed CLI archives);
  - SPDX SBOMs, build provenance and SBOM attestations, and a checksummed, attested bundle:
    the Compose stack by digest (`images.lock`), `bin/agw`, `init-home.sh`,
    `verify-release.sh`, `INSTALL.md`, `UPGRADE.md`, `ROLLBACK.md`, `MIGRATIONS.md` and a
    recipe for an operator-built Claude Code worker;
  - `package.yml` on every change: build twice and compare, bundle, and an install test on a
    runner without the checkout (smoke mention, versions, hardening, the Codex sandbox,
    upgrade and rollback);
  - `release.yml` on a `vX.Y.Z` tag: CI again, then GHCR, attestations and the GitHub
    Release.
- Hardened containers: uid 10001, read-only root filesystem, no capabilities,
  `no-new-privileges`, CPU/memory/PID limits, separate networks, and a seccomp profile that
  lets bubblewrap confine a runtime's commands inside the container. Services refuse to run as
  root.
- Schema compatibility: every migration is `expand` or `contract`
  (`packages/db/migrations/compatibility.json`); `gateway db migrate` certifies the releases
  that may run on the result, and every service and CLI session command refuses a database
  it is not certified for. A rollback by one release after expand-only migrations needs no
  restore. New commands `gateway db status`, `gateway db create-role` and `gateway version`.
- linux/arm64 release images next to linux/amd64: each platform built, reproduced and
  install-tested natively on its own runner, published as one index per image;
  `images.lock` format 2 pins the index and each platform's manifest, and
  `verify-release.sh` checks the index against it.
- The deployment lock: services hold it shared, `gateway db migrate` exclusively, so a
  migration never runs under live services.

### Changed

- The controller no longer migrates the pg-boss schema or creates queues on start;
  `gateway db migrate` does both. Run it before starting a new version.
- `@agent-gateway/testkit`'s packages are development dependencies, and the controller
  declares `@agent-gateway/policy`, which it loads at run time.

- Observability (ADR-019):
  - metrics on every service's `/metrics` (Prometheus text format), with database gauges
    from the controller and a collection-success flag;
  - a health server for the worker (port 8081);
  - W3C trace context carried from an event through its runs, attempts, deliveries, agent posts
    and tool actions, with `trace_id` and `span_id` in log lines;
  - log redaction of headers, Google tokens, JWTs, fine-grained GitHub tokens, secret query
    parameters and email addresses; bounded log lines; the service version in every line
    (`GATEWAY_VERSION`, `GATEWAY_COMMIT`).
- Alert conditions: a lasting problem fires once, reminds every 6 hours and is resolved when it
  ends. It covers:
  - Mattermost disconnects;
  - dead letters and dead outbox items;
  - budgets at 80%;
  - repeated invalid output;
  - Gmail watch expiry;
  - retention and backup checks.

  `gateway doctor` lists firing alerts.
- Retention (`organization.retention`): the controller removes message content after its
  period, hourly and in batches. Identifiers and hashes stay for dedupe. Pending work and a
  FAILED agent's latest run are kept, and so are approvals, tool actions and the audit log.
- `gateway backup check`: verifies the newest backup (manifest, age, checksum, database
  identity, schema, archive) and optionally restores it into a scratch database. `--record`
  lets the controller alert on a failed or stale check. `scripts/backup-gateway-db.sh` is a
  reference producer.
- Resource limits:
  - statement, lock and idle-transaction timeouts on the services' database pools;
  - a 2 MiB turn input cap;
  - removal of run workspaces a crashed worker left behind.
- Security scans in CI (`security.yml`): Gitleaks over the git history and OSV-Scanner over
  `bun.lock` with a license allowlist, on push, pull request and daily. Every GitHub Action is
  pinned by commit SHA.
- Migration `0012_traces_retention_alerts`:
  - `traceparent` on runs, outbox items and tool actions;
  - `content_expired_at` markers;
  - `alert_states` and `maintenance_status`.

- Approval decisions and the tool broker. An owner decides in the approval card's thread with
  `approve <code>` or `deny <code>`. The listener hands the reply to a dedicated decision path
  that checks the owner (fresh account lookup, approver snapshot and current owners), the
  one-time code, the status and the expiry, and answers in the thread. A grant re-checks the
  policy and queues a tool action. `apps/tool-runner` (`@agent-gateway/tool-broker`) executes
  it: it recomputes the hash, runs the `gateway_begin_tool_action` check (approval, hash,
  deadline, kill switch) and reports a receipt. The agent waits for one `approval.resolved`
  event with the outcome. Kill-all cancels pending approvals and queued actions.
  A stop request (kill-all, disable) aborts a running executor. An unknown outcome is never
  retried; `gateway tools settle` records it by hand. `gateway db grant-tool-runner`,
  `gateway tools list`. ADR-018.
- Policy engine (`@agent-gateway/policy`): deny-by-default tool evaluation, finance only for the
  finance agent and always approval-gated, typed parameter sets for `finance.payment.create`
  and `finance.subscription.create`, checked before a card is shown, at grant and in the
  runner. Approval cards flag values that mix alphabets.
- Daily budgets (`organization.budgets`): per-agent and global limits on cost and tokens per
  UTC day, summed from a usage ledger of every run attempt; an agent over its limit starts no
  run until the day changes or the limit is raised. `gateway budgets`, budget and tool action
  checks in `gateway health`.
- Migrations `0010_approvals_and_tool_actions` (`tool_actions`, `approval_replies`,
  `run_usage`, approval `cancelled` replaces `executed`) and `0011_approval_guards`
  (immutability triggers and the `begin` function).

- Gmail connector without Pub/Sub by default: it polls the mailbox's history every minute with
  a credential that grants `gmail.readonly` only; Pub/Sub push notifications are optional
  (`gateway gmail authorize --pubsub`, `GMAIL_PUBSUB_*`). `GMAIL_SYNC_SECONDS` replaces
  `GMAIL_RECONCILE_SECONDS`. The connector records its mode and interval for
  `gateway health` (migration `0009_gmail_mode`). ADR-017.
- Gmail connector (`@agent-gateway/connector-gmail`, `apps/connector-gmail`): Gmail watch with
  daily renewal, Pub/Sub pull, history sync with a transactional cursor, periodic
  reconciliation and full sync after a history gap. Mail is normalized to plain text
  (active and hidden HTML removed, attachments described only) as external-untrusted
  `google.gmail.message.received` events that wake `@mail-follower`. A read-only credential:
  `gateway gmail authorize` (loopback OAuth with PKCE) grants exactly `gmail.readonly` and
  `pubsub`, and any wider token is refused. `gateway gmail status`, Gmail checks in
  `gateway health`, migration `0008_gmail_mailboxes`. ADR-016.
- Runtime adapters for Grok (`@agent-gateway/runtime-grok`), Kiro (`runtime-kiro`), OpenCode Go
  (`runtime-opencode`) and Hermes Agent (`runtime-hermes`). Each uses a home directory the
  Gateway owns, and gets only the built-in tools it can confine. ADR-015.
- Runtime health: worker heartbeats, `gateway runtimes list`, degraded agents and an alert when
  a runtime has no ready worker; `WORKER_RUNTIME_VERSION` pins a runtime version. Migration
  `0007_runtime_workers`. A worker whose probe fails now stays up and reports it instead of
  exiting.
- MIT license.
- Runtime adapters for Codex (`@agent-gateway/runtime-codex`, `codex exec --json`) and Claude
  Code (`@agent-gateway/runtime-claude`, `claude -p`). Each call runs in its own process group,
  with a clean environment and a workspace per run. Built-in tools follow the agent's tool
  policy. Provider sessions are resumed under `resumable-if-available`, with a fresh start when
  a session is gone. ADR-014.
- `gateway runtime doctor <adapter>`: version, login, a real structured turn, cancellation,
  session resume and policy risks. Worker settings `WORKER_WORKSPACE_ROOT`, `CODEX_*` and
  `CLAUDE_*`. Live runtime tests (`bun run test:live`); fake CLIs for the contract suite in CI.

- Turn context (`@agent-gateway/context`): the turn's Mattermost thread assembled from stored
  events within a budget, thread summaries compacted from run summaries (`thread_summaries`),
  the agent's memory from its own namespaces; a turn resumed by a timeout keeps its thread.
- Memory review: private proposals are accepted at once, shared ones wait for
  `gateway memory accept|reject`; waits may name only thread participants or owners.
- `renderTurnPrompt` in the runtime SDK: prompt layers in trust order with delimited data;
  ADR-013; mock scenarios `wait-asker` and `remember`.

- Mattermost bridge (`@agent-gateway/mattermost`): WebSocket listener with per-channel cursors,
  REST catch-up after reconnects, restarts and sequence gaps; exact mention parsing; posts by
  each agent's own bot with HMAC-signed routing props; alerts and approval cards by the
  listener bot; `gateway mattermost bootstrap` and `gateway mattermost reconcile`.
- Thread activity guard (30 wake-ups per thread per 10 minutes); edits and deletions are
  record-only; replies are bound to their thread's channel.
- Mattermost 11.7.11 in the development Compose; end-to-end tests against a real Mattermost
  (`bun run test:e2e`, `e2e` workflow); ADR-012; Mattermost operations guide; privacy notes.

- Durable core on the mock runtime: Drizzle schema and migrations, event ingest with dedupe,
  deterministic routing with loop guards, agent state machine and inbox, durable waits and
  timeouts, pg-boss queues with dead letter queues, transactional outbox, approval requests.
- `@agent-gateway/runtime-sdk` (adapter contract, turn execution with one repair, contract
  suite) and `@agent-gateway/runtime-mock`.
- Controller and worker processes with health endpoints and redacted JSON logs; `gateway` admin
  CLI; development Compose with PostgreSQL; loopback delivery for cascades without Mattermost.
- ADR-011 run execution protocol; local development guide.

- Monorepo scaffold on bun workspaces with Biome, TypeScript 7 and Vitest.
- `@agent-gateway/contracts`: Zod contracts for organization/agent config, CloudEvents gateway
  events, runtime turn input/result, wait conditions and approval requests; generated JSON Schema.
- `@agent-gateway/testkit`: PostgreSQL Testcontainers helper and a Bun compatibility smoke test.
- Example organization, agents and prompts.
- Turn result authority check and a provider strict-mode compatible model output schema.
- ADR-001 ... ADR-010, assumptions, project structure, threat model draft.
- CI workflow skeleton.

### Fixed

- `bun run dev` started the controller only after the worker exited.
