# Changelog

All notable changes are documented here. The project follows Semantic Versioning.

## [Unreleased]

### Added

- The release pipeline (ADR-020):
  - release images `agent-gateway` (controller, CLI, Gmail connector, tool runner, mock
    worker) and `agent-gateway-worker-codex`, linux/amd64, reproducible bit for bit from pinned
    inputs (base image digest, Debian snapshot, `bun.lock`, checksummed CLI archives);
  - SPDX SBOMs, build provenance and SBOM attestations, and a checksummed, attested bundle:
    the Compose stack by digest (`images.lock`), `bin/agw`, `init-home.sh`,
    `verify-release.sh`, `INSTALL.md`, `UPGRADE.md`, `ROLLBACK.md`, `MIGRATIONS.md` and a
    recipe for an operator-built Claude Code worker;
  - `package.yml` on every change: build twice and compare, bundle, and an install test on a
    runner without the checkout (smoke mention, versions, hardening, the Codex sandbox,
    upgrade and rollback);
  - `release.yml` on a `vX.Y.Z` tag: CI again, then GHCR, attestations and the GitHub
    Release.
- Hardened containers: uid 10001, read-only root filesystem, no capabilities,
  `no-new-privileges`, CPU/memory/PID limits, separate networks, and a seccomp profile that
  lets bubblewrap confine a runtime's commands inside the container. Services refuse to run as
  root.
- Schema compatibility: every migration is `expand` or `contract`
  (`packages/db/migrations/compatibility.json`); `gateway db migrate` certifies the releases
  that may run on the result, and every service and CLI session command refuses a database
  it is not certified for. A rollback by one release after expand-only migrations needs no
  restore. New commands `gateway db status`, `gateway db create-role` and `gateway version`.
- linux/arm64 release images next to linux/amd64: each platform built, reproduced and
  install-tested natively on its own runner, published as one index per image;
  `images.lock` format 2 pins the index and each platform's manifest, and
  `verify-release.sh` checks the index against it.
- The deployment lock: services hold it shared, `gateway db migrate` exclusively, so a
  migration never runs under live services.

### Changed

- The controller no longer migrates the pg-boss schema or creates queues on start;
  `gateway db migrate` does both. Run it before starting a new version.
- `@agent-gateway/testkit`'s packages are development dependencies, and the controller
  declares `@agent-gateway/policy`, which it loads at run time.

- Observability (ADR-019):
  - metrics on every service's `/metrics` (Prometheus text format), with database gauges
    from the controller and a collection-success flag;
  - a health server for the worker (port 8081);
  - W3C trace context carried from an event through its runs, attempts, deliveries, agent posts
    and tool actions, with `trace_id` and `span_id` in log lines;
  - log redaction of headers, Google tokens, JWTs, fine-grained GitHub tokens, secret query
    parameters and email addresses; bounded log lines; the service version in every line
    (`GATEWAY_VERSION`, `GATEWAY_COMMIT`).
- Alert conditions: a lasting problem fires once, reminds every 6 hours and is resolved when it
  ends. It covers:
  - Mattermost disconnects;
  - dead letters and dead outbox items;
  - budgets at 80%;
  - repeated invalid output;
  - Gmail watch expiry;
  - retention and backup checks.

  `gateway doctor` lists firing alerts.
- Retention (`organization.retention`): the controller removes message content after its
  period, hourly and in batches. Identifiers and hashes stay for dedupe. Pending work and a
  FAILED agent's latest run are kept, and so are approvals, tool actions and the audit log.
- `gateway backup check`: verifies the newest backup (manifest, age, checksum, database
  identity, schema, archive) and optionally restores it into a scratch database. `--record`
  lets the controller alert on a failed or stale check. `scripts/backup-gateway-db.sh` is a
  reference producer.
- Resource limits:
  - statement, lock and idle-transaction timeouts on the services' database pools;
  - a 2 MiB turn input cap;
  - removal of run workspaces a crashed worker left behind.
- Security scans in CI (`security.yml`): Gitleaks over the git history and OSV-Scanner over
  `bun.lock` with a license allowlist, on push, pull request and daily. Every GitHub Action is
  pinned by commit SHA.
- Migration `0012_traces_retention_alerts`:
  - `traceparent` on runs, outbox items and tool actions;
  - `content_expired_at` markers;
  - `alert_states` and `maintenance_status`.

