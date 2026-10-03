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
shows". No UI reads any of this yet — that is still later work — but `custom_https` (an owner's own
HTTPS-backed tool) and `utility` (a fixed, image-shipped implementation) are both fully defined and
executable: "Custom HTTPS tools" and "Packaged utilities" below.

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
`executor` (a tool-broker action backed by a registered executor), `custom_https` (an owner's own
HTTPS-backed tool, "Custom HTTPS tools" below), or `utility` (a fixed, image-shipped implementation,
"Packaged utilities" below) — and an immutable `implementationKey` naming the concrete capability
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
capability the owner did not build. At the time this rule was written, no `kind`/`implementationKey`
pairing that was not built in had a creation path yet, so it had no non-built-in case to exercise;
`custom_https` ("Custom HTTPS tools" below) is now that case, and `editCatalogEntry` applies this
same restriction to it unchanged — `kind`/`implementationKey` stay immutable, only a non-built-in
entry may also change `configSchema`/`riskFloor`/`supportedAdapters` (`custom_https` never sets the
latter two itself; see below). Every field an edit does supply (`name`, `description`,
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
`executor`/`utility` entry is available only once its action type is actually registered by a
running tool runner; a `custom_https` entry is available once a currently healthy tool runner
serves the `custom` namespace (every such entry, not individually enumerable the way a fixed action
type is — "Custom HTTPS tools" below). `computeCatalogEntryAvailability` is a pure
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
`mode` respects the entry's own `riskFloor`; no agent attaches the same entry twice (`allow` and
`disabled` at once would compile into overlapping permission-list entries `AgentConfigSchema`
itself refuses — caught here, before a commit, rather than only the next time something parses the
result back). `attachTool`/`updateAttachment` already give a caller a friendlier, earlier refusal
for the same problems (`checkAttachable`); this boundary is what closes the gap for every other path
that can commit a bundle — `config import`'s `replace_bundle`, a direct `commitChange` — which never
called `checkAttachable` at all. `writeConfigRevisionIn`, the one writer every committing path ends
in, re-checks both this and the mirrored agents its own bundle-mirror invariant (below) is about to
produce, immediately before anything is hashed or stored — never relying on a caller upstream having
already checked first.

**Attaching to a still-legacy agent converts its `permissions` first.** `attachTool` on an agent with
no attachments document of its own yet would otherwise make it hub-managed with only the one
attachment just requested: the bundle-mirror invariant (below) replaces `permissions` with the
compiled result on the very commit that first gives an agent an attachments document, so attaching
one entry on its own would silently drop everything else the agent's `permissions` used to cover
(an agent allowed `mattermost.post` loses it the moment anything else is attached). `attachTool`
instead reads the agent's current attachments and its own `permissions` together, right before
committing, and — only when the agent is still legacy — converts its `permissions` the same way
`gateway tools adopt` (below) does, committing the converted attachments and the one actually
requested in the same revision, against the exact base revision that read came from (so a
concurrent change is a conflict, never silently rebased onto). The conversion itself is reported
back (`legacyConversion`). A legacy pattern whose resolved mode its own catalog entry's `kind` does
not support refuses the whole attach outright — nothing committed — with a pointer to
`gateway tools adopt <agent-id>` first, the explicit, reviewed path for resolving it; `detachTool`
and `updateAttachment` need no such conversion, since neither can itself be the first write that
makes a legacy agent hub-managed (a detach of nothing is a no-op, and an update of an attachment
that does not exist yet is already refused).

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
| `custom_https` | `require_approval`, `disabled` | An owner's own HTTPS-backed tool reaches an external address through the broker; the broker has no approval-free execution path ("Custom HTTPS tools" below). |
| `utility` | `require_approval`, `disabled` | Side-effect-free does not mean approval-free: the broker has only one execution path, and every kind it executes shares it ("Packaged utilities" below). |

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
permissions at all) is still adopted: `set_tool_attachments` (below) marks an *existing* agent
hub-managed with an explicitly empty list, the one thing `attach_tool` cannot express on its own
(it always adds at least one row) — every other agent keeps the targeted, per-attachment
`attach_tool` changeset it always has. Each agent's own read (its resolved attachments, and the
revision they came from) and its commit happen together, so a concurrent change elsewhere — a
revoke landing between when `tools adopt` read an agent's permissions and when it commits — is a
conflict (`ManagementConflictError`), never silently overwritten by a commit built from the earlier,
now-stale read.

