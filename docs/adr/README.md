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
| [007](007-approval-model.md) | Human approval model | Accepted, amended by 018 |
| [008](008-bun-biome-typescript7.md) | Bun as runtime and package manager, Biome, TypeScript 7 | Accepted |
| [009](009-model-output-vs-turn-result.md) | Model output is separate from the turn result and fits strict structured output | Accepted |
| [010](010-zod-is-the-validator.md) | Zod is the only validator; published JSON Schemas are structural | Accepted |
| [011](011-run-execution-protocol.md) | Run execution protocol between controller and workers | Accepted |
| [012](012-mattermost-bridge.md) | Mattermost bridge: identity, signed routing, durable catch-up | Accepted |
| [013](013-turn-context.md) | Turn context: stored threads, run summaries, reviewed shared memory | Accepted |
| [014](014-cli-runtime-adapters.md) | CLI runtime adapters: confined processes, policy-mapped tools, optional sessions | Accepted |
| [015](015-unconfined-runtimes-and-runtime-health.md) | Grok, Kiro, OpenCode and Hermes: tools only where confined; runtime health | Accepted |
| [016](016-gmail-connector.md) | Gmail connector: watch, Pub/Sub pull, history cursor, read-only credential | Accepted, amended by 017 |
| [017](017-gmail-polling-by-default.md) | Gmail connector polls by default; Pub/Sub notifications are optional | Accepted |
| [018](018-approval-decisions-and-tool-broker.md) | Approval decisions in the card thread, a separate tool runner, daily budgets | Accepted |
| [019](019-observability-and-retention.md) | Metrics, trace-correlated logs, alert conditions, retention, backup checks | Accepted |
| [020](020-release-pipeline.md) | Release pipeline: reproducible images, a verified bundle, certified schemas | Accepted |
| [021](021-home-server.md) | The home server: a Lima VM on an Apple silicon Mac | Accepted |
| [022](022-channel-grants.md) | Channel grants: an owner adds an agent's bot, and the agent works there | Accepted |
| [023](023-console-and-operator.md) | The owner's console and the operator agent's system status | Accepted |
| [024](024-managed-configuration.md) | Managed configuration: immutable snapshots and a revision journal | Accepted |
