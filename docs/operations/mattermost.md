# Mattermost bootstrap and operation

The Gateway talks to one Mattermost team through a listener bot and one bot per agent
([ADR-012](../adr/012-mattermost-bridge.md)). This guide sets them up on a new server and
keeps them healthy.

## Server settings

The Gateway is tested against Mattermost 11.7.11 (ESR). Two System Console settings are
required: **Enable Bot Account Creation** and **Enable Personal Access Tokens** (environment
variables `MM_SERVICESETTINGS_ENABLEBOTACCOUNTCREATION=true` and
`MM_SERVICESETTINGS_ENABLEUSERACCESSTOKENS=true`).

## Manual steps first

1. Create the first account; it becomes the system admin.
2. Create the team named in `organization.yaml` (`mattermost.team`) and every channel listed
   in `mattermost.channels`. Private channels work: bootstrap adds the bots to them.
3. Create the owner accounts (`owner_mattermost_usernames`) and add them to the team.
4. As the admin, create a personal access token (Profile, Security, Personal Access Tokens).
   It is needed only for bootstrap; revoke it afterwards.

## Bootstrap

The configuration must be applied first (`gateway config apply`), because bootstrap works from
the active version.

```bash
export MATTERMOST_URL=http://127.0.0.1:8065
read -rs MATTERMOST_ADMIN_TOKEN && export MATTERMOST_ADMIN_TOKEN   # not in shell history
bun run gateway mattermost bootstrap --secrets-dir secrets
unset MATTERMOST_ADMIN_TOKEN                                       # then revoke it in Mattermost
```

Bootstrap is idempotent, runs one at a time, and runs again when the configuration changes
while it works. It:

- resolves the team, channels and owners and stores their ids (it never creates them);
- creates each missing bot (the listener and one per agent) as a plain member, never an admin,
  and re-enables a deactivated one;
- adds the listener to every managed channel and each agent to its `allowed_channels`, and
  removes agent bots from managed channels they are no longer allowed in;
- takes the bots of agents removed from the configuration out of every managed channel and
  deactivates them (their tokens stop working);
- writes each bot's token into `<secrets-dir>/<name>` for its configured
  `/run/secrets/<name>`, mode 0600, and keeps a stored token that still works (pass
  `--rotate-tokens` to issue new ones);
- creates the routing key `<secrets-dir>/gateway_routing_key` if there is none;
- starts the catch-up of each newly managed channel at its newest post, so a channel's older
  history is never replayed (run bootstrap whenever a channel is added);
- takes every Gateway bot out of channels that are no longer managed, and retires a listener
  bot of an earlier configuration;
- refuses to adopt an existing bot account with more than plain member roles, keeps each bot
  in the one team as a plain member (team or channel admin rights are removed) and takes it
  out of every other channel of the team, managed or not (except `town-square`, which no
  member can leave) and out of other teams.

Nothing secret is printed. In a deployment, mount the secrets directory at `/run/secrets` in
the controller container only; workers get none of these files. In local development
(`bun run dev`) the worker runs as the same user in the same working tree and could read
them: use throwaway development bots only.

## Automated agent provisioning (no bootstrap needed)

Bootstrap above sets up the team, the channels, the owners and the listener bot once, with a
temporary admin token. Creating an agent afterwards does not need that temporary token, or a
`gateway mattermost bootstrap` run, again: the controller provisions the new agent's bot itself,
using a long-lived personal access token of a dedicated, non-bot Mattermost system-admin
account ([ADR-026](../adr/026-agent-lifecycle.md)) — a credential kept in the controller's own
secrets, never handed to a model, constrained in code to exactly the bot-provisioning actions
below.

### One-time setup

1. In Mattermost (as an existing system admin, or the first account on the server), create a
   dedicated user for this, e.g. `gateway-admin`, give it the **System Admin** role, and make sure
   **Enable Personal Access Tokens** is on (`MM_SERVICESETTINGS_ENABLEUSERACCESSTOKENS=true`, the
   same setting bootstrap needs). This account is never a bot (Mattermost bots cannot create other
   bots) and is never one of the `owner_mattermost_usernames` an agent's approvals already trust —
   keep it out of that list.
2. As `gateway-admin`, create a personal access token (Profile, Security, Personal Access Tokens).
3. Store it in the controller's secrets, from an interactive shell (hidden entry; the token is
   never printed, logged or committed):

   ```bash
   bun run gateway mattermost admin-token set --secrets-dir secrets
   ```

   This validates the token (`users/me`: a non-bot account with the `system_admin` role) and
   writes it to `<secrets-dir>/mattermost_admin_token`, mounted read-only into the controller at
   `/run/secrets/mattermost_admin_token` (`MATTERMOST_ADMIN_TOKEN_FILE`). The controller's
   provisioner picks it up on its own next pass — no restart needed.

