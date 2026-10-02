# Implementation status

Tracks implementation progress by phase (0-10).

## Phase 0 - Architecture baseline

Status: **done** (pending the first CI run on GitHub)

| Item | State | Evidence |
|------|-------|----------|
| Monorepo scaffold (bun workspaces, Biome, TypeScript 7, Vitest) | done | `package.json`, `biome.json`, `tsconfig.base.json`, `vitest.config.ts` |
| ADR-001 ... ADR-010 | done | [docs/adr](docs/adr/README.md) |
| Assumptions | done | [docs/assumptions.md](docs/assumptions.md) |
| Threat model draft | done | [docs/security/threat-model.md](docs/security/threat-model.md) |
| Zod contracts: OrganizationConfig, AgentConfig, GatewayEvent, AgentTurnInput, AgentTurnModelOutput, AgentTurnResult, WaitCondition, ApprovalRequest | done | `packages/contracts` |
| Turn result authority check (run, channels, targets, memory, attachments) | done | `packages/contracts/src/turn-authority.ts` |
| Model output schema fits provider strict structured output | done | `examples.test.ts`, [ADR-009](docs/adr/009-model-output-vs-turn-result.md) |
| Config schemas (JSON Schema generated from Zod) | done | `config/schemas`, `bun run schemas:generate` |
| Config examples validate | done | `packages/contracts/src/examples.test.ts` |
| Bun compatibility smoke: pg-boss, Drizzle, Testcontainers, transactional enqueue | done | `packages/testkit/src/bun-compat.integration.test.ts` |
| CI skeleton | done | `.github/workflows/ci.yml` |

Acceptance:

- [x] `bun install`, `bun run fix`, `bun run test` pass locally.
- [x] `bun run test:integration` passes locally (Docker required).
- [x] Config examples validate, including cross-file checks.
- [x] Architecture docs match code boundaries ([docs/project-structure.md](docs/project-structure.md)).
- [ ] CI run on GitHub (no remote repository yet).

Known gaps, deferred:

- CI has no secret scan, dependency/license scan, migration test or build step yet
  (migrations arrive in Phase 1; scans before Phase 9). Scans and the migration check are done
  since Phase 8; the build step comes with the release pipeline.
- GitHub Actions are pinned by tag, not by commit SHA. Pin by SHA before the first release.
  Pinned since Phase 8.

## Deliberate design choices

- Bun instead of Node.js 24 + pnpm, Biome instead of ESLint/Prettier
  ([ADR-008](docs/adr/008-bun-biome-typescript7.md)).
- Config references Mattermost channels and owners by **name**; bootstrap resolves them to ids
  Authorization still checks ids.
- `constitution_file` lives in `organization.yaml` instead of every agent file.
- `AgentTurnResult.publicSummary` is a structured working summary, not free text.
- `AgentTurnResult` is split into model output and adapter metadata; `sideEffectReceipts` are
  removed from it (receipts come from the Tool Broker) ([ADR-009](docs/adr/009-model-output-vs-turn-result.md)).
- `organization.finance_agent_id` names the only agent that may hold finance tools.
- Approval drafts carry `actionParams` as `{name, value}` strings; risk level comes from policy.
- `WaitCondition` is limited to waitable event types, and Mattermost waits must name a sender.
  A generic payload predicate on waits is deferred until a scenario needs it.
- Packages are created in the phase that needs them, not as empty stubs.

## Deferred to the controller (tracked for Phase 1-3)

- [x] Clamp `WaitCondition.timeoutAt` into `[now + 60 s, now + 7 d]` and check that
  `correlationId` belongs to the run (its trigger or inbox events). Phase 1.
- [x] Build `TurnAuthorityContext` for every run and reject results with authority issues.
  Phase 1.
- [x] Resolve prompt files inside the config root and refuse symlinks that leave it. Phase 1.
- [x] Transactional enqueue: Drizzle and pg-boss share one client transaction
  (`withTransaction` + `transactionalJobSink`). Phase 1.
- [x] `PublicMessage.rootPostId` must be a thread of the run's own events. Phase 1.
- [x] Canonical JSON for `immutableActionHash` (sorted keys, parameters sorted by name).
  Phase 1.
- [x] Check `WaitCondition.expectedSenderUserIds` against the thread participants (and the
  owners). Phase 3.
- [x] Typed parameter sets per financial action. Phase 7: `finance.payment.create` and
  `finance.subscription.create`; other finance writes cannot be approved.
- [x] Verify each provider actually accepts `agent-turn-model-output.schema.json`. Phase 4: Codex
  accepts it as is; Claude Code accepts it without `$schema`, which its adapter drops.
- [x] The approval card renders parameters in a code block (so Markdown in values is inert),
  separate from the summary, and flags mixed-script values (homoglyphs are a rendering
  concern, not a contract one). Code blocks since Phase 2, the mixed-script warning in Phase 7.

## Review log

- Round 1 (Codex + Opus subagent): 9 + 17 findings. Fixed: strict-mode model output schema,
  authority check, finance isolation by pattern, approval state invariants, JSON Schema parity
  for approval actions, typed Mattermost event data, sender-bound waits, prompt path
  restrictions, side-effect receipts removed, size bounds, message safety (broadcast mentions,
  duplicate targets, control/bidi characters), artifact path traversal, memory namespace format,
  reserved agent ids, `username == id`, `passWithNoTests`, smoke-test error handling, stale doc
  references, `Readonly<T[]>`. Not taken: `.mcp.json` uses `npx` (pre-existing user file, left
  for the owner); `__proto__` keys in `JsonObjectSchema` (not model-facing any more).
- Round 2 (Codex + Opus subagent): Codex 2 P1 + 3 P2, Opus 0 P1 + 3 P2. Fixed: provider schema
  reduced to the OpenAI + Anthropic strict subset (no bounds, lookaround or unsupported formats)
  with an independent linter; agent id regex without lookahead; target agents checked against
  the destination channel; approval requests checked against the tool policy; approval
  parameter values reject invisible/control characters (extended to C1, zero-width, LRM/RLM,
  ALM, BOM); `createdAt <= decidedAt <= expiresAt`; typed Mattermost post data expressed in the
  event JSON Schema; smoke test stops resources before asserting. Also fixed P3: broadcast
  mention false positives, thread replies need `root_id`, Mattermost posts are never
  `system-trusted`, no userinfo in artifact URLs, typed ids in `TurnAuthorityContext`.
  `.mcp.json` switched from `npx` to `bunx` by the owner's request.
