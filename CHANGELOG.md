# Changelog

All notable changes are documented here. The project follows Semantic Versioning.

## [Unreleased]

### Added

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
