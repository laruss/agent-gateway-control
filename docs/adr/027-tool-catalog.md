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
shows". It makes no change to tool enforcement: `packages/policy` reads `permissions` exactly as it
always has, and nothing here compiles an attachment into a grant. No UI reads any of this yet, and
`custom_https` (an owner's own HTTPS-backed tool) is reserved as a `kind` with no definition —
both are later work this decision anticipates and prepares storage for, the same way ADR-026
anticipated automated Mattermost provisioning without performing it.

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
case to exercise this release.

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

### Attachments: part of the bundle, independent of `permissions`

An attachment (`ToolAttachmentSchema`: `entryId`, `pinnedVersion` — null tracks the entry's current
version, a positive integer pins it even as the entry is edited further — `mode`
(`allow`/`require_approval`/`disabled`) and bounded, opaque `settings`) binds one agent to one
catalog entry. **Attachments live in `ConfigSnapshotBundle.toolAttachments`, a new field keyed by
agent id, alongside `agents`/`rolePrompts`** — not in `AgentConfig` itself, which stays untouched
(no YAML schema change, no migration of every existing agent definition or test fixture) — the
same way `rolePrompts` is bundle-level, hub-managed state rather than something `AgentConfigSchema`
carries. This is this decision's source-of-truth choice: attachments are part of the snapshot, so
every write that changes one goes through the same `commitChange`/`commitChangeIn` path (four new
change operations: `attach_tool`, `detach_tool`, `update_attachment`, `clear_tool_attachments` —
the last removes one entry's attachment from every agent that has it in a single operation,
regardless of how many agents that is, since `MAX_CHANGE_SET_OPERATIONS` could not bound one
`detach_tool` per agent for a widely-attached entry) and is covered by config history, rollback and
`config export`/`import` for free, exactly like every other field of the bundle.

**`permissions` is not derived from attachments, and attachments are not derived from
`permissions`, in this release.** `packages/policy` keeps reading only `permissions`, completely
unchanged; attaching, detaching or editing an attachment has no effect on what a running agent may
actually do. This is deliberate, not an oversight: compiling attachments into enforcement (or
making policy read them directly) is real design work — which direction, whether a floor interacts
with `tools_require_human_approval`, how a `custom_https` definition would even execute — that
belongs to a later phase building on this one, not to introducing the data model itself. Keeping
the two independent this release is also what keeps this decision small enough to review and
revert on its own: nothing about tool enforcement changes merely because this migration ran.

`catalog_attachments` is a database table, but it is the **current-state projection** of
`ConfigSnapshotBundle.toolAttachments`, exactly the way the existing `agents` table projects
`ConfigSnapshotBundle.agents` — reconciled by `writeConfigRevisionIn` on every committed change
(`replace_bundle` included, so a plain YAML `config apply` reconciles it too), never written to
directly by the catalog service. The bundle inside `config_snapshots` is the actual historical
record rollback restores; the table exists only so "every attachment of this agent" or "every
agent attached to this entry" is a cheap, indexed read instead of a snapshot deserialization.

One consequence of attachments being bundle content: `gateway config apply`'s long-standing
whole-bundle-replace semantics now also apply to them. A plain YAML directory with no
`tool-attachments.json` resets every agent's attachments to none — exactly as it already resets any
agent dropped from the directory to disabled, or a changed field to whatever the YAML now says. An
operator who wants attachments to survive an edit round-trips through `config export`/`import`
(which does carry `tool-attachments.json` forward), rather than hand-editing YAML once the hub is
in use.

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
entry's own row (and, implicitly, its `catalog_attachments` rows, already reconciled away by that
same commit) is removed. A failure anywhere — the commit conflicting after its bounded retries, an
unexpected constraint — rolls back everything: no partial state (an entry gone but an attachment
left referencing it, or the reverse) is ever observable. For a **built-in** entry, deletion also
writes a row to `catalog_entry_tombstones` (id, its `kind`, who deleted it, when); a non-built-in
entry's deletion writes none, since nothing ever reseeds a capability nothing declared. Past
versions are never deleted (the guard trigger would refuse it regardless) and remain readable,
orphaned, after their entry is gone.

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

## Alternatives

- **Attachments derived from `permissions`, never stored separately.** Rejected: a bare permission
  pattern cannot express a pinned version or free-form settings, and the hub's whole premise (edit
  a capability once, see every agent that holds it; attach/detach per agent) needs attachments to
  be real, addressable rows, not a projection recomputed from strings that happen to overlap a tool
  name.
- **Compile attachments into `permissions` at write time, so `packages/policy` needs no change
  ever.** Considered. Rejected for this step specifically: deciding the compilation rule (how a
  `require_approval` floor interacts with an agent's own `tools_require_human_approval`, whether a
  `disabled` attachment must also appear in `tools_deny` or simply absent is enough, what happens
  to a pinned-version attachment once its entry is edited) is real design work on its own, better
  done once the catalog model it operates on already exists and is tested, not invented
  simultaneously with the storage. Nothing here forecloses it: `permissions` keeps its existing
  shape and meaning exactly.
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

- No UI reads any of this yet; no console route, no CLI command beyond what `gateway config
  export`/`import`/`diff`/`rollback` already print as part of the bundle. Surfacing the catalog and
  its attachments to an owner is later work.
- No tool's actual permission changes because of this release: attaching, detaching or editing an
  attachment is pure bookkeeping until a later phase compiles it into enforcement or changes
  `packages/policy` to read it directly.
- `configSchema`/`settings` are bounded JSON, structurally validated only; nothing compiles a JSON
  Schema into an actual validator this release. An attachment's `settings` can hold anything that
  fits the bound regardless of what `configSchema` claims to require — a gap a later phase closes
  before `settings` drives anything real.
- `catalog_entry_versions` grows without bound, like the configuration journal and the audit log;
  nothing here adds its own retention pass.
- Rolling back to a release before this one keeps every existing table fully readable (ADR-020's
  expand-migration guarantee); `catalog_entries`/`catalog_entry_versions`/`catalog_attachments`/
  `catalog_entry_tombstones` are simply additional tables an older release does not know about and
  does not need, and `ConfigSnapshotBundleSchema.toolAttachments` defaults to `{}` wherever an older
  bundle (or a `config export` directory predating `tool-attachments.json`) does not have it.
