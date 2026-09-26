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
  (migrations arrive in Phase 1; scans before Phase 9).
- GitHub Actions are pinned by tag, not by commit SHA. Pin by SHA before the first release.

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
- [ ] Typed parameter sets per financial action (Phase 7).
- [ ] Phase 4: verify each provider actually accepts `agent-turn-model-output.schema.json` (the
  linter only checks the documented subset locally).
- [ ] Phase 7: the approval card renders parameters in a code block (so Markdown in values is
  inert), separate from the summary, and flags mixed-script values (homoglyphs are a rendering
  concern, not a contract one).

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
  an approval request expires and resumes the agent with a timeout.
- `/metrics` is served but empty; metrics come with observability work.
- Provider sessions are stored when returned but not resumed yet (`continueTurn` unused).
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
