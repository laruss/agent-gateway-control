# Architecture Decision Records

Every significant architectural decision is recorded as a separate ADR. An accepted ADR is not
rewritten in substance: a changed decision gets a new ADR that references the old one with
`Supersedes`.

| ADR | Decision | Status |
|-----|----------|--------|
| [001](001-mattermost-communication-postgres-state.md) | Mattermost is the communication plane, PostgreSQL is the canonical state | Accepted |
| [002](002-control-runner-separation.md) | Separate control plane and runner plane | Accepted |
| [003](003-postgresql-pg-boss.md) | PostgreSQL + pg-boss instead of a separate broker | Accepted |
| [004](004-at-least-once-idempotency.md) | At-least-once delivery and idempotency | Accepted |
| [005](005-one-bot-per-agent.md) | One Mattermost bot per logical agent | Accepted |
| [006](006-no-direct-messages-in-mvp.md) | No Direct Messages in the MVP | Accepted |
| [007](007-approval-model.md) | Human approval model | Accepted |
| [008](008-bun-biome-typescript7.md) | Bun as runtime and package manager, Biome, TypeScript 7 | Accepted |
| [009](009-model-output-vs-turn-result.md) | Model output is separate from the turn result and fits strict structured output | Accepted |
| [010](010-zod-is-the-validator.md) | Zod is the only validator; published JSON Schemas are structural | Accepted |
| [011](011-run-execution-protocol.md) | Run execution protocol between controller and workers | Accepted |
| [012](012-mattermost-bridge.md) | Mattermost bridge: identity, signed routing, durable catch-up | Accepted |
