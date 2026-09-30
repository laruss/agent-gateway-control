# ADR-022. Channel grants: an owner adds an agent's bot, and the agent works there

- Status: Accepted
- Date: 2026-09-30
- Amends: [ADR-012](012-mattermost-bridge.md) (static channel authorization and bootstrap's
  pruning), [ADR-006](006-no-direct-messages-in-mvp.md) ("channels listed in the
  configuration")

## Context

An agent could work only in channels named twice in the configuration (`mattermost.channels`
and its `allowed_channels`), after `config apply` and a bootstrap. Adding its bot to another
channel in Mattermost did nothing, and the next bootstrap took the bot out again. For the
operator of an invite-only server this is the wrong way round: adding a member to a channel is
how Mattermost says who works where.

Channel membership alone cannot authorize an agent, though: in Mattermost any channel member
may add members, so anyone in a channel could put an agent to work for them, and an agent's
bot could add another agent.

## Decision

- **A grant is an add by an owner or a system admin.** The controller's membership
  synchronizer polls every agent bot's channels (every 5 s, with the bot's own token: a bot
  hears nothing of a channel before it is in it). For a new membership it reads the channel's
  newest `system_add_to_channel` post for that bot, which only the server writes, and takes its
  author as the actor. An active human who is a configured owner or has `system_admin` grants
  the channel; anyone else, bots included, grants nothing, the bot leaves and an alert says who
  added it. A membership without such a post leaves after a minute. For a granted channel each
  poll also reads the posts since the grant: a newer add (a remove and re-add between polls)
  is judged again, and a refused one ends the grant.
- **Grants are rows** (`mattermost_channel_grants`: agent, channel, team, the bot's user id,
  grantor, the add's post and time, state, generation). A grant counts while it is active, in
  the configured team, for the agent's current bot, in the active configuration; a revoked row
  stays as a tombstone, and only an add newer than it grants again. A channel taken out of an
  agent's `allowed_channels` gets a tombstone dated at the config apply: bootstrap added the
  bot there with the admin's token, and that add must not turn into a grant.
- **One authority.** Routing, scheduling (inbox retirement, missed-answer matching), the turn's
  channels and addressable agents, the listener's managed channels, ingest admission and
  delivery all read `ChannelAccess`: the configured channels and the active grants. A grant or
  its revocation takes the configuration row exclusively, so a post already authorized
  finishes first and none is authorized from stale rows.
- **No history.** A channel first followed through a grant starts its catch-up at the add
  itself; a channel already followed keeps its catch-up, and the grant's time is the agent's
  floor there: routing, its inbox, the answers that may end its waits and the thread context of
  its turns (roots, replies, summaries) hold nothing created at or before its add.
- **The listener comes with the first grant.** The agent's own bot adds it (a plain member may
  add members under Mattermost's default permissions): no admin credential is stored. When it
  cannot, nothing is granted, the bot leaves and the alerts channel says so. Every poll ends
  with the listener leaving the channels that no grant and no configured channel needs.
- **Removal revokes.** A bot no longer in a granted channel loses the grant at the next poll;
  pending work from there is dropped where it is checked (an agent left with no channel too),
  and nothing more is delivered there. One bot's failure (a rejected token) does not stop the
  poll for the others.
- **Configuration stays.** `allowed_channels` is optional; configured channels need no grant
  and work as before. `mattermost.channels` still names the listener's fixed channels, the
  approvals and alerts channels among them. Bootstrap keeps bots in their granted channels, and
  reconcile counts them as allowed. A team change revokes every grant.
- **Unchanged:** no direct or group messages (ADR-006); `town-square` is granted by
  configuration only, since every team member is in it; one bot per agent, plain members only,
  one listener WebSocket (ADR-005, ADR-012).

## Consequences

- Giving an agent a channel is one action in Mattermost, taking it back another; discovery
  takes up to a few seconds.
- The add record is Mattermost's own system post. It says who added the bot, but it is not an
  immutable journal: a remove and re-add missed between two polls is judged by the newest add.
  The polls keep that window to seconds; a stricter guarantee would need a server plugin.
- A permission scheme that forbids members to add members needs the listener added by hand.
- The poll costs one API call per agent bot, one per granted channel and one for the listener
  every 5 s, and a few more per new membership.
- The add record is looked for among a channel's newest 600 posts: an add made while the
  controller was down in a very busy channel may be missed, and the bot leaves (add it again).
- An archived channel loses its grants; after restoring it, add the bots again.
- A grant keeps the channel's name from when it was given; a renamed channel shows its old
  name in turns until the bot is added again.
