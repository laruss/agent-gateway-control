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
- [ ] Check `WaitCondition.expectedSenderUserIds` against the thread participants (needs thread
  context, Phase 3).
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
`events replay`, `runtime doctor`, `mattermost bootstrap|reconcile`, `backup check`.

Known gaps, deferred:

- Outbox delivery is `dry-run` or `loopback` (explicit, refused in production); real Mattermost
  posting is Phase 2.
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
- Context assembly is minimal: no thread context, memories or workspace (Phase 3). Memory
  proposals are stored as `proposed` and not reviewed yet.
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
| 13 (Codex only) | 0 / 0 | - | closed |