- Round 3 (Codex + Opus subagent): Codex 2 P1 + 2 P2, Opus 0 P1 + 1 P2 + 2 P3. Fixed:
  `addressableAgents` lookup uses own keys only (an agent id like `constructor` crashed the
  check); unsafe text is defined by Unicode categories (Cc, Cf, Zl, Zp) with two levels:
  `text` keeps ZWJ/ZWNJ for emoji and scripts, `verbatim` (approval values and summaries,
  paths) rejects every invisible character, including U+2060; range quantifiers are removed
  from provider patterns and flagged by the linter; `toProviderSchema` keeps field names inside
  `properties`; thread replies have their own event JSON Schema branch with a required root id.
  Phase 0 has no round limit (owner's decision); later phases keep the 3-round cap.
- Round 4 (Codex + Opus subagent): 0 P1, Codex 2 P2, Opus 1 P2 + 1 P3. Fixed: `verbatim` text
  is an allowlist (single line, NFC, letters/digits/punctuation/symbols/space, no blank
  lookalikes), so approval values cannot forge extra card lines or hide characters; `text`
  rejects lone surrogates and tag characters (ASCII smuggling) and now allows the soft hyphen;
  the provider schema drops `pattern` wherever a supported `format` exists, and the linter flags
  it. Approval `actionSummary` is prose (`text`), rendered apart from hashed parameters.
  Not taken: allowing tag characters for subdivision flags (they are a prompt-smuggling vector).
- Round 5 (Codex + Opus subagent): Codex 2 P1 + 1 P2, Opus 0 P1/P2 + 3 P3. Fixed: memory in
  `agents/<id>` must be private and shared namespaces cannot be private; broadcast mentions are
  matched conservatively on Mattermost token boundaries (`Alert.@all`, `@all-hands`,
  `@all_hands` are rejected, `me@here.com` and `@allison` are not); text mentions of known
  agents must be declared in `targetAgentIds`; `verbatim` rejects NFKC-unstable values
  (fullwidth, math alphanumerics), leading/trailing/double spaces and U+FFFC; `safety` is a
  required argument of `safeText` and `hasUnsafeCharacters`. Markdown inside approval values is
  covered by the Phase 7 code-block rendering item.
- Round 6 (Codex only, by the owner's request): 1 P1 + 2 P2. Fixed: artifacts carry a
  turn-local `key`, and attachments reference exactly one of an existing `artifactId` or an
  `artifactKey` produced in the same turn (keys unique, checked by the authority check);
  `AgentTurnInput.channels` lists the channels (id + name) the agent may post to, so turns
  without a thread (e.g. Gmail) can choose one; the text-mention check covers every
  registered agent (`registeredAgentIds`), not only addressable ones.
- Round 7 (Codex only): 1 P1 + 2 P2; round 5 and 6 fixes confirmed. Fixed: private artifacts
  produced in the turn cannot be attached to posts (existing attachable ids are documented as
  non-private only); the namespace/visibility rule applies to stored `MemoryItem`s as well as
  proposals; Mattermost trust labels are consistent: posts by agent bots are always
  `internal-untrusted` and thread posts are never `system-trusted`.
- Round 8 (Codex only): 1 P1 + 1 P2; round 7 fixes confirmed. Fixed: public messages require
  `mattermost.post` in the effective tool policy (allowed and not denied). The P2 (published
  JSON Schemas miss some Zod cross-field rules) is resolved by decision instead of more
  encoding: Zod is the only validator and every non-provider JSON Schema says so in `$comment`
  ([ADR-010](docs/adr/010-zod-is-the-validator.md)).
- Round 9 (Codex only): 1 P1, 0 P2; round 8 fixes confirmed. Fixed: `ToolPolicySnapshot`
  rejects overlapping `allow`/`requireHumanApproval`/`deny` lists (the same shared
  `toolPatternOverlaps` rule as agent config), and the authority check allows a direct post
  only when `mattermost.post` is allowed, not denied and not approval-gated.
- Round 10 (Codex only): no P1, P2 or P3 findings; round 9 fixes confirmed. Phase 0 review
  closed.

## Phase 1 - Durable core with mock runtime

Status: **done** (review closed: Codex round 13 found no P1/P2)

| Item | State | Evidence |
|------|-------|----------|
| DB schema and migrations (19 tables, CHECK constraints, append-only `audit_log`) | done | `packages/db`, `packages/db/migrations` |
| CloudEvents envelope helpers, canonical JSON, payload and content hashes | done | `packages/events` |
| Event ingest with dedupe on `(source, id)`, conflict detection on changed redeliveries | done | `packages/core/src/services/ingest.ts` |
| Routing skeleton: wait match, structured targets, subscriptions, store-only; fan-out | done | `packages/core/src/routing.ts` |
| Loop guards: self-post, hop, cascade, hourly rate, duplicate payload, pairwise; alerts | done | `routing.ts`, `routing.test.ts` |
| Agent state machine and inbox with `enqueue` / `enqueue-and-coalesce` | done | `state-machine.ts`, `scheduler.ts` |
| Durable waits: creation, atomic match, early replies in the inbox, timeouts | done | `runs.ts`, `wait-timeouts.ts` |
| pg-boss queues with backoff and dead letter queues, transactional send | done | `packages/queue` |
| Runtime SDK: adapter contract, deadline/cancel, validation with one repair, contract suite | done | `packages/runtime-sdk` |
| Mock runtime (reply, mention, wait, artifact, approval, failures, invalid, slow) | done | `packages/runtime-mock` |
| Structured result validation and authority/scope check in the controller | done | `runs.ts`, [ADR-011](docs/adr/011-run-execution-protocol.md) |
| Approval requests: immutable hash, policy risk, nonce, expiry, card via outbox, waits | done | `runs.ts` |
| Outbox: leased delivery, idempotency keys, retries, dead items, reconciliation | done | `packages/outbox` |
| Controller and worker processes, health endpoints, JSON logs with redaction | done | `apps/controller`, `apps/worker`, `packages/logging`, `packages/service` |
| Admin CLI basics | done | `apps/cli` ([local development](docs/operations/local-development.md)) |
| Dev infrastructure (PostgreSQL Compose), `bun run dev`, loopback delivery | done | `deploy/dev`, `apps/controller/src/loopback-deliverer.ts` |
| CI: migrations match the schema | done | `.github/workflows/ci.yml` |

Acceptance (`apps/controller/src/durable-core.integration.test.ts`):

- [x] A duplicate event creates one run, also for concurrent redeliveries.
- [x] Restart of controller and worker preserves queued work.
- [x] The mock agent returns IDLE, WAITING (resumed by another agent's reply), errors
  (permanent, retryable with a second attempt, invalid output) and an approval request.
- [x] The outbox delivers once across a failed attempt, duplicate jobs and an expired lease.
- [x] Also covered: a forged result beyond the run's authority is rejected and recorded, stale
  and cross-agent reports are ignored, kill-all stops new runs, the hop guard blocks a cascade
  and raises an alert.

CLI commands: `health`, `doctor`, `db migrate|grant-worker`, `config validate|apply`,
`directory set`, `outbox list|redrive`,
`agents list|show|enable|disable|pause|resume`, `runs list|show|cancel|redrive`, `waits list`,
`events show|ingest`, `dlq list|redrive`, `approvals list`, `kill-all [--release]`. Not yet:
`events replay`, `runtime doctor`, `backup check` (`mattermost bootstrap|reconcile` came in
Phase 2).

Known gaps, deferred:

- Outbox delivery was `dry-run` or `loopback` only; real Mattermost delivery came in Phase 2.
- Hourly per-agent rate limits and the pairwise sender->target limit are read without a lock
  across cascades; concurrent events of different cascades can overshoot by the number of
  concurrent ingests (cascade budgets and duplicate checks are serialized per cascade).
- A compromised worker can read its own adapter's turn inputs and report results for that
  adapter's runs (bounded by each agent's authority); per-run report credentials are not
  implemented.
- Late wait matches (found by the missed-answer scan) check the cascade budget outside the
  cascade lock; concurrent late matches in one cascade can overshoot by one each.
- Wake rules with `target_agent_id` are redundant (being addressed always wakes); they are kept
  as documentation in the examples.
- An outbox item on its last attempt is marked dead when its lease expires even if the slow
  delivery later succeeds; `outbox redrive` recovers it (deliverers are idempotent). The lease
  must stay longer than a deliverer's own timeout.
- Context assembly was minimal: no thread context, memories or workspace. Threads, summaries
  and memory came in Phase 3; workspaces come with the coding runtimes.
- Approval decisions (grant/deny) arrive with the Mattermost approval flow (Phase 7); until then
  an approval request expires and resumes the agent with a timeout. Done in Phase 7.
- `/metrics` is served but empty; metrics come with observability work. Done in Phase 8.
- Provider sessions are stored when returned but not resumed yet (`continueTurn` unused).
  Resumed since Phase 4.
- `max_active_runs` is limited to 1.

Deliberate choices in this phase:

- Runtime adapters return untrusted raw output; validation and repair live in the SDK and the
  controller re-validates ([ADR-011](docs/adr/011-run-execution-protocol.md)).
- Being addressed by structured targets always wakes an agent; wake rules matter only for
  untargeted events (subscriptions such as Gmail or timers).
- While an agent is WAITING, only an event that resolves one of its waits resumes it; other
  events wait in its inbox and reach the resumed run as `pendingInbox`.
- A paused agent resumes to WAITING when it still holds active waits, otherwise to IDLE.
- FAILED is a latch: only `runs redrive` clears it. Pause and kill-all skip failed agents, and
  enabling an agent whose latest run failed restores FAILED.
- Disabling an agent cancels its active waits and expires its pending approvals.
- A controller sweep (every reconcile interval) schedules idle or waiting agents with pending
  inbox entries that no event will trigger again.
- A model-reported `failed` puts the agent in FAILED (fail closed); its messages are still
  delivered.
- Wait timeouts are exempt from cascade and rate guards: they resolve an existing wait, at most
  once, and blocking them would leave the agent waiting forever.

### Phase 1 review log

- Round 1 (Codex + Opus subagent): Codex 8 P1 + 2 P2, Opus 0 P1 + 7 P2 + 6 P3, overlapping.
  Fixed: FAILED latch (no pause, restored on enable, exact-trigger redrive); disable cancels
  waits and approvals; the wait-timeout handler locks agent then wait and checks due time;
  answers that arrive before or while the wait is committed are matched when scheduling a
  waiting agent (pending inbox and correlation events since the run was queued); run deadlines
  start when the worker starts, a silent started attempt is retried by the controller, pg-boss
  never re-runs a run job, a never-started attempt only alerts; reserved event types are
  rejected by external ingest and only Gateway-emitted events match reserved waits; models
  cannot create approval waits; cascade budgets are serialized by an advisory lock; outbox
  settles are fenced by the claim's attempt number and reconciliation respects backoff; dead
  outbox items show in `doctor` and can be redriven; `OUTBOX_DELIVERY` is required and
  non-delivering modes are refused in production; workers run as a pg-boss-only role;
  config apply schedules enabled agents and a periodic sweep picks up stranded inbox work; a
  lost wait race no longer adds a spurious inbox entry; the mock no longer ping-pongs answers;
  the outbox idempotency test asserts real calls. Not taken: locking the hourly rate counter
  (documented as a known gap).
- Round 2 (Codex + Opus subagent): Codex 8 P1 + 5 P2, Opus 1 P1 + 5 P2 + 3 P3; round 1 fixes
  mostly confirmed. Fixed: agent and run rows are locked `FOR NO KEY UPDATE`, so concurrent
  ingests for one agent no longer deadlock on foreign-key share locks (reproduced by Opus;
  regression test added); events refused for an agent (blocked, ignored) can no longer resolve
  its wait through the missed-answer scan; when a wait is lost to a concurrent event, an event
  that addresses the agent still becomes an ordinary wake-up; the report path takes the cascade
  locks of the waits it creates before the agent lock, closing the wait-commit race; cascade
  budgets count granted wake-ups instead of created runs; redrive loads its trigger directly;
  config apply locks every agent up front; each run stores its `timeout_seconds`; a required
  target never matches events without structured targets; outbox redrive keeps the attempt
  counter (the fencing token) and raises the limit instead; duplicate outbox jobs respect the
  retry backoff; run DLQ jobs cannot be redriven raw; external ingest refuses `system-trusted`;
  the payload hash covers correlation, causation, hop and trust; non-delivering outbox modes
  need `GATEWAY_ENV=development|test`; every adapter has its own run, report and dead letter
  queue in dedicated tables and a worker role may touch only those (verified in the suite: the
  worker runs as that role); the sweep visits only schedulable agents. Not taken: per-run report
  credentials (documented), locking hourly rate counters (documented).
- Round 3 (Codex + Opus subagent): Codex 1 P1 + 2 P2, Opus 0 P1 + 2 P2 + 5 P3; round 2 fixes
  confirmed. Fixed: the restricted worker can now fail and dead-letter jobs (pg-boss moves a
  failed job through the parent table; the worker gets that insert, limited by row-level
  security to its adapter's queues; tested with a job the worker rejects and an attempted
  injection into another adapter's report queue); ingest locks every agent it may wake in id
  order before any change (reproduced deadlock); a wait-match route is recorded with the
  decision that took effect, so a lost race spends no budget; a cascade restarts with the
  latest human post, so long threads keep working; late wait matches from the missed-answer
  scan pass the hop and cascade guards and are recorded as routes; outbox items whose lease
  keeps expiring on the last attempt become dead; `not_due` deliveries are re-enqueued for
  their due time instead of spending job retries; `runs cancel` re-checks the run under the
  agent lock; the queued-run alert says how to recover. The review cap was raised to 5 rounds
  by the owner during this round.
- Round 4 (Codex + Opus subagent): Codex 1 P1 + 4 P2, Opus 0 P1 + 1 P2 + 7 P3; round 3 fixes
  confirmed. Fixed: routing spends the cascade budget by tier (exact wait matches, then
  targets, then subscriptions; by agent id inside a tier), so a target cannot take the last
  wake-up from a matching wait; ingest locks every agent the event may wake before routing
  reads their state, so a concurrent disable or pause cannot be overtaken; Gateway-reserved
  event types never wake agents by subscription (no lock inversion from wait timeouts); late
  wait matches run through the full routing guards (rate, duplicate payload, pairwise,
  self-post, hop, cascade); the cascade anchor uses a monotonic event sequence instead of a
  timestamp; `grant-worker` refuses the owning role, superusers and roles that bypass
  row-level security, and its policy name is hashed; docs say the controller must use the
  owning role. New mock scenario `wait-open` and tests for allowed and blocked late matches.
- Round 5 (Codex + Opus subagent, final): Codex 1 P1 + 2 P2, Opus 0 P1/P2 + 4 P3; round 4
  fixes confirmed by both. Fixed after the round (no sixth review, by the 5-round cap):
  `grant-worker` refuses roles that belong to any group role (e.g. `pg_read_all_data`) and
  verifies the role's effective privileges, including PUBLIC grants, before committing;
  every granted route records the cascade it spends (`cascade_anchor`), so a late match counts
  against the current cascade; ingest holds the configuration row in share mode while routing,
  so a config apply cannot add an unlocked recipient; late-match guards count duplicates and
  pairwise messages as of the answer's own position; wake rules on Gateway-reserved event types
  are rejected by the agent config schema (and removed from the examples). Open (P3): agents
  added between the two agent reads of ingest are covered by the config lock; late-match
  budget checks remain outside the cascade lock (documented).
- Round 6 (Codex only, by the owner's request to continue until zero): 1 P1 + 2 P2. Fixed:
  `grant-worker` verifies the exact effective privilege set per table and privilege (PUBLIC
  grants included) and refuses CREATE on the gateway schemas; ingest takes the cascade lock
  before inserting the event, so sequence order within a correlation is lock order and
  concurrent duplicates cannot both pass; FAILED agents and their failed runs appear in
  `doctor` and `dlq list` (a domain-level dead letter, recovered with `runs redrive`).
- Round 7 (Codex only): 1 P1 + 1 P2. Fixed: `grant-worker` also checks column-level grants
  (`has_any_column_privilege`, PUBLIC included) and PostgreSQL 17's `MAINTAIN`; regression
  tests grant a PUBLIC column on `context_snapshots` and `UPDATE` on `pgboss.queue`. `doctor`
  and `dlq list` report every agent whose latest run failed, whatever its current state (a
  disabled FAILED agent is still listed, with its state).
- Round 8 (Codex only): 2 P1. Fixed: run and timeout jobs are retained for 90 days, and the
  controller reconciles lost jobs: a queued attempt whose run job is gone (or a running one past
  its deadline without a backstop) fails as retryable, fenced by its job id, so it is requeued
  or fails for good; an overdue active wait gets a new timeout job (tests delete a run job and
  lose a wait timeout). `grant-worker` refuses roles with `REPLICATION`; a `MAINTAIN` grant test
  was added.
- Round 9 (Codex only): 1 P1 + 1 P2. Fixed: reconciliation skips a run whose report is still
  waiting in its report queue, and `failLostAttempt` re-verifies the observed job, status,
  attempt and (for running attempts) the deadline under the run lock; the pairwise guard counts
  wake-ups the sender actually caused per recipient (wake and wait-match routes), so untargeted
  answers to open waits count; the lost wait-timeout test now deletes the original job.
- Round 10 (Codex only): 0 P1 + 1 P2. Fixed: a worker-side deadline timeout is retryable
  (bounded by the controller's attempts and backoff), an operator cancellation is not; the
  contract suite asserts both. The pending-report test now uses the controller's real pg-boss
  probe (`bossJobProbe`) with a queued report.
- Round 11 (Codex only): 0 P1 + 2 P2. Fixed: the worker sets the turn deadline after the
  `started` report is sent, and a deadline that passed before the start is retryable (contract
  suite case added); a claimant that lost its outbox lease settles nothing, returns `skipped`
  and writes no `outbox.dead` audit record (tested with a late permanent failure).
- Round 12 (Codex only): 1 P1 + 2 P2. Fixed: run reconciliation pages through every candidate
  on a stable cursor, so healthy old runs cannot starve a lost one; it probes the run job first
  and only then a pending report (a worker reports before its job completes); the hourly run
  quota is enforced when scheduling from the inbox too (excess work stays pending until the
  sweep finds the agent eligible; redrive is exempt); a stale successful outbox settle returns
  `skipped`.
- Round 13 (Codex only): no P1/P2. Its P3 test suggestions were added: a lost run found on a
  later reconciliation page (page size 1, a healthy stale run first) and a late successful
  outbox claimant after a lease takeover. A dedicated test of the scheduling quota is still
  open (P3).

Findings per round (P1 / P2):

| Round | Codex | Opus | Outcome |
|-------|-------|------|---------|
| 1 | 8 / 2 | 0 / 7 | fixed |
| 2 | 8 / 5 | 1 / 5 | fixed |
| 3 | 1 / 2 | 0 / 2 | fixed |
| 4 | 1 / 4 | 0 / 1 | fixed |
| 5 | 1 / 2 | 0 / 0 | fixed |
| 6 (Codex only) | 1 / 2 | - | fixed |
| 7 (Codex only) | 1 / 1 | - | fixed |
| 8 (Codex only) | 2 / 0 | - | fixed |
| 9 (Codex only) | 1 / 1 | - | fixed |
| 10 (Codex only) | 0 / 1 | - | fixed |
| 11 (Codex only) | 0 / 2 | - | fixed |
| 12 (Codex only) | 1 / 2 | - | fixed |
| 13 (Codex only) | 2 / 2 | - | fixed |
| 14 (Codex only) | 1 / 1 | - | fixed |
| 15 (Codex only) | 1 / 1 | - | fixed |
| 16 (Codex only) | 2 / 1 | - | fixed |
| 17 (Codex only) | 1 / 0 | - | fixed |
| 18 (Codex only) | 1 / 0 | - | fixed |
| 19 (Codex only) | 0 / 1 | - | fixed |
| 20 (Codex only) | 1 / 0 | - | fixed |
| 21 (Codex only) | 1 / 3 | - | fixed |
| 22 (Codex only) | 1 / 0 | - | fixed |
| 23 (Codex only) | 2 / 0 | - | fixed |
| 24 (Codex only) | 1 / 1 | - | fixed |
| 25 (Codex only) | 0 / 1 | - | fixed |
| 26 (Codex only) | 0 / 2 | - | fixed |
| 27 (Codex only) | 2 / 0 | - | fixed |
| 28 (Codex only) | 1 / 1 | - | fixed |
| 29 (Codex only) | 0 / 0 (one P2 re-rated P3) | - | closed |
| 13 (Codex only) | 0 / 0 | - | closed |

## Phase 2 - Mattermost bridge

Status: **done** (review closed: Codex round 29 found no P1/P2)

| Item | State | Evidence |
|------|-------|----------|
| REST client (typed subset of API v4, error classes, timeouts, no credentials in URLs or errors) | done | `packages/mattermost/src/client.ts` |
| Listener bot WebSocket: authentication, ping, sequence gaps, reconnect with backoff and jitter | done | `packages/mattermost/src/listener.ts` |
| Channel allowlist: only managed channels are read; system posts and the listener's own are skipped | done | `normalize.ts` |
| Exact mention parser: code blocks, inline code, quotes and lazy continuations ignored | done | `mentions.ts`, `mentions.test.ts` |
| Identity by user id; integrations (webhook, bot, plugin props) record-only | done | `normalize.ts`, `normalize.test.ts` |
| Per-agent bot posting through the outbox, idempotent (earlier post lookup, `pending_post_id`) | done | `deliver.ts` |
| HMAC routing props bound to channel, thread and text; unsigned agent-bot posts audited and alerted | done | `routing-props.ts`, `recordImpersonation` |
| Threads: correlation by thread root, replies bound to the thread's channel | done | `normalize.ts`, `outcome.ts` |
| Reconnect/backfill: per-channel cursors, sync after hello, timer, gaps and failures; since-limit paging | done | `backfill.ts`, `listener.ts` |
| Loop protections: thread activity guard; edits and deletions record-only; alerts and approval cards posted by the listener bot | done | `routing.ts`, `render.ts` |
| `gateway mattermost bootstrap` / `reconcile` | done | `packages/mattermost/src/bootstrap.ts`, `apps/cli/src/mattermost-commands.ts` |
| Secret files: atomic 0600 writes, no symlinks, `SECRETS_DIR` for development | done | `packages/service/src/secrets.ts` |
| Mattermost 11.7.11 in the development Compose; `bun run dev` runs both processes in parallel | done | `deploy/dev/compose.yaml`, `package.json` |
| End-to-end suite against a real Mattermost (Testcontainers), `e2e` workflow | done | `apps/controller/src/mattermost-bridge.e2e.test.ts`, `.github/workflows/e2e.yml` |

Acceptance (`apps/controller/src/mattermost-bridge.e2e.test.ts`, real Mattermost 11.7.11):

- [x] A human `@developer` triggers exactly one developer run.
- [x] A non-mentioned ambient message triggers none; neither do mentions in code, quotes, edits
  or in a channel the agent is not allowed in.
- [x] A code-block mention triggers none.
- [x] An agent post to `@finance` wakes finance (signed routing props).
- [x] A controller restart and a WebSocket loss do not lose posts and do not duplicate runs
  (repeated syncs included).
- [x] The reply is posted under the correct bot identity and thread root.
- [x] Also covered: bootstrap creates bots as plain members and keeps working tokens on a
  second run; reconcile reports nothing; an agent-bot post without a valid signature (or with
  props copied from a genuine post) is not ingested, is audited and alerted, and the alert is
  posted by the listener bot in `#gateway-alerts`.

Known gaps, deferred:

- Artifact attachments are not uploaded to Mattermost; posts carry only their text.
- The routing key has no rotation window: agent posts signed with an old key that are synced
  after the change are rejected (and alerted).
- A channel's history from before it became managed is not replayed (by design); run
  bootstrap whenever a channel is added.
- When a catch-up gap exceeds 1000 changes, edits and deletions of posts beyond the newest
  1000 are not seen, and neither is a post created and deleted within the gap; posts that still
  exist are recovered (a warning is logged). Edits and deletions are record-only, so routing is
  unaffected; a delivery retry whose own scan hits that limit adopts no earlier post and posts
  afresh, since a deletion it cannot see might be the original's.
- The approval card is informational; decisions from Mattermost (buttons) come in Phase 7.
- Thread context (root, recent messages, participants) was not assembled yet; it came in
  Phase 3.
- The Mattermost image is amd64 only; on Apple silicon the e2e suite and the development
  Compose run it emulated.

### Phase 2 review log

- Round 1 (Codex + Opus subagent): Codex 3 P1 + 4 P2, Opus 0 P1 + 2 P2 + 5 P3, overlapping.
  Fixed: a signed agent post's event id is its signed idempotency key, so an exact replay with a
  leaked token (or a duplicate create) never routes and is alerted as a replay; sync replays
  only creations inside its window (a reply bumps an old root's `update_at`), checks whether a
  post is already stored before verifying it (index on `(source, subject)`, new migration) and
  records a creation first seen after an edit without routing; other bot accounts are
  recognized by user id and address nobody; untargeted wake rules on Mattermost types are
  rejected and never route; the deliverer checks that a token belongs to the agent's bot;
  bootstrap removes bots from managed channels they are not configured for and reconcile
  reports such memberships; link destinations, autolinks, URLs and fences inside list items
  name no one; a rejected post is audited once; sync failures are tracked per channel with
  backoff; `stop()` during a pending connect opens no socket. The e2e suite covers exact
  replays, old roots bumped by a reply, a post edited while the controller was down, a foreign
  bot, link mentions and a stale membership (the replay and old-root cases fail without the
  fixes).
- Round 2 (Codex + Opus subagent): Codex 3 P1 + 4 P2 + 1 P3, Opus 1 P1 + 2 P3; round 1 fixes
  confirmed. Fixed: a creation first seen after an edit is its own record-only type
  (`mattermost.post.recovered`: no wake-up, no wait match), and for an agent's bot it is
  rejected (an unsigned reply could otherwise resolve a wait after an edit; e2e reproduces it
  with an open wait); edits and deletions of an agent-bot post the Gateway did not accept are
  not recorded; edits, deletions and recovered posts never start a new cascade; catch-up pages
  are anchored at post ids, so deletions while paging cannot hide a post; bots of agents
  removed from the configuration are taken out of every managed channel and deactivated;
  a retry accepts an earlier post only when its signature, place and text match; the listener
  and the alert/card deliverer refuse a token that is not the bootstrapped listener's; link
  destinations are cut at the next whitespace (parentheses inside URLs); the privacy note
  lists what is not stored; a directory failure on a live post marks the channel for a resync;
  the sync window (10 min) is longer than the periodic sync (5 min). Not taken: an unaddressed
  human reply keeps starting a new cascade (Codex asked to exclude it). It is the human's own
  answer, possibly to a wait for a human, and agent loops stay bounded by the hop limit, which
  a human post does not reset for agent-to-agent posts, and by the thread activity guard.
- Round 3 (Codex + Opus subagent): Codex 3 P1 + 5 P2 + 1 P3, Opus 0 P1 + 1 P2 + 2 P3; round 2
  fixes confirmed by Opus. Fixed: a signed post counts only as the exact post the outbox
  delivered with its key (a copy made after deleting an unseen original is a replay, and a key
  the Gateway never issued is rejected); bootstrap starts each newly managed channel at its
  newest post by server time, nothing created before that is replayed, the listener only
  advances existing cursors and drops the state of unmanaged channels (e2e: a pre-bootstrap
  mention in a new channel stays silent, a post made while the listener still saw the channel
  as unmanaged is caught once); every Gateway bot leaves channels that are no longer managed
  and a listener bot of an earlier configuration is retired; removed agents are out of the
  live directory, so their bots are inert; an existing bot is adopted only with plain member
  roles; a renamed channel or user moves its directory entry instead of failing bootstrap;
  "not a bot" is looked up again after a minute (accounts can be converted into bots); a wait
  for a human's user id is satisfied only by that human's own post, not by an integration
  under the account; the WebSocket-loss test posts only after the socket is closed. Docs:
  in local development controller and worker share a user, so the secret boundary holds only
  in a deployment (the worker gets no secrets mount there).
- Round 4 (Codex + Opus subagent): Codex 3 P1 + 1 P2, Opus 0 P1 + 1 P2 + 3 P3; round 1-3
  fixes confirmed by both. Fixed: a reply in a thread an agent started takes that root's
  stored correlation, so a human's answer reaches the agent's wait; a catch-up from an empty
  channel's zero cursor asks `since=1` (zero is not a since query to the server); the routing
  key file is reserved in the configuration check; bootstrap removes team and channel admin
  rights, takes each bot out of every other channel of its team and out of other teams, and
  reconcile reports admin rights, extra channels and extra teams (e2e covers both); sync leaves
  the creation of a post whose live frame is queued to that frame (a quick edit no longer turns
  it into a record-only post); blockquotes inside list items name no one; bootstrap resets the
  catch-up of a channel that leaves the configuration, so re-adding it starts afresh.
- Round 5 (Codex + Opus subagent, final): Codex 3 P1 + 2 P2 + 1 P3, Opus 0 P1 + 1 P2 + 1 P3;
  round 1-4 fixes confirmed by Opus. Fixed after the round (no sixth review, by the 5-round
  cap): bootstrap revokes every token of a bot it adopts for the first time and of every bot
  whose tokens are rotated (e2e: the stored and a foreign token are rejected afterwards); a
  routing mention drops only trailing dots, so `@developer_` addresses no agent; the channel
  and agent allowlist is read fresh for every post instead of from a 5-second cache; a link
  title names no one; a rejected listener token makes the listener reconnect with the
  current one; catch-up handles creations in creation order (a root before its replies, so
  they take its correlation), and live changes of a channel with a failed change wait for the
  resync; the unmanaged-channel cleanup reads the directory at delete time; the known gaps
  mention missed deletions past the since limit, which is logged.


- Round 6 (Codex only, continuing until zero P1/P2 at the owner's request): 2 P1 + 2 P2.
  Fixed: routing itself drops a Mattermost post for an agent not allowed in the post's channel
  (`channel_not_allowed`), inside the ingest transaction, so a permission revoked during a long
  catch-up or between normalization and ingest no longer routes; a recorded bot account that
  was renamed or replaced in Mattermost is retired (out of every channel, tokens revoked,
  deactivated) before its replacement takes over; bootstrap removes admin rights in every
  channel a bot stays in, the default channel included, and reconcile reports those and
  elevated system roles; link reference definitions (`[label]: /@x "title"`) name no one. The
  e2e suite covers a town-square admin role and a bot renamed in Mattermost.
- Round 7 (Codex only): 2 P1 + 3 P2; round 6 fixes confirmed. Fixed: token revocation reads the
  paged token list again until it is empty (more than 200 tokens); a 401 during delivery is
  retried within the attempt limit, and the next attempt reads the current secret (a rotation
  mid-delivery no longer kills a post); link reference definitions inside list items and
  backslash-escaped `\@` name no one; edits and deletions are recorded only for posts whose
  creation the Gateway has (an edit of a post from before its channel was managed is not
  imported; e2e fails without it); reconcile reports a bot account that was renamed.
- Round 8 (Codex only): 2 P1 + 1 P2. Fixed: catch-up paging anchors each page at the oldest
  post of a later millisecond, because the server's `before` means "created strictly earlier"
  and anchoring at the oldest post skipped others of its millisecond (unit test with three
  posts per millisecond fails without it); names inside paths (`example.com/@developer`) and
  multi-line link reference definitions name no one; bootstrap stores a channel's catch-up
  start before publishing the channel as managed, and the start records the ids of the posts of
  its millisecond, so a later post of the same millisecond is not excluded.
- Round 9 (Codex only): 3 P1 + 2 P2. Fixed: bootstrap starts and publishes a channel in one
  transaction, and the listener's cleanup of unmanaged channels is one statement against the
  active configuration and the directory, so it cannot erase a channel bootstrap just started;
  a directory entry is forgotten only while it still names the old id (a channel replaced under
  the same name stays managed; e2e); accounts the current plan uses are never retired (a removed
  agent's bot may become the listener); a page that lies wholly in one millisecond is completed
  by offset pages (unit test fails without it); bootstrap refuses a symlinked token file,
  replaces a token whose file others could read, and refuses an exposed routing key file;
  reconcile reports such files.
- Round 10 (Codex only): 3 P1 + 1 P2. Fixed: a run's posts take the correlation of the thread
  they reply in and build on the highest hop among all the run's events, so coalesced inbox
  events cannot reset the hop or cascade; bootstrap collects every post of a channel's newest
  millisecond for its start (more than 200 included); offset catch-up passes repeat until one
  adds nothing, and an unsettled scan keeps the cursor and retries (unit test fails with one
  pass); an agent post is delivered only while the active configuration still has the agent and
  allows it in that channel (otherwise it is settled as dead).
- Round 11 (Codex only): 2 P1 + 3 P2. Fixed: the listener's directory and bootstrap's plan are
  read in one transaction holding the configuration row in share mode, so a config apply
  cannot commit between their reads; an agent post is authorized and created while that row is
  held, so a config apply revoking the permission waits for a post already authorized
  (integration test); a bot not resolved yet and a 403 from Mattermost (bot not yet in the
  channel) are retried within the attempt limit, only a revoked permission is final; catch-up
  reads the directory for each post; within one millisecond a root is handled before its
  replies.
- Round 12 (Codex only): 1 P1 + 2 P2 + 1 P3. Fixed: channel names resolve within the team
  bootstrap recorded (new directory kind `team`, migration 0003), recorded last, so after a team
  change the bridge manages nothing until bootstrap resolves the new team (integration test);
  bootstraps are serialized by an advisory lock and rerun when the configuration version
  changed meanwhile, so an in-flight bootstrap cannot restore a revoked membership; a channel's
  start is scanned until two scans agree (deletions during paging; unit test fails with one
  scan); the known gap says a post created and deleted within a large gap is not recovered.
- Round 13 (Codex only): 2 P1 + 2 P2. Fixed: channel ids count only within the configured
  team everywhere (routing in the ingest transaction, late wait matches, turn channels, alert
  and approval destinations), so a post in flight across a team change wakes no one; alerts
  and approval cards go to the channel the active configuration names at delivery time, under
  the configuration lock, never to a channel recorded earlier; a config apply that changes the
  team deletes every channel's catch-up state in the same transaction, and cursor cleanup also
  requires the team (integration test); a signed post whose delivery has no receipt yet waits
  for it (read again a second later), a key of a dead delivery is rejected, and a delivery retry
  adopts an earlier post only if it is the one intact post with the key and the bot deleted
  nothing, otherwise it posts afresh. `directory set` accepts `team` for development without
  Mattermost.
- Round 14 (Codex only): 1 P1 + 1 P2. Fixed: whether an author is a bot is looked up for every
  post of a non-agent account (only bots are cached; a human account can be converted at any
  moment); a delivery retry whose channel scan hit the since limit adopts no earlier post.
- Round 15 (Codex only): 1 P1 + 1 P2 + 1 P3. Fixed: bootstrap scans for a channel's start only
  when it has none (a busy managed channel could otherwise hold up bootstrap and token
  rotation); image alt text names no one; a trailing blank line.
- Round 16 (Codex only): 2 P1 + 1 P2. Fixed: bootstrap revokes every token of an adopted bot
  (and of one whose token file others could read, or whose tokens are rotated) before granting
  any membership, and issues the new token after; a config apply that drops a channel deletes
  its catch-up state in the same transaction (integration test), so a quick re-add starts
  afresh; image alt text with nested or escaped brackets names no one.
- Round 17 (Codex only): 1 P1. Fixed: a new post is admitted only after its channel's current
  start, checked inside the ingest transaction under the cascade lock and the configuration row
  in share mode (`ingestEventIf` with `afterChannelStart`), so a queued live frame or a scan in
  flight across a channel's removal, re-adding and bootstrap cannot store an older post
  (integration test).
- Round 18 (Codex only): 1 P1 + 1 P3. Fixed: retiring a bot revokes its tokens and deactivates
  it before any channel removal, and removals skip the team's default channel (which Mattermost
  lets no member leave), so a managed `town-square` can no longer stop a retirement halfway; an
  unsigned agent-bot post from before its channel's current start raises no impersonation
  alert.
- Round 19 (Codex only): 0 P1 + 1 P2 + 2 P3. Fixed: edits and deletions are admitted against
  their channel's current start inside the ingest transaction too, so after a channel's removal
  and re-adding an edit of a post from its earlier managed period is not imported; the second
  bootstrap assertion checks the report count; the threat model states that `human-trusted`
  marks any human account's post, and that owners are recognized by user id.
- Round 20 (Codex only): 1 P1. Fixed: bootstrap records the team, its channels and their
  catch-up starts in one transaction, and cursor cleanup no longer depends on the team being
  recorded (a team change already clears all channel state in the config apply), so starts
  staged for a new team cannot be deleted before the team is recorded (integration test).
- Round 21 (Codex only): 1 P1 + 3 P2. Fixed: the listener's fallback start of a channel checks
  that the channel is still managed and writes all three start records in one transaction under
  the configuration lock; admission (and the impersonation alert) also requires the channel to
  be managed now (configured team, name in the configuration), so a replaced channel's
  surviving start admits nothing (integration test); the periodic REST catch-up runs whenever
  the listener is authenticated, also while the WebSocket cannot connect; an approval request's
  summary and parameters together must fit one card (refined in round 25).
- Round 22 (Codex only): 1 P1. Fixed: every config apply increments a configuration generation
  (`gateway_controls.config_generation`, migration 0004); bootstrap and the listener's fallback
  start record the generation before scanning a channel's start and install it only under the
  configuration lock, and bootstrap's rerun check compares generations, not versions (refined in
  round 23).
- Round 23 (Codex only): 2 P1. Fixed: bootstrap takes the generation its plan was read in; if a
  configuration was applied since, it publishes nothing and the CLI reloads the plan and runs
  again (no stale plan under a new generation); a config apply records the generation in which
  channels left management (per channel, or all of them on a team change), and the listener's
  fallback start is installed unless its channel left after the scan's generation, so
  re-applying a configuration no longer voids it; a voided start is scanned again a second
  later (integration test covers both a harmless re-apply and a drop and re-add).
- Round 24 (Codex only): 1 P1 + 1 P2. Fixed: a config apply takes the configuration row for
  update before reading the configuration it replaces, so concurrent applies are serialized and
  each sees its true predecessor (a removal can no longer be missed; integration test); URIs
  without `//` (`mailto:`) and bare domains with a path, query or fragment name no one.
- Round 25 (Codex only): 0 P1 + 1 P2. Fixed: an approval request is bounded by the size its
  card's summary and parameter blocks really take, fences included (a long backtick run makes
  its fence long), so every valid request renders within one Mattermost post (unit test at the
  limit with long backtick runs fails under the old bound).
- Round 26 (Codex only): 0 P1 + 2 P2. Fixed: a link target is masked whole, to the last `)` of
  its line (a title with escaped quotes names no one; doubtful text is dropped, not read); a
  channel Mattermost will not let an account leave (another team's default channel after a team
  change) is reported instead of aborting bootstrap.
- Round 27 (Codex only): 2 P1. Fixed: a config apply makes sure the configuration row exists
  before locking it (a missing row would lock nothing and let first applies race); a signed post
  by an account that is no longer the agent's bot (replaced between delivery and catch-up) is
  still recognized by its signature and counts only as the exact post its delivery receipt
  names, so a delivered handoff is not lost (unit test).
- Round 28 (Codex only): 1 P1 + 1 P2. Fixed: a link target is masked across line endings, to the
  last `)` of its paragraph (and an unclosed one through its next word, on the next line too);
  an indented line starts a code block only where a paragraph could start, otherwise it
  continues the paragraph and stays inside an open code span.
- Round 29 (Codex only): no P1; one finding Codex rated P2, re-rated P3 by agreement with the
  owner: a multi-line image description could name an agent. A Markdown edge case like this only
  lets a human wake an agent they could mention directly, so it grants nothing; it was fixed
  anyway (image descriptions are masked across line endings). No P1/P2 remains: review closed.
  From round 28 on, parser findings of this kind are rated by their real impact, not the
  reviewer's label.

Findings per round (P1 / P2):

| Round | Codex | Opus | Outcome |
|-------|-------|------|---------|
| 1 | 3 / 4 | 0 / 2 | fixed |
| 2 | 3 / 4 | 1 / 0 | fixed (one item declined, see above) |
| 3 | 3 / 5 | 0 / 1 | fixed |
| 4 | 3 / 1 | 0 / 1 | fixed |
| 5 | 3 / 2 | 0 / 1 | fixed |
| 6 (Codex only) | 2 / 2 | - | fixed |
| 7 (Codex only) | 2 / 3 | - | fixed |
| 8 (Codex only) | 2 / 1 | - | fixed |
| 9 (Codex only) | 3 / 2 | - | fixed |
| 10 (Codex only) | 3 / 1 | - | fixed |
| 11 (Codex only) | 2 / 3 | - | fixed |
| 12 (Codex only) | 1 / 2 | - | fixed |
| 13 (Codex only) | 2 / 2 | - | fixed |
| 14 (Codex only) | 1 / 1 | - | fixed |
| 15 (Codex only) | 1 / 1 | - | fixed |
| 16 (Codex only) | 2 / 1 | - | fixed |
| 17 (Codex only) | 1 / 0 | - | fixed |
| 18 (Codex only) | 1 / 0 | - | fixed |
| 19 (Codex only) | 0 / 1 | - | fixed |
| 20 (Codex only) | 1 / 0 | - | fixed |
| 21 (Codex only) | 1 / 3 | - | fixed |
| 22 (Codex only) | 1 / 0 | - | fixed |
| 23 (Codex only) | 2 / 0 | - | fixed |
| 24 (Codex only) | 1 / 1 | - | fixed |
| 25 (Codex only) | 0 / 1 | - | fixed |
| 26 (Codex only) | 0 / 2 | - | fixed |
| 27 (Codex only) | 2 / 0 | - | fixed |
| 28 (Codex only) | 1 / 1 | - | fixed |
| 29 (Codex only) | 0 / 0 (one P2 re-rated P3) | - | closed |

## Phase 3 - Durable waits and context

Status: **done** (review closed: Codex round 7 found no P1/P2)

| Item | State | Evidence |
|------|-------|----------|
| Wait subscriptions, atomic matching, timeout events (from Phase 1) | done | `runs.ts`, `wait-store.ts`, `wait-timeouts.ts` |
| Waits name only humans who posted in the run's threads, or owners | done | `turn-authority.ts` (`waitableUserIds`) |
| Context assembler: thread of the turn from stored events (edits applied, deletions left out, budget), memory, durable state | done | `packages/context`, `core/src/services/context-store.ts`, `scheduler.ts` |
| A turn resumed by a timeout gets the thread it waited in and may reply there | done | `scheduler.ts`, `runs.ts` (`completionScope`) |
| Thread summaries: run public summaries merged per thread, older runs compacted deterministically | done | `context/src/summary.ts`, `thread_summaries` (migration 0005) |
| Reply waits bound to the threads they were asked in (a correlation can span threads) | done | `waits.ts`, `wait-store.ts` (`toActiveWaits`), migrations 0005-0006 |
| Queued posts shown as they are now: edits applied, deleted posts and revoked channels dropped | done | `context-store.ts` (`withCurrentPosts`, `retireInbox`) |
| Durable public run summaries: previous summary of the waiting run, the conversation, or the agent | done | `scheduler.ts` (`previousRun`) |
| Memory namespace boundaries: own namespaces only; private accepted at once, shared reviewed by an operator; one accepted item per key | done | `context/src/memory.ts`, `services/memory.ts`, `gateway memory list/accept/reject` |
| Prompt rendering in trust order with delimited untrusted data | done | `runtime-sdk/src/prompt.ts` |
| Mock scenarios `wait-asker`, `remember`; mock replies in the turn's thread after a timeout | done | `runtime-mock/src/scenarios.ts` |

Acceptance (`apps/controller/src/mattermost-bridge.e2e.test.ts`, real Mattermost 11.7.11, and
`durable-core.integration.test.ts`):

- [x] Developer asks finance and enters WAITING.
- [x] Finance's reply in the correct thread resumes developer, which sees the thread.
- [x] A finance reply addressed to developer in another thread does not resume it.
- [x] A duplicate delivery of the reply (restart and catch-up) resumes once.
- [x] A restart while waiting preserves the wait; an answer posted while the Gateway was down
  resumes the agent once.
- [x] Also covered: thread context with edits and deletions, a human's answer resolving a wait
  on their user id, memory boundaries and review, thread summaries across a cascade, a timeout
  resume replying in its thread.

Known gaps, deferred:

- Memory has no relevance ranking: the newest accepted items within the budget are included.
- A thread with more than 1000 replies is read from its newest 1000.
- `DirectoryEntry.summary` (what other agents do) stays empty: agents' latest summaries may come
  from channels the reader cannot see.
- Workspaces are not assembled (coding runtimes, Phase 4).

Deliberate choices in this phase ([ADR-013](docs/adr/013-turn-context.md)):

- Thread context is read from the Gateway's own events, not from Mattermost: assembly needs no
  network call inside the scheduling transaction and is reproducible.
- Thread summaries are compacted without a model: no cost, no failure mode, nothing to inject.
- Proposals to shared memory need an operator's acceptance; private memory does not.

### Phase 3 review log

- Round 1 (Codex + Opus subagent): Codex 4 P1 + 2 P2, Opus 0 P1 + 5 P2 + 3 P3, overlapping.
  Re-rated by impact: Codex's queued-content findings (revoked channel, edits/deletions of
  queued posts) and the durable-state label to P2, memory list paging to P3. Fixed: waits on
  replies are bound to the threads they were asked in plus threads the waiting run started
  (a correlation spans several threads); a timeout turn takes the thread of its wait, not of an
  inbox post; carried posts show their latest edit, deleted posts and posts of channels no
  longer allowed are dropped from the inbox; a run that saw posts of several channels adds
  nothing to a thread summary; a thread without a recorded root keeps its replies and the
  authors of carried posts may be waited on; the durable state is labelled internal-untrusted
  in the prompt; summary rendering budgets the newest runs first; the wait creator comes from
  the trigger's own wait; `memory list` pages (`--limit`, `--offset`, proposals oldest first).
  Not taken: tolerating snapshots without `waitableUserIds` (pre-release, no stored runs).

- Round 2 (Codex + Opus subagent): Codex 1 P1 + 3 P2 + 1 P3, Opus 0 P1/P2 + 3 P3; round 1
  fixes confirmed. Re-rated: a revoked channel's post in a wait-resolving entry to P2 (needs a
  channel revocation while the resume is deferred). Fixed: such a post reaches the turn without
  its text; the missed-answer scan skips posts deleted since; stale inbox entries are retired
  before the scan, and not at all while no channel is resolved (Opus P3: an unresolved team
  would have dropped every queued post); thread summaries keep each recent run's facts and
  risks; the summary header says how many runs are not shown. Not taken: binding a wait to one
  of several threads its own run started (P3: the model cannot name a root that does not exist
  yet, and both threads are its own); a real-server test of two threads in one cascade (P3, the
  integration test covers it); re-matching when a started root arrives after its reply (P3, the
  listener ingests roots first).

- Round 3 (Codex + Opus subagent): Codex 1 P1 + 1 P2 + 1 P3, Opus 0 P1/P2 + 1 P3; round 2
  fixes confirmed. Re-rated: a previous summary from a channel the agent lost to P2 (needs a
  revocation). Fixed: the previous summary comes from the wait's run or the same conversation
  only, and only from a thread the agent may still read (the latest-run-anywhere fallback is
  gone); missed answers are not matched while no channel is resolved, nor from channels no
  longer allowed; a root the turn carries is not repeated as `rootPost`; an unreadable stored
  thread summary is left alone instead of being overwritten.

- Round 4 (Codex + Opus subagent): Codex 1 P1 + 2 P2, Opus nothing; round 3 fixes confirmed.
  Fixed: the previous-summary lookup filters readable threads in SQL before limiting; a thread
  window counts reply creations only, and their edits and deletions are loaded separately, so
  edits cannot push replies out. Re-rated P3 and not taken: tracking which channels contributed
  to a summary across later runs. An agent allowed in several channels can move information
  between them in its posts and private memory anyway; the boundary is what the Gateway
  assembles (ADR-013, consequences).

- Round 5 (Codex + Opus subagent): Codex 1 P1 + 1 P2, Opus nothing; round 4 fixes confirmed.
  Re-rated: unbound reply waits after an upgrade to P2 (only waits active during the upgrade;
  nothing is deployed yet). Fixed: migration 0006 binds active reply waits to their run's
  threads of the waited-on conversation (none found: no thread, fail closed), tested on stored
  data; inbox retirement touches Mattermost post events only, not a connector event that
  happens to carry a `post_id`.
- Round 6 (Codex only, by the owner's request): 0 P1 + 2 P2; round 5 fixes confirmed. Fixed:
  roots a waiting run started count only when they are new Mattermost root posts of the run's
  own agent (not any event naming the run as its cause), also in the 0006 backfill; a thread's
  reply window takes the newest replies by post time, so a late catch-up of older replies
  cannot push newer ones out.
- Round 7 (Codex only): 0 P1 + 1 P2; round 6 fixes confirmed. Re-rated P3: a timeout turn of
  a wait created by a run without a thread (only connector-started runs, which arrive in
  Phase 6) got no thread. Fixed anyway: such a turn takes the single new root its creating run
  opened in the wait's conversation (none or several: no thread). Review closed.

Findings per round (P1 / P2):

| Round | Codex | Opus | Outcome |
|-------|-------|------|---------|
| 1 | 4 / 2 | 0 / 5 | fixed |
| 2 | 1 / 3 (P1 re-rated P2) | 0 / 0 | fixed |
| 3 | 1 / 1 (P1 re-rated P2) | 0 / 0 | fixed |
| 4 | 1 / 2 (P1 re-rated P3) | 0 / 0 | fixed |
| 5 | 1 / 1 (P1 re-rated P2) | 0 / 0 | fixed |
| 6 (Codex only) | 0 / 2 | - | fixed |
| 7 (Codex only) | 0 / 0 (one P2 re-rated P3) | - | closed |

## Phase 4 - Codex and Claude Code

Status: **done** (review closed after round 5, the round limit: its two P2s are fixed and
covered by tests)

| Item | State | Evidence |
|------|-------|----------|
| Codex adapter: `codex exec --json`, `--output-schema`, resume by thread id | done | `packages/runtime-codex` |
| Claude Code adapter: `claude -p --output-format json`, `--json-schema`, `--resume` | done | `packages/runtime-claude` |
| Process group per call, stopped as a whole on deadline, cancel and kill-all; bounded output | done | `runtime-sdk/src/process.ts` |
| Clean runtime environment; no credentials in the model's commands | done | `runtime-sdk/src/environment.ts`, both adapters |
| Workspace per attempt, created empty and removed by the worker | done | `createRunWorkspace`, `apps/worker/src/run-job.ts` |
| Model commands in the OS sandbox: no home, login, secrets or other runs; writes to the workspace only; no network | done | Codex permission profile, Claude Code Bash sandbox |
| Built-in tools mapped from the tool policy, fail-closed | done | `nativeToolGrants`, adapters' sandbox and tool flags |
| Session resume under `resumable-if-available`, within the same config version and conversation; fresh start on any resume failure | done | `RunJob.runtime`, `scheduler.ts` (`sessionScope`, `storedSession`), `executeTurn` |
| One repair turn with the validation issues as data | done | `renderRepairPrompt` |
| `gateway runtime doctor <adapter>`: version, login, structured turn, cancel, resume, risks | done | `runtime-sdk/src/doctor.ts`, `apps/cli` |
| Worker builds its adapter from settings (`CODEX_*`, `CLAUDE_*`, `WORKER_WORKSPACE_ROOT`) | done | `apps/worker/src/adapters.ts` |

Acceptance for each adapter. CI runs the contract suite against fake CLIs. The live suite ran
against codex-cli 0.156.1 and Claude Code 2.1.283:

- [x] Doctor passes (live; `gateway runtime doctor` on both).
- [x] Structured output passes: reply and a structured wait for another agent (contract suite
  on the fake, live suite on the real CLI; both CLIs accept the provider schema).
- [x] Timeout and cancel tested: the deadline and an abort stop the whole process group, and a
  child the runtime started is gone afterwards (fake). Cancel of a real turn was checked by the
  doctor.
- [x] Workspace isolation verified. Live: a write inside the workspace succeeds and a write
  outside it does not. Fake: the process runs in the run workspace, the workspace is removed
  afterwards, and the worker's `DATABASE_URL` and tokens do not reach the runtime.
- [x] Tool allowlist verified. Live: without `workspace.write` nothing is written. Fake: the
  policy maps onto the sandbox, shell and web flags (Codex) and the built-in tool list
  (Claude Code).
- [x] Invalid output is handled without posting raw content: one repair, then `invalid_output`,
  and the detail carries no model text (contract suite; integration test for the controller
  side).
- [x] Session resume fallback works: the stored session is offered to the next run; an unknown
  session, or one from another runtime version, starts fresh (contract suite, worker tests,
  and an integration test across a worker restart).

Known gaps, deferred:

- Workspaces are empty directories: git worktrees per run and capturing diffs and commits as
  artifacts need repository configuration (`collectArtifacts` returns nothing).
- Granted commands can read system paths (and `/tmp` under Claude Code); secrets must stay in
  the denied places. Container hardening is Phase 8.
- On Codex, `repository.read` without `tests.run` gives no file access (Codex reads only through
  its shell), and `tests.run` sees system toolchains only.
- `runtime.profile` is not used by these adapters.
- A command that detaches into a new session survives cancellation (sandboxed, workspace
  removed); a per-run cgroup or container stops it (Phase 8).
- One stored session per agent and adapter: interleaved conversations replace each other's.
- Codex does not report cost; its usage has tokens only.

Deliberate choices in this phase ([ADR-014](docs/adr/014-cli-runtime-adapters.md)):

- CLIs, not SDKs or app servers: one process per call, the same control for both runtimes.
- `tests.run` grants any command, not only tests; finer command policies belong to the Tool
  Broker.
- A repair turn always starts fresh instead of resuming the first attempt's session.

### Phase 4 review log

- Round 1 (Codex + Opus subagent): Codex 5 P1 + 4 P2 + 1 P3, Opus 1 P1 + 3 P2 + 6 P3.
  - Rejected: Claude sessions not resuming across workspaces (Codex P1). Checked on the real CLI:
    a session started in one directory resumes from another, and the doctor's resume check
    runs across workspaces.
  - Fixed, both reviewers' P1: granted commands could read the CLI login, session transcripts,
    secret files and other runs. They now run in the OS sandbox (Codex permission profile,
    Claude Code Bash sandbox). A live test checks that another run's file does not leak.
  - Fixed, re-rated P2 (Codex P1s):
    - a descendant that left the process group could hang cancel: the result waits for exit
      plus a bounded drain, and cancel is bounded;
    - Claude stdout could reach error details: only its size is reported now;
    - a model-written `AGENTS.md` could reach the repair turn (needs `workspace.write` and a
      git repository): `project_doc_max_bytes=0`.
  - Fixed, P2:
    - sessions are scoped to config version and conversation;
    - any failure of a resumed call starts fresh (one bad session no longer fails every run),
      and sessions expire after seven days;
    - Codex's `thread … not found` counts as a missing session;
    - a cut event stream no longer loses the answer (read from `-o`, the stream keeps head and
      tail, a completed turn is required);
    - an attempt gets a fresh, attempt-specific workspace;
    - Codex gets a shell only with `tests.run`;
    - Claude budget and structured-output limits are permanent failures.
  - Fixed, P3:
    - Codex output tokens no longer count reasoning twice;
    - the workspace root and agent directory must be the worker's own real directories;
    - the invalid-output contract test checks for leaks.
  - Declined, P3: a repair turn replacing the stored session; jobs queued before this change
    failing validation (nothing is deployed); a retry reading the session policy from the
    current config.
- Round 2 (Codex + Opus subagent): Codex 3 P1 + 2 P2, Opus 2 P2 + 8 P3.
  - Fixed, P2:
    - Codex listed skills, the operator's and any written into the workspace, even with
      `--ignore-user-config` (checked on the real CLI): `skills.include_instructions=false`;
    - Claude Code's scratch and Bash temp files went to a shared per-user `/tmp` directory,
      readable and writable across runs (Codex P1, Opus P2; re-rated P2: the files hold command
      output, not credentials): `TMPDIR` and `CLAUDE_CODE_TMPDIR` point into the attempt;
    - validation messages quote unknown key names into the failure detail (Codex P1, re-rated
      P2: the detail goes to operators, not to channels): the detail has paths and codes only,
      and the leak test uses a key name;
    - the round-1 reasoning-token fix had not been applied: fixed and tested.
  - Fixed, P3:
    - an unknown model or rejected CLI config is a permanent failure;
    - Codex commands get a temp directory;
    - `view_image` is disabled;
    - the doctor runs a sandboxed command;
    - the workspace root must not be writable by others;
    - ADR wording.
  - Deferred: a detached (`setsid`) command outliving cancellation (Codex P1, re-rated P2: it
    stays sandboxed, without network or workspace). Only a per-run cgroup or container can
    stop it (Phase 8, documented in ADR-014).
  - Rejected: Codex resuming in the old session's directory (checked: a resumed turn runs and
    writes in the new workspace).
  - Declined, P3:
    - the fresh start after a resumed call hit a limit spends that limit once more; the
      fallback is what keeps one bad session from failing every run;
    - one session row per agent (documented).
- Round 3 (Codex + Opus subagent): Codex 2 P1 + 3 P2, Opus 1 P2 + 6 P3.
  - Fixed, P2:
    - a workspace the model made unremovable (a directory without its write bit) threw from the
      cleanup and lost the run's report: removal restores access and retries, and a cleanup
      failure is logged without replacing the report;
    - a session of a turn that also carried inbox events from other conversations was offered
      to later turns of the trigger's conversation alone (Codex P1, re-rated P2: every
      conversation involved was in the agent's own channels). The scope now covers every
      carried conversation;
    - Claude's "no conversation found" was matched against a successful answer as well;
    - the doctor's sandbox check trusted the model's word: it now posts a token that exists
      only in a workspace file, and the live isolation test does the same;
    - Claude accepts a result only when the CLI exits with 0.
  - Fixed, P3:
    - Codex commands can write their temp directory without `workspace.write`;
    - Claude Bash cannot read the worker's `$TMPDIR`;
    - deny paths are resolved (`realpath`) before they reach a sandbox;
    - the worker checks its workspace root at startup.
  - Declined: `cancel(runId)` before a process is registered (Codex P1, re-rated P3). The Gateway
    cancels only through the turn's signal, which every start and the fallback check; `cancel`
    runs after that abort.
  - Found while fixing the doctor check: with a proof word that exists only in a workspace file,
    the live tests showed that models had not run the commands at all. Codex took `tests.run`
    for a tool name it lacked, and read the profile's `/tmp` denial as covering its workspace.
    Claude refused to post a value called a token. The earlier "no leak" results were
    therefore vacuous. Fixed:
    - the prompt names the granted built-in tools in plain words;
    - `tests.run` implies reading;
    - the Codex profile lists the workspace by its own path;
    - the live checks require the proof word, using harmless wording.
- Round 4 (Codex + Opus subagent): Codex 3 P1 + 2 P2, Opus 1 P2 + 3 P3.
  - Fixed, P2:
    - the sandbox checks could pass without Bash, because `tests.run` gives Claude the Read tool
      (both reviewers). The doctor and the live test now require a file only a shell can create
      (a copy of a workspace word, with no file-write grant);
    - Claude's Bash wrote temp files to the shared `/tmp/claude-<uid>`. Claude Code falls back
      to it whenever the configured temp path is long, which a workspace path always is (found by
      the new doctor check; the reviewer rated it P2). Each call now gets a short
      `/tmp/agw-*` directory, removed afterwards, and Bash cannot read the rest of `/tmp`;
    - with `HOME` unset, Claude's Bash could read the account's home (Codex P1, re-rated P2:
      needs a worker started without HOME): the home comes from the account as well;
    - `tests.run` let Claude write the workspace while Codex kept it read-only (Codex P1,
      re-rated P2: the workspace is the run's own scratch, and nothing leaked). Aligned:
      commands write the workspace on both, and an explicit deny of `workspace.write` withholds
      `tests.run`.
  - Fixed, P3:
    - session scopes are JSON-encoded (Codex P1, re-rated P3: ids with commas would have to
      collide exactly);
    - Codex matches a missing session only on a failed call;
    - workspace cleanup does not follow a symlink out of the workspace;
    - an explicit deny of `repository.read` withholds writing and commands.
- Round 5 (Codex + Opus subagent): Codex 0 P1 + 2 P2, Opus 0 P1/P2 + 3 P3.
  - Fixed, P2:
    - the shell proof wrote into `.tmp`, which the Claude workspace does not have: the proofs
      now go to the workspace root;
    - an abort during Codex's call setup could recreate a workspace the worker had already
      removed: the attempt's `.tmp` is created only inside an existing workspace.
  - Fixed, P3:
    - the Claude risk text and ADR-014 say that Claude's Bash denies reads by list;
    - Codex's comment and the ADR say `tests.run` makes the workspace writable;
    - the ADR requires the doctor to pass on the deployment host before `tests.run` is granted
      (only macOS was verified in this phase).
  - Review closed at the round limit.

Findings per round (P1 / P2, as reported):

| Round | Codex | Opus | Outcome |
|-------|-------|------|---------|
| 1 | 5 / 4 (one P1 rejected, three re-rated P2) | 1 / 3 | fixed |
| 2 | 3 / 2 (two P1 re-rated P2, one deferred) | 0 / 2 | fixed |
| 3 | 2 / 3 (one P1 re-rated P2, one declined) | 0 / 1 | fixed |
| 4 | 3 / 2 (P1s re-rated P2, P2, P3) | 0 / 1 | fixed |
| 5 | 0 / 2 | 0 / 0 | fixed, closed |

## Phase 5 - Grok, Kiro, OpenCode Go, Hermes

Status: **done** (review closed after round 5, the round limit: its P2s are fixed and covered
by tests)

| Item | State | Evidence |
|------|-------|----------|
| Grok adapter: `grok --prompt-file /dev/stdin --output-format json`, `--json-schema`, resume by session id | done | `packages/runtime-grok` |
| Kiro adapter: `kiro-cli chat --no-interactive --output-format stream-json`, engine v2, resume by session id | done | `packages/runtime-kiro` |
| OpenCode Go adapter: `opencode run --format json`, per-call permissions, no resume | done | `packages/runtime-opencode` |
| Hermes adapter: `hermes chat --query-file - --format stream-json`, resume by session id | done | `packages/runtime-hermes` |
| Built-in tools granted only where the runtime confines them; withheld ones removed from the prompt and reported as risks | done | `confinedGrants`, `capabilities.confinedTools` |
| Gateway-owned home per runtime, configuration rewritten before use; no operator settings, rules, skills, plugins, MCP, memory or telemetry | done | the four adapters |
| JSON answers of runtimes without structured output, in or out of a code fence | done | `parseJsonAnswer` |
| Worker heartbeats; a failing probe stops taking jobs, recovery resumes them | done | `apps/worker/src/worker.ts` |
| Runtime availability per adapter; agents of an unavailable runtime degraded; one alert per change | done | `runtime-health.ts`, migration `0007_runtime_workers` |
| Pinned runtime version (`WORKER_RUNTIME_VERSION`); version in heartbeats, runs and `gateway runtimes list` | done | `pinProbe`, `apps/cli` |

Acceptance. CI runs the contract suite against a fake CLI of each runtime. The live suite
(doctor with cancel and resume, structured wait, tool withholding, local-file fetch; reads and
writes for OpenCode) ran against grok 1.0.41, kiro-cli 2.24.1, opencode 1.18.31 (OpenCode Go)
and Hermes 0.21.5 (openai-codex):

- [x] Each passes the common contract suite (mock task, wait result, invalid output, timeout,
  cancel, session fallback), plus its own tests.
- [x] Runtime version pinned and observable: a worker on another version than
  `WORKER_RUNTIME_VERSION` reports the runtime unavailable (integration test); the version is
  in every heartbeat, run and `gateway runtimes list`.
- [x] Secrets isolated: none of the worker's environment reaches a runtime (each adapter's
  tests); the runtimes use their own homes, never the operator's; Grok and Hermes get an empty
  `HOME`; no tool that could read a login is granted.
- [x] An unavailable runtime marks only its agents degraded: a worker whose probe fails stays
  up, takes no jobs and reports it; its agents are degraded and alerted, the other adapters'
  agents are not; recovery clears it (integration test).

Known gaps, deferred:

- Grok, Kiro and Hermes agents have no file or command tools, OpenCode no commands. A
  container per run (Phase 8) can confine them.
- OpenCode's file tools are confined by its own permission check, not by an OS sandbox.
- Kiro records no token usage (it meters credits); OpenCode Go and Hermes report no cost.
- A worker silent without a `stopped` heartbeat is noticed after three heartbeats (90 s).

Deliberate choices in this phase ([ADR-015](docs/adr/015-unconfined-runtimes-and-runtime-health.md)):

- The same CLI-per-call approach as ADR-014 for all four runtimes, including Grok (the CLI
  rather than the xAI API) and OpenCode (`run` rather than `serve`).
- A failing probe keeps the worker running and reporting instead of exiting.

### Phase 5 review log

- Round 1 (Codex + Opus subagent): Codex 4 P1 + 3 P2, Opus 0 P1 + 8 P2 + 9 P3.
  - Fixed, both reviewers: the adapters rewrote their CLI configuration in place, so a CLI
    starting during a probe could read a missing or partial file and fall back to its default
    tools or agent. Files are now written atomically before every call, and only when changed
    (`writeRuntimeFile`); a removed Kiro agent definition is restored.
  - Fixed (Codex P1): an OpenCode agent without a model let the CLI choose its default
    provider. The model is now required (`runtime.model` or `OPENCODE_MODEL`).
  - Fixed (Codex P1, Opus P3): a probe that threw left a ready worker taking jobs, and a failed
    `offWork` lost the subscription. Probe exceptions count as failed probes; the subscription
    id is kept until removal succeeds; `stop` waits for a check in flight.
  - Fixed, both reviewers (P2): heartbeat handling and sweeps could race, alert twice or be
    undone by an older heartbeat applied later. Both now decide under one lock per adapter;
    heartbeats are dated by when they were queued (`createdOn`) and never move backwards; the
    alert key names the state that ended.
  - Fixed (Opus P2): restarts, deploys and one failed probe raised alert pairs. A change is
    settled and alerted only after it lasted 60 s (`pending_since`).
  - Fixed (Opus P2): runs kept recording the old version after an in-place CLI upgrade. A new
    version makes the worker take jobs anew under it.
  - Fixed (Opus P2): the OpenCode and Hermes probes do not verify the credential (with no
    `HERMES_PROVIDER`, Hermes checks no login). Reported as policy risks; the doctor's turn
    verifies it.
  - Fixed (Opus P2): OpenCode's file tools may reach a whole git checkout. A workspace inside
    one is refused.
  - Fixed (Codex P2, Opus P3): transcripts of failed or cancelled turns stayed behind. Grok gets
    the new session's id from the adapter (`--session-id`) and deletes it in any case; Kiro
    finds the id in any event. The privacy notes say what can remain.
  - Fixed (Opus P3): an OpenCode turn cut off by the output limit (`length`) was retried; the
    probe detail went unquoted into alerts; `withoutUnanchoredPatterns` kept `^a|b$` and
    stripped patterns inside `const`/`default`; Grok's `forgetSession` took any id and removed
    other runs' empty groups.
  - Found while checking Opus P3 (web fetch of local files): Grok refused every fetch under
    `dontAsk`. It now gets `--allow WebFetch` when fetch is granted. Grok, Kiro and OpenCode
    refuse `file:` URLs (live suite check added); fetch reaching loopback addresses is
    documented in ADR-015.
  - Tests added: the health integration test covers a throwing probe, a queued run that waits
    while its runtime is unavailable and runs after recovery, stale and out-of-order
    heartbeats, and a worker id reused by another adapter.
  - Accepted (Opus P3): after a recovery, jobs still running on the removed subscription can
    overlap a new one for a moment. Deferred (Opus P3): a live check that files the model
    writes in the first turn do not become instructions in the repair turn.
- Round 2 (Codex + Opus subagent): Codex 1 P1 + 3 P2, Opus 0 P1 + 2 P2 + 10 P3.
  - Re-rated P2 (Codex P1): a CLI replaced in place between probes runs, reporting the old
    version, until the next probe (up to five minutes). Worker images are immutable; still, a
    worker with a pinned version now probes every heartbeat.
  - Fixed (Codex P2): the sweep's cleanup of old worker rows could wait on a row while a
    heartbeat held the adapter lock and waited on the same row; it is now a statement of its
    own. Two adapters racing for a new worker id could overwrite each other; the upsert now
    requires the same adapter. The live file-fetch check granted fetch without search, which
    Hermes needs for fetch.
  - Fixed (Opus P2): after a cancel the workspace can be gone before the Hermes and OpenCode
    session deletes ran there; they now run from the Gateway's home (checked on the real
    OpenCode). After an upgrade, a failed resubscribe was not retried; the worker now keeps
    the subscription's version and resubscribes on every tick until it matches (integration
    test).
  - Fixed (Opus P3): a heartbeat is sent before a slow probe; `stop` waits at most 5 s for a
    check in flight; agents added to an adapter that is already down are alerted (only
    adapters with enabled agents are settled); a heartbeat that fails is logged, never retried
    into the dead letter queue; OpenCode records no cost when no step reports one; a failed
    `writeRuntimeFile` removes its temporary file.
  - Accepted (Opus P3): heartbeat dates are database time while the controller compares with
    its own clock (hosts run NTP); a runtime that flaps faster than the stable window is not
    alerted (its runs fail and alert on their own); an OpenCode workspace root inside a git
    checkout fails runs instead of degrading the runtime; no test of two controllers alerting.
- Round 3 (Codex + Opus subagent): Codex 1 P1 + 3 P2, Opus 0 P1 + 1 P2 + 7 P3.
  - Fixed (Codex P1): while a subscription could not be removed, it still ran turns and the
    heartbeat was skipped. Jobs of a subscription whose runtime failed or changed version are
    now refused as retryable (`accepting`, unit test), removal is retried every tick, and the
    heartbeat goes out regardless.
  - Fixed, both reviewers (P2): under `resumable-if-available`, transcripts of failed,
    cancelled or superseded turns were never deleted. Only a session handed back to the
    Gateway is kept; Kiro and Hermes prune sessions past their lifetime on every probe; the
    privacy notes say what can remain until then.
  - Fixed (Codex P2): a session could be labeled with the version a probe read during the run.
    The worker labels sessions with the version the run reports, and the adapters read it
    before the call. `runtimes list` shows the versions of unavailable workers too
    (`reportedVersions`).
  - Fixed (Opus P3): versions are quoted in alerts; Hermes and OpenCode session ids are checked
    before they reach a delete command; queued runs of a runtime known to be down raise no
    "still queued" alert; the adapter homes are created before their real path is taken; a
    pinned worker probes every minute instead of every heartbeat; Hermes checks stderr for a
    failed login.
- Round 4 (Codex + Opus subagent): Codex 1 P1 + 3 P2 + 1 P3, Opus 0 P1 + 2 P2 + 8 P3.
  - Fixed, both reviewers (Codex P1, Opus P2): a subscription that could not be removed kept
    fetching jobs and refusing them, and each refusal used up a run attempt until the agent
    was FAILED. A worker that cannot remove a subscription now stops pg-boss altogether and
    exits (`failed`), so its supervisor starts a clean one; its agents are degraded meanwhile.
  - Fixed (Codex P2): a failed subscribe skipped the heartbeat; it now counts as unavailable
    with its reason. `stop` removes the subscription before reporting `stopped`, and no turn
    starts once the worker is stopping.
  - Fixed, both reviewers (P2): OpenCode sessions of a call stopped before its first event
    stayed forever. The probe deletes every OpenCode session older than a day (none is ever
    resumed).
  - Fixed (Opus P3): a failed resumed Kiro or Hermes turn deleted the session the Gateway still
    holds; the heartbeat before a probe could say ready for an outdated subscription;
    rate-limit and overload errors are always retryable, and the permanent-error patterns are
    narrower; the live file-fetch check requires a completed turn (Codex P3); the pinned-version
    test stops its worker.
  - Accepted (Opus P3): a "still queued" alert suppressed while the runtime is down is not
    raised again after recovery (the runtime's recovery alert and `gateway health` cover it);
    availability of an adapter without enabled agents is not settled until agents use it
    again; heartbeats read the fresh workers of every adapter (a few rows per adapter).
- Round 5, the round limit (Codex + Opus subagent): Codex 0 P1 + 2 P2 + 1 P3, Opus 0 P1 + 2 P2
  + 7 P3. Review closed: both reviewers' P2s are fixed and covered by tests.
  - Fixed (Opus P2): a worker giving up left its turns' CLIs running in their own process
    groups. It now cancels its turns and waits for them (bounded) before it exits.
  - Fixed (Opus P2): a CLI that starts a new session instead of resuming the requested one
    counted as resumed. Grok, Kiro and Hermes now treat it as an unavailable session: the turn
    starts fresh and the stray session is removed.
  - Fixed (Codex P2): two heartbeats of one worker queued at the same moment could apply in the
    wrong order. Reports carry a per-worker sequence, and only a later one replaces the stored
    status (integration test with equal timestamps).
  - Fixed (Codex P2): expired sessions were pruned only when the login check passed; pruning now
    runs first.
  - Fixed (P3): the settings reference lists every adapter and the new settings; ADR-015 says
    when a worker exits and that Kiro workspaces with repository content must not carry
    `.kiro/`; the live suite checks that a runtime without confined commands creates no
    shell-only file.
  - Accepted (Opus P3): heartbeats wait for a probe in flight (probes are bounded by 30 s per
    CLI call); Hermes without web grants relies on its empty `cli` toolset list (the live suite
    checks that such an agent writes nothing); a `pending_since` left by a controller outage
    can alert once after the restart; Grok's result schema goes on the command line (well
    under the argument limit today).

| Round | Codex P1 / P2 | Opus P1 / P2 | Outcome |
|-------|---------------|--------------|---------|
| 1 | 4 / 3 | 0 / 8 | fixed |
| 2 | 1 / 3 (P1 re-rated P2) | 0 / 2 | fixed |
| 3 | 1 / 3 | 0 / 1 | fixed |
| 4 | 1 / 3 | 0 / 2 (one re-rated then fixed with Codex's P1) | fixed |
| 5 | 0 / 2 | 0 / 2 | fixed, closed |

## Phase 6 - Gmail connector

Status: **done** (review closed after round 5, the round limit: its P2s are fixed and covered
by tests; checked live against a real mailbox)

| Item | State | Evidence |
|------|-------|----------|
| Polling by default (`gmail.readonly` only), Pub/Sub push optional ([ADR-017](docs/adr/017-gmail-polling-by-default.md)) | done | `connector.ts`, `gmail-polling.integration.test.ts` |
| OAuth setup docs; `gateway gmail authorize` (loopback, PKCE, state), exactly `gmail.readonly` (+ `pubsub` with `--pubsub`) | done | [docs/operations/gmail.md](docs/operations/gmail.md), `apps/cli/src/gmail-commands.ts` |
| Gmail watch lifecycle: created on start, renewed daily and before expiry, alert when renewal fails near expiry | done | `packages/connector-gmail/src/connector.ts` |
| Pub/Sub pull subscriber: notification stored before acknowledgement, foreign and malformed messages dropped | done | `connector.ts`, `pubsub-client.ts` |
| Cursor and history delta: per page, ingested with the cursor move in one transaction (compare-and-set) | done | `sync.ts`, `core/src/services/gmail.ts`, migration `0008_gmail_mailboxes` |
| Reconciliation: periodic sync without notifications; full sync and alert after a history gap | done | `sync.ts` |
| Normalized events: `google.gmail.message.received` (deterministic id, per-thread correlation, stable fields), record-only notifications | done | `normalize.ts`, `contracts/src/event.ts` |
| Mail body sanitization: HTML to text without active or hidden content, unsafe characters stripped, bounded; attachments described only | done | `html.ts`, `mime.ts` |
| `@mail-follower` sample agent | done | `config/examples/agents/mail-follower.yaml`, `prompts/examples/agents/mail-follower.md` |
| Health: connector readiness, `gateway gmail status`, Gmail checks in `gateway health` | done | `apps/connector-gmail`, `apps/cli` |

Acceptance (integration tests against a fake Google speaking the REST wire format,
`apps/connector-gmail/src/gmail.integration.test.ts` with Pub/Sub,
`gmail-polling.integration.test.ts` without):

- [x] One incoming email wakes mail-follower once.
- [x] A duplicate Pub/Sub notification (a redelivery, and a second notification of the same
  change) is deduplicated: one message event, one run.
- [x] A dropped notification is found by reconciliation.
- [x] A restart resumes from the cursor: mail received while the connector was down is
  ingested once, nothing is replayed.
- [x] Email prompt injection cannot invoke a privileged tool: the run asking for a finance
  action is refused (`deny` policy decisions, alert, nothing published, no approval request);
  the turn input is labelled external-untrusted and holds no credential.
- [x] No send permission exists: the credential has exactly two read scopes and a wider one is
  refused on every refresh; the Gmail client has no call that changes mail; no outbox kind
  delivers mail.
- [x] Live check against a real mailbox (2026-09-27, polling mode, `gmail.live.test.ts`): the
  credential holds exactly `gmail.readonly`; an email sent to the mailbox became one
  external-untrusted event and one `@mail-follower` run. The Pub/Sub mode is covered by the
  fake only.

Deliberate choices in this phase ([ADR-016](docs/adr/016-gmail-connector.md)):

- Plain REST with `fetch` and synchronous Pub/Sub pull instead of Google's SDKs and gRPC
  streaming pull.
- One OAuth credential of the owner for Gmail and Pub/Sub (owner's decision) instead of a
  separate service account.
- The connector is a process of its own; only it holds the Google credential.

Known gaps, deferred:

- Attachment scanning and handing attachments to tools (after Phase 7: the tool broker executes
  approved actions only, no tool reads mail attachments yet).
- One mailbox per connector process; several mailboxes run several processes.
- Retention of stored mail (Phase 8). Done in Phase 8: event payloads expire after
  `organization.retention.event_content_days`.
- A Google OAuth app left in "Testing" status issues refresh tokens that expire after seven
  days; publishing it needs a home page, a privacy policy link and an authorized domain.

### Phase 6 review log

- Round 1 (Codex + Opus subagent): Codex 4 P1 + 4 P2, Opus 0 P1 + 6 P2 + 8 P3.
  - Fixed (Codex P1): history references usually carry no labels, and the sync dropped every
    message without them: against real Gmail no mail would have arrived. A message now counts
    when history (read filtered by INBOX) reports it; its current labels only exclude spam,
    trash, drafts and chats. The fake answers with ids only, as Gmail does.
  - Fixed (Codex P1): the first watch and the first sync raced to create the cursor. The
    watch creates it, and syncing and pulling wait for the first watch attempt.
  - Fixed (Codex P1, Opus P2): a sync that found nothing recorded nothing, so `gateway health`
    failed on a quiet mailbox and a later full sync looked back from the wrong time. Every
    completed sync commits (the cursor unchanged) and records its time; the health threshold
    follows `GMAIL_RECONCILE_SECONDS`.
  - Re-rated P3, kept by design (Codex P1): a full sync reads at most the latest 500 messages,
    so a long outage does not wake agents for thousands of old mails. The alert now says
    plainly when older mail was left unread.
  - Fixed (Codex P2, Opus P2): mail archived before it was read was dropped, contrary to the
    ADR (see the first fix).
  - Fixed (Codex P2, Opus P2): hidden text passed through when hidden by the mail's stylesheet,
    `height:0;overflow:hidden`, off-screen positioning, tiny fonts, background-coloured text,
    CSS comments or `/` attribute separators, and an unclosed hidden paragraph hid the rest of
    the mail. The sanitizer reads the mail's hiding rules (classes, ids), a broader set of
    hiding declarations, and applies implied end tags.
  - Fixed (Codex P2, Opus P2): the plain part was preferred, so a sender could show harmless
    HTML to the reader and put instructions in the plain part. The HTML part is used when it
    has text; the injection test now sends divergent parts.
  - Fixed (Codex P2, Opus P3): Gmail ids were assumed hex; a message that cannot be
    normalized was skipped silently. Ids are opaque URL-safe strings; a skipped message alerts.
  - Fixed (Opus P2): a Gmail thread's cascade budget never reset, so a thread of more than 20
    mails stopped waking `@mail-follower` for good. Each received mail starts a new cascade
    (integration test with 22 mails in one thread).
  - Fixed (Opus P2): watch renewal, renewal failure near expiry, full sync paging and its
    bound, and full sync against Postgres had no tests; the fake's listing did not paginate.
  - Fixed (Opus P3): lock order of notification recording (mailbox row before the ingest
    locks) and its comment; a sync request between a sync's end and its cleanup was lost; stop
    now aborts Gmail calls in flight; pull failures alert after five in a row (daily); a doc
    comment split by a new function; duplicate delta, commit and ingest status types now live
    in `contracts`.
- Round 2 (Codex + Opus subagent): Codex 2 P1 + 2 P2 + 1 P3, Opus 0 P1 + 1 P2 + 5 P3. Opus
  verified every round 1 fix.
  - Fixed (Codex P1): every page commit recorded the sync time, so after a sync stopped
    halfway and a history gap, the full sync looked back from the wrong moment and could skip
    mail. Only a sync that reached the present is recorded; with none yet, the full sync looks
    back from the cursor's creation (test: stop after the first page, expire history).
  - Re-rated P3 (Codex P1): when Google accepted the first watch but its database write
    failed, the fallback cursor starts at the profile's history id, a moment later. Mail in
    between arrived before the mailbox had any cursor, which the first start never reads by
    design. Fixed with it: `syncNow()` from outside also waits for the first watch attempt.
  - Fixed (Codex P2): mail moved into the inbox later (a filter that skipped it, taken back
    from the archive) never became an event. History is read for `labelAdded` too, admitting
    additions of INBOX; a message is ingested once however often it enters.
  - Fixed (Codex P2, Opus P3): stylesheet rules with element types (`div{display:none}`) and
    CSS escapes (`n\6f ne`) hid text unnoticed. Rules are matched by their selector's last
    compound (tag, classes, id); declarations are unescaped.
  - Fixed (Opus P2): stylesheet rules over-hid ordinary mail: rules inside `@media` (a
    responsive template's mobile or desktop version) and every class anywhere in a selector
    (`.wrapper .pre` hid the whole wrapper). Conditional at-rules are ignored, and only the
    element the selector styles is hidden.
  - Fixed (Opus P3): any hop-0 Gmail event could reset a cascade budget whatever its
    correlation. The contract binds a Gmail event's source, id and correlation to its data.
  - Fixed (Opus P3): the long-thread test only excluded `cascade_limit`; it now requires every
    route to wake. The owner's sent mail is excluded by its labels as well as by the inbox
    filter. A sync request during a failed sync now gets its own sync. An empty pull that
    returns at once pauses a second instead of spinning (Codex P3).
  - Accepted (Opus P3): white text without a set background, or with the background on a
    parent, is not detected; attribute selectors are not resolved. The body stays
    external-untrusted and the policy checks every result.
- Round 3 (Codex + Opus subagent): Codex 0 P1 + 4 P2 + 1 P3, Opus 0 P1 + 1 P2 + 2 P3. Both
  verified the round 2 fixes.
  - Fixed (Opus P2): stylesheet hiding was bypassed by wrapping the rule in `@media screen`,
    `@media all` or `@layer`, or adding a pseudo-class (`:nth-child(n)`, `:not(...)`,
    `:where(...)`). Unconditional at-rules are read through (only `@media` with conditions,
    and print, are skipped); pseudo-classes that only narrow a match are read as matched,
    interaction states (`:hover`) as never.
  - Fixed (Codex P2): the history-gap alert was raised after the cursor commit and could be
    lost; it is now committed in the same transaction.
  - Fixed (Codex P2): a credential re-authorized for another account continued from the old
    account's cursor. The cursor stores a hash of its account's address; another account is
    refused with an alert until `gateway gmail reset <mailbox-id>`.
  - Fixed (Codex P2): deeply nested HTML made the conversion quadratic. Nesting is read to
    256 levels and HTML to 2 million characters; the body is marked truncated beyond.
  - Fixed (Codex P3): the process health counted an unfinished sync as fresh.
  - Re-rated, not a defect (Codex P2): mail with both SENT and INBOX is mail the owner sent
    to themself; it did arrive in the inbox and stays an event. Only SENT without INBOX is
    excluded.
  - Accepted (Opus P3): the CSS cascade is not modelled, so a later rule that shows an element
    again is ignored and the text dropped. Rare in mail, and it errs towards dropping.
  - Fixed (Opus P3): stacked doc comments in `html.ts`.
- Round 4 (Codex + Opus subagent): Codex 0 P1 + 3 P2, Opus 0 P1 + 2 P2 + 1 P3. Both
  verified the round 3 fixes.
  - Fixed (Opus P2): the refresh token was re-read at every token refresh while the account
    was checked once per process, so a consent for another account given while the connector
    ran would have been used. The token is read once at start; a new consent applies at the
    next start, where the account check runs. A refused account is not asked again.
  - Fixed (Opus P2): stylesheet hiding still leaked through `@media (min-width:0)`,
    `:is(.a,.h)`, `.h:not(:hover)`, nested `:where()` and `:not(.a,.b)`. Selectors are split
    at top-level commas, `:is()`/`:where()` stand for each argument, `:not()` is removed
    before looking for interaction states. A hiding rule that is conditional or unresolved no
    longer passes silently: its text is kept and the mail is marked `hidden_text_suspected`,
    which the agent's prompt tells it to treat with care.
  - Fixed (Codex P2): an HTML part without text fell back to the plain part, reopening the
    divergent-alternative trick; the HTML part now always wins.
  - Fixed (Codex P2): each element was checked against every hiding rule (quadratic in a
    crafted mail). Rules are indexed by id, class and tag, and bounded to 2000 (beyond, the
    mail is marked suspected).
  - Re-rated P3, accepted (Codex P2): a full sync finds mail by its date, so an old message
    moved into the inbox during a week-long outage is missed; listing the whole inbox would
    wake agents for all mail from before the connector's start. Recorded in ADR-016.
- Round 5 (Codex + Opus subagent, the round limit): Codex 0 P1 + 2 P2 + 1 P3, Opus 0 P1 +
  1 P2 + 2 P3. Both verified the round 4 fixes. The review is closed: the P2s below are fixed
  and covered by tests.
  - Fixed (Opus P2): a rule for a pseudo-element (`::-webkit-scrollbar`, `::after`,
    `:first-line`) hid the element itself, so templates that hide their scrollbar gave an
    empty body. Such rules are ignored.
  - Fixed (Codex P2): `:hover` inside a quoted attribute value (`[data-x=":hover"]`) was read
    as an interaction state; attribute selectors are removed first.
  - Fixed (Codex P2): at-rules nested beyond the read depth were skipped silently; the mail is
    marked `hidden_text_suspected`.
  - Fixed (Opus P3): `:link` matches at rest and no longer counts as an interaction state;
    `:visited` is unresolved (suspected). Stale docs on reading the refresh token. Fixed
    (Codex P3): `gmail authorize --port` is validated.

| Round | Codex P1/P2 | Opus P1/P2 | Result |
|---|---|---|---|
| 1 | 4 / 4 | 0 / 6 | fixed (one P1 re-rated P3, kept by design) |
| 2 | 2 / 2 | 0 / 1 | fixed (one P1 re-rated P3) |
| 3 | 0 / 4 | 0 / 1 | fixed (one P2 re-rated, not a defect) |
| 4 | 0 / 3 | 0 / 2 | fixed (one P2 re-rated P3, accepted) |
| 5 | 0 / 2 | 0 / 1 | fixed, closed |

Follow-up: polling by default ([ADR-017](docs/adr/017-gmail-polling-by-default.md), the owner's
decision to drop the Pub/Sub setup; IMAP via himalaya was rejected because Gmail's IMAP
credentials can send mail). One review round (Codex + Opus subagent): 0 P1, Codex 3 P2, Opus
1 P2 + 3 P3.
  - Fixed (Codex P2, Opus P2): `gateway health` inferred the mode from past watch renewals,
    so a mailbox switched to polling failed once the old watch expired, and freshness assumed
    five minutes. The connector records its mode and interval (migration `0009_gmail_mode`).
  - Fixed (Codex P2, Opus P3): recovery hints (alert, readiness, guide) name
    `gateway gmail authorize --pubsub` in the Pub/Sub mode.
  - Fixed (Opus P3): a connector started with the renamed `GMAIL_RECONCILE_SECONDS` refuses to
    start.

## Phase 7 - Policies and approvals

Status: **done** (review closed after round 5, the round limit: its P2 is fixed and covered by
the Mattermost e2e test)

| Item | State | Evidence |
|------|-------|----------|
| Policy engine outside the model: deny wins, deny by default, finance only for the finance agent and always approval-gated, typed finance parameters, risk by policy | done | `packages/policy`, checked at request (`runs.ts`), at grant and in the runner |
| Approval decisions in the card's thread (`approve <code>` / `deny <code>`), handed over by the listener only, answered in the thread | done | `listener.ts`, `core/src/services/approvals.ts`, [docs/operations/approvals.md](docs/operations/approvals.md) |
| Owner identity verification: approver snapshot and current owners, fresh account lookup (not a bot, active), no integration props, expiry by the controller's clock under the request lock | done | `approvals.ts`, `listener.ts` |
| Immutable action hashes: triggers keep the request and a tool action immutable and decisions final; the hash is recomputed at grant, by the runner and by `begin` | done | migration `0011_approval_guards`, `tool-job.ts` |
| Tool broker boundary: `apps/tool-runner` per namespace, a role limited to its queues and `gateway_begin_tool_action`, static executors, idempotency keys, `unknown` outcomes never retried | done | `packages/tool-broker`, `apps/tool-runner`, `grantToolRunnerRole` |
| One `approval.resolved` continuation per approval, exempt from loop guards, deferred by kill-all and budget holds | done | `approval-store.ts`, `routing.ts`, `waits.ts` |
| Budgets: per-agent and global daily cost and token limits, usage ledger of every attempt, gate at schedule, retry and redrive | done | `core/src/services/budgets.ts`, migration `0010_approvals_and_tool_actions` |
| Kill-all: also cancels pending approvals and queued actions, asks running ones to stop; `begin` refuses under the switch | done | `admin.ts`, `0011_approval_guards` |
| CLI: `db grant-tool-runner`, `tools list`, `budgets`, execution status in `approvals list`, tool action and budget checks in `gateway health` | done | `apps/cli/src/commands.ts` |

Acceptance (`apps/tool-runner/src/approvals.integration.test.ts` with the controller, a mock
worker and a tool runner on PostgreSQL; the Mattermost path in `mattermost-bridge.e2e.test.ts`):

- [x] The developer cannot call a finance tool: a developer run that asks for
  `finance.payment.create` fails with `deny` policy decisions and gets no approval request;
  configuration validation and the policy engine both refuse finance tools to any agent but the
  finance agent.
- [x] The finance agent still cannot execute a payment without human approval: finance writes
  can only be approval-gated; nothing runs until an owner approves, and `begin` refuses an
  action whose approval is not granted.
- [x] Forged approval text is rejected: replies from a bot, from a human who is not an owner,
  with webhook props on the owner's account, from a deactivated account, with the wrong code,
  malformed commands and plain `APPROVED` decide nothing (audited and alerted); a replayed post
  decides nothing twice; a reply after expiry is refused. Checked against a real Mattermost for
  a non-owner and a webhook on the owner's account.
- [x] A changed amount invalidates the approval: the stored request cannot be updated
  (trigger), and a job with a changed amount is refused by the runner before `begin`; only the
  approved amount is executed, once.
- [x] Kill-all prevents new runs and cancels active runs where supported, and now also
  withdraws pending approvals and queued actions; `begin` answers `kill_switch`, and a runner
  started afterwards executes nothing.

Deliberate choices in this phase ([ADR-018](docs/adr/018-approval-decisions-and-tool-broker.md),
advised by Codex astra, decided by the owner where noted):

- Decisions by a reply in the card's thread (owner's choice), not buttons or reactions.
- A separate tool runner holding the tool credentials (owner's choice).
- Daily budgets per agent and in total (owner's choice), computed from a ledger, not stored
  holds.
- No real payment or mail integration ships: sandbox executors for development, tests with
  recording executors.

Known gaps, deferred:

- A stop request aborts an executor's call only where the executor honours its abort signal;
  a provider call already made may still complete (its report counts).
- Approvals pending before migration `0010` wait on the old decision events; they end with
  their expiry. There was no deployment yet.
- Kill-all and a concurrent run report can deadlock (the report locks the agent, then the
  controls row; kill-all the other way round). Postgres aborts one: the report is retried by
  its queue, a failed kill-all is run again. Pre-existing since Phase 1.
- An approved action that begins after the controller's clock and the database clock disagree
  by minutes may be refused by `begin` (the deadline is checked by the database clock).
- Budgets admit work by reported usage; runs in flight can overshoot a limit.
- In loopback development without Mattermost there is no way to decide an approval.
- A retry deferred by the budget starts again as a new run with fresh attempts.

### Phase 7 review log

- Round 1 (Codex + Opus subagent): Codex 1 P1 + 2 P2, Opus 1 P1 + 4 P2 + 13 P3.
  - Fixed (Codex P1): a stop request (kill-all, disable) on a running action was only recorded.
    The runner now polls `gateway_tool_action_stop_requested` and aborts the executor's call.
  - Fixed (Codex P2): the executor got the job's idempotency key; `begin` now hands out the
    stored one, and a job carrying its own key is malformed.
  - Fixed (Codex P2, Opus P2): any command-shaped reply stalled the approvals channel while any
    card was undelivered. A reply waits only when its thread root is the listener bot's own
    post claiming that card's key.
  - Fixed (Opus P1): a failure that never reached the model (no usage) was booked as unmetered
    and, under `unmetered: hold`, held the agent for the day and cancelled its retry. Only a
    completed turn without usage is unmetered; usage is booked on the day it is reported (a
    retry after midnight no longer escapes today's limit); cost is capped to the column.
  - Fixed (Opus P2): `gateway tools settle` records an unknown action's outcome by hand.
  - Fixed (Opus P2): tests for the runner role's isolation (no domain tables, no other
    namespace's `begin`, no worker access), the deadline sweep (cancelled, unknown, a late
    report without a second resolution), revocation by config apply, disable, kill-all against
    a running executor, the global budget, and in e2e an edited command and a command in
    another thread.
  - Fixed (Opus P3): the sweep isolates failing approvals and expires pending requests whose
    wait is gone; withdrawn requests get a notice on the card; quoted or code-formatted
    commands are answered as malformed; forgery alerts are one per request and author; `begin`
    refuses a runner role of another namespace; a grant under the kill switch is refused;
    errors are bounded before resolution; legacy wait types still parse; lock-order and
    threat-model wording (the code is per request, not a secret; any owner credential decides).
- Round 2 (Codex + Opus subagent): Codex 1 P1 + 2 P2, Opus 0 P1/P2 (all round-1 fixes
  confirmed) + 6 P3.
  - Fixed (Codex P1): a retry held by the budget failed the run for good. It is deferred now:
    the run ends as cancelled, its events go back to the inbox, and the work runs once the hold
    lifts (integration test).
  - Fixed (Codex P2): `gateway health` failed on a database with pending migrations; the new
    checks wait for them and a missing queue is reported, not thrown.
  - Fixed (Codex P2): moving `approvals_channel` left pending requests undecidable until expiry;
    a config apply that moves it withdraws them (integration test).
  - Fixed (Opus P3): stop checks no longer pile up; a report contradicting a settled action is
    audited and alerted; a refusal names its reason (policy or kill switch) instead of always
    blaming the policy.
  - Deferred to round 3 (Opus P3): a final notice for a request that ended before its card was
    delivered. Migration `0011` changed in place during the review; it was never committed or
    deployed.
- Round 3 (Codex + Opus subagent): Codex 0 P1 + 2 P2, Opus 0 P1/P2 + 4 P3.
  - Fixed (Codex P2): a request that ended before its card was delivered left a card inviting
    a decision. Cards are posted only for pending requests, and the sweep posts the last word on
    a card that was delivered as its request ended.
  - Fixed (Codex P2): after the approvals channel moved, the withdrawal notice for an old card
    was refused; answers in a card's thread now go to the card's own channel while it is managed.
  - Fixed (Opus P3): a team change withdraws pending requests like a channel move; the pending
    withdrawal honours its agent filter; a known failure of an action cancelled before it began
    raises no conflict alert. Kept as a known gap: a deferred retry restarts with fresh
    attempts.
- Round 4 (Codex + Opus subagent): Codex 0 P1 + 2 P2, Opus 0 P1/P2 + 3 P3.
  - Fixed (Codex P2): a forged job naming a queued action under another action type could fail
    that action ("no executor") without `begin`. The runner calls `begin` first, which checks the
    job against the stored action; only then does a missing executor fail it.
  - Fixed (Codex P2): a job aborted while `begin` was pending could still start its executor;
    the runner now fails it as known before anything is sent.
  - Fixed (Opus P3): the late-notice query probes notices by their unique keys; the two-day
    window is documented.
- Round 5 (Codex + Opus subagent): Codex 0 P1 + 1 P2, Opus 0 P1/P2 + 1 P3.
  - Fixed (Codex P2): a command in a card's thread, handled by the decision path, also went
    through ordinary routing, so `approve <code> @agent` could wake an agent allowed in the
    approvals channel. Such a command is now the decision path's alone and is not ingested as a
    post (e2e test).
  - Fixed (Opus P3): stale comments about failures "before `begin`".


## Phase 8 - Observability and operational hardening

Status: **done** (review closed after round 5, the round limit: its two P2 are fixed and covered
by the operations integration test)

| Item | State | Evidence |
|------|-------|----------|
| Structured logs and redaction: real service version, headers, Google tokens, JWTs, GitHub fine-grained tokens, secret query parameters and email addresses redacted; strings, arrays and lines bounded; health details sanitized | done | `packages/logging`, `packages/service/src/health.ts` |
| Metrics: a Prometheus registry; `/metrics` on the controller (database gauges with a collection-success flag), worker, Gmail connector and tool runner; process and build gauges | done | `packages/service/src/metrics.ts`, `apps/controller/src/metrics.ts` |
| Traces: W3C trace context from an event through its runs, attempts, deliveries, the agents' posts and tool actions; `trace_id`/`span_id` in log lines | done | `packages/logging/src/trace.ts`, `ingest.ts`, `scheduler.ts`, migration `0012_traces_retention_alerts` |
| Alerts: condition episodes (fire, remind every 6 h, resolve, fire again) for Mattermost disconnects, dead letters, dead outbox items, budgets at 80%, repeated invalid output, Gmail watch expiry, stale retention and backup checks | done | `core/src/services/alerts.ts`, [docs/operations/observability.md](docs/operations/observability.md) |
| Resource limits: service pool timeouts, a turn input cap, removal of crashed workers' workspaces | done | `packages/db/src/client.ts`, `scheduler.ts`, `pruneRunWorkspaces` |
| Readiness and liveness: the worker has health endpoints (probe and subscription); the tool runner is not ready while stopping | done | `apps/worker/src/main.ts`, `apps/tool-runner/src/runner.ts` |
| Retention jobs: `organization.retention`, hourly in the controller, in batches; content removed in place, pending and FAILED work kept, approvals, tool actions and the audit log kept | done | `core/src/services/retention.ts` |
| Backup check: `gateway backup check` (manifest, age, checksum, identity, schema, archive, optional restore test), `--record` for the alert sweep, reference producer `scripts/backup-gateway-db.sh` | done | `apps/cli/src/backup.ts`, [docs/operations/backups.md](docs/operations/backups.md) |
| Security scans: Gitleaks over the history and OSV-Scanner (vulnerabilities and licenses) on push, pull request and daily; every Action pinned by SHA | done | `.github/workflows/security.yml`, `osv-scanner.toml`, [docs/operations/security-scans.md](docs/operations/security-scans.md) |
| `gateway doctor`: firing alerts and retention | done | `apps/cli/src/commands.ts` |

No acceptance criteria were set for this phase in advance. The criteria below were proposed by the
advisor (Codex astra) and are checked by tests
(`apps/controller/src/operations.integration.test.ts`, `apps/cli/src/backup.integration.test.ts`,
the unit tests of `packages/logging` and `packages/service`):

- [x] Every service exposes metrics; a failed database collection is reported as a failure,
  not as zeros.
- [x] Trace lineage holds across an event, its runs, their jobs, deliveries, the next agent's
  post and run, and the tool action of an approval.
- [x] Secret and personal-data fixtures are redacted in logs, stored errors and health details.
- [x] Retention removes old content while keeping dedupe, pending work, a FAILED agent's
  redrivable work, approvals and unknown outcomes; it runs once per interval.
- [x] Missing, stale, corrupt and truncated backups fail the check; an isolated restore passes
  its invariants and a restore into the live database is refused.
- [x] Alert conditions fire, remind, resolve and fire again; a Mattermost outage fires only
  after two minutes and survives a controller restart.
- [x] Scanners pass on the repository and fail on a seeded license violation.

Deliberate choices in this phase ([ADR-019](docs/adr/019-observability-and-retention.md),
advised by Codex astra):

- A small metrics registry instead of a client library; database gauges from the controller
  only.
- Trace-correlated logging without a span exporter.
- Retention removes content in place and keeps records (approvals, tool actions, audit log).
  Turn inputs go with run content (30 days), not after 7: the previous run's summary depends on
  its snapshot.
- Backups are verified, not made; `--record` feeds the alert sweep.
- Container hardening goes with the release images (next phase).

Known gaps, deferred:

- Container hardening (non-root, read-only rootfs, capabilities, CPU, memory and PID limits,
  networks) and per-run containment of unconfined runtimes: the release images. The earlier
  "Phase 8" references in this file for container confinement move there.
- No span export; a tracing backend can be added later on the same trace context.
- No alert route independent of Mattermost and the database; external monitoring watches the
  health endpoints and the exit codes of `gateway health` and `gateway backup check`.
- Approval requests, tool actions and the audit log grow without bound.
- Posts whose content expired are no longer part of a later turn's thread context.
- Alert conditions assume one controller per deployment: with several, each would judge the
  Mattermost outage by its own listener.

### Phase 8 review log

- Round 1 (Codex, Opus):
  - Fixed (Codex P1, Opus P1): a restore test could empty the live database when the URLs
    differed by an alias and `pg_control_system()` was closed to the role. It now proves the
    scratch database is another one with a probe table invisible through `DATABASE_URL`, and
    refuses without it.
  - Fixed (Codex P1): a `?password=` query parameter reached `pg_restore`'s command line; it
    moves to `PGPASSWORD`, and the backup script refuses it.
  - Fixed (Codex P2): retention kept every event of a FAILED agent forever; only its latest
    run's events are kept now.
  - Fixed (Codex P2): a reachable live database that could not be queried let the identity
    check pass as skipped; it fails now.
  - Fixed (Opus P2): expired events broke `gateway events show` and late wait matching (they no
    longer parse as envelopes); `events show` prints their columns, and wait matching skips
    them.
  - Fixed (Opus P2): the edits and deletions of a protected post expired before the post, so a
    turn could show a pre-edit text; they are protected with it.
  - Fixed (Opus P2): a first retention run still in progress looked like a stale one; a task
    that never succeeded counts from its first run, and reconcile ticks no longer overlap.
  - Fixed (Opus P2): `gateway_queue_oldest_job_seconds` counted jobs scheduled for later; it
    counts due jobs only.
  - Fixed (Opus P3): retention locks rows `for no key update`, so foreign key checks are not
    blocked; indexes for the invalid-output alert and the snapshot step; a Mattermost outage
    ends only after the listener stayed connected for two minutes.
  - Kept (Opus P3): protected old events are scanned again by each retention batch; they are
    few (pending work and failed runs).
- Round 2 (Codex, Opus):
  - Fixed (Opus P2): sampling the listener once a tick made every start-up and short blip look
    like a two-minute outage. A new outage needs the listener disconnected for two minutes now;
    only an outage that fired waits for two stable minutes before it resolves.
  - Fixed (Opus P2): retention inside the reconcile tick, with the overlap guard, held up
    recovery, approvals, alerts and outbox reconciliation; it has its own loop now, and `stop`
    waits for both loops' passes in flight.
  - Fixed (Codex P2): a causation id that only looked like a run id failed the ingest on the
    UUID column; only a real UUID is looked up.
  - Fixed (Codex P2): a backup with the same migration count but another latest migration
    passed the schema check; it fails now.
  - Fixed (Codex P2): the metrics collection is bounded as a whole (3 s, connection included),
    so a saturated pool still reports `gateway_metrics_collection_success 0` in time; the
    oldest-job gauge counts due retries too; overlapping scrapes read their own cache entry.
  - Fixed (Opus P3): the scratch URL may carry only `sslmode` and `password`, so node-postgres
    (the probe) and libpq (the restore) connect to the same database; other query parameters
    keep their encoding; the backup script's password match stops at the host.
  - Kept (Opus P3): email addresses are redacted in CLI error output too (privacy over
    convenience).
- Round 3 (Opus: no P1/P2):
  - Fixed (Opus P3): a reconnect between two ticks restarts the stable period of an outage;
    retention stops between batches when the controller stops; the scratch URL must name its
    host, and `pg_restore` gets no libpq target variables from the environment; an encoded
    `password` parameter name is removed too; the backup script handles an empty user and a
    literal backslash in the password; a reminder after a restart names the earlier outage start.
- Round 3 (Codex):
  - Fixed (Codex P2): a wait timeout left in a paused agent's inbox lost its thread when the
    creating run's snapshot expired; runs whose waits still have work waiting keep their
    content and snapshot.
  - Fixed (Codex P2): an item that died after a long outage lost its payload at once; dead
    payloads are counted from the last attempt.
  - Fixed (Codex P2): a timed-out metrics collection kept running while the next scrape began
    another; a collection stays shared until it settles.
- Round 4 (Opus: no P1/P2):
  - Fixed (Opus P3): the scratch URL must name its host, user and database, so neither client
    falls back to its own defaults; indexes for retention's open-wait lookups; the service pool
    has a client-side query timeout and TCP keepalive against silent partitions; the backup
    script also refuses an encoded `password` parameter name.
  - Kept (Opus P3): a run stopped between batches records a success; the rest is picked up by
    the next run.
- Round 4 (Codex):
  - Fixed (Codex P1): the restore probe could read a lagging standby behind `DATABASE_URL` and
    take "not found" as proof; it now asks in one statement whether the server answering is in
    recovery, and refuses a standby.
  - Fixed (Codex P2): a retention pass longer than the interval could be joined by a second one;
    an advisory lock is held for the whole pass.
  - Fixed (Codex P2): a migration applied during `pg_dump` left the manifest describing another
    schema; the script checks the schema again after the dump and fails.
  - Kept (Codex P2): several controllers would each judge the Mattermost outage by their own
    listener. The deployment runs one controller (known gap).
- Round 5 (Opus: no P1/P2):
  - Fixed (Opus P3): a retention lock client whose unlock failed is closed, not pooled; a
    transaction client that cannot roll back is closed too; the controller's and the Gmail
    connector's pools log a lost idle connection instead of crashing; the backup script's
    query check survives a literal backslash.
- Round 5 (Codex), the round limit:
  - Fixed (Codex P2): an item the reconcile declared dead after repeated lease expiries kept an
    old `next_attempt_at` and could lose its payload at once; dying now dates it.
  - Fixed (Codex P2): a retention pass interrupted by a stopping controller was recorded as a
    success; it is not, and it is due again at once.

## Phase 9 - GitHub release pipeline

Status: **done** (review closed after round 5, the round limit: its two P2 are fixed; no release
tagged yet)

| Item | State | Evidence |
|------|-------|----------|
| Reproducible containers: `agent-gateway` and `agent-gateway-worker-codex` from a digest-pinned `oven/bun`, a fixed Debian snapshot with exact versions, `bun.lock` without install scripts and checksummed Codex archives; timestamps from the commit; CI builds twice on independent builders and compares digests | done | `deploy/images/Dockerfile`, `scripts/release/build-images.sh`, `.github/workflows/package.yml` |
| GHCR publishing: the tested image bytes are copied with their digests unchanged; anonymous pulls are checked | done | `.github/workflows/release.yml` |
| SBOM: SPDX 2.3 from Syft per image, shipped in the bundle and attested | done | `package.yml`, `release.yml` |
| Attestations and checksums: build provenance and SBOM attestations for the images; the archive, `SHA256SUMS`, `images.lock` and `compose.yaml` attested; `verify-release.sh` checks them | done | `release.yml`, `deploy/release/bin/verify-release.sh` |
| Release bundle: the hardened Compose stack by digest, `agw`, `init-home.sh`, the seccomp profile, the example configuration with prompts, schemas, the secrets layout, the Claude Code worker recipe, SBOMs; reproducible archive | done | `deploy/release/`, `scripts/release/assemble-bundle.sh` |
| Upgrade and rollback docs: `INSTALL.md`, `UPGRADE.md`, `ROLLBACK.md`, `MIGRATIONS.md` (generated), `RELEASE_NOTES.md` (from the changelog); maintainer guide | done | `deploy/release/*.md`, [docs/operations/releases.md](docs/operations/releases.md) |
| Exact image lock: `images.lock` with every image (PostgreSQL too) by digest and the runtime pins; the stack refers to images only by digest | done | `scripts/release/write-images-lock.sh` |
| Schema rules: migration kinds, certificates written by `gateway db migrate`, the schema gate in every service and mutating CLI command, `gateway db status`; services never migrate (pg-boss `migrate: false`); the deployment lock | done | `packages/db/src/compatibility.ts`, `deployment-lock.ts`, migrations `0013`, `0014` |
| Container hardening (deferred from Phase 8): uid 10001 and a root refusal, read-only root filesystem, no capabilities, `no-new-privileges`, limits, separate networks, the worker seccomp profile for bubblewrap | done | `deploy/release/compose.yaml`, `deploy/images/seccomp/worker-sandbox.json`, `packages/service/src/startup.ts` |
| `gateway version`, `gateway db create-role` | done | `apps/cli/src/commands.ts` |

Acceptance (the install test, `scripts/release/install-test.sh`, runs in `package.yml` on a
runner without the checkout; the schema rules also in `apps/cli/src/migrate.integration.test.ts`):

- [x] A clean machine installs from the release without a source checkout: the bundle and
  the images only, following INSTALL.md (home, database, roles, configuration, Mattermost
  bootstrap), and a mention in Mattermost is answered by the agent's bot.
- [x] Release versions are reported by all services: `gateway_build_info` of every running
  service and `gateway version` carry `X.Y.Z+<commit>`; an image without a version does not
  build.
- [x] The previous release can be restored under documented schema rules: after an upgrade to
  a release with an expand migration, the previous release's stack starts again on the
  migrated database without a restore, and no mention is answered twice. A contract migration,
  a changed history, an uncertified release and an interrupted migration are refused.

Deliberate choices in this phase ([ADR-020](docs/adr/020-release-pipeline.md), advised by Codex
astra):

- One shared gateway image plus a Codex worker image; separate containers keep the secrets
  apart.
- Claude Code is built by the operator from a recipe (its license forbids redistribution);
  Grok, Kiro, OpenCode and Hermes ship no image until per-run containment exists.
- linux/amd64 and linux/arm64 (arm64 added before the first release), each built, reproduced and install-tested natively on its own runner.
- Certificates in the database instead of migration counts: an older release needs no
  knowledge of a newer one.
- Planned downtime for every upgrade, enforced by the deployment lock.
- GitHub attestations, no cosign.

Known gaps, deferred:

- The database owner is PostgreSQL's superuser in the stack; separating a non-login owner from
  the controller's runtime role needs row-level security policies for the controller.
- Worker egress to the LAN and to Mattermost's public URL is closed by host firewall rules
  (INSTALL.md), not by the stack.
- Claude Code's Bash sandbox may not start inside the container; agents without `tests.run`
  are unaffected, and `gateway runtime doctor` shows it.
- Per-run containment of the unconfined runtimes remains open; their agents cannot be released.
- No release has been tagged yet: the first `vX.Y.Z` also needs the one-time repository setup
  (immutable releases, a tag ruleset, public GHCR packages).

### Phase 9 review log

- Round 1 (Codex + Opus subagent): Codex 5 P1, Opus 1 P1 + 2 P2 + 8 P3. Fixed:
  - the install guide ran a downloaded script before verifying its provenance;
  - the configuration directory was unreadable to the CLI container, and the install test
    hid it;
  - existing worker roles could not call `gateway_schema_state()`;
  - the AppArmor profile lacked `userns` where the kernel mediates it;
  - the manifest was not formatted;
  - the Gmail connector's role;
  - the pg-boss schema version was not bound to the certificates;
  - migration times must increase;
  - SCRAM verifiers for new roles;
  - `kill-all --release` did not match its command;
  - a heartbeat on the deployment lock;
  - the install test also starts the Codex worker and the tool runner and checks that
    `db migrate` refuses under live services;
  - the upgrade and rollback steps for grants and the AppArmor profile;
  - a publish rerun replaces its own draft.
- Round 2: Codex 3 P2, Opus 1 P2 + 7 P3. Fixed:
  - an older release's migrate certified itself on a newer pg-boss schema; the manifest now
    records the build's own pg-boss schema, an integration test checks it, and every check
    requires it;
  - a half-migrated development database counted as compatible;
  - `create-role` could leave a service with a stale URL;
  - `sudo` dropped `GATEWAY_HOME`;
  - CLI session commands hold the deployment lock;
  - the install test's refusal and sandbox checks have positive controls;
  - the publish job has no persisted credentials and runs no install scripts;
  - `--latest` only for the highest release.
- Round 3: Codex 3 P2, Opus 0 P1/P2 + 6 P3. Fixed:
  - a CLI command that lost its lock carried on;
  - the password of a role in use could change;
  - a failed rename after a password change hid the working URL;
  - the upgrade's backup ran with the new CLI;
  - the rollback test skipped the grants;
  - a time-of-day-dependent alert test from Phase 8 failed after 20:00 UTC.
- Round 4: Codex 4 P2, Opus 0 P1/P2 + 5 P3. Fixed:
  - kill-all ran without the deployment lock;
  - `backup check --record` could leave its session open;
  - Gmail consent had no working path from the release (`bin/gmail-authorize.sh`, a host
    loopback callback);
  - the install test takes and verifies the pre-upgrade backup.
- Round 5: Codex 2 P2, Opus 0 P1/P2 + 3 P3. Fixed:
  - a retried `create-role` could erase the pending working URL;
  - `bin/agw` ignored an override file;
  - smaller documentation and cleanup gaps.
- Kept P3:
  - `openSession` starts a pg-boss client before `doctor` and `kill-all`, so both fail with
    pg-boss's own error on a queue schema of another version;
  - the release workflow cannot prove in advance that the repository enables immutable
    releases;
  - the Gmail connector, which needs a real Google account, is not started in the install
    test.

## Phase 10 - Home server deployment and soak (in progress)

Done so far ([ADR-021](docs/adr/021-home-server.md), [ADR-022](docs/adr/022-channel-grants.md)):

- Release images for linux/arm64 next to linux/amd64, each built, reproduced and
  install-tested natively; the first releases (0.1.0 never published, 0.1.1 published).
- The home server kit in the bundle: a Lima VM for an Apple silicon Mac, the guest setup (fixed
  LAN address, mDNS name, the egress firewall unit), the Mattermost ESR stack with Caddy TLS,
  and encrypted backups copied off the VM by a LaunchDaemon.
- On the home server: the VM starts at boot; Mattermost runs behind Caddy; the Gateway 0.1.1
  runs with one agent on Codex; the egress firewall is checked from a worker.
- Found there and fixed: the Codex worker image lacked Codex's code-mode host (no granted
  command ran); the turn prompt made models refuse commands that write files.
- Channel grants: an owner or system admin adds an agent's bot to a channel in Mattermost and
  the agent works there; any other add is refused.

Channel grants review log (5 rounds, Codex and Opus):
- Round 1: a channel taken out of the configuration became a grant through bootstrap's admin
  add; pre-add history reached turns through thread context; one failing bot stopped the poll;
  a re-add between polls was not judged.
- Round 2: the re-add check read the whole channel since the grant; bootstrap removed granted
  bots from channels leaving `mattermost.channels`; a race could turn bootstrap's add into a
  grant.
- Round 3: incomplete re-add scans kept grants (now fail closed); provider sessions could
  carry revoked channels (now ended on grant changes); the check mark lived in memory, so a
  restart revoked grants in busy channels (now stored, migration 0017).
- Round 4: an old owner's add could vouch for someone else's return (now the newest membership
  change decides); a mention right after the add in an already-followed channel was lost (now
  routed); grant changes were not serialized with scheduling; the check mark followed the
  controller's clock.
- Round 5: no P1/P2. Kept P3: a deactivated agent bot keeps its grants (it cannot post); a
  mention in a post edited before the grant was recorded is not routed.

Since then:
- 0.2.0 released and installed on the home server by upgrade from 0.1.1 (UPGRADE.md: backup,
  migrations 0015-0017, 0.1.1 still certified), the runtime doctor fully passing.
- Daily encrypted backups: the age identity kept off the server; the LaunchDaemon on the Mac.
- Restore rehearsal in a second VM: every row count matched; it found that worker roles must
  exist before the dump restore (its pg-boss policies name them).

- Failure drills on a restored copy (`scripts/soak/drills.sh`): controller and database
  restarts, Mattermost network loss, duplicates, provider failures and invalid output pass; they
  found that a worker kept running a cancelled turn until its deadline (fixed in 0.2.1).

Still to do: the 14-day soak.

## Phase 11 - The owner's console and the operator agent

Status: **done**

| Item | State | Evidence |
|------|-------|----------|
| The owner's console: a separate listener, HTTP Basic against one Argon2id hash, a bounded global failed-login counter, fixed security headers on every response, `GET /` (HTML) and `GET /api/status` (JSON), a shared collection cached for 15 s with stale/unavailable states | done | `apps/controller/src/console-server.ts`, `console-status.ts`, `console-render.ts` |
| `gateway console password set`: hidden entry, confirmed twice, control keys rejected, 12-256 characters | done | `apps/cli/src/console-commands.ts`, `packages/service/src/console-auth.ts` |
| `permissions.observe_system` and `SystemStatus` (ADR-023): operational metadata only (states, run ids, queue depths, alert keys, token/cost counts), every list bounded, never message content | done | `packages/contracts/src/agent-config.ts`, `system-status.ts` |
| Turn input version 2: `AgentTurnInput.schemaVersion` `1 \| 2`, `systemStatus` present if and only if version 2; the scheduler collects and places it only for an agent that observes the system | done | `packages/contracts/src/turn.ts`, `packages/core/src/turn-context.ts`, `services/scheduler.ts` |
| An explicit `memory.write` deny now also removes every writable memory namespace, private and shared, not only the tool call itself; a retried attempt's usage is saved too | done | `packages/core/src/turn-context.ts`, `services/runs.ts` |
| The `operator` example agent: Codex, replies only in its channels, `observe_system: true`, no other grant (`tools_allow: [mattermost.post]`, `memory.write` denied) | done | `config/examples/agents/operator.yaml`, `prompts/examples/agents/operator.md` |
| Deployment: `gateway.local` through the home server's Caddy (`local_certs`, the same authority already trusted for `mattermost.local`), a second mDNS alias, the controller bound only to its own alias on `agent-mm` (`gateway-console`), no host port, workers and connectors unable to reach it | done | `deploy/release/compose.yaml`, `deploy/home-server/mattermost/{Caddyfile,compose.yaml}`, `deploy/home-server/guest/setup-guest.sh` |
| The release-compatibility rule for rolling back past this release (config and queued-input, distinct from database certification), documented and rehearsed | done | `deploy/release/ROLLBACK.md`, [docs/operations/releases.md](docs/operations/releases.md), `scripts/release/install-test.sh` |

Acceptance:

- [x] An agent configured with `observe_system: true` receives a `SystemStatus` snapshot as its
  turn's metadata only — agent states, run ids and statuses, queue depths, alert keys and
  timestamps, token and cost counts — never message text, thread content, run summaries, wait
  conditions or memory content, and never for an agent that does not have the permission.
- [x] The console shows the same shape of state (agents, current tasks, recent runs, waits,
  queues, alerts, budgets, context measurements) without a synthesized context-window
  percentage, and marks a failed or slow collection as stale (with its last-known time) or
  unavailable rather than showing an empty, healthy-looking system.
- [x] The console is reachable only through the home server's Caddy at `https://gateway.local`:
  no host port, and no service on `agent-control` (workers, connectors, the tool runner) can
  reach the controller's console alias or hold its secret.
- [x] Enabling the console with a missing or invalid password hash refuses to start the
  controller outright, rather than starting unauthenticated or with just the console skipped.
- [x] Rolling back past this release is documented (`ROLLBACK.md`) and rehearsed by the install
  test: the operator's permission removed and its config re-applied, no queued or running
  observer run left outstanding, and the restored configuration validates and applies under the
  release being rolled back to.

Deliberate choices in this phase ([ADR-023](docs/adr/023-console-and-operator.md)):

- Server-side HTML with no client framework and no build step for a single-owner, read-only
  page: an explicit, documented exception to the shadcn-first UI rule
  (`.claude/rules/basic-rules.md`).
- HTTP Basic behind Argon2id and a global rate limit instead of session cookies: no session
  store or CSRF handling needed for a single-user, read-only page.
- `observe_system` is its own explicit, off-by-default permission rather than something every
  agent receives automatically: visibility across every agent's state and the whole queue is
  strictly more than a channel grant conveys (ADR-022).
- Turn input version 2 is refused outright by an older release rather than silently downgraded,
  so a rollback past this release must first ensure no version 2 work is outstanding — a
  release-runbook step (ROLLBACK.md), not a database migration.

Known gaps, deferred:

- The install test's rollback rehearsal exercises the documented recipe (remove the permission,
  settle outstanding work, confirm the restored configuration re-applies) against the
  same-commit bundle pair `package.yml` builds; it does not by itself prove that a genuine
  pre-ADR-023 release rejects `observe_system` or a version 2 run job — that half of the rule is
  covered by the contracts' own schema tests. Rehearsing the actual rejection needs a real
  previous release bundle passed as the test's first argument, which `package.yml` does not do.
- There is no CLI command to discard a single dead-lettered job; `gateway dlq redrive` is the
  only action besides leaving it in `gateway dlq list` (ROLLBACK.md notes this for a version 2
  payload that must not be redriven under an older release).

Released as 0.3.0 (no migration: head `0017_channel_grant_checks`, pg-boss schema 42).

## Phase 12 - Managed configuration

Status: **done**

| Item | State | Evidence |
|------|-------|----------|
| Immutable, content-addressed `config_snapshots` and an append-only `config_revisions` journal (append-only triggers), `gateway_controls.active_config_revision`; `config_versions`/`agents` kept as compatible projections | done | `packages/db/migrations/0018_config_history.sql`, `0019_config_history_guards.sql`, `packages/core/src/services/admin.ts` |
| History backfill for a database upgraded from a release without it, and after an older release changed configuration (generation drift, enabled-flag drift, enabled agents retained outside the active configuration) | done | `ensureConfigHistory` in `packages/core/src/services/admin.ts` |
| A shared prepare/commit service: typed change operations, deterministic structural diff, base-revision conflicts, idempotency keys (`0020_config_revision_idempotency.sql`), validation at the service boundary | done | `packages/core/src/services/management.ts`, `packages/contracts/src/management.ts` |
| `gateway config export\|diff\|import\|history\|rollback\|ack`; `agents enable\|disable` through the shared path; `config apply` kept as a deprecated alias | done | `apps/cli/src/config-commands.ts`, `apps/cli/src/config-files.ts` |
| Drift reporting: a structured warning, the `config:backfill` alert and a `doctor` check, cleared by acknowledgement (`0021_config_revision_acks.sql`) or a newer revision | done | `packages/core/src/services/alerts.ts`, `apps/cli/src/commands.ts` |
| Restore verification of configuration history, gated on the backup's own schema | done | `apps/cli/src/backup.ts` |

Acceptance:

- [x] Applying configuration records a snapshot and a revision in the same transaction as the
  projections; identical content reuses its snapshot under a new revision.
- [x] An export re-imports to the same snapshot hash as a no-op; two exports of one revision are
  byte-for-byte identical.
- [x] Import paths are confined: symlinks, `..`, special files and oversized files are refused
  before they are read, and an export's manifest must match its file set exactly.
- [x] Rolling back to 0.3.0 needs no database step: it reads the projections unchanged, and its
  changes are recorded and reported on re-upgrade (`deploy/release/ROLLBACK.md`).

Deliberate choices in this phase ([ADR-024](docs/adr/024-managed-configuration.md)):

- Snapshots are content-addressed and revisions are separate rows, so returning to earlier
  content is a new revision, never a pointer reset.
- The projections are what runs: a backfill records them as they are rather than preferring a
  stale snapshot.
- `config export` writes only into a new or empty directory; replacing an earlier export is left
  to the operator.

Released as 0.4.0 (migrations `0018_config_history` to `0021_config_revision_acks`, all expand; head `0021_config_revision_acks`, pg-boss schema 42).

## Phase 13 - Authenticated management console and agent editor

Status: **done**

### Session authentication and mutation protections

Status: **done**

| Item | State | Evidence |
|------|-------|----------|
| `console_sessions`: hashed token, `password_hash_fingerprint`, sliding 30-minute idle timeout (touched at most once a minute), 12-hour absolute expiry, a 20-session active cap evicting the oldest; the CSRF token is derived from the session token on every check, never stored (`csrf_token_hash` kept, nullable, unused) | done | `packages/db/migrations/0022_console_sessions.sql`, `0023_console_csrf_derived.sql`, `packages/core/src/services/console-sessions.ts`, `apps/controller/src/console-auth.ts` |
| `POST/GET/DELETE /api/session`; every other `/api/*` route needs a valid session, every mutation needs the exact `CONSOLE_ORIGIN` and a matching CSRF header; HTTP Basic removed | done | `apps/controller/src/console-server.ts`, `console-auth.ts` |
| `CONSOLE_ORIGIN` setting, validated at start alongside the password hash | done | `apps/controller/src/main.ts`, `deploy/release/compose.yaml`, `deploy/release/gateway.env.example` |
| `gateway console password set` revokes every active session directly when it can reach the database, on top of the fingerprint check that invalidates them on the next controller restart regardless | done | `apps/cli/src/commands.ts`, `packages/service/src/console-auth.ts` |
| Expired/revoked session cleanup hooked into the existing retention pass | done | `packages/core/src/services/retention.ts` |

Acceptance:

- [x] Login always mints a fresh session; a client-supplied cookie is never consulted (session
  fixation is not possible).
- [x] Idle timeout, absolute expiry, logout and a password rotation each invalidate a session;
  verified against an injected clock, not real sleeps.
- [x] A missing or foreign `Origin`, `Sec-Fetch-Site: cross-site`, and a missing, wrong or
  cross-session CSRF token are each refused on login and/or on a mutation as appropriate.
- [x] An unauthenticated `/api/status` returns `401`; no password, token or cookie value appears
  in a log line or an error body.

Deliberate choices here ([ADR-025](docs/adr/025-management-console.md)):

- The CSRF token is derived from the session's own raw token and a controller-held key
  (`GATEWAY_ROUTING_KEY`, reused under its own HMAC label), never stored: there is nothing to
  rotate, so a second tab's own `GET /api/session` never invalidates the first tab's copy — the
  problem the original rotating, hash-stored design had.
- Session validation and `Origin`/CSRF checks never consult `X-Forwarded-*`: only the connection
  Caddy actually made to the listener counts.

### The React console (SPA), replacing the server-rendered page

Status: **done**

| Item | State | Evidence |
|------|-------|----------|
| `apps/console` (bun workspace): React 19, TypeScript, Vite, Tailwind CSS v4, shadcn/ui (`style: radix-nova`); `components.json` checked in | done | `apps/console/package.json`, `apps/console/components.json` |
| Shared response types: `ConsoleStatus`/`ConsoleSnapshot` and everything under them are now Zod schemas in `@agent-gateway/contracts`, re-exported from `@agent-gateway/core`; the console parses every response against them at the fetch boundary | done | `packages/contracts/src/console-status.ts`, `apps/console/src/lib/api-client.ts` |
| Pages: sign-in (JSON `POST /api/session`, CSRF token held in memory, recovered via `GET /api/session` on reload), overview (every section the old page showed, polling `/api/status` every 15 s via TanStack Query), the Agents hub (below), placeholders for Skills/Instruments & utils, sign-out | done | `apps/console/src/routes/` |
| A typed API client adding `X-CSRF-Token` on mutations, same-origin credentials, and turning a `401` into the one error kind the session layer reacts to; `403`/`409` surfaced as their own distinct, typed outcomes | done | `apps/console/src/lib/api-client.ts`, `apps/console/src/lib/session-context.tsx` |
| `bun run console:build` (`vite build`, hashed assets, no source maps, no inline script); `bun run console:dev` (Vite dev server, proxying `/api/*` to a running controller) | done | `apps/console/vite.config.ts`, root `package.json` |
| The console's own `tsc` project (`apps/console/tsconfig.app.json`/`tsconfig.node.json`, DOM lib + JSX + the `@/*` alias), checked separately from the backend's (`tsc -b apps/console`, since a browser program and `@types/bun`'s globals do not mix in one `tsc` invocation); Biome lints and formats it, with Tailwind v4's CSS syntax enabled in the CSS parser | done | `tsconfig.json`, `package.json`'s `fix`/`check`/`typecheck` scripts, `biome.json` |
| Vitest unit tests for the console (React Testing Library + happy-dom) in the existing `unit` project | done | `apps/console/src/**/*.test.tsx` |
| The controller serves the built assets (`/assets/*` immutable-cached, any other non-`/api/*` path as the SPA fallback), path-traversal- and symlink-safe, missing-build-tolerant (plain 503 for the UI, `/api/*` unaffected); the server-rendered dashboard, its stand-in sign-in form, and `console-render.ts` are removed | done | `apps/controller/src/console-static.ts`, `console-server.ts` |
| A strict CSP with no inline script anywhere and no `unsafe-eval` (`style-src-elem` alone allows `unsafe-inline`, narrowly, for Radix's own scroll-lock `<style>` element), verified against the real built app in a browser | done | `apps/controller/src/console-http.ts`, ADR-025 |
| The release image builds the console in its own Docker stage (dev dependencies included) and copies only the built static output into the runtime image; the production install stays dependency-free of it | done | `deploy/images/Dockerfile` |

Acceptance:

- [x] `bun run console:build` produces hashed, source-map-free assets with no inline script in
  `index.html`.
- [x] The overview page renders every section (agent states, tasks, waits, context measurements,
  recent runs, queues, alerts, budgets, footer) from a fixture status payload, including the
  stale and unavailable snapshot states.
- [x] Sign-in (success, wrong password, rate-limited) and the CSRF header on mutations are
  covered by component tests against a mocked `fetch`; a `401` on the status poll flips the
  session to signed-out.
- [x] The controller refuses path traversal and a symlink escaping the static root, serves
  `/assets/*` immutably cached and every other non-`/api/*` path as the SPA fallback, never
  falls back to HTML for an unknown `/api/*` path, and serves a plain 503 for the UI (API
  intact) when the build is missing.
- [x] Loaded in a real browser: signs in, shows the overview, signs out, with zero CSP
  violations reported.
- [x] `osv-scanner` reports no license outside the allowlist and no unexempted vulnerability
  across every new dependency.

Deliberate choices here ([ADR-025](docs/adr/025-management-console.md)):

- React Router over TanStack Router: four top-level pages do not need file-based route
  generation; the controller's own SPA fallback is what makes every deep link work regardless.
- TanStack Query for the status poll specifically (its stale/error/pending state and
  `refetchInterval` are exactly what that one endpoint needs), a small typed fetch wrapper
  underneath it for everything else (same-origin credentials, the CSRF header, shared-schema
  parsing) — not Query for every call.
- The console's own `tsc` program is checked separately from the backend's rather than widening
  the backend's `lib`/`types` to include the DOM and Vite's ambient types, which would risk
  colliding with `@types/bun`'s own globals across the entire rest of the monorepo.
- Radix UI's inline `element.style` calls are CSSOM manipulation, not an HTML `style` attribute
  or a `<style>` element, so `style-src`/`style-src-attr` needed no loosening; Radix's scroll
  lock (every modal popover: `Dialog`, `AlertDialog`, `Select`) genuinely does insert a `<style>`
  element, so `style-src-elem` alone gets `'unsafe-inline'` — confirmed by a real CSP violation
  before this directive was added, and its absence after, not assumed either way.

### The Agents hub: viewing and editing existing agents

Status: **done** (creating and deleting an agent, and the Skills/Instruments & utils hubs, remain)

| Item | State | Evidence |
|------|-------|----------|
| Management API: `GET /api/agents`/`GET /api/agents/:id` (read models over the active snapshot), `POST /api/agents/:id/preview`/`commit` (a bounded `AgentPatch` DTO translated into `update_agent`/`set_role_prompt`/`set_agent_enabled` change operations), `GET /api/config/revisions`/`GET /api/config/revisions/:id/diff` | done | `packages/contracts/src/console-management.ts`, `packages/core/src/services/console-management.ts`, `apps/controller/src/console-management.ts` |
| `commit`'s outcomes: `200` (including an idempotency-key replay), `409` with the current revision id on a stale base, `422` with problems for anything invalid (caught at preview time or only at commit time, e.g. a run-in-progress disable protection) | done | `packages/core/src/services/console-management.ts` |
| Every console commit carries `source: "console"`, `actor: "console:owner"` — distinguishable in `gateway config history` with no change to that command | done | `apps/cli/src/config-commands.ts` (unchanged), `packages/core/src/services/console-management.ts` |
| The Agents list page (table: state, runtime/model, channel count, last run) and the agent editor (`/agents/:id`: Overview, Instructions, Runtime, Assignments, Permissions, History tabs) | done | `apps/console/src/routes/agents-list-page.tsx`, `agent-detail-page.tsx`, `agent-detail/*.tsx` |
| Save flow: a local draft (dirty fields only), a "Review changes" dialog showing the server's diff and an "impact" list requiring explicit confirmation before applying, a fresh idempotency key per apply, 409/422 handled with a reload-and-rebase or inline problems respectively | done | `apps/console/src/routes/agent-detail/review-dialog.tsx`, `rebase-draft.ts` |
| New shadcn/ui components (table, tabs, select, switch, dialog, alert-dialog, sonner, scroll-area, textarea already or newly present) and a small app-level tag-list input for tool patterns and channels | done | `apps/console/src/components/ui/*.tsx`, `apps/console/src/components/tag-list-input.tsx` |
| The Agents hub's two page components are code-split (`React.lazy`), loaded only once opened | done | `apps/console/src/App.tsx` |

Acceptance:

- [x] Listing, showing, previewing and committing an agent change are covered by a controller
  integration test against a real PostgreSQL, including a stale base refused at preview time and
  at commit time alike (`409`), the full scenario of a load followed by a `commitChange` (as a
  CLI apply would make it) to the same agent leaving nothing overwritten, two concurrent edits
  (the second gets `409`), an idempotency-key replay (including one retried after an unrelated,
  intervening change to the same agent), clearing `runtime.model` back to its default, a retained
  agent whose own configuration no longer validates falling back to `remove_agent` in both preview
  and commit, that same agent excluded from the list, invalid bodies (an unknown field, an
  oversized role prompt, a protected field) at `400`, unauthenticated/missing-CSRF/foreign-Origin
  at `401`/`403`, and a disable of a running agent surfacing its protection error at `422`.
- [x] A committed role-prompt change is visible in the `agents` projection immediately (the same
  column the scheduler's turn context reads from).
- [x] Console component tests cover the save flow end to end against a mocked `fetch`: editing
  the role prompt, the preview dialog showing its diff, applying with the editor's own loaded base
  revision (never one read back from the preview response) and a fresh idempotency key, the 409
  and 422 paths, and the unsaved-changes guard (a confirm dialog on the page's own "back to
  Agents" action; `beforeunload` for the tab itself — this app's router is a plain declarative
  one, not a data router, so a blanket `useBlocker` is not available).
- [x] Loaded in a real browser: sign in, open an agent, edit the role prompt, review and apply
  the change, see the new revision in its History tab, zero CSP violations.

Deliberate choices here ([ADR-025](docs/adr/025-management-console.md)):

- The patch DTO exposes only the fields the editor's tabs offer (display name, enabled, role
  prompt, runtime, wake rules, allowed channels, the three tool lists, `observe_system`) — never
  the whole `AgentConfig` shape, and never the Mattermost identity, memory or concurrency, which
  have no tab yet.
- Preview and commit both require the request's `baseRevisionId` to equal the revision actually
  active right now — the editor's own loaded view — refusing a mismatch with `409` and the
  current revision id rather than computing a plan or a diff against the live state as if the
  stale view were still current. Preview builds its plan from the agent's current live definition
  once that equality is confirmed (matching `prepareChange`'s own always-against-the-live-revision
  contract); commit instead builds it from the snapshot `baseRevisionId` itself names — immutable
  and content-addressed, so a retry under the same idempotency key (the same `baseRevisionId`, the
  same patch) always recomputes the identical change set regardless of what the live configuration
  has become since, which is what lets `commitChange`'s own idempotency check replay it correctly
  instead of seeing "the same key, a different change set" purely because an unrelated field had
  moved on.
- An agent's History tab scans the most recent 20 revisions for ones that touched it (one diff
  fetch per revision) rather than adding a per-agent history endpoint; older history stays
  reachable through `gateway config history`/`diff`.
- The Agents hub's list reads the active configuration snapshot, the same source
  `consoleShowAgent` reads a single agent's detail from, rather than the `agents` projection table
  directly: a row retained, disabled, outside the active snapshot (the disable-with-fallback-to-
  `remove_agent` path below) is consistently absent from both, instead of listed but 404ing when
  opened.
- `react-hook-form`/shadcn's `form` component was not added: every tab is a handful of plain
  controlled inputs, not a multi-field validated form, so the lighter existing pattern (plain
  `useState`, the same the sign-in page already uses) fit better than a new dependency.

Released as 0.5.0 (migrations `0022_console_sessions` and `0023_console_csrf_derived`, both expand; head `0023_console_csrf_derived`, pg-boss schema 42).

## Phase 14 - Agent lifecycle: creation, assignment and retirement

Status: **done** (review closed after round 5, the round limit; its findings and those of a final
review of the fix commit are fixed and covered by tests)

| Item | State | Evidence |
|------|-------|----------|
| `secrets/controller-bots` (mode 0700, owner 10001), mounted read-write into the controller at `/run/bot-secrets`, distinct from the read-only `/run/secrets`; `SecretFileSchema` accepts both mounts | done | `deploy/release/bin/init-home.sh`, `deploy/release/compose.yaml`, `packages/contracts/src/common.ts` |
| `MATTERMOST_ADMIN_TOKEN_FILE` read from the controller's existing read-only secrets mount; the lifecycle provisioner stays idle with none configured, surfaced by `gateway doctor`'s `mattermost_provisioning` check rather than failing anything | done | `deploy/release/compose.yaml`, `apps/controller/src/agent-provisioner.ts`, `apps/cli/src/commands.ts` |
| A create request's `mattermost.token_secret_file` is optional; left unset, `requestAgentCreate` generates `/run/bot-secrets/mm_<id>_token` itself — never a path a client chooses | done | `packages/contracts/src/agent-lifecycle.ts`, `packages/core/src/services/agent-lifecycle.ts` (`defaultBotSecretFile`) |
| The provisioner: a controller loop alongside `reconcile`/`retain` that takes `pending`/`running` `create`/`restore`/`reprovision` operations and drives each one's steps (resolve or create the bot by username, issue and write its token, add it to the team and its configured channels, record its account), checkpointing after every external step and never holding a transaction across a Mattermost call; resumes `running` operations from their checkpoint after a restart | done | `apps/controller/src/agent-provisioner.ts`, `checkpointOperation`/`listPendingLifecycleOperations` in `packages/core/src/services/agent-lifecycle.ts` |
| Failure classification: a username taken by an account that is not plausibly the Gateway's own, or a rejected/insufficient admin token, fail the operation (`failOperation`, redacted); anything else is retried on the next pass; a lost token response is recovered by revoking every token the bot has that is not the one in its file and issuing a fresh one | done | `apps/controller/src/agent-provisioner.ts` |
| The provisioning admin account is resolved from its own token (`users/me`) every pass and excluded from routing exactly like the listener bot: a post by it never wakes an agent | done | `packages/core/src/services/store.ts` (`PROVISIONING_ADMIN_DIRECTORY_NAME`), `packages/mattermost/src/normalize.ts` (`admin_post` skip reason) |
| `gateway mattermost admin-token set` (hidden entry, validates `users/me`: non-bot, `system_admin`) and `admin-token rotate` (create-verify-switch-revoke: a new token for the same account, verified, switched, then every other Gateway-tagged token on the account revoked, never an unrelated one; `set` converts the pasted token into a Gateway-tagged one; both run under the shared Mattermost credential lock) | done | `apps/cli/src/mattermost-commands.ts`, `packages/mattermost/src/client.ts` (`createUserAccessToken` now returns its id too) |
| `gateway agents create <id> --display-name ... --role-prompt-file ... [--channel ...] [--runtime ...] [--model ...]` (a thin wrapper over `requestAgentCreate`) and `gateway agents operations [--agent <id>]` | done | `apps/cli/src/commands.ts` |
| `gateway mattermost bootstrap` unchanged; an agent it created keeps its own `/run/secrets/...` token path | done | `apps/cli/src/mattermost-commands.ts` (unchanged) |
| Retirement cleanup: an active run cancelled, waits cancelled, approvals/tool actions withdrawn (card updated), every channel grant tombstoned, pending outbox deliveries blocked (`cancelled` status), all in the same transaction as `remove_agent`; the finance agent refused without `reassignFinanceTo` | done | `packages/core/src/services/agent-lifecycle.ts` (`requestAgentRetire`), `packages/core/src/services/channel-grants.ts` (`revokeAllActiveGrantsIn`), `packages/db/migrations/0026_outbox_cancelled_status.sql` |
| Late run/tool reports for a `retiring`/`retired` agent publish no effect, dropped with an audit entry | done | `packages/core/src/services/runs.ts` (`handleRunReport`), `packages/core/src/services/approvals.ts` (`handleToolReport`) |
| Private memory excluded from `gateway memory list`; shared memory the agent wrote stays | done | `packages/core/src/services/memory.ts` (`retiredPrivateNamespaces`) |
| The provisioner executes `retire`: every token revoked, the bot deactivated, every channel left, a lifecycle-created agent's own token file removed (never a bootstrap-managed one); `restore` reuses `create`'s own steps unchanged (`ensureBot` already re-enables a disabled bot) | done | `apps/controller/src/agent-provisioner.ts` (`processRetireOperation`) |
| Assignments read model (`configured`/`granted` provenance) and `gateway agents channels <id>` / `gateway agents revoke-grant <id> <channel>` / `gateway agents retire <id>` / `gateway agents restore <id>` | done | `packages/core/src/services/channel-grants.ts` (`loadAgentChannelAssignments`, `revokeChannelGrant`), `apps/cli/src/commands.ts` |
| `config apply`'s whole-bundle replace runs the same `/run/bot-secrets/` ownership check and `reprovision` queuing a managed-configuration commit already did | done | `packages/core/src/services/admin.ts` (`applyConfig`) |
| Queuing a `reprovision` locks affected agents' lifecycle rows before the `agents` table (matching `completeOperation`'s own order); a config edit during a running `reprovision` cancels it and queues a fresh one; the leaving-channels step re-checks grants immediately before each removal | done | `packages/core/src/services/management.ts` (`queueMembershipReprovisioning`, `lockLifecycleRows`), `apps/controller/src/agent-provisioner.ts` |
| `requestOperationRetry`: refused unless an agent's current operation is actually `failed`; queues a fresh operation of the same kind, carrying its checkpoints forward, never resurrecting the terminal row (the journal stays append-only); the agent returns to `pending` (or stays `retiring`, for a retried retire). `gateway agents retry <id>` is its CLI surface | done | `packages/core/src/services/agent-lifecycle.ts` (`requestOperationRetry`), `apps/cli/src/commands.ts` |
| Console management routes for the full lifecycle: `POST /api/agents` (create), `POST /api/agents/:id/{retry,retire,restore}`, `GET /api/agents/:id/lifecycle`, `GET /api/agents/:id/channels`, `POST /api/agents/:id/channels/revoke` — the same session/CSRF/exact-Origin protection and idempotency-key convention `preview`/`commit` already use; `AdminError`/`ManagementConflictError` map to `422`/`409` the same way | done | `apps/controller/src/console-management.ts`, `packages/core/src/services/console-management.ts`, `packages/contracts/src/console-management.ts` |
| Console UI: a "New agent" dialog (id, display name, channels, role prompt, a runtime adapter/model picker restricted to adapters with a ready worker); a lifecycle status badge and live progress (polled checkpoints) on the agent page; Retry next to an actionable failure message; a Retire confirmation requiring a finance reassignment when applicable and warning (not blocking) for a system-flagged agent; Restore for a retired agent (which stays listed, filterable, specifically so Restore is reachable, falling back to a read-only lifecycle view since it has no editable configuration); a channel assignments view (configured/granted, with provenance) with a Revoke action | done | `apps/console/src/routes/agents-list-page.tsx`, `apps/console/src/routes/agents-list/new-agent-dialog.tsx`, `apps/console/src/routes/agent-detail/{lifecycle-panel,retire-dialog,retired-agent-view,channel-assignments}.tsx` |

Acceptance:

- [x] Each provisioning step is idempotent and checkpointed; a fake-client unit suite covers
  resuming after a failure following each step without duplicating work, a lost token response
  (the old token revoked, a new one written), a username taken by a non-Gateway account (permanent
  failure), no admin token configured (idle, surfaced by doctor), and that no secret ever reaches
  a log or a stored error (the existing redaction helpers).
- [x] Retiring an agent and completing one of its operations concurrently, many times over, never
  deadlocks (Postgres 40P01): `lockCurrentOperation` locks the agent's lifecycle row before its
  operation row, the same order `requestAgentRetire` already took.
- [x] Against a real, dev Mattermost 11.7 server: `requestAgentCreate` through to a `ready`
  agent — the provisioner creates its bot, token and memberships without any bootstrap run — and a
  mention in a channel wakes it (mock runtime), its reply posted by the newly created bot.
  `admin-token rotate` leaves the old token rejected and the new one working.
- [x] CLI integration coverage of `agents create`/`agents operations`, and `admin-token set`
  refusing a bot token or a non-admin account.
- [x] Retiring an agent mid-queue, mid-run, with a pending wait, a pending approval and a pending
  outbox item each cancels or blocks its own kind, auditing every one; a late run report after
  retire publishes nothing; the finance agent's retirement is refused without `reassignFinanceTo`
  and succeeds with it; a grant revoked on retire stays revoked even after the bot is re-added to
  the channel.
- [x] Against a real, dev Mattermost server: create through to `ready`, then retire — the bot is
  deactivated, removed from its channels, its token rejected by the server; restore brings it back
  to working.
- [x] A fake-client provisioner suite covers `retire`'s own steps resuming from each checkpoint,
  and a permanent failure leaving the agent `retiring` with `last_error`.
- [x] A concurrent config edit and a running `reprovision` operation never deadlock and never lose
  the edit: the edit either rides an operation still `pending`, or cancels one already `running` and
  queues a fresh one that reads the edited configuration.
- [x] Core integration coverage of `requestOperationRetry`: retry after a failed create completes
  (reaching `ready`); retry of a failed retire completes (reaching `retired`, agent stays
  `retiring` throughout); retry carries a failed operation's own checkpoints forward; refused for
  an agent whose current operation is not actually failed, or with no lifecycle record at all; a
  repeat with the same idempotency key replays rather than queuing a second operation.
- [x] Controller integration coverage of every new console route: auth required (`401`), CSRF and
  exact-Origin required on every mutation (`403`), `422` for a business-rule refusal (a duplicate
  create id, retiring the finance agent without reassigning it, restoring/retrying an agent not in
  the right state), an idempotent replay of create and of retire, and a secret-looking failure
  message never reaching the lifecycle route's JSON body.
- [x] Console unit coverage: the "New agent" dialog's own validation (id format, required fields)
  and submission; the lifecycle panel's progress rendering from `pending`/`failed` operation
  states and its Retry action; the retire dialog's required finance reassignment and its
  non-blocking system-agent warning.
- [x] Against a real, dev Mattermost server, through the console's own HTTP routes (no manual
  YAML/bootstrap/reconcile): signing in, creating an agent, through to `ready`; a mention wakes it
  and its own newly created bot replies; retiring it deactivates the bot. A separately simulated
  permanent failure retried through the console's own retry route completes against the real
  server.

Deliberate choices here ([ADR-026](docs/adr/026-agent-lifecycle.md)):

- The provisioner reuses `ensureBot`'s existing semantics (refuse a non-bot account or one with
  elevated roles) rather than tracking "which bot did the Gateway itself create": Mattermost's API
  gives no way to ask a bot account who made it, and a lifecycle-created agent's username is
  already reserved in the Gateway's own database before any Mattermost call happens, so a plain bot
  already there under that exact name is, in practice, the provisioner's own earlier attempt.
- Team and channel resolution is not duplicated here: `allowed_channels` is already validated as a
  subset of `organization.mattermost.channels`, so the provisioner only reads the directory entries
  bootstrap (or an earlier provisioner pass) already resolved, waiting rather than failing when one
  is not there yet.
- A retry queues a fresh operation rather than resetting the failed row in place: the operation
  journal's own append-only guard (migration 0025) only ever lets `state` move forward, so a
  terminal row can never become `pending` again — the same reason a superseded `create`/`restore`
  is cancelled and replaced rather than rewound.
- `secrets/controller-bots` needs no change to `backup.sh`/`restore.sh`: both already archive and
  restore the whole of `$GATEWAY_HOME` (minus `backups/` itself), so the new directory is included
  and restored automatically, the same as every other secrets directory.
- Retirement's channel-removal order follows `bootstrapMattermost`'s own retirement of a replaced
  bot: tokens revoked and the bot deactivated *before* any channel is left, so a crash partway
  through the (purely cosmetic, from that point on) channel list leaves no working access behind.
- Restore needed no new provisioner code at all: `create`/`restore` already share one path through
  the provisioner, and `ensureBot` already re-enabled a disabled bot it finds by username before
  this phase: a restored agent is, to that function, indistinguishable from an existing bot
  bootstrap would adopt.
- The assignments read model's third provenance, `member-unauthorized`, is live-only (what
  Mattermost itself currently reports) and so is not part of `loadAgentChannelAssignments`, which
  reads only the database, or of the console's own `GET /api/agents/:id/channels`: a live check
  against Mattermost itself is `gateway mattermost reconcile`'s own job, not this read model's.
