# Project structure

A bun workspaces monorepo. Every internal package is named `@agent-gateway/<name>` and exports
its TypeScript sources directly (`exports: "./src/index.ts"`), with no build step.

Packages are created in the phase where they get code. Progress is tracked in
[IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md).

```text
agent-gateway-control/
├── apps/
│   ├── controller/          # report/timeout/outbox consumers, health endpoints,    (done)
│   │                        #   the owner's console API and static serving
│   │                        #   (console-server/-status/-static/-auth.ts)
│   ├── console/             # the owner's console SPA: React, Vite, Tailwind v4,    (done)
│   │                        #   shadcn/ui; built to static assets the controller
│   │                        #   serves (ADR-025)
│   ├── worker/              # generic worker host for one runtime adapter           (done)
│   ├── connector-gmail/     # Gmail connector process for one mailbox               (done)
│   ├── tool-runner/         # executes approved tool actions of its namespaces      (done)
│   └── cli/                 # `gateway` admin CLI, console-commands.ts              (done)
│                            #   (console password set)
├── packages/
│   ├── contracts/           # Zod schemas: config, events, turn, queue payloads,     (done)
│   │                        #   system-status.ts (ADR-023), console-status.ts
│   │                        #   (ADR-025, shared with apps/console)
│   ├── testkit/             # Testcontainers PostgreSQL, test helpers                (done)
│   ├── core/                # state machine, routing, wait matching, use cases,      (done)
│   │                        #   system-status.ts and console read models (ADR-023)
│   ├── db/                  # Drizzle schema, migrations, schema certificates,       (done)
│   │                        #   deployment lock
│   ├── queue/               # pg-boss queues, retry/DLQ policies, transactional send (done)
│   ├── events/              # canonical JSON, hashes, CloudEvents helpers            (done)
│   ├── outbox/              # leased, idempotent side-effect delivery                (done)
│   ├── logging/             # JSON logs with mandatory redaction, trace context      (done)
│   ├── service/             # settings, health server, metrics registry, shutdown,    (done)
│   │                        #   console-auth.ts (Argon2id)
│   ├── runtime-sdk/         # adapter contract, turn execution, process control,     (done)
│   │                        #   workspaces, tool grants, doctor, contract/live suites
│   ├── runtime-mock/        # scenario-driven mock runtime                           (done)
│   ├── mattermost/          # WebSocket listener, REST client, deliverers, bootstrap (done)
│   ├── context/             # thread folding, run summary compaction, memory budget  (done)
│   ├── runtime-codex/       # Codex through `codex exec --json`                      (done)
│   ├── runtime-claude/      # Claude Code through `claude -p`                        (done)
│   ├── runtime-grok/        # Grok Build through `grok --output-format json`         (done)
│   ├── runtime-kiro/        # Kiro through `kiro-cli chat --no-interactive`          (done)
│   ├── runtime-opencode/    # OpenCode Go through `opencode run --format json`       (done)
│   ├── runtime-hermes/      # Hermes through `hermes chat --format stream-json`      (done)
│   ├── connector-gmail/     # Gmail watch, Pub/Sub pull, history sync, mail          (done)
│   │                        #   normalization, OAuth consent
│   ├── policy/              # tool evaluation, risk, action hash, approval codes,    (done)
│   │                        #   typed finance parameters, budget math
│   ├── tool-broker/         # executor port, execute job handling, sandbox executors (done)
│   └── connector-webhook/   #                                                        (later)
├── config/
│   ├── examples/            # organization.yaml and agents/*.yaml
│   └── schemas/             # JSON Schema, generated from contracts
├── prompts/examples/        # constitution and agent roles
├── deploy/
│   ├── dev/                 # development Compose (PostgreSQL, Mattermost)
│   ├── home-server/         # the Apple silicon home server: Lima VM, guest setup and
│   │                        #   backups, the Mattermost stack, the Mac's backup job
│   ├── images/              # release Dockerfile, entrypoints, the worker seccomp profile
│   └── release/             # the home server bundle: Compose stack, runbooks, helper
│                            #   scripts, the Claude Code worker recipe
├── docs/                    # about, assumptions, adr/, operations/, security/
├── scripts/                 # maintenance scripts (JSON Schema and seccomp generation,
│   │                        #   database backup)
│   └── release/             # image build, images.lock, bundle assembly, install test
└── .github/workflows/       # CI, e2e, security scans, package and release
```

