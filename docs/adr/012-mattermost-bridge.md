# ADR-012. Mattermost bridge: identity, signed routing, durable catch-up

- Status: Accepted
- Date: 2026-09-25

## Context

Mattermost is the communication plane (ADR-001), each agent has its own bot (ADR-005), and
routing must be deterministic and loop-safe. Mattermost gives no delivery guarantees to a
WebSocket client: events are lost while it is disconnected, the REST `since` query returns at
most the newest 1000 changes, and any client can put arbitrary `props` on a post, including
`from_bot` and a copy of another post's metadata (verified against Mattermost 11.7).

## Decision

- **Where it runs.** The listener runs inside the controller process with one WebSocket as the
  listener bot. Workers never see Mattermost tokens or the routing key (ADR-002).
- **Identity is the user id.** A post is an agent's only when its `user_id` is that agent's
  bot. Props are never proof of identity. Posts by any other bot account (looked up by user id)
  and posts that carry `from_webhook`, `from_bot` or `from_plugin` are recorded but address
  nobody: only a human's own words are an instruction.
- **Agent routing is signed.** An agent's post carries `props.agent_gateway` with
  `{agent_id, run_id, correlation_id, targets, hop, idempotency_key}` and an HMAC-SHA256 over
  that metadata plus the post's channel, thread root and SHA-256 of the exact message. The
  listener routes an agent post only if the signature verifies and names the bot's own agent.
  Otherwise the post is not ingested; the attempt is audited and alerted (someone else holds
  the bot's token). The key lives only in the controller (`GATEWAY_ROUTING_KEY_FILE`). The
  run's correlation travels in the metadata, so an agent cannot escape its cascade budget by
  starting a new thread; replies in a thread an agent started take that root's stored
  correlation, so a human's answer there reaches the agent's wait. The event id of a signed post is its signed idempotency key, so a
  second post with the same signed routing (an exact replay with a leaked token) is the same
  event: it never routes, and is audited and alerted as a replay. A signed post also counts
  only when the outbox item its key names exists, is not dead, and recorded this very post id;
  until the receipt is written the post waits (the channel is read again a second later). A
  delivery retry adopts an earlier post only when it is the one intact post with the key and
  the bot deleted nothing meanwhile; otherwise it posts afresh, and any copy is a replay.
- **Human routing is exact mentions.** `@username` of a registered agent, outside fenced and
  indented code, inline code and blockquotes (with their lazy continuation lines), addressed
  only to agents allowed in the post's channel (read fresh for every post, never cached, and
  checked again by routing inside the ingest transaction, so a permission revoked while a post
  is being handled no longer routes). Only
  trailing dots are dropped from a name: `@developer_` may be another account. Link destinations, autolinks and URLs name no
  one. `@all`, `@here`, `@channel` address nobody. Untargeted wake rules on Mattermost event
  types are rejected: a post wakes only the agents it addresses.
- **Edits and deletions are record-only.** They are stored as `mattermost.post.edited` and
  `mattermost.post.deleted` events, never wake an agent (wake rules on them are rejected) and
  never match a wait. A deleted post's event keeps no text.
- **Durable catch-up.** Nothing is acknowledged to Mattermost; per-channel cursors (newest
  synced `update_at`, in `source_cursors`) are the progress marker. After every `hello`, every
  5 minutes, after a sequence gap and after any failed ingest, the listener reads each managed
  channel with `since = cursor - 10 min` (posts are stamped at creation but can be broadcast
  after newer ones). When `since` hits its limit, older creations in the gap are recovered by
  paging back, each page anchored at a post id so deletions cannot shift it.
  - Only creations after the window's start are replayed: a reply bumps its thread root's
    `update_at`, and an old root is not a new instruction.
  - A channel's history from before it became managed is never replayed: bootstrap starts each
    newly managed channel at its newest post (server time), and no creation up to that point
    counts, checked again inside the ingest transaction so work in flight across a channel's
    removal and re-adding cannot slip under a new start. The listener only advances existing
    cursors, and a config apply drops the catch-up state of channels it removes.
  - A creation first seen after its post was edited is recorded as `mattermost.post.recovered`,
    which never routes (no wake-up, no wait match): its original text is unknown. For an
    agent's bot such a post is rejected. Edits and deletions are recorded only for a post
    whose creation the Gateway has (not for a rejected post, nor for one from before its
    channel was managed).
  - A channel's cursor advances only while none of its changes is left unprocessed.
  - Event ids are deterministic (`mattermost:post:<id>`, `:edited:<edit_at>`, `:deleted`, and
    the signed key for agent posts), so every replay deduplicates in ingest.
- **Outbound.** Agent posts go out through the outbox as the agent's own bot. Idempotency by
  the outbox key: a retry first searches the channel for a post by that bot with the same key
  (a crash between the API call and storing the receipt), and `pending_post_id` makes the
  server drop a quick duplicate create. Alerts and approval cards are posted by the listener
  bot, always into the channel the active configuration names for them at delivery time;
  everything variable in them sits in a code block its content cannot close.
- **Bootstrap and reconcile.** `gateway mattermost bootstrap` uses a temporary admin token to
  resolve the team, channels and owners (which an operator creates), create missing bots as
  plain members, add memberships, remove bots from managed channels they are not configured
  for, and write each bot's token straight into its secret file
  (mode 0600, never printed). Bots of agents removed from the configuration are taken out of
  every managed channel and deactivated, which invalidates their tokens; so is a listener bot
  of an earlier configuration, and every Gateway bot leaves channels that are no longer
  managed; a recorded bot account that was renamed or replaced is retired too. An existing bot
  is adopted only with plain member roles; bootstrap keeps every bot
  in one team, as a plain member of exactly its channels (only the team's default channel,
  which nobody can leave, is exempt), and reconcile reports any deviation. `gateway mattermost reconcile` checks the result with each bot's
  own token and needs no admin rights. The deliverer checks that a token belongs to the
  recorded bot before posting with it, and the listener refuses a token that is not the
  bootstrapped listener's. A retry accepts an earlier post as its delivery only when it is
  exactly that post (signature, place and text), never by a claimed key alone.
- **Event source.** `mattermost://<team>`: stable when the server URL changes. Channel names
  resolve within the team bootstrap recorded, in routing too; after a team change nothing is
  managed until bootstrap has resolved the new team, and the change itself restarts every
  channel's catch-up. Bootstraps run one at a time, and one that ran on a
  configuration replaced meanwhile runs again.

## Consequences

- A leaked bot token can post as the agent in Mattermost but cannot route, wake anyone or
  spend cascade budget; the attempt raises an alert.
- A duplicate post (the lookup missed an earlier attempt's post) carries the same signed key,
  so it is recorded as a replay and routes nothing; the first post has already routed.
- Bot tokens are read at use, so rotating one needs no restart. The routing key is a single
  key without rotation: after changing it, agent posts signed with the old key and not yet
  synced are rejected (and alerted).
- Posting outside an agent's channels is impossible by construction: the authority check
  bounds channels, the run scope binds replies to their thread's channel, and Mattermost
  refuses posts in channels the bot is not a member of.
- A missed wake-up is recoverable by mentioning again; the parser drops doubtful lines rather
  than waking an agent by accident.