- `gateway agents revoke-grant` queues a `reprovision` for a lifecycle-owned, `ready` agent so the
  bot's removal does not wait for an unrelated configuration change; a bootstrap-managed agent has
  no such operation, and is left to the membership synchronizer's own next pass (seconds away),
  which already removes a bot from a channel it has neither a grant nor a configuration entry for.

Not yet released; see the Changelog's `[Unreleased]` section.

### Phase 14 review log

- Per-change reviews (Codex) while building: retirement cleanup (1 P1 + 2 P2: bot identity
  recovery, restore of bootstrap-managed tokens, retention of cancelled deliveries) and the
  console lifecycle (4 P2: polling, retired view, retry replay, finance choices) — fixed.
- Round 1 (Codex + Opus subagent): Codex 1 P1 + 5 P2, Opus 2 P2 + 5 P3. Fixed: channel edits
  during provisioning, team changes, restoring a former finance agent, failed reprovisions
  stopping an agent, config writes dropping lifecycle agents, doctor and audit noise, adopting a
  foreign bot, rotation revoking unrelated tokens.
- Round 2: Codex 1 P1 + 4 P2, Opus 3 P2 + 3 P3. Fixed: retire recovery touching a foreign bot,
  a completion fence for configuration changes, permission-preserving restore, failed
  reprovisions visible in the console and doctor, tagged admin tokens, retry provenance
  (migration `0027_lifecycle_retry_of`).
- Round 3: Codex 2 P1 + 2 P2, Opus 3 P2 + 3 P3. Fixed: membership now converges from live
  Mattermost state every pass (teams and channels), elevated membership roles demoted, retired
  agents cannot be re-added outside restore, bounded checkpoints, earlier admin owners.
- Round 4: Codex 1 P1 + 5 P2, Opus 5 P3. Fixed: cross-process provisioning and admin-token
  locks, bootstrap leaving lifecycle retirees alone, immutable lifecycle token paths, admin
  history on create resume, checkpoint bounds, shared config guards, a team-leave e2e test.
- Round 5: Codex 1 P1 + 2 P2, Opus 1 P2 + 2 P3. Fixed: one lock for every Mattermost credential
  writer (provisioner, bootstrap, admin-token), the token read under it, a 401 after a token
  swap retried rather than failed, lifecycle refreshed after a revoke.
- Final review of the fix commit: 2 P2 (bootstrap's token read under the lock, a connection whose
  credential unlock failed is discarded) — fixed.