With no admin token configured yet, `create`/`restore`/`reprovision` operations simply stay
`pending`; `gateway doctor`'s `mattermost_provisioning` check names this plainly rather than
failing them.

### Creating an agent

```bash
bun run gateway agents create data-analyst \
  --display-name "Data Analyst" \
  --role-prompt-file prompts/agents/data-analyst.md \
  --channel hq --channel research
bun run gateway agents operations --agent data-analyst
```

`agents create` commits the agent's configuration and records a `create` operation; the
provisioner then creates the bot (refusing to adopt an existing account that is not plausibly its
own — a regular user, or a bot with elevated roles — with "username taken"), issues it a token
under `/run/bot-secrets/mm_<id>_token` (generated, never a path you choose), adds it to the team
and to each channel in `--channel`, and records its account the same way bootstrap does. Each step
is checkpointed as it completes, so a controller restart mid-way resumes exactly where it left
off, and a lost token response is recreated rather than reused. Once every step is done the agent
becomes `ready` and a waiting mention runs at once. `agents operations` shows each operation's
state, checkpoints and error, if any; a permanent failure (the username really is taken, or the
admin token is rejected) needs an operator's attention — everything else (a slow or unreachable
Mattermost) retries on its own.

The bot's token file is in `secrets/controller-bots/`, backed up and restored along with the rest
of `$GATEWAY_HOME` (`docs/operations/home-server.md`); nothing needs to be reprovisioned after an
ordinary restore. Only if that directory itself were ever lost without a backup would an agent's
bot need a fresh token — created by hand in Mattermost and written to its
`mattermost.token_secret_file`, or by retiring and restoring the agent (below).

### Changing a lifecycle-created agent's channels

Editing `allowed_channels` for a `ready`, lifecycle-created agent — the owner's console, or
`gateway config import` — queues a `reprovision` operation the moment the change commits; no
`gateway mattermost bootstrap` run touches this agent, so without it nothing would ever join or
leave its bot to match. The provisioner picks it up like any other operation: it keeps the bot's
existing token, joins every channel the edit added, and leaves every channel the edit removed
(except one an owner or admin granted the bot directly, which stays). The agent itself stays
`ready` throughout — a membership-only change is never a reason to pause its scheduling.

### Retiring and restoring an agent

```bash
bun run gateway agents retire data-analyst --reason "role no longer needed"
bun run gateway agents operations --agent data-analyst
```

`agents retire` cancels an active run (the same cancellation `agents pause` performs), cancels
its waits, withdraws its pending approvals and queued tool actions (and asks a running one to
stop), revokes every channel it was ever granted directly, blocks its own pending Mattermost
deliveries, and commits the configuration change that takes it out of scheduling — all before the
Mattermost side even starts. The lifecycle moves to `retiring`, then the provisioner removes the
bot from every channel it is in, revokes its access tokens, deactivates the account, and (for a
lifecycle-created agent only — a bootstrap-managed one's `/run/secrets/...` file is never
touched) deletes its local token file; the lifecycle becomes `retired`. A permanent failure
leaves it `retiring` with `last_error`, surfaced by `gateway doctor`; **a database rollback alone
never reactivates a Mattermost account that a provisioner pass already deactivated** — Mattermost
is never inside a Gateway database transaction.

Retiring the organization's configured finance agent is refused unless the same command also
reassigns the role:

```bash
bun run gateway agents retire finance-bot --reassign-finance-to data-analyst
```

An agent id is never reused, so a retired agent's identity, audit trail and run history always
stay its own. Its private memory becomes unreadable at once (excluded from `gateway memory list`
too) and is left to the existing retention to expire on its own schedule; shared memory it wrote
and that was accepted is organization-owned and stays.

```bash
bun run gateway agents restore data-analyst
```

`agents restore` re-adds the agent's last recorded configuration (`pending`, then provisioning
again): the provisioner re-enables the same bot account, issues it a fresh token (its old ones
were revoked on retirement), and rejoins its configured channels — the same steps a fresh
`create` takes, since `restore` shares the provisioner's own path with it. Restore is refused
when no historical configuration for the agent is still available (an upgrade from a release
before the configuration journal existed).

### Channel assignments and provenance

```bash
bun run gateway agents channels data-analyst
```

Lists the agent's channels with where each one comes from: `configured` (named in its own
`allowed_channels`) or `granted` (an ADR-022 grant — by whom, when, and the post that is its
evidence). Revoke a grant directly:

```bash
bun run gateway agents revoke-grant data-analyst research
```

This tombstones the grant (re-adding the bot to the same channel later never silently re-grants
it) and removes the bot from the channel: at once, via a queued `reprovision` operation, for a
lifecycle-created agent; on the membership synchronizer's own next pass (seconds away) for a
bootstrap-managed one. A channel the bot is a member of that is neither configured nor granted
(`member-unauthorized`) does not show up here — that is a live check against Mattermost itself,
which `gateway mattermost reconcile` already performs.

