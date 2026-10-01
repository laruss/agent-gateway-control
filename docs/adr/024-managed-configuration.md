# ADR-024. Managed configuration: immutable snapshots and a revision journal

- Status: Accepted
- Date: 2026-10-01

## Context

Today `gateway config apply` is the only way to change configuration: an operator edits YAML
files and runs the CLI. `applyConfig` computes a content hash (`config_versions.version`) and
stores the organization and constitution, but agent definitions and resolved role prompts of a
*replaced* version are never retained — only the current `agents.config`/`agents.role_prompt`
hold them, and an apply overwrites both. There is no record of when a configuration changed, who
changed it or why, and no way to reconstruct a prior configuration's complete content once it is
replaced.

A web console and management agents need to mutate configuration directly in PostgreSQL rather
than only through a YAML file and a CLI apply, and need a reliable way to show history, diff two
points in time and roll back. This decision provides the storage foundation — persisted immutable
snapshots and an append-only revision journal — together with a shared prepare/commit service that
applies a typed change set to them, and the CLI surface (`export`/`diff`/`import`/`history`/
`rollback`) that reads and writes through it. `gateway config apply` keeps working exactly as
before, now as a documented, deprecated alias that also contributes to the revision journal every
other surface reads. A console actually showing this history, or a management agent proposing a
change through it, is out of scope: this decision gives both a service and a CLI to build on, not
a Mattermost- or browser-facing surface of their own.

## Decision

- **PostgreSQL becomes the authoritative store of configuration history going forward.**
  Immutable, content-addressed `config_snapshots` hold the complete, reproducible bundle —
  organization, every agent definition, the constitution and every agent's resolved role prompt —
  that a configuration apply produces. A snapshot's `hash` is the same canonical sha256 as
  `config_versions.version` of the same content (`canonicalHash` over the same fields, with
  agents sorted by id so input order never affects it), so the two agree without a foreign key
  between them: not every `config_versions` row gets a snapshot (see below). A snapshot's
  `format` integer records the bundle shape version, open for a later revision of the schema.
- **A chronological `config_revisions` journal records every applied change**, even one that
  repeats an earlier snapshot's content verbatim: a re-apply or a rollback gets its own revision
  id, pointing at the same `snapshot_hash`, rather than overwriting or reusing an existing
  revision. Each revision names its `parent_revision_id` (the revision it replaced, null for the
  very first ever recorded), the `generation` it produced (equal to
  `gateway_controls.config_generation`), the `actor`, a `source` — `cli_apply` (`config apply`,
  and `agents enable`/`disable`, which commit a `set_agent_enabled` change set under the same
  source), `backfill` (`ensureConfigHistory`), `rollback` (`config rollback`) and `import` (`config
  import`) are all recorded today; `console` and `agent` remain reserved, for a web console and a
  management agent that do not exist yet — and an optional bounded `reason`.
- **Both tables are append-only**, the same way `audit_log` already is: a trigger rejects UPDATE,
  DELETE and TRUNCATE. History cannot be rewritten by any role, including the owner's.
- **`gateway_controls.active_config_revision`** names the revision that produced the active
  configuration; nullable, with no foreign key — matching how `active_config_version` already
  points at `config_versions` without one, since the row it names is always written first, in the
  same transaction that sets it.
