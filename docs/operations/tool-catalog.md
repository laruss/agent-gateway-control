# The tool catalog and effective permissions

What an agent may actually do, and how to change it. The data model is
[ADR-027](../adr/027-tool-catalog.md), which also documents the compiler rules in detail; this page
is the operational how-to.

## Two kinds of agent

- **Hub-managed**: the active revision's attachments document has an entry for this agent — it has
  been attached to, detached from, or had an attachment edited for, at least once. Its effective
  permissions come **only** from its compiled attachments; its `permissions` field in
  `gateway config export`/`gateway agents show` is a mirror of that compiled result (kept in sync on
  every attachment write), never an independent fact.
- **Legacy**: no attachments document at all. Its effective permissions are exactly its
  `permissions` lists (`tools_allow`/`tools_require_human_approval`/`tools_deny`), unchanged — the
  same hand-authored YAML behaviour the Gateway has always had.

Every agent starts legacy. Nothing converts one to hub-managed implicitly — not a catalog change,
not a reseed, not a rollback. An owner (or operator) opts an agent in explicitly, with
`gateway tools adopt` (below) or by attaching its first entry directly.

## Attaching and detaching

There is no console route for attaching, detaching or editing an entry itself yet (ADR-027); use
`gateway config` directly, or a future console surface once one exists. The Agents hub's own
editor does show whether an agent is hub-managed: its tool lists are read-only there, with a hint
to use the hub instead, and a patch that tries to edit them directly is refused (preview and
commit alike) rather than silently discarded by the bundle-mirror invariant on commit. A legacy
agent's `permissions` stay fully editable from the console, unaffected.

Attaching, detaching or editing an attachment takes effect on the
agent's **very next turn** — including a turn already scheduled but not yet started, and a queued
tool action or a still-pending approval for a capability just detached or turned `disabled`, which
are revoked or refused (with an audit entry) rather than left to run on a permission the hub no
longer shows.

An attachment's `mode` is bounded by its catalog entry's own `kind`, not only its risk floor:

| Kind | Example | Supported modes |
|------|---------|------------------|
| `native` | `repository.read`, `tests.run` | `allow`, `disabled` |
| `gateway` | `mattermost.post`, `memory.write` | `allow`, `disabled` |
| `executor` | `finance.payment.create` | `require_approval`, `disabled` |

`require_approval` on a native or gateway capability, or `allow` on an executor action, is refused
at attach time: neither has an enforcement point that can pause a turn mid-flight for a human.

Two things an attachment does **not** need restating:

- **Native dependencies.** Attaching `tests.run` also makes `repository.read` and
  `workspace.write` effectively usable, even though neither was attached itself — a runtime needs
  to read (and may need to write) the files a command touches. The compiled result's `impliedBy`
  shows which attached tool caused which implied one.
- **`memory.write`.** Detaching it (or never attaching it) removes the agent's memory-write
  authority outright — it shows up as an explicit denial, not silent absence, so the rendered
  prompt and the turn's own authority check always agree.

One thing it cannot express yet: an **adapter-specific prerequisite**. Codex reads files only
through its shell, so `repository.read` alone gives a Codex-adapter agent no file access at all —
attach `tests.run` too, for that agent, or the grant is real but inert. The compiled result's
`missingPrerequisites` names this when it applies; nothing attaches the prerequisite for you.

Finance capabilities (`finance.*`) compile in only for the organization's `finance_agent_id`:
attaching one to any other agent is accepted (it is a valid catalog entry) but grants nothing at
all, exactly like `config-bundle.ts`'s finance rules already require for hand-authored
`permissions`.

## Checking an agent's effective permissions

No console route yet. From a shell with access to the Gateway's database and `gateway` CLI:

```bash
gateway config export /tmp/export   # tool-attachments.json alongside the bundle
gateway agents show <agent-id>      # permissions as currently stored (the compiled mirror, for a
                                     # hub-managed agent)
```

For the full compiled detail (`impliedBy`, `missingPrerequisites`, unresolved legacy patterns), use
`gateway tools adopt <agent-id> --dry-run` (below) even on an agent you do not intend to adopt — it
never commits anything in `--dry-run` and reports the before/after effective permissions either way.

## Adopting a legacy agent

`gateway tools adopt <agent-id>|--all [--dry-run] [--reason <text>]` converts a legacy agent's
current `permissions` lists into real, recorded attachments (ADR-027's legacy conversion:
`tools_deny` → `disabled`, `tools_require_human_approval` → `require_approval`, `tools_allow` →
`allow`, matched against catalog entries known right now). It is the only way an agent becomes
hub-managed from its existing configuration rather than from attaching entries one at a time.

```bash
gateway tools adopt developer --dry-run   # preview: before/after, unresolved patterns
gateway tools adopt developer             # commit: one revision for this agent
gateway tools adopt --all                 # every currently legacy agent, one revision each
```

Each agent's own JSON result names:

- `alreadyHubManaged`: `true` means nothing was touched — adopting an already hub-managed agent
  again would silently overwrite real, deliberate attachments with a legacy reconstruction of a
  `permissions` list the hub may have long since stopped reflecting, so it never happens.
- `unresolved`: every pattern that matched no catalog entry known right now (e.g. a future
  capability's pattern, or a typo) — never silently dropped.
- `before`/`after`: the effective permissions before and after, in the same shape as
  `permissions`. They are identical whenever every pattern resolved to a known entry — the whole
  point of a safe migration — **except** `memory.write`: an agent that never explicitly denied it
  gains an explicit `tools_deny` entry for it once adopted, because hub-managed `memory.write`
  defaults to denied-unless-attached, where legacy defaults to allowed-unless-denied. Review this
  specific line before committing; attach `gateway-memory-write` (`allow`) first if the agent should
  keep writing memory.
- `problems`: a resolved pattern whose mode its own catalog entry's `kind` does not support (see
  the table above) — found before attempting a commit that would otherwise refuse it. Non-empty
  means nothing was committed, `--dry-run` or not.

`--all` commits one revision **per agent**, never a single combined one: a batch could exceed the
change-set size limit, and one agent's adoption failing must never block another's.

An agent whose legacy conversion resolves to zero attachments (every pattern unresolved, or no
`permissions` at all) is still adopted — it becomes hub-managed with an explicitly empty list,
denying every tool (the same default-deny effect as having no permissions at all). Review
`unresolved` first: a non-empty list there means some of the agent's original intent had no known
catalog entry to resolve against and is dropped by adopting, not preserved.

Each agent's own resolved attachments and the revision they are committed against are read
together, right before committing: a concurrent change elsewhere (another attach, a YAML edit to
the same agent's `permissions`) between when `tools adopt` reads an agent and when it commits is
refused as a conflict, rather than silently overwritten by a commit built from the stale read.

## Rollback safety

Because a hub-managed agent's `permissions` field is kept mirrored to its compiled attachments on
every write, rolling the binary back to a release before this phase (which enforces only
`permissions`, knowing nothing about attachments) still enforces the same effective permissions.
Nothing about attachments or the compiler needs to be undone before a rollback; only outstanding
version 3 turn inputs do (see [ADR-023](../adr/023-console-and-operator.md)'s turn input version 3
section) — settle or cancel them first, the same deploy-runbook step a version 2 rollback already
needed.