## Giving an agent a channel

An owner (`owner_mattermost_usernames`) or a system admin adds the agent's bot to a channel in
Mattermost, like any member ([ADR-022](../adr/022-channel-grants.md)). Within a few seconds the
controller notices, the agent's bot adds the Gateway's listener to the channel, and the agent
answers mentions there. Nothing needs to change in the configuration, and no command is run.

- The agent sees only what is posted after it was added; the channel's earlier history is not
  replayed to it.
- An add by anyone else counts for nothing: the bot leaves the channel again and the alerts
  channel says who added it. That includes bots: an agent can ask a human in a thread to add
  it or another agent, never add one itself.
- Removing the bot from the channel takes the channel away. Its pending mentions from there are
  dropped, and nothing more is posted there; the listener leaves when no agent and no
  configured channel needs the channel.
- Public and private channels of the configured team work. Direct and group messages never do
  (ADR-006), and `town-square`, which every team member is in, works only through the
  configuration.
- Mattermost's default permissions let a channel member add members; the agent's bot uses that
  to add the listener. With a stricter permission scheme, add `gateway-listener` to the channel
  first, then the agent (otherwise the bot leaves again and the alerts channel says why).
- Taking a channel out of an agent's `allowed_channels` takes it away for good: to give it back,
  add the bot again (or configure it again).
- An archived channel loses its agents; after restoring it, add the bots again.
- Bootstrap reads the grants when it starts: a bot added while it runs may be taken out again.
  Add it once more after bootstrap.

`allowed_channels` in an agent's configuration stays available for channels an agent should
always have; bootstrap adds the bot there. Bootstrap keeps bots in the channels they were
given, and reconcile counts those channels as allowed.

## Reconcile

```bash
bun run gateway mattermost reconcile --secrets-dir secrets
```

It checks, with each bot's own token, that the token works and belongs to the recorded bot,
that the bot is a plain member of exactly its channels (and of no other team), and that
channel names still resolve to the recorded ids. It
changes nothing in Mattermost and exits with 1 when something needs attention; rerun bootstrap
to fix it.

## Controller settings

| Setting | Meaning |
|---------|---------|
| `OUTBOX_DELIVERY=mattermost` | run the listener and deliver posts to Mattermost |
| `MATTERMOST_URL` | server base URL, e.g. `http://mattermost:8065` inside the Compose network |
| `GATEWAY_ROUTING_KEY_FILE` | the routing key file created by bootstrap |
| `SECRETS_DIR` | optional: where `/run/secrets/<name>` files are looked up instead (development) |

`/health/ready` includes a `mattermost` check: `connected`, or `connected, catching up` while
a sync after a failure is pending.

## How posts are handled

- A human's post addresses the registered agents it mentions exactly (`@developer`), outside
  code blocks, inline code and quotes, and only agents allowed in that channel (configured
  there, or given it by an owner or admin).
- An agent's post routes by its signed metadata, never by its text. A post by an agent's bot
  without a valid Gateway signature is not routed and raises an alert in the alerts channel:
  someone else is using that bot's token. Rotate it (`bootstrap --rotate-tokens`).
- Posts by webhooks, other bots and plugins are recorded but wake nobody. So are exact copies
  of an agent's signed post (a replay alert).
- Edits and deletions are recorded and never wake anyone; mention the agent in a new post. A
  post that was written and edited while the controller was down is recorded without waking
  anyone, because its original text is unknown.
- Posts written while the controller was down are picked up when it starts again. A channel's
  history from before the Gateway first listened to it is not replayed.

## Rotation

- **Bot tokens:** `bootstrap --rotate-tokens` revokes every existing token of each bot and
  issues new ones. The controller reads tokens when it uses them, and the listener reconnects
  when its token is rejected; no restart is needed. Bootstrap also revokes all tokens of an
  existing bot account it adopts for the first time.
- **Routing key:** replace the file and restart the controller. Agent posts signed with the
  old key that were not yet synced are rejected and alerted; there is no dual-key window.
- **The provisioning admin token:** Mattermost access tokens do not expire on their own, so rotate
  it by hand, every 90 days:

  ```bash
  bun run gateway mattermost admin-token rotate --secrets-dir secrets
  ```

  Create-verify-switch-revoke (ADR-026): it creates a new personal access token for the same
  `gateway-admin` account, verifies it authenticates as that account, writes it over the current
  file — the controller's provisioner reads it on its next pass, no restart needed — and only then
  revokes every other token the account has. A crash between any two of those steps leaves a token
  that still works; re-running the command finishes it (it revokes every token that is not the one
  it just wrote, however many stray ones a crashed earlier attempt left behind).
