# Changelog

All notable changes are documented here. The project follows Semantic Versioning.

## [Unreleased]

### Added

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
