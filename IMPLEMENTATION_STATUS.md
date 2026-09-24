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

- Clamp `WaitCondition.timeoutAt` into `(now, now + policy max]` and check that `correlationId`
  belongs to the run's thread or business process.
- Build `TurnAuthorityContext` for every run and reject results with authority issues.
- Resolve prompt files inside the config root and refuse symlinks that leave it.
- JSON canonicalization for `immutableActionHash`; typed parameter sets per financial action.
- Transactional enqueue through Drizzle `db.transaction(...)`: the smoke test covers a raw
  `pg` client transaction only.
- Check `WaitCondition.expectedSenderUserIds` and `PublicMessage.rootPostId` against the
  run's thread participants (part of the correlation ownership check).
- Phase 4: verify each provider actually accepts `agent-turn-model-output.schema.json` (the
  linter only checks the documented subset locally).
- Phase 7: the approval card renders parameters in a code block (so Markdown in values is
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

Status: not started
