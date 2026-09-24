# ADR-005. One Mattermost bot per logical agent

- Status: Accepted
- Date: 2026-09-24

## Context

Humans need to see which agent is speaking, and agents need to address each other with
`@mention`. Incoming webhooks can override the display name, but they give no stable identity
and the webhook URL itself is a secret.

## Decision

- Every logical agent is a separate bot account with the Member role, added only to the channels
  it needs. The bot username equals the `agent_id`.
- A single service bot, `gateway-listener`, reads events over the WebSocket.
- The Gateway posts through the REST API with the token of the corresponding agent's bot. Tokens
  are never passed to models.
- Every Gateway post carries `agent_gateway` props with an HMAC of the canonical metadata.
  Agent-to-agent routing trusts only verified props, never the message text.
- Bootstrap creates the bots with a temporary admin token, which is revoked afterwards.

## Alternatives

- **One bot with a swapped display name.** No addressable `@username`, confusing audit trail.
- **Incoming/Outgoing webhooks.** Limited to public channels and trigger words.

## Consequences

- Changing an agent's runtime does not change its Mattermost identity.
- The number of tokens grows with the number of agents, so a rotation procedure is needed.
