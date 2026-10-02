# ADR-027. Tool catalog: entries, immutable versions, attachments and legacy conversion

- Status: Accepted
- Date: 2026-10-02

## Context

An agent's `permissions` (`tools_allow`/`tools_require_human_approval`/`tools_deny`, bare tool
names or `prefix.*` wildcards) are the only record today of what it may use, hand-authored in YAML
and enforced unchanged by `packages/policy`. There is no catalog of what the Gateway can actually
offer — a runtime's own built-in tools, a capability the Gateway itself performs, a tool-broker
executor action — no record of which capabilities are real in this release versus aspirational,
and no per-agent, richer binding (a pinned version, free-form settings) a bare permission string
cannot express. An owner who wants to see "everything an agent could be given, and what it already
has" today has only three flat string lists per agent, with no shared inventory behind them and no
way to edit one capability's own description, risk posture or configuration once for every agent
that holds it.

This decision gives the catalog a durable data model: entries, their immutable version history,
the availability a listing of them computes (never stores), and agents' attachments to them — the
Instruments & Utils hub's "what exists" and "who has it", not yet "what runs" or "what a console
shows". No UI reads any of this yet, and `custom_https` (an owner's own HTTPS-backed tool) is
reserved as a `kind` with no definition — both are later work this decision anticipates and
prepares storage for, the same way ADR-026 anticipated automated Mattermost provisioning without
performing it.

The data model alone made no change to tool enforcement, deliberately (see "Alternatives" below):
attaching, detaching or editing an attachment was pure bookkeeping until "Effective permissions:
compiled attachments as the single source of truth" below, which completes the work this decision
anticipated — an agent's attachments now decide what it may actually do.

## Decision

### Entries, kinds and immutable versions

A catalog entry (`catalog_entries`) has a stable, never-reused id, an immutable `kind` — `native`
(a runtime's own built-in tool: reading or writing the run workspace, running commands, web
search/fetch — `packages/runtime-sdk`'s `NativeTool`s), `gateway` (a capability the Gateway itself
performs, never a runtime or the tool broker: posting to Mattermost, writing memory),
`executor` (a tool-broker action backed by a registered executor), or `custom_https` (reserved,
undefined this release) — and an immutable `implementationKey` naming the concrete capability
behind it (a `ToolName` such as `repository.read`, `mattermost.post` or
`finance.payment.create`). `isBuiltin` marks an entry this release itself ships, never editable
and governing what `ensureToolCatalogSeeded`/deletion do (below).

An entry never stores its own content directly: it points at its `currentVersionId`, a row in the
append-only `catalog_entry_versions` (migration `0029` guards it exactly like `config_snapshots` —
no UPDATE, DELETE or TRUNCATE ever succeeds; unlike `agent_lifecycle_operations`'s guard, no column
is allowed to change in place at all, since a version has no in-flight state to progress through).
A version carries `name`/`description` (metadata), a bounded `configSchema` (a JSON Schema for an
attachment's own `settings` — structurally bounded only this release; nothing compiles or enforces
it yet, see Consequences), `riskFloor` (`allow` or `require_approval`: the minimum attachment mode
the entry may be given — `require_approval` refuses a bare `allow`, `disabled` is never refused,
an attachment can always be turned off) and `supportedAdapters` (which runtime adapters this
capability actually works under; empty for `gateway`/`executor`, which are not adapter-scoped).
Editing an entry (`editCatalogEntry`) publishes a new version, copying forward whatever the edit
leaves unset; a built-in entry may only have its `name`/`description` edited this way —
`kind`/`implementationKey` are never part of an edit's input at all (structurally immutable), and
`configSchema`/`riskFloor`/`supportedAdapters` are refused when they differ from the current
version (`builtInEditProblems`, unit-tested without a database): those fields describe what the
real integration actually does, not something an edit should be able to silently redefine for a
capability the owner did not build. A `kind`/`implementationKey` pairing that is not built in has
no creation path yet — `custom_https` is reserved, not defined — so this rule has no non-built-in
case to exercise this release. Every field an edit does supply (`name`, `description`,
`configSchema`, `riskFloor`, `supportedAdapters`) is validated against its own contract schema
before a new version is ever inserted (`editCatalogEntryInputProblems`): `EditCatalogEntryInput` is
a plain TypeScript type, never itself runtime-checked, so a caller handing this service data
parsed from JSON (a future console route, say) is held to the same bounds `ToolCatalogEntryVersionSchema`
already enforces for a seeded or freshly inserted version.