**The bundle-mirror invariant.** Whenever a hub-managed agent's compiled attachments could have
changed — any `attach_tool`/`detach_tool`/`update_attachment`/`clear_tool_attachments`/
`set_tool_attachments`, or a plain `replace_bundle` that supplies a `toolAttachments` document, a
plain YAML `config apply` included — every hub-managed agent's attachments are recompiled and its
`permissions` field replaced with the result (`compiledAgentPermissions`). This runs inside
`writeConfigRevisionIn` itself (`admin.ts`) — the one function every committing path ends in
(`applyConfig`'s whole-bundle replace and the managed-config service's finer-grained operations
alike) — rather than left to each caller to remember before it calls that writer: whatever bundle
and hash a caller hands in, `writeConfigRevisionIn` recomputes both from the *mirrored* agents
before anything is hashed or stored, so no committing path can skip the invariant or store a bundle
that disagrees with it. (`commitChangeIn`'s own earlier mirror, needed before that point for its
no-op check and diff, mirrors the same way; compiling an already-compiled result reproduces it
exactly, so running it twice costs correctness nothing.) This is what keeps a binary rollback to a
release before this step (0.6.0, which enforces only `permissions`) safe: it enforces exactly the
effective permissions the compiler would have, not whatever `permissions` happened to say before the
owner last touched an attachment. Tested directly, for every committing path (`commitChange`,
`config import`'s `replace_bundle`, `config apply`, `config rollback`, restoring a retired agent,
`tools adopt`): bundle `permissions` equals the compiled result of that same revision's attachments.

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
pattern has no catalog entry to describe, and is simply left out). A pinned attachment's own
description resolves to the version it is actually pinned to (name/description/risk floor as that
version recorded them), never a later edit's, the same way its compiled mode already does; an
implied tool (e.g. `repository.read`, implied by `tests.run`) is described too, from its own
catalog entry's current version — looked up by implementation key rather than by attachment, since
an implied tool has no attachment of its own — and carries `impliedBy`, naming the attached tool(s)
that make it effectively usable. `packages/runtime-sdk`'s prompt renders them as a structured
alternative to the bare tool-name lists it already shows. See ADR-023 for the exact schema rule and
its rollback consequence.

### Custom HTTPS tools: definitions, egress and outcomes

