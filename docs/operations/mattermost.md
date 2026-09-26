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
  code blocks, inline code and quotes, and only agents allowed in that channel.
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