`catalog_entry_versions.entry_id` carries no foreign key: deleting an entry (below) never touches
its past versions, which stay exactly as recorded, entry gone or not — the same reasoning
`agent_lifecycle_operations.retry_of` already applies to a reference that must survive the row it
once pointed at moving on.

### Availability: computed, never stored as truth

Whether an entry is actually usable right now is never written to a column: a `native` entry is
available once at least one of its `supportedAdapters` is actually installed (a fresh, ready
worker — `runtimeHealth`'s own `available`, reduced by `installedAdaptersFromHealth`); a `gateway`
entry is always available (the Gateway itself performs it, not an optional external process); an
`executor` entry is available only once its action type is actually registered by a running tool
runner; `custom_https` is never available (reserved). `computeCatalogEntryAvailability` is a pure
function of an entry and a `ToolCatalogAvailabilityContext` (`installedAdapters`,
`registeredExecutorActionTypes`) the caller supplies — `packages/core` depends on no runtime or
tool-broker package (`docs/project-structure.md`'s own boundary), and a tool runner's registered
executors live in a separate process this release has no way to observe live, so neither fact is
looked up inside `tool-catalog.ts` itself. In production today `registeredExecutorActionTypes` is
always empty (no real integration ships; `sandboxExecutors` is development/test only), so every
`executor`-kind built-in is seeded but shown unavailable until a later phase gives the controller a
way to see what a tool runner actually registered.

`BUILT_IN_NATIVE_CAPABILITIES`/`BUILT_IN_GATEWAY_TOOLS`/`BUILT_IN_EXECUTOR_ACTIONS`
(`packages/contracts`) are a deliberate, documented duplication of facts each runtime-\* package
and `packages/tool-broker/src/sandbox.ts` already declare privately: `core` cannot depend on them
without crossing the dependency boundary that keeps it free of runtime/IO concerns. A mismatch
only ever affects what the catalog *displays* as supported — never what policy enforces, which
this decision does not touch — and is reconciled by hand if a runtime's own confinable tools ever
change.

### Attachments: a document of their own, alongside the bundle, independent of `permissions`

An attachment (`ToolAttachmentSchema`: `entryId`, `pinnedVersion` — null tracks the entry's current
version, a positive integer pins it even as the entry is edited further — `mode`
(`allow`/`require_approval`/`disabled`) and bounded, opaque `settings`) binds one agent to one
catalog entry — not in `AgentConfig` itself, which stays untouched (no YAML schema change, no
migration of every existing agent definition or test fixture).

**Every agent's attachments, keyed by agent id, are their own content-addressed snapshot
(`config_attachment_snapshots`), named by a revision alongside its configuration bundle
(`config_revisions.attachments_snapshot_hash`, nullable) — never a field inside
`ConfigSnapshotBundle` itself.** A revision's full state is the pair (bundle snapshot, attachments
snapshot); hashing, idempotent no-op detection, diff, history, rollback and export/import all treat
the pair as one unit, through the same `commitChange`/`commitChangeIn` path every other
configuration change already uses (four change operations: `attach_tool`, `detach_tool`,
`update_attachment`, `clear_tool_attachments` — the last removes one entry's attachment from every
agent that has it in a single operation, regardless of how many agents that is, since
`MAX_CHANGE_SET_OPERATIONS` could not bound one `detach_tool` per agent for a widely-attached
entry). `attachmentsSnapshotHash` is null for a revision whose resulting configuration has no agent
ever touched through the hub (`{}` is never given its own stored row) or one recorded before this
column existed.

This separation exists because `ConfigSnapshotBundleSchema` is a `strictObject`: a release before
attachments existed parses it with the exact same schema it always has, which refuses any key it
does not know. Putting attachments inside the bundle would mean that release's own copy of the
schema fails to parse the very first snapshot a hub-managed attachment ever touches — and so fails
to start at all — the moment an operator rolls back to it. Keeping the bundle exactly the shape
every release has always read, and the attachments document in a table of its own that an older
release simply does not know exists (and does not need: `config_snapshots`/`config_revisions` stay
fully readable, ADR-020's expand-migration guarantee), avoids that regression by construction. The
bundle's own agent `permissions` lists stay present and valid regardless: "Effective permissions:
compiled attachments as the single source of truth" below mirrors compiled attachments into them
for exactly this reason, so an older release still enforces the same effective permissions after a
binary rollback.

**At the time entries, versions and attachments were introduced, `permissions` was not derived
from attachments, and attachments were not derived from `permissions`.** `packages/policy` read
only `permissions`, unchanged; attaching, detaching or editing an attachment had no effect on what
a running agent could actually do. This was deliberate, not an oversight: compiling attachments
into enforcement is real design work — which direction, whether a floor interacts with
`tools_require_human_approval`, how a `custom_https` definition would even execute — that belonged
to a later step building on this one, not to introducing the data model itself. Keeping the two
independent at that point was also what kept that step small enough to review and revert on its
own. "Effective permissions: compiled attachments as the single source of truth" below is that
later step: for a hub-managed agent, `permissions` is now a mirror of its compiled attachments,
never an independent fact — see that section for the exact rule.

Every attachment named anywhere in a committed configuration is checked, at the same shared commit
boundary every write path commits a bundle through (`prepareChange`/`commitChangeIn`): its entry
exists and is not deleted, any `pinnedVersion` it names is a real version of that entry, and its
`mode` respects the entry's own `riskFloor`. `attachTool`/`updateAttachment` already give a caller a
friendlier, earlier refusal for the same problems (`checkAttachable`); this boundary is what closes
the gap for every other path that can commit a bundle — `config import`'s `replace_bundle`, a
direct `commitChange` — which never called `checkAttachable` at all.

Each agent's own attachment list is canonicalized (sorted by `entryId`) once, right after a change
set is applied and before anything hashes or stores the result: an attachment's position in its
list carries no meaning, but a canonical hash is sensitive to array order regardless, and
`config export` already writes `tool-attachments.json` with each agent's list sorted. Without this,
an untouched export of a revision whose attachments were attached in a different order than their
sorted one, re-imported unchanged, would hash to different content than what is actually stored —
manufacturing a new revision for what is, in truth, a no-op.

`catalog_attachments` is a database table, but it is the **current-state projection** of the active
revision's own attachments document, exactly the way the existing `agents` table projects
`ConfigSnapshotBundle.agents` — reconciled by `writeConfigRevisionIn` on every committed change
(`replace_bundle` included, so a plain YAML `config apply` reconciles it too), never written to
directly by the catalog service. The snapshot is the actual historical record rollback restores;
the table exists only so "every attachment of this agent" or "every agent attached to this entry"
is a cheap, indexed read instead of a snapshot deserialization.

**A bundle committed without an attachments document never clears anything.** `replace_bundle`'s
own whole-bundle-replace semantics apply to the *bundle* — organization, agents, constitution,
role prompts — never silently to attachments, which are a separate document that changes only when
one is actually supplied as part of the same operation. A plain YAML directory (`gateway config
apply`, with no `tool-attachments.json`) carries every agent's existing attachments forward
unchanged, filtered down to whichever agents the apply still configures; an export/import directory
that does carry `tool-attachments.json` (even an empty one) replaces the document in full, exactly
as it always has. `config diff`/`config rollback` show every attachment added, removed or changed
(mode, pinned version or settings) per agent per entry, the same way they already show an agent's
own changed fields.

### Deleting an entry never removes its row: a retired, referenceable identity

Deleting a catalog entry (`deleteCatalogEntry`) marks it deleted (`deleted_at`/`deleted_by`) rather
than removing the row: the row, its `current_version_id` and every past version stay exactly as
they were. A deleted entry is excluded from every active read (`listCatalogEntries`/
`getCatalogEntry`/`checkAttachable`'s own `loadEntry`) and can never be attached again or
undeleted — a built-in's own `catalog_entry_tombstones` row still exists alongside this, so
`ensureToolCatalogSeeded` never re-adds it — but the row itself persists so a historical
`config_revisions` snapshot that once attached it can still be rolled back to: inserting its
`catalog_attachments` projection row on rollback needs the entry it references to still exist, or
the foreign key fails and the rollback cannot be written at all. `config rollback` and
`requestAgentRestore` (an agent's attachments restored on a retire-then-restore round trip) each
resolve this themselves, before committing: any attachment naming a deleted entry is dropped from
what they actually commit, reported in the rollback's own output or the restore's own result,
rather than failing the operation outright or silently bringing a retired capability back.

`deleteCatalogEntry` locks `gateway_controls` before `catalog_entries`, the global lock order every
configuration writer keeps (`commitChangeIn`'s own first lock): taking the entry row first risks a
deadlock against a concurrent `attach_tool`/`update_attachment` commit, which always reaches for
`gateway_controls` first.

### Legacy conversion: a read model, never written back

Every agent configured before this decision — which is every agent today — has no
`toolAttachments` entry of its own: the bundle simply has no key for its id.
`legacyAttachmentsFromPermissions` (pure, unit-tested without a database) maps such an agent's
current `permissions` lists to what its attachments would look like, by pattern coverage against
catalog entries *known right now* alone: a wildcard (`finance.*`) expands into one attachment per
currently known entry it covers, never a future one the pattern might someday also match; an exact
pattern becomes one attachment if it names a known entry's `implementationKey`; a pattern covering
no known entry is reported `unresolved` (named with the list it came from), never silently
dropped. `tools_deny` maps to `disabled`, `tools_require_human_approval` to `require_approval`,
`tools_allow` to `allow`. Because `AgentPermissionsSchema` already refuses two overlapping patterns
anywhere across its three lists, no entry is ever produced twice, and finance rules
(`config-bundle.ts`'s `financeIssues`) fall out unchanged — a finance agent's own
`tools_require_human_approval` entries convert to `require_approval`, every other agent's
`tools_deny: ["finance.*"]` converts every known finance entry to `disabled`, with no
finance-specific code in the conversion itself.

`loadAllAgentToolAttachments`/`loadAgentToolAttachments` are the DB-backed read wrapping this: an
agent with a `toolAttachments` entry in the active bundle (it has been attached to, detached from,
or had an attachment edited for, at least once) is **hub-managed** — its recorded attachments are
returned as-is, with no unresolved patterns (they are already resolved by construction) and,
deliberately, no reconciliation against its `permissions`: the two are independent facts, per the
decision above. Every other agent is **legacy** — its attachments and unresolved patterns are
computed fresh from its current `permissions` on every read, never persisted, so a later catalog
change (a new entry added, an old one tombstoned) is always reflected rather than frozen at
whatever the first read happened to see.

### Deletion and tombstones

Deleting a catalog entry (`deleteCatalogEntry`) removes its attachment from every agent that has
one, atomically: a single `clear_tool_attachments` change set is committed (one new config
revision, or none at all when nothing was attached), and, in the same database transaction, the
entry's own row is marked deleted (see "Deleting an entry never removes its row" above — it is
never actually removed). A failure anywhere — the commit conflicting after its bounded retries, an
unexpected constraint — rolls back everything: no partial state (an entry marked deleted but an
attachment left referencing it, or the reverse) is ever observable. For a **built-in** entry,
deletion also writes a row to `catalog_entry_tombstones` (id, its `kind`, who deleted it, when),
read by `ensureToolCatalogSeeded` alongside the entry's own now-permanent `deleted_at`; a
non-built-in entry's deletion writes none, since nothing ever reseeds a capability nothing
declared. Past versions are never deleted (the guard trigger would refuse it regardless) and
remain readable after their entry is deleted.

### Seeding built-ins

`ensureToolCatalogSeeded` is an idempotent TypeScript function, run at controller startup and the
start of every CLI session that touches a schema-compatible database — the same place and the same
pattern as `ensureConfigHistory`/`ensureAgentLifecycleAdoption`. It inserts every built-in this
release's code declares (nine today: five native capabilities, `mattermost.post` and
`memory.write` as gateway built-ins, and the two sandbox executor actions
`finance.payment.create`/`finance.subscription.create` — `memory.read` is not included: nothing in
`packages/core` ever checks a `memory.read` pattern, reads are always folded into context
regardless of permissions, so it is not a real, gated capability yet) that is neither already
present nor tombstoned — a built-in the owner deleted stays deleted across every future reseed,
including a later release that ships it again under the same id. Namespace-only patterns
(`finance.*`) are never seeded as entries themselves: only concrete, executable capabilities are.
Built-in ids are deterministic (`<kind>-<implementation-key-with-hyphens>`, e.g.
`native-repository-read`, `executor-finance-payment-create`), so reseeding and tombstoning always
agree on which row they mean.

### Effective permissions: compiled attachments as the single source of truth

Attach a tool in the hub and the agent may use it on its next turn; detach it and it cannot,
including anything already queued. `compileAttachments` (`@agent-gateway/policy`, pure, no IO)
takes one agent's attachments and the catalog metadata (`kind`/`implementationKey`) of every entry
they name, and produces disjoint, concrete tool lists — `allow`, `requireApproval`, `deny` — plus
two derived maps, `impliedBy` and `missingPrerequisites`, and a `memoryWriteAllowed` flag.

**Mode is bounded by an entry's own `kind`, not only its `riskFloor`.** `riskFloorAllows` (ADR-027's
original rule) says how strict a mode must be; `modeSupportedByKind` says which modes an entry's
`kind` can express at all, because not every kind has an enforcement point that can pause a turn
for a human mid-flight:

| Kind | Supported modes | Why |
|------|------------------|-----|
| `native` | `allow`, `disabled` | A runtime's own built-in tool runs inside the turn; nothing can intercept it to ask a human first. |
| `gateway` | `allow`, `disabled` | `mattermost.post`/`memory.write` are direct Gateway actions with no approval flow of their own. |
| `executor` | `require_approval`, `disabled` | A tool-broker action's risk floor is already `require_approval` (`riskFloorAllows` already refuses `allow` for it); this makes the bound explicit and kind-driven rather than an accident of every executor's own floor. |
| `custom_https` | none | Reserved; nothing is ever attachable against it. |

An attachment whose mode its entry's `kind` does not support is refused at the same shared write
boundary that already checks `riskFloor` (`attachmentCatalogProblems`, reused rather than
duplicated) and, earlier and more specifically, at `attachTool`/`updateAttachment`'s own
`checkAttachable`.

**Native dependencies are catalog data, not scattered `if`s.** Granting a native capability with
`allow` can make another effectively usable even when it was never itself attached: `tests.run`
implies `repository.read` and `workspace.write` (a runtime needs to read, and may need to write,
the files a command touches), and `workspace.write` alone implies `repository.read`. This mirrors,
for the compiled result, the same fail-closed inference `packages/runtime-sdk`'s `nativeToolGrants`
already makes from a `ToolPolicySnapshot`'s raw lists — restated here so every enforcement point
that reads the compiled result (not only `nativeToolGrants`) agrees on what is effectively allowed,
and so a version 3 turn input's `capabilities` can describe the implied tool too. An explicit
`disabled` or `require_approval` on the implied tool wins over the implication; `impliedBy` records
which attached tool caused which implied one, for both the capability description and any future
operator-facing display.

A second, narrower kind of fact runs the other way: an **adapter-specific prerequisite**. Codex
reads files only through its shell (`packages/runtime-codex`'s `SHELL_FEATURES`, withheld unless
`tests.run` is granted), so `repository.read` alone gives a Codex agent no file access at all — a
fact the adapter already enforces on its own (`sandboxArgs`), unconditionally, regardless of how a
grant arrived. The compiler does not remove `repository.read` from `allow` to compensate (the
adapter's own fail-closed behaviour already makes the capability inert); instead it surfaces the
missing prerequisite (`missingPrerequisites: { "repository.read": ["tests.run"] }`), from a small,
explicit, adapter-keyed table (`ADAPTER_NATIVE_PREREQUISITES`) — data an owner managing attachments
(or a future console) can be shown, not a silent trap.

**`memory.write` is always explicit, in `allow` or in `deny`, never silently absent from both.**
Authority (`writableMemoryNamespaces`, `packages/core/src/turn-context.ts`) and the rendered prompt
(`memoryWriteDenied`, `packages/runtime-sdk/src/prompt.ts`) both derive deniability from `deny`
alone, a contract that predates this compiler; an attachment simply never existing for
`memory.write` must still show up as an explicit denial, or that independent re-derivation would
tell the model it may propose writes the turn's own authority then refuses. The compiler enforces
this directly: whenever `memory.write` is not in `allow`, it is added to `deny` — whether it was
explicitly attached `disabled` or never attached at all.

**Finance capabilities compile in only for the organization's finance agent.** An attachment of a
finance-kind entry held by any other agent contributes nothing at all, as though never attached —
the same invariant `config-bundle.ts`'s `financeIssues` already enforces for hand-authored
`permissions`, so attaching a finance entry to the wrong agent through the hub can never become a
second, inconsistent way to grant finance access.

**Single source of truth.** For a **hub-managed** agent — the active revision's attachments
document has an entry for it, even an explicitly empty one (detached from everything) — effective
permissions come only from `compileAttachments`'s result: `packages/policy`'s enforcement, the
turn's own `toolPolicy`, memory-write authority and the runtime prompt all read it, never
`agent.config.permissions` directly. For a **legacy** agent (no attachments document at all),
effective permissions are exactly its `permissions` lists, byte for byte, the same as before this
step — `loadEffectivePermissionsIn` (`packages/core/src/services/effective-permissions.ts`) is the
one function that resolves this distinction, so no enforcement point can read one fact for one kind
of agent and a different one for the other by accident. `agents.tool_attachments_managed`
(migration `0032`) is the live, cheap signal for "hub-managed, including an empty list" that
`catalog_attachments` rows alone cannot give (an empty list and "never touched" both have zero
rows); it is reconciled by `writeConfigRevisionIn` exactly like `catalog_attachments` itself, and
was backfilled, at migration time, from the then-active revision's own attachments document (every
agent key present there, regardless of its list's length).

**Never converted implicitly.** A legacy agent stays legacy until an owner
explicitly asks for it: `adoptAgentToolAttachments` (`gateway tools adopt <agent>|--all
[--dry-run]`) is a core function and CLI command that converts one named agent's (or every
currently legacy agent's, for `--all`) current `permissions` into real, recorded attachments
(`legacyAttachmentsFromPermissions`, unchanged from ADR-027's original read model), committing one
revision per agent (never combined: a batch could exceed `MAX_CHANGE_SET_OPERATIONS`, and one
agent's adoption failing must never block another's). It reports, per agent: whether it was already
hub-managed (left untouched), every unresolved pattern, the effective permissions before and after
(identical in effect whenever every pattern resolved — the whole point of a safe migration), and
any resolved attachment whose mode its entry's `kind` does not support (found before attempting a
commit that would otherwise refuse it). `--dry-run` previews everything above without committing.
An agent whose legacy conversion resolves to zero attachments (every pattern unresolved, or no
permissions at all) is not adopted even without `--dry-run`: there is no change-set operation that
marks an *existing* agent hub-managed with an explicitly empty list (only `add_agent`/
`replace_bundle` can start one that way), so `tools adopt` reports this rather than silently doing
nothing useful — attach at least one entry directly instead.

**The bundle-mirror invariant.** Whenever a hub-managed agent's compiled attachments could have
changed — any `attach_tool`/`detach_tool`/`update_attachment`/`clear_tool_attachments`, or a plain
`replace_bundle` that supplies a `toolAttachments` document — `mirrorCompiledAttachmentPermissionsIn`
(`management.ts`) recompiles every hub-managed agent's attachments and replaces its `permissions`
field with the result (`compiledAgentPermissions`), in the very same draft the catalog-constraint
check and the hash are computed from, so the mirror is never a separate write and never a separate
revision. This is what keeps a binary rollback to a release before this step (0.6.0, which enforces
only `permissions`) safe: it enforces exactly the effective permissions the compiler would have, not
whatever `permissions` happened to say before the owner last touched an attachment. Tested directly:
bundle `permissions` equals the compiled result of that same revision's attachments, after every
attach/detach/delete/rollback.

**Enforcement points.** Every place that read `agent.config.permissions` for a policy decision now
reads `loadEffectivePermissionsIn`'s result instead: the turn scheduler (`scheduler.ts`, once per
scheduled turn, stored in the run's own `toolPolicy` snapshot — a run's authority is fixed at
scheduling time, same as before this step), the human-approval grant/revoke path (`approvals.ts`'s
`executionIssues`, re-read live — not the run's stale snapshot — since a human may decide, or a
configuration change may land, long after a turn was scheduled), and the runtime prompt/environment
(`packages/runtime-sdk`, which already read the turn's own `toolPolicy`, unchanged in shape).
`revokeQueuedActions` (`approvals.ts`), already run after every configuration commit, now also
withdraws a still-**pending** approval (not only an already-**queued**, granted tool action) once
the live, recompiled policy no longer permits it — a capability detached, or turned `disabled`,
revokes or refuses either, with an audit entry, before it can execute.

### Turn input version 3 (ADR-023)

A version 3 `AgentTurnInput` always carries `capabilities`: bounded descriptions (name, a short,
catalog-sourced description, mode) of the agent's own effective tools, compiled the same way for a
hub-managed or a legacy agent (a read model, not an enforcement decision — an unresolved legacy
pattern has no catalog entry to describe, and is simply left out). `packages/runtime-sdk`'s prompt
renders them as a structured alternative to the bare tool-name lists it already shows. See ADR-023
for the exact schema rule and its rollback consequence.

## Alternatives

- **Attachments derived from `permissions`, never stored separately.** Rejected: a bare permission
  pattern cannot express a pinned version or free-form settings, and the hub's whole premise (edit
  a capability once, see every agent that holds it; attach/detach per agent) needs attachments to
  be real, addressable rows, not a projection recomputed from strings that happen to overlap a tool
  name.
- **Compile attachments into `permissions` at write time, so `packages/policy` needs no change
  ever.** Considered, and deferred rather than rejected: deciding the compilation rule (how a
  `require_approval` floor interacts with an agent's own `tools_require_human_approval`, whether a
  `disabled` attachment must also appear in `tools_deny` or simply absent is enough, what happens
  to a pinned-version attachment once its entry is edited) was real design work on its own, better
  done once the catalog model it operates on already existed and was tested, not invented
  simultaneously with the storage. "Effective permissions: compiled attachments as the single
  source of truth" below is that work, done once the model had settled: for a hub-managed agent,
  `packages/policy`'s enforcement now reads the compiled result (mirrored into `permissions` too,
  for rollback), not a second, independent decision path.
- **Reconstruct a legacy agent's attachments once and persist them, rather than converting on every
  read.** Rejected: persisting a conversion the owner never asked for would make that agent
  "hub-managed" by accident, freezing it away from ever reflecting a newly added catalog entry
  through the legacy path again, and would need its own migration-time decision about exactly when
  to materialize it — the same reconstruction ADR-024 already refused for configuration history,
  for the same reason (it would misrepresent something nobody actually recorded as if they had).
- **A single `set_tool_attachments` change operation (a whole per-agent list replace) instead of
  `attach_tool`/`detach_tool`/`update_attachment`.** Rejected: a whole-list replace built from a
  stale read races a concurrent edit from elsewhere invisibly (the last write wins, silently
  discarding the other), where a targeted operation at least reports a clear "no attachment to
  update" or produces a deterministic, independent result regardless of what else is in the list.

## Consequences

- No console route reads any of this yet; surfacing the catalog and its attachments in the
  console is later work. `gateway config export`/`import`/`diff`/`rollback` print it as part of
  the bundle, and `gateway tools adopt` (below) surfaces a legacy agent's own conversion.
- Attaching, detaching or editing an attachment now changes what a hub-managed agent may actually
  do, on its very next turn — see "Effective permissions: compiled attachments as the single
  source of truth" below.
- `configSchema`/`settings` are bounded JSON, structurally validated only; nothing compiles a JSON
  Schema into an actual validator this release. An attachment's `settings` can hold anything that
  fits the bound regardless of what `configSchema` claims to require — a gap a later phase closes
  before `settings` drives anything real.
- `catalog_entry_versions` grows without bound, like the configuration journal and the audit log;
  nothing here adds its own retention pass.
- Rolling back to a release before this one keeps every existing table fully readable (ADR-020's
  expand-migration guarantee); `catalog_entries`/`catalog_entry_versions`/`catalog_attachments`/
  `catalog_entry_tombstones`/`config_attachment_snapshots` are simply additional tables (and, for
  `config_revisions`, an additional nullable column) an older release does not know about and does
  not need — `ConfigSnapshotBundleSchema` itself never gained a field for attachments at all, so an
  older release's own copy of that schema parses every snapshot this release ever writes exactly as
  it always has. A `config export` directory predating `tool-attachments.json` (or any directory
  simply missing that file) resolves to every agent's attachments carrying forward unchanged, never
  to `{}` unconditionally — see "Attachments: a document of their own" above.
