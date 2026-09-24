# ADR-006. No Direct Messages in the MVP

- Status: Accepted
- Date: 2026-09-24

## Context

DMs between bots and humans hide communication from the rest of the organization and complicate
the channel allowlist and the audit trail.

## Decision

The MVP works only in public and private channels and threads listed in the configuration.
Posts in DMs and in unmanaged channels are recorded in the audit log as ignored and wake no
agent.

## Alternatives

- **Support DMs from the start.** More scenarios, but a higher risk of hidden cascades and policy
  bypass.

## Consequences

- Private topics are discussed in private channels.
- DM support can be added later with a separate ADR.
