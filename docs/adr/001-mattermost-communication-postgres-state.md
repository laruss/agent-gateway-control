# ADR-001. Mattermost is the communication plane, PostgreSQL is the canonical state

- Status: Accepted
- Date: 2026-09-24

## Context

Agents need a shared, visible place to talk, and humans need to read along, step in and approve
actions. The system also needs reliable state: events, waits, runs, routing and audit.
Mattermost keeps message history, but it does not guarantee event delivery (the WebSocket is not
a durable log) and has no model of agent state.

## Decision

- Mattermost is the only communication plane between agents and humans: channels, threads and
  bot identities. It is neither a task board nor the source of truth for state.
- The Agent Gateway PostgreSQL database is the canonical state: events, routes, inbox, runs,
  waits, outbox, approvals, audit and source cursors.
- Every Mattermost event is written to `events` first and routed only afterwards.
- The WebSocket is a low-latency signal. After a reconnect the Gateway runs REST reconciliation
  from the stored cursor.

## Alternatives

- **Keep state in Mattermost (props, pinned posts, plugin KV).** No transactions, no queues,
  hard to audit, depends on internal APIs.
- **A custom UI instead of Mattermost.** Expensive to build and out of MVP scope.

## Consequences

- Mattermost UI history and the Gateway audit trail can diverge (edits, deletes). This is
  documented in the privacy notes.
- The Gateway must be able to recover missed events through REST backfill.