- **`applyConfig` writes a snapshot and a revision in the same transaction** as it stores
  `config_versions`/`agents`: the snapshot insert is `onConflictDoNothing` (content-addressed,
  and a re-apply's content may already exist), the revision is chained to the previously active
  one, and `active_config_revision` advances alongside `active_config_version`/
  `config_generation`. `ConfigApplyResult` gains `revisionId`; every existing field is unchanged.
- **`config_versions`, `agents.config` and `agents.role_prompt` keep their existing shape and
  meaning.** Every reader of them today — the scheduler, the turn context, the CLI's own
  `config apply` output — is unaffected, and they remain the compatible projections 0.3.0 reads,
  through the rollback window and beyond.
- **History before this release is unavailable, not reconstructed.** A database upgraded from a
  release before these tables existed has no record of past agent definitions or role prompts
  beyond whatever the active `config_version` and the still-live `agents` rows hold; a *disabled*
  agent's stale row (its `config_version` lagging behind the active one) reflects an older,
  no-longer-active version and is excluded — but an *enabled* stale row is retained in the backfill
  instead, under its own stored configuration and role prompt: a release before this one could
  re-enable an agent's row directly after it had already left the active configuration, and
  routing and scheduling run every row regardless of its `config_version` (`loadAgents`), so
  history must reflect what is actually running or the agent becomes impossible to disable or
  remove through the normal path (`commitChange` refusing it as "does not exist").
  `ensureConfigHistory`, in TypeScript rather than the migration, synthesizes exactly one snapshot
  and one revision for the active configuration the first time it finds `active_config_revision`
  null or stale
  (`ensureConfigHistoryIn` also treats a recorded revision whose generation, or whose agents' live
  `enabled` projection (including such a retained row), has drifted from what it names as needing
  a fresh backfill — not only a never-recorded one), keyed by the existing `active_config_version`
  hash, and marks the snapshot's `origin` as `backfill` rather than `applied`. It runs at
  controller startup and inline at the start of every `applyConfig`/`prepareChange`/`commitChange`
  call, re-checking for drift every time rather than only once, so the backfill happens whether the
  next thing to occur is a restart, a plain `config apply`, or any change committed through the
  shared prepare/commit path; it is a no-op once the recorded revision already agrees with the live
  projections, or there is no active configuration at all. `gateway doctor` is read-only and never
  triggers this itself; `configHistoryNeedsBackfill` answers the same question without writing, so
  a first post-upgrade `doctor` run (before anything else has backfilled) still reports the drift
  truthfully instead of "no drift" from a journal that has simply not caught up yet.
- **Disabling an agent whose own retained configuration no longer validates commits `remove_agent`
  instead of `set_agent_enabled`.** A row backfilled enabled from outside the active snapshot
  carries whatever configuration it was last given, which current whole-bundle validation may since
  have started rejecting on its own (independent of its `enabled` flag); merely flipping that flag
  would still fail the same validation and leave the agent permanently impossible to disable.
  `gateway agent disable` tries `set_agent_enabled` first and falls back to `remove_agent` only
  when that specifically resolves the problem; its projection row still only becomes disabled,
  never deleted.
- **The migrations are `expand`** (ADR-020): `config_history` (the two tables and the column),
  `config_history_guards` (the append-only triggers), `config_revision_idempotency`
  (`idempotency_key`/`change_hash`) and `config_revision_acks` (the acknowledgement table below)
  keep 0.3.0 fully working against the resulting schema; nothing existing changes shape or
  meaning.
- **A drift signal clears by acknowledgement, not merely by review.** The most recently recorded
  revision being a `backfill` *with* a `parent_revision_id` (as opposed to the very first one ever
  recorded, which has none) means a release before this one changed the configuration outside the
  journal — most likely during a rollback interval; it fires the `config:backfill` alert and fails
  `gateway doctor`'s `config_history` check. Reviewing it with `config diff`/`history` does not
  clear either on its own: `commitChange` treats identical content as a no-op,
  so recommitting the drifted revision's own reviewed content, or `config rollback` to it, writes
  no new revision to supersede it. `config_revision_acks` (one row per revision, naming the actor
  and when) records that a human reviewed and accepted it; `gateway config ack <revision-id>`
  writes it, and the alert/check clear once the latest revision is acknowledged or actually
  superseded by a later one — whichever comes first.

## Alternatives

- **Reconstruct historical snapshots for every past `config_versions` row during the migration.**
  Rejected: the join to `agents` only has the *current* definitions of the presently active
  version; the agent rows of a replaced version were never retained. Reconstructing a history that
  is already lost would misrepresent what the Gateway can actually prove happened.
- **Compute the backfill hash in SQL, inside the migration.** Rejected: canonical hashing of a
  configuration bundle is application logic (`canonicalHash` plus explicit agent sorting) already
  implemented in TypeScript; duplicating it in PL/pgSQL risks a hash that silently does not match
  `config_versions.version`, defeating the point of a content-addressed snapshot. The migration
  adds only the schema; `ensureConfigHistory` in `packages/core` performs the backfill with the
  same function `applyConfig` itself uses to build and hash the bundle.
- **A materialized parent chain with no separate snapshot table.** Rejected: a revision and a
  snapshot answer different questions — what changed, when and by whom, versus what the
  configuration actually was — and separating them is what lets a rollback or a repeated apply
  create new history while reusing existing content, instead of inventing a new blob for bytes
  already stored.

## Consequences

- Every `config apply` now writes two additional rows (one of them often a no-op insert, since
  content hashes are reused) in the same transaction; this adds negligible latency to an
  operation that is already infrequent and already transactional.
- A console or a management agent can build on this service and CLI to show a true chronological
  history, diff two revisions' snapshots, and roll back — exactly what `gateway config
  diff`/`history`/`rollback` already do by calling `prepareChange`/`commitChange` directly, which
  neither a console nor a management agent does yet.
- History recorded before this release is exactly one synthesized entry: the active configuration
  at upgrade time, marked `backfill`. Anything the owner wants provably retained from before this
  release needs one re-apply (even of unchanged content) to acquire a first-class revision.
- Rolling back to a release before this one keeps `config_versions`/`agents` fully readable
  (ADR-020's expand-migration guarantee); `config_snapshots`/`config_revisions` are simply
  additional tables an older release does not know about and does not need.
- `gateway config export`/`diff`/`import`/`history`/`rollback`/`ack` (see below) read and write
  this journal directly; `config apply` remains a working, deprecated alias so existing scripts and
  the install/upgrade/rollback runbooks keep working unchanged.

## Change sets: a shared prepare/commit path

A web console and management agents need to change configuration directly, in smaller pieces than
a whole YAML bundle, without duplicating `config apply`'s validation and projection-writing. A
typed change set — an ordered list of operations (`replace_bundle`, `update_agent`,
`set_role_prompt`, `set_agent_enabled`, `add_agent`, `remove_agent`, `set_constitution`) — is
applied, in memory, to the active snapshot bundle; the result is validated by the same whole-bundle
rules `config apply` already enforces.

- **`prepareChange` is read-only.** It loads the active revision's bundle, applies the change set,
  and returns a preview: the base revision and its hash, the resulting hash, whether anything would
  actually change (`noop`, when the two hashes agree), a deterministic structural diff, and any
  validation problems. Nothing is written; a console shows this preview before anyone commits it.
- **`commitChange` writes through the same transactional path `config apply` always has**
  (`writeConfigRevisionIn`): the `gateway_controls` row locked first, the snapshot and revision
  inserted together, agent projections upserted, channel tombstones and scheduling run exactly as
  before. `applyConfig` itself now calls this path with a `replace_bundle` change set; the CLI has
  no revision it expects to still be active, so it reads the current one itself and always
  proceeds, recording a new revision even over identical content (the CLI's own re-apply has always
  worked this way). `commitChange`'s callers, instead, name the revision they built their change
  set against:
  - **Conflict.** If the active revision has moved on since, the commit is refused with
    `ManagementConflictError`, naming the revision that is now active, so the caller re-prepares
    and retries against it instead of silently overwriting someone else's change.
  - **No-op.** If the change set resolves to the same content the base revision already has,
    nothing is written — no snapshot, no revision, no projection update — and the base revision is
    returned as the result. `config apply`'s own long-standing behavior (a re-apply of identical
    YAML still gets a fresh revision) is unchanged; only this finer-grained path treats "nothing
    actually changed" as nothing to record.
  - **Idempotency.** A commit may carry a caller-chosen key; a repeat with the same key returns the
    first commit's result without writing anything again, even once the active revision has since
    moved on (the first commit already succeeded). The same key reused with a different change set
    is rejected rather than silently applied. A no-op commit stores no key — there is nothing to
    deduplicate, since it never wrote a row in the first place.
- **Enabling or disabling an agent is now a configuration change, not just operational state.**
  `gateway agent enable`/`disable` commits a `set_agent_enabled` change set through this path
  instead of flipping `agents.enabled` directly, so the action appears in the revision journal with
  its actor and is reflected in the next snapshot — closing the gap where a later `config apply`
  would otherwise silently revert it. Pause and resume remain operational state and are unaffected.
  Its `source` is `cli_apply`, the same as `config apply` itself: no migration `CHECK` distinguishes
  it, since nothing today reads `source` to tell the two apart.
- **Stored agent configuration and snapshot bundles are parsed, not trusted, where this service
  reads them**, so a malformed row fails with a clear error instead of propagating corrupt data
  into a diff or a new snapshot; a validated bundle is cached in-process by its own content hash,
  since a snapshot never changes once written, bounded to the last 16 distinct hashes read (LRU)
  and deep-frozen so a caller cannot mutate the shared cached object.

## CLI: export, diff, import and rollback

YAML becomes an import/export format rather than the only way to change configuration:
`gateway config validate`/`config apply` keep working exactly as before (`config apply` is now
a documented, deprecated alias — see below), and six more commands read and write through the
same `prepareChange`/`commitChange` path as any other change set.

- **`config export <dir>`** writes a revision's snapshot (the active one, or `--revision <id>`) as
  a config directory: `organization.yaml`, `agents/<id>.yaml`, and every prompt file at the exact
  path its bundle already names (`organization.constitution_file`, each agent's
  `prompts.role_file`), so nothing in the bundle's own content is rewritten and it reads back to
  the identical hash. A `manifest.json` records the format, the revision and snapshot id, and each
  file's sha256; two exports of the same revision are byte-for-byte identical (the manifest carries
  no timestamp). `<dir>` must not exist yet, or must already be an empty directory — export never
  deletes or reuses existing content, so an operator who wants to replace a previous export removes
  it themselves first. A fresh directory is built off to the side and put in place with one
  same-filesystem rename, so a failure never leaves a partial export at `<dir>`. The prompt paths
  are relative to whatever root the original import used, which export cannot know, so importing
  the directory back needs `--root` set to the export directory itself — the same convention a
  mounted `/config` already uses with `gateway config apply /config --root /config`.
- **`config diff <dir>`** loads a directory, builds a `replace_bundle` change set and runs
  `prepareChange`: read-only, printing the structural diff (or the raw preview with `--json`).
- **`config import <dir>`** commits that same change set through `commitChange`, source `import`.
  `--expected-revision` is required once a configuration is active (refused otherwise, naming the
  current revision so the operator runs `config diff` first); a fresh database with none yet
  accepts none. The change set is built from the canonical bundle (`configSnapshotBundle`, agents
  sorted by id), not the directory's own file order, so renaming an agent's YAML file never changes
  the idempotency key's `changeHash`. Its idempotency key is derived from the expected revision and
  the directory's own content hash, so retrying an identical import after a transient failure
  replays the first commit instead of writing a second revision; the CLI reports that replay as
  such, naming the revision it replays and, when the active revision has since moved past it, a
  clear warning naming the one that is now active instead.
- **`config rollback <revision-id> --expected-revision <id>`** commits a new revision (source
  `rollback`) whose content is `<revision-id>`'s own snapshot — never a pointer reset — printing
  the diff against the current active configuration first (the CLI is non-interactive;
  `--expected-revision` already guards against rolling back over a change made since the operator
  last looked).
- **`config history`** lists the journal's most recent entries: id, created, actor, source, a
  shortened snapshot hash, parent and reason.
- **`config ack <revision-id>`** records an acknowledgement for the named revision (see the
  `config_revision_acks` bullet above); it writes no configuration change or revision of its own.
- **`config apply` is now a deprecated compatibility alias.** Existing scripts call it without
  `--expected-revision`; it keeps applying against the current active revision exactly as before
  (through `applyConfig`, unchanged) and prints a deprecation note on stderr recommending
  `config import --expected-revision` instead.

Every `rolePrompts` key in a committed bundle must name a configured agent, and both the
constitution and every role prompt are bounded by the same limit `set_role_prompt` already
enforces (`RolePromptSchema`, 50,000 characters, no unsafe characters) — enforced once, in
`configBundleProblems`, so every path that can write a bundle (`config apply`, `commitChange`'s
own operations, and `config import`'s `replace_bundle`) agrees with what `config export` can
actually reproduce and `config import` can read back.

Path safety on import covers both `<dir>` and `--root` (which may differ: an operator-supplied
`<dir>` of `organization.yaml`/`agents/*.yaml` can point prompts at a separately mounted `--root`).
Every entry anywhere in `<dir>`, walked recursively, must be a regular file or a real directory —
never a symlink, a FIFO, a socket or a device — and bounded in size; `organization.yaml` and
`agents/*.yaml` are checked by name too. `readPromptFile` gives every prompt path under `--root`
the same check, one path component at a time (lstat, never follow a symlink, the final component a
regular file under the size bound) before opening it, so a FIFO under `--root` cannot hang the CLI
and a symlink is refused even one that would resolve back inside `--root`. A present
`manifest.json`'s recorded hashes must match the files on disk, its own keys must themselves be
safe relative paths (no `..`, no absolute path, normalized) before any is ever joined with `<dir>`,
the directory must then contain nothing else, and `--root` must be `<dir>` itself: an export's
prompt paths are only ever relative to the directory it was written into, never to an unrelated
`--root` (a hand-written directory with no manifest is accepted as-is, whatever `--root` is, once
every entry in it has passed the walk).