- Approval decisions and the tool broker. An owner decides in the approval card's thread with
  `approve <code>` or `deny <code>`. The listener hands the reply to a dedicated decision path
  that checks the owner (fresh account lookup, approver snapshot and current owners), the
  one-time code, the status and the expiry, and answers in the thread. A grant re-checks the
  policy and queues a tool action. `apps/tool-runner` (`@agent-gateway/tool-broker`) executes
  it: it recomputes the hash, runs the `gateway_begin_tool_action` check (approval, hash,
  deadline, kill switch) and reports a receipt. The agent waits for one `approval.resolved`
  event with the outcome. Kill-all cancels pending approvals and queued actions.
  A stop request (kill-all, disable) aborts a running executor. An unknown outcome is never
  retried; `gateway tools settle` records it by hand. `gateway db grant-tool-runner`,
  `gateway tools list`. ADR-018.
- Policy engine (`@agent-gateway/policy`): deny-by-default tool evaluation, finance only for the
  finance agent and always approval-gated, typed parameter sets for `finance.payment.create`
  and `finance.subscription.create`, checked before a card is shown, at grant and in the
  runner. Approval cards flag values that mix alphabets.
- Daily budgets (`organization.budgets`): per-agent and global limits on cost and tokens per
  UTC day, summed from a usage ledger of every run attempt; an agent over its limit starts no
  run until the day changes or the limit is raised. `gateway budgets`, budget and tool action
  checks in `gateway health`.
- Migrations `0010_approvals_and_tool_actions` (`tool_actions`, `approval_replies`,
  `run_usage`, approval `cancelled` replaces `executed`) and `0011_approval_guards`
  (immutability triggers and the `begin` function).

- Gmail connector without Pub/Sub by default: it polls the mailbox's history every minute with
  a credential that grants `gmail.readonly` only; Pub/Sub push notifications are optional
  (`gateway gmail authorize --pubsub`, `GMAIL_PUBSUB_*`). `GMAIL_SYNC_SECONDS` replaces
  `GMAIL_RECONCILE_SECONDS`. The connector records its mode and interval for
  `gateway health` (migration `0009_gmail_mode`). ADR-017.
- Gmail connector (`@agent-gateway/connector-gmail`, `apps/connector-gmail`): Gmail watch with
  daily renewal, Pub/Sub pull, history sync with a transactional cursor, periodic
  reconciliation and full sync after a history gap. Mail is normalized to plain text
  (active and hidden HTML removed, attachments described only) as external-untrusted
  `google.gmail.message.received` events that wake `@mail-follower`. A read-only credential:
  `gateway gmail authorize` (loopback OAuth with PKCE) grants exactly `gmail.readonly` and
  `pubsub`, and any wider token is refused. `gateway gmail status`, Gmail checks in
  `gateway health`, migration `0008_gmail_mailboxes`. ADR-016.
- Runtime adapters for Grok (`@agent-gateway/runtime-grok`), Kiro (`runtime-kiro`), OpenCode Go
  (`runtime-opencode`) and Hermes Agent (`runtime-hermes`). Each uses a home directory the
  Gateway owns, and gets only the built-in tools it can confine. ADR-015.
- Runtime health: worker heartbeats, `gateway runtimes list`, degraded agents and an alert when
  a runtime has no ready worker; `WORKER_RUNTIME_VERSION` pins a runtime version. Migration
  `0007_runtime_workers`. A worker whose probe fails now stays up and reports it instead of
  exiting.
- MIT license.
- Runtime adapters for Codex (`@agent-gateway/runtime-codex`, `codex exec --json`) and Claude
  Code (`@agent-gateway/runtime-claude`, `claude -p`). Each call runs in its own process group,
  with a clean environment and a workspace per run. Built-in tools follow the agent's tool
  policy. Provider sessions are resumed under `resumable-if-available`, with a fresh start when
  a session is gone. ADR-014.
- `gateway runtime doctor <adapter>`: version, login, a real structured turn, cancellation,
  session resume and policy risks. Worker settings `WORKER_WORKSPACE_ROOT`, `CODEX_*` and
  `CLAUDE_*`. Live runtime tests (`bun run test:live`); fake CLIs for the contract suite in CI.

- Turn context (`@agent-gateway/context`): the turn's Mattermost thread assembled from stored
  events within a budget, thread summaries compacted from run summaries (`thread_summaries`),
  the agent's memory from its own namespaces; a turn resumed by a timeout keeps its thread.
- Memory review: private proposals are accepted at once, shared ones wait for
  `gateway memory accept|reject`; waits may name only thread participants or owners.
- `renderTurnPrompt` in the runtime SDK: prompt layers in trust order with delimited data;
  ADR-013; mock scenarios `wait-asker` and `remember`.

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