A `custom_https` entry is the one non-built-in kind with a creation path (`createCustomHttpsTool`):
the owner picks its id (its action type is `custom.<entry-id>`, immutable from then on) and supplies
the first version's `httpsDefinition` — a fixed destination host, path template and method; typed
parameters (string/number/boolean/enum, with bounds) mapped explicitly into exactly one slot each
(a path placeholder, a query key, a header or a JSON body field); named secrets the definition
references by alias, mapped into their own slot the same way; response limits (max bytes, allowed
content types, a timeout); and, for anything but `GET`, a required idempotency header name.
`customHttpsDefinitionProblems` (`@agent-gateway/contracts`, pure) refuses a definition whose path
placeholders and path parameters do not match exactly, whose slots collide (header names compared
case-insensitively, since two differently-cased spellings are the same HTTP header; the
idempotency header itself is one more name nothing else may target), that declares a parameter
named `custom_tool_definition_version` (reserved for the controller's own pin, below), that puts a
secret in the path, or that is a write without an idempotency mechanism — a write cannot be saved
at all without one. Editing a `custom_https` entry (`editCatalogEntry`) publishes a new version precisely
like a built-in's `name`/`description` edit, except every field — `httpsDefinition` included — may
change, since nothing here is a real integration's own fixed fact the way a built-in's `riskFloor`
is. `riskFloor` is always `require_approval` and `supportedAdapters` always empty for this kind;
`utility` (below) is the same. `MODES_BY_KIND` (`@agent-gateway/policy`) therefore supports only
`require_approval`/`disabled` for both — the broker has no approval-free execution path, so neither
kind can ever be attached `allow`, side-effect-free or not.

**No value, ever, except through an encoded slot.** There is no JavaScript evaluation and no shell:
every parameter value is percent-encoded into its one path segment or query entry, or placed as one
header value or one JSON field — never interpolated into a larger string, and a path placeholder is
filled by the *parameter* that declares it (its own `name`), never by its placeholder's own
`slotName`, which may differ. A path value that is itself `.`/`..`, contains `/` or `\`, or carries
a control character is refused at the validation layer (`customToolParamIssues`,
`@agent-gateway/policy`) before an approval is ever created; a header or query value carrying a
control character (CR/LF, NUL, ...) is refused there too, and a header value outside Latin-1 — the
same validation layer refusing outright what `https.request` would otherwise throw on, forcing an
`unknown` the destination never actually saw. A number parameter's value is required to parse to a
finite number: a long enough run of digits still matches the numeric grammar but overflows to
`Infinity`, which `JSON.stringify` would otherwise turn into `null` on the wire — a request that
would then disagree with what was approved. `resolveCustomHttpRequest`'s own percent-encoding keeps
a path value that somehow reached execution anyway (a forged job) confined to its one segment
regardless — encoding, not re-validation, is what the execution layer itself relies on.

**The broker namespace.** `custom` is a fixed `ToolNamespace` (`TOOL_NAMESPACES`) that every
`custom_https` entry's action type routes through — one shared queue
(`tool.execute.custom`/`tool.report.custom`), not one per entry: a tool runner's database role is
granted the namespace, not an individual entry, exactly like `finance`. The runner dispatches
dynamically, through `DynamicExecutor` (`@agent-gateway/tool-broker`'s `processToolJob`): a static
`ToolExecutors` map cannot enumerate an owner-created, unbounded set of action types the way it
enumerates `finance.payment.create`, so a job whose action type no static executor claims falls
through to the dynamic one when the runner serves `custom`. `gateway_custom_tool_definition(entry
id, version)` is the one additional `SECURITY DEFINER` function (migration `0034`) the runner may
call, symmetrical with `gateway_begin_tool_action`: read-only, it returns one immutable version's
own `https_definition` and nothing else of the catalog, and only to a role that can settle the
`custom` namespace's own execute jobs — a runner of another namespace gets no row, the same
`wrong_namespace` boundary `begin` already enforces for execution itself.

**Pinning an approval to the exact version it was resolved against.** A `needs_human` request
naming a `custom_https` action is never approved against "whatever the entry currently is": the
controller (`prepareCustomApprovalDraft`, `packages/core`) strips any `custom_tool_definition_version`
the model's own draft already names — reserved for this call alone, never trusted from a model or a
forged draft — validates the remaining parameters against the entry's *current* definition and,
only once they pass, adds exactly one synthetic parameter, `custom_tool_definition_version`, pinned
to that version — before the draft is ever hashed, shown on the card, or stored. A `custom_https`
action is the one case `ApprovalRequestDraftSchema` allows zero model-supplied parameters at all
(every other action type still needs at least one): a fixed call whose only moving part is a named
secret — a definition with no typed parameters of its own — still ends up with this one, controller-
added parameter and so is still approvable. Because this parameter is part of `actionParams` like
any other, it is covered by the same immutable `approvalActionHash` every other action already uses,
with no schema change to `ApprovalRequestSchema` or `ToolActionJobSchema` at all. At grant time (`customGrantTimeIssues`,
re-run inside `executionIssues` alongside every other live policy check — never the run's stale
snapshot) the pinned version is compared against the entry's version *now*: a mismatch — the
definition was edited since the request was made — refuses the grant outright
(`customDefinitionVersionIssues`), and the model's parameters are re-validated against the current
definition too, independently of the version check. The tool runner, once an action is granted,
reads the exact pinned version by (entry id, version) through `gateway_custom_tool_definition` —
never "current" — so execution is always what was actually approved, immutable version content
making that guarantee free rather than a race against a concurrent edit.

**Egress.** `resolvePinnedAddress` (`@agent-gateway/tool-broker`'s `egress.ts`) is the one gate
every `custom_https` call passes through before a socket ever opens: `host` is resolved once (an
injectable `DnsResolver`, the real one backed by `dns.lookup` in production), and the connection is
made to exactly the address that resolution returned — never re-resolved, which is what defeats DNS
rebinding (a second answer, from this process or the destination's own resolver, can never change
what a call already pinned to). Before resolving at all, `host` (and every candidate address DNS
returns) is classified by `@agent-gateway/policy`'s `ip-guard.ts`: private (RFC 1918), loopback,
link-local (169.254/16, the cloud metadata range included), carrier-grade NAT (100.64/10),
multicast and reserved IPv4 ranges are a deny-list; IPv6 is the reverse, an allow-list — only global
unicast (`2000::/3`) may ever pass, and only once it matches none of the special-purpose ranges
carved out of it (6to4, Teredo, the documentation and benchmarking ranges, ORCHIDv2, both NAT64
well-known prefixes) or aliases a non-global address the IPv4-style forms above already cover
(unique-local, link-local, an IPv4-mapped or IPv4-compatible address, the deprecated site-local
range, the discard-only prefix, SIIT) — a deny-list here would have to name every non-global range
that exists, where an allow-list can only ever refuse something that happens to be global, never
admit something that is not. Every address is classified from its literal numeric value regardless
of notation (dotted, decimal, octal, hex for IPv4; compressed `::` forms and embedded-IPv4 forms for
IPv6), since a hostname that is itself a numeric literal in an unusual base is exactly the classic
SSRF bypass this guard exists to close. The TLS SNI and the HTTP `Host` header stay the definition's
own hostname throughout — only the TCP/TLS connection target is the resolved address — so the
destination sees an ordinary request. Redirects are never followed (`sendPinnedRequest` simply never
looks at one); a response over `responseLimits`'s own cap is aborted mid-stream, the moment the
overflow is actually detected rather than waiting on a further stream event that may never come.

One overall deadline — `AbortSignal.any` combining `responseLimits.timeoutMs` with the executor's
own cancellation signal (kill-all, the agent disabled, the runner stopping) — covers DNS, connect,
TLS, send and the response body alike, passed to `https.request` as its own `signal` rather than
relied on as a socket-idle timeout (which a response trickling one byte at a time would never trip
at all). The executor itself checks that same signal before every stage — the definition lookup,
secret resolution, sending — so a call still resolving its destination can be cancelled, not only
one already connected, and returns a clean `failed` when nothing was sent yet rather than starting
an external write on behalf of a run that has already been told to stop.

**Outcomes.** `succeeded` carries a receipt (status code, a redacted response preview — every
resolved secret value, and the forms this executor's own request-building could have put it on the
wire in (URL- and form-encoded, JSON-escaped, base64/base64url), are replaced outright before
anything is read into a receipt or an error, even one a destination echoes back — best-effort
against a destination that happens to echo the credential; a hostile destination that already holds
it learns nothing more from a scrub missing some further transformation of it. A definition may also
turn the preview off entirely, `includeBodyPreview: false`, for a body an owner never wants an agent
to see regardless). `failed` is a clean, known refusal with nothing left uncertain — a blocked
address, a `GET` with an unexpected content type, an oversized `GET` response, the destination's own
4xx/5xx. `unknown` is reserved for what the brief among tool actions already means it to be
(ADR-018): an abort — a timeout or a cancellation — or a connection reset **after** the request was
already fully sent, when the destination may or may not have acted on it — the egress client
distinguishes this by whether the request finished writing (and, for an HTTPS call, the TLS
handshake itself completed: `finish` alone can fire before the connection is even established,
which would otherwise make a pre-connect failure — an untrusted CA, a hostname/certificate mismatch
— look sent) before the failure, and throws rather than returning `failed`, so `processToolJob`
records it as `unknown` exactly like any other executor's unexplained crash. An oversized response
is the one case decided by the method: a `GET`'s own abort is always `failed` (nothing but a read
was ever at stake); a write's is `unknown` once the request was actually sent, `failed` otherwise.
A write whose request was fully sent and that comes back with a content type the definition does not
allow is no longer automatically `failed`: a 2xx (the common case is no body or `Content-Type` at
all, a plain 201/204) is `succeeded`, its body withheld rather than previewed, since a clean failure
here is exactly what would make an owner retry an already-done write under a new idempotency key; a
non-2xx stays `failed`; the one case left genuinely ambiguous (a response with no usable status at
all) is `unknown`. A `GET` with an unexpected content type stays `failed` regardless of status, as
before. Neither `failed` nor `unknown` is ever retried automatically — an `unknown` custom-tool
action is settled by hand (`gateway tools settle`), the same as any other namespace's.

**Secrets never reach anywhere but the request.** A definition names a secret by alias only; the
runner resolves it from its own secrets directory (file per alias, `gateway tools secret set
<alias>`, read-only to the runner) at the moment it builds the request, and the value is used to
fill exactly the slot the definition names — never logged, never part of a receipt or an error
(scrubbed, best-effort, even from a destination's own echo — see Outcomes above), never part of the
approval hash (only the *slot* a secret fills is ever part of what gets resolved and shown — never a
value, since none exists yet at approval time), and never written to any table this release's schema
has a column for. This is best-effort against a destination that echoes the credential back, not a
guarantee against one that is itself hostile: a destination the call actually reached already holds
every value it was sent, scrub or no scrub.

### Packaged utilities

`utility` is a second broker-executed, approval-gated kind, for a capability that is fixed,
image-shipped code — never owner-defined, never an arbitrary worker command. It exists alongside
`executor`/`custom_https` rather than folding into either: unlike `executor`, nothing registers a
utility's implementation at a tool runner's own discretion (it ships in this release's own image,
the same way a built-in native capability ships in a runtime adapter's own code); unlike
`custom_https`, nothing about it is owner-configurable. `BUILT_IN_UTILITY_ACTIONS`
(`@agent-gateway/contracts`) is the same kind of static, compile-time-known list
`BUILT_IN_EXECUTOR_ACTIONS` already is, seeded the same way (`ensureToolCatalogSeeded`) and routed
through its own fixed `utility` namespace and queue, with its own static `ToolExecutor`
registration in the tool runner (`utilityExecutor`) — no dynamic dispatch, since there is no
unbounded, owner-created set to enumerate the way `custom` has. Availability reflects whether a
currently healthy tool runner actually registers the action type, exactly like `executor`.

This release ships one utility, `utility.text-transform`, to prove the path: a deterministic,
side-effect-free string transform (trim/case/reverse/slugify) with a bounded input and output —
genuinely useful (producing a slug or a normalized form of a short piece of text), and deliberately
minimal. Being side-effect-free does not exempt it from a human turn: `MODES_BY_KIND` gives
`utility` the identical `require_approval`/`disabled` pair `executor`/`custom_https` have, because
the broker's approval gate is not a risk-based convenience this kind happens to clear on its own
merits — it is the only execution path the broker has at all.

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
  `attach_tool`/`detach_tool`/`update_attachment`, as a general editing primitive.** Rejected: a
  whole-list replace built from a stale read races a concurrent edit from elsewhere invisibly (the
  last write wins, silently discarding the other), where a targeted operation at least reports a
  clear "no attachment to update" or produces a deterministic, independent result regardless of what
  else is in the list. `set_tool_attachments` does exist, narrowly, for the one thing no targeted
  operation can express at all — marking an *existing* legacy agent hub-managed with an explicitly
  empty list (`tools adopt`'s own zero-attachments case, above); its only caller resolves the list
  it replaces and the revision it commits against together, in the same read, so the staleness this
  alternative was rejected for cannot arise through it.

## Consequences

- The Instruments & Utils hub (ADR-025's own "Instruments & Utils hub's management API" section)
  now reads and edits the catalog itself — listing, an entry's own detail, create/edit/delete for a
  `custom_https` entry, attach/detach/update and "Adopt into the tools hub" for an agent — alongside
  `gateway config export`/`import`/`diff`/`rollback` (which still print attachments as part of the
  bundle) and `gateway tools adopt`/`custom`/`secret` (still the only way to set a secret's value,
  or to adopt `--all` agents at once). The Agents hub's own general-purpose editor
  (`consoleShowAgent`'s `toolsHubManaged`) still shows a hub-managed agent's tool lists read-only,
  with a hint to use the Tools tab instead, and still refuses (preview and commit alike) a patch
  that edits them directly — editing them there would preview a change the bundle-mirror invariant
  then silently discards on commit, which is confusing precisely because that invariant is
  otherwise invisible from the console. A legacy agent's own `permissions` stay fully editable
  there, unaffected.
- Attaching, detaching or editing an attachment now changes what a hub-managed agent may actually
  do, on its very next turn — see "Effective permissions: compiled attachments as the single
  source of truth" below.
- `configSchema`/`settings` are bounded JSON, structurally validated only; nothing compiles a JSON
  Schema into an actual validator this release. An attachment's `settings` can hold anything that
  fits the bound regardless of what `configSchema` claims to require — a gap a later phase closes
  before `settings` drives anything real.
- `catalog_entry_versions` grows without bound, like the configuration journal and the audit log;
  nothing here adds its own retention pass.
- The Instruments & Utils hub also creates and edits a `custom_https` tool (client-side validation
  reusing `customHttpsDefinitionProblems` directly, a review step before committing) — `gateway
  tools custom create|edit` remains fully equivalent; `gateway tools secret set` remains the only
  way to set a secret's actual value (the console shows only whether an alias is set, read from the
  same mount, read-only).
- Rolling back to a release before this one keeps every existing table fully readable (ADR-020's
  expand-migration guarantee); `catalog_entries`/`catalog_entry_versions`/`catalog_attachments`/
  `catalog_entry_tombstones`/`config_attachment_snapshots` are simply additional tables (and, for
  `config_revisions`, an additional nullable column) an older release does not know about and does
  not need — `ConfigSnapshotBundleSchema` itself never gained a field for attachments at all, so an
  older release's own copy of that schema parses every snapshot this release ever writes exactly as
  it always has. A `config export` directory predating `tool-attachments.json` (or any directory
  simply missing that file) resolves to every agent's attachments carrying forward unchanged, never
  to `{}` unconditionally — see "Attachments: a document of their own" above. Rolling back past the
  `custom_https`/`utility` migrations (`0033`/`0034`) the same way leaves a custom tool's own
  `https_definition` column and `gateway_custom_tool_definition` simply unused rather than
  unreadable; a queued custom-tool action an older release's own tool runner cannot execute (it
  knows no `custom`/`utility` namespace) is settled by hand, the same as any action a decommissioned
  executor left behind.
