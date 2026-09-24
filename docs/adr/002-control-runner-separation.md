# ADR-002. Separate control plane and runner plane

- Status: Accepted
- Date: 2026-09-24

## Context

AI runtimes (Codex, Claude Code, Grok and others) perform untrusted actions: shell commands,
file edits, network requests. If one is compromised through prompt injection, the damage must
stay local and must not expose other agents' secrets or permissions.

## Decision

- The **controller** (control plane) only does deterministic work: ingest, dedupe, routing, wait
  matching, the state machine, context assembly, policy, outbox and the admin API. It has no
  Docker socket, no shell access to repositories and no AI provider credentials.
- **Workers** (runner plane) are separate processes/containers, one per runtime class. Each one
  pulls jobs from PostgreSQL, holds only its own secrets and its assigned workspace, returns a
  strictly validated `AgentTurnResult` and accepts no public inbound traffic.
- High-risk tools run through the Tool Broker, never directly from a runtime.

## Alternatives

- **A monolith that launches agent CLIs itself.** Simpler, but the controller would hold every
  secret and a shell; a single prompt injection would compromise the whole system.

## Consequences

- A shared runtime contract (`runtime-sdk`) and contract tests for every adapter are required.
- A failing runtime degrades only the agents assigned to it.