## Dependency boundaries

- `contracts` depends on no internal package and performs no IO. It also owns the queue names,
  queue payload schemas and the `JobSink` port.
- `events`, `logging` and `context` depend at most on `contracts` and perform no IO.
- `core` depends on `contracts`, `events`, `context`, `db` and `logging`, never on transports:
  it sends jobs only through `JobSink`, not pg-boss, and knows no Mattermost client or runtime.
- `queue` is the only package that talks to pg-boss directly (apps use its `createBoss`).
- The controller never imports runtime adapters; workers never import `core` or the
  Mattermost client, and read no domain state. From `db` a worker, the tool runner and
  `service` use only the schema gate (`requireCompatibleSchema`, through
  `gateway_schema_state()`) and the deployment lock.
- `mattermost` depends on `contracts`, `events`, `logging` and `outbox` only; it reaches the
  control plane through ports (`ListenerStore`, `BotCredentials`, `BootstrapStore`) that the
  controller and the CLI implement with `core`.
- Every runtime adapter depends only on `runtime-sdk` and `contracts`. The worker builds its
  adapter from settings (`createRuntimeAdapter`); the CLI reuses that factory for
  `gateway runtime doctor`, so the doctor checks exactly what the worker would run.
- `connector-gmail` depends on `contracts`, `events` and `logging` only and talks to Google
  over plain REST; it reaches the control plane through the `GmailStore` port, which
  `apps/connector-gmail` implements with `core`. Only that process holds the Google
  credential.
- `policy` depends on `contracts` and `events` only and performs no IO: the controller and the
  tool runner evaluate the same rules and hash.
- `tool-broker` depends on `contracts`, `logging` and `policy`. `apps/tool-runner` hosts it; it
  reads no domain state and reaches the control plane only through its queues and the
  `gateway_begin_tool_action` function. Only that process holds tool credentials.
- `testkit` is used only by tests. Integration tests may compose the controller and a worker
  in one process; production code may not.

## Conventions

- **Field names.** YAML config uses `snake_case`. The CloudEvents envelope uses the spec
  attribute names (`correlationid`, `trustlevel`). Runtime contracts (`AgentTurnInput`,
  `AgentTurnResult`, `WaitCondition`, `ApprovalRequest`) use `camelCase`.
- **Strictness.** All contracts are `z.strictObject`: unknown fields are rejected, not silently
  dropped (fail-closed for model output and config typos).
- **Tests.** Unit tests are `*.test.ts`, integration tests (Docker) are `*.integration.test.ts`,
  end-to-end tests against a real Mattermost are `*.e2e.test.ts`, all next to the code. Tests
  against installed runtime CLIs are `*.live.test.ts` (`bun run test:live`, on demand only:
  they spend real turns). Runtime adapters are tested in CI against fake CLIs
  (`fake-<runtime>.ts`) that speak the real wire format.
- **JSON Schema.** Generated by `bun run schemas:generate`; a test fails when files are stale.
  The files are structural only; Zod is the validator ([ADR-010](adr/010-zod-is-the-validator.md)).
- **Migrations.** Generated by `bun run db:generate` from `packages/db/src/schema.ts`; a
  committed migration is never edited. Hand-written SQL (triggers, seed rows) goes into a
  `--custom` migration. Every migration gets its kind (`expand` or `contract`) in
  `packages/db/migrations/compatibility.json` ([ADR-020](adr/020-release-pipeline.md)).
- **Production dependencies.** Release images install `dependencies` only; a test walks the
  services' imports and fails on a package declared only under `devDependencies`.
- **Time.** Use cases take the clock from their deps; database defaults are not relied on for
  timestamps that guards compare.
- **Validation.** `bun run fix`, then `bun run test`, `bun run test:integration` and
  `bun run test:e2e`; `bun run test:live` after changing a runtime adapter.
