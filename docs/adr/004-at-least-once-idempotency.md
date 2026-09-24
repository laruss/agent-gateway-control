# ADR-004. At-least-once delivery and idempotency

- Status: Accepted
- Date: 2026-09-24

## Context

The Mattermost WebSocket, Gmail Pub/Sub, HTTP callbacks and model providers can redeliver
messages or lose responses. End-to-end exactly-once delivery is not achievable.

## Decision

- The whole system is treated as at-least-once. Every handler is idempotent.
- An event is unique by `(source, id)`; `id` is deterministic for external sources
  (for example `mattermost:post:<post_id>`). Inserts use `ON CONFLICT DO NOTHING`.
- The source is acknowledged only after the commit.
- Every external side effect (a Mattermost post, a tool action) goes through the transactional
  outbox with a unique `idempotency_key`, for example `mattermost-post:<run_id>:<message_index>`.
- Repeating a side effect with the same key returns the stored receipt or checks the provider's
  state.

## Alternatives

- **Rely on pg-boss exactly-once semantics.** That guarantee holds only inside the database, not
  at the boundaries with external systems.

## Consequences

- Every table that records an external effect gets a unique constraint on its idempotency key.
- Tests must cover redelivery of every event type.
