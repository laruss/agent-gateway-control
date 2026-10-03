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

The **Instruments & utils** hub (the console's own sidebar entry) and the Agents hub's own
**Tools** tab both attach, detach and update an attachment, through the same console routes
(`/api/tools*`, `/api/agents/:id/tools*`) `gateway config`/`gateway tools adopt` already use
underneath — attaching, detaching or updating an attachment always goes through
`prepareChange`/`commitChange`, so a config revision records it and `gateway config rollback`
covers it exactly as before (see "What config rollback covers" below for what it does not). The
hub's own entry detail page shows an
entry's version history, every agent currently attached to it (with its mode and pinned version)
and an "Attach to agent" action; deleting or editing it there affects every agent listed, shown as
the delete confirmation's own impact before anything commits. The Agents hub's **Tools** tab shows
one agent's requested attachments against its effective, compiled access side by side (below), and
is where attach/detach/mode changes and "Adopt into the tools hub" (below) happen for that one
agent. The CLI (`gateway tools adopt|custom|secret`, `gateway config`) remains fully equivalent —
neither surface is the only way, and either one sees the other's changes immediately.

The Agents hub's own general-purpose editor (the Permissions tab) still shows whether an agent is
hub-managed: its `tools_allow`/`tools_require_human_approval`/`tools_deny` are read-only there,
with a hint to use the Tools tab instead, and a patch that tries to edit any of them directly is
refused (preview and commit alike) rather than silently discarded by the bundle-mirror invariant on
commit — `observe_system` is the one part of `permissions` still editable there even for a
hub-managed agent, since compiled attachments never touch it. A legacy agent's whole `permissions`
stays fully editable from the console, unaffected.

Attaching an entry to a still-**legacy** agent for the first time (its attachments document does
not exist yet) converts its current `permissions` lists into real attachments first, in the same
revision — exactly the conversion `gateway tools adopt` (below) performs, committed alongside the
attachment actually requested. Never just that one attachment on its own: the bundle-mirror
invariant replaces `permissions` with the compiled result on the very commit that first gives an
agent an attachments document, so attaching one entry without first carrying the rest forward
would silently drop everything else the agent's legacy `permissions` used to cover (an agent
allowed `mattermost.post` loses it the moment anything else is attached, unless this conversion
runs first). The command's own JSON result names what it converted, under `legacyConversion`; if
the conversion cannot resolve cleanly — a legacy pattern's mode its own catalog entry's `kind` does
not support (the same `problems` check `gateway tools adopt` makes), **or an allow or approval
pattern is unresolved** (names no catalog entry known right now, e.g. `memory.read` or `mail.send`) —
the attach is refused outright, nothing committed, with a pointer to run
`gateway tools adopt <agent-id>` first to resolve it under full review (which shows every unresolved
pattern before committing anything, rather than this implicit shortcut silently dropping it) before
attaching anything new. The console's own attach dialog binds this implicit conversion to the exact
one its agent-tools read showed, the same way "Adopt into the tools hub" already binds its own
confirm step: a catalog entry created, edited or deleted since that read is a `409`, never a commit
built from a conversion the owner never actually saw.

Attaching, detaching or editing an attachment takes effect on the
agent's **very next turn** — including a turn already scheduled but not yet started, and a queued
tool action or a still-pending approval for a capability just detached or turned `disabled`, which
are revoked or refused (with an audit entry) rather than left to run on a permission the hub no
longer shows.

**Detaching (or deleting an entry entirely) never widens what an agent may actually do.** An
attached `disabled`/`require_approval` can be the only thing suppressing a native dependency's
implication (`tests.run` implying `workspace.write`): removing it would otherwise let that
implication through the moment nothing explicit governs the implied tool any more. Both the Tools
tab's own "Detach" and the hub's own entry-delete each compute every affected agent's effective
permissions before and after the removal, and refuse — nothing committed, the console shows which
tool would widen, for which agent — the moment any agent would gain anything. Detaching one
attachment for one agent can be confirmed anyway (the Tools tab's own "Detach anyway", once it has
shown the warning) since it is a normal, deliberate edit; deleting a catalog entry has no such
override — an owner who means to widen several agents at once detaches or reconfigures each one
individually first, under full review, rather than through one blanket confirm.

An attachment's `mode` is bounded by its catalog entry's own `kind`, not only its risk floor:

| Kind | Example | Supported modes |
|------|---------|------------------|
| `native` | `repository.read`, `tests.run` | `allow`, `disabled` |
| `gateway` | `mattermost.post`, `memory.write` | `allow`, `disabled` |
| `executor` | `finance.payment.create` | `require_approval`, `disabled` |
| `custom_https` | an owner-defined HTTPS tool | `require_approval`, `disabled` |
| `utility` | `utility.text-transform` | `require_approval`, `disabled` |

`require_approval` on a native or gateway capability, or `allow` on a `custom_https`/`executor`/
`utility` action, is refused at attach time: the broker-executed kinds have no enforcement point
that can pause a turn mid-flight for a human on their own, and this release adds no second,
approval-free path through the broker — so every one of them always needs a human, side-effect-free
or not. Both attach dialogs' own mode picker already filters to this table (and to the entry's own
risk floor), so a mode that would be refused this way is never offered in the first place.

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

The Agents hub's own **Tools** tab (`GET /api/agents/:id/tools`) is the full compiled detail in one
place: requested attachments (recorded, for a hub-managed agent; a read-only preview of what its
`permissions` convert to, for a legacy one) against effective `allow`/`requireApproval`/`deny`,
implied capabilities (`impliedBy`), an unmet adapter prerequisite (`missingPrerequisites`), unresolved
legacy patterns and whether memory writes are allowed — the console explains there, plainly, that
`tests.run` grants general sandboxed command execution: hiding a utility entry from the hub cannot
retract a binary from an agent already granted a shell on an earlier turn.

From a shell with access to the Gateway's database and `gateway` CLI, the same facts are reachable
without the console:

```bash
gateway config export /tmp/export   # tool-attachments.json alongside the bundle
gateway agents show <agent-id>      # permissions as currently stored (the compiled mirror, for a
                                     # hub-managed agent)
```

For the full compiled detail (`impliedBy`, `missingPrerequisites`, unresolved legacy patterns) from
the CLI, use `gateway tools adopt <agent-id> --dry-run` (below) even on an agent you do not intend
to adopt — it never commits anything in `--dry-run` and reports the before/after effective
permissions either way.

## Adopting a legacy agent

`gateway tools adopt <agent-id>|--all [--dry-run] [--reason <text>]` converts a legacy agent's
current `permissions` lists into real, recorded attachments (ADR-027's legacy conversion:
`tools_deny` → `disabled`, `tools_require_human_approval` → `require_approval`, `tools_allow` →
`allow`, matched against catalog entries known right now). It is the only way an agent becomes
hub-managed from its existing configuration rather than from attaching entries one at a time. The
Agents hub's own Tools tab offers the identical conversion as "Adopt into the tools hub", for one
agent at a time: a dry-run preview (`GET /api/agents/:id/tools/adopt`) showing the same
before/after/unresolved/problems this section describes, and a commit
(`POST /api/agents/:id/tools/adopt`) once reviewed — `--all` stays CLI-only, since the console's own
editor works one agent at a time by design.

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

## Custom HTTPS tools

An owner can define their own HTTPS-backed tool — "create a ticket in service X" — without a code
change: a fixed destination and method, typed parameters mapped into encoded path/query/header/body
slots, named secrets the tool runner alone resolves, and response limits. See
[ADR-027](../adr/027-tool-catalog.md)'s custom HTTPS tools section for the full model and the
egress guard; this is the day-to-day how-to.

### 1. Write the definition

A JSON file matching `CustomHttpsDefinitionSchema`:

```json
{
  "host": "api.example.com",
  "pathTemplate": "/tickets/{priority}",
  "method": "POST",
  "parameters": [
    { "name": "priority", "slot": "path", "slotName": "priority", "type": "enum",
      "values": ["low", "high"] },
    { "name": "summary", "slot": "body", "slotName": "summary", "type": "string",
      "minLength": 1, "maxLength": 500 }
  ],
  "secretSlots": [
    { "alias": "ticket_api_key", "slot": "header", "slotName": "Authorization" }
  ],
  "idempotency": { "headerName": "Idempotency-Key" },
  "responseLimits": {
    "maxResponseBytes": 65536,
    "allowedContentTypes": ["application/json"],
    "timeoutMs": 10000
  }
}
```

A few rules the definition can never work around:

- Every `{placeholder}` in `pathTemplate` names exactly one `path`-slot parameter, and vice versa.
- No two parameters (or a parameter and a secret) ever target the same slot — header names compare
  case-insensitively, since two differently-cased spellings are the same HTTP header — and none of
  them may target the idempotency header either.
- A secret may never sit in the `path` (it would be visible, and the approval card shows the
  resolved path).
- A write (anything but `GET`) must declare `idempotency`; a `GET` must not — a write without a
  provider-supported idempotency mechanism is refused as a definition outright, before it is ever
  saved.
- `host` is a DNS hostname, never a literal address — not that it would help: the egress guard
  classifies every literal and resolved address alike at execution time regardless (below).
- No parameter may be named `custom_tool_definition_version` — reserved for the controller's own
  version pin (below).
- `responseLimits.includeBodyPreview` (default `true`) can be set `false` to withhold the response
  body preview from every receipt this tool ever produces, success or failure alike — for a
  destination whose body should never reach an agent regardless of how well scrubbing works.

A model's own request may leave every typed parameter out, if the definition declares none (a
fixed call whose only moving part is a named secret) — still approvable, since the controller's own
version-pin parameter (below) is enough on its own for `needs_human` to require at least one.

### 2. Set its secret

```bash
gateway tools secret set ticket_api_key
```

Hidden entry, confirmed, written verbatim to the tool runner's own secrets mount
(`$GATEWAY_HOME/secrets/custom-tools/<alias>` in the release bundle, `/run/custom-tool-secrets/`
inside the container) — never the model, the database, logs, an approval or an error. Restart the
tool runner (`bin/agw restart gateway-tool-runner`) to pick it up. Setting a value is CLI-only; the
console entry detail page lists every alias a definition names and whether each is set (a boolean
only, read from the same mount, read-only) and prints this exact command for an alias still
unset — a value is never collected or shown there.

### 3. Create and attach it

Through the console: **Instruments & utils → New custom HTTPS tool** — the same fields as the
definition file below, with client-side validation mirroring `customHttpsDefinitionProblems` and a
review step showing exactly what will be sent before it commits; then its own entry detail page's
**Attach to agent** action. Through the CLI:

```bash
gateway tools custom create zendesk-ticket \
  --name "Create Zendesk ticket" --description "Files a support ticket." \
  --definition ticket-definition.json
gateway tools adopt finance --dry-run   # or attach it directly through `gateway config`
```

Its action type is `custom.<entry-id>` (`custom.zendesk-ticket` here); a tool runner must serve the
`custom` namespace for it to be reachable at all (`TOOL_RUNNER_NAMESPACES=custom`, `gateway db
grant-tool-runner <role> custom`).

### 4. An agent's own pinned version, and what editing invalidates

An agent's attachment of a custom tool either pins an exact version (a positive integer) or tracks
current (`null`, the default when attaching without one). An approval request is always prepared,
hashed and (at grant time) executed against **the requesting agent's own selected version** — its
pin, or whatever is current when unpinned — never blindly "the entry's current version": an agent
pinned to version 1 stays on version 1's exact definition content even once the entry has moved on
to version 2, and the approval card's own request preview (below) reflects that same pinned
content, never the newer one.

`gateway tools custom edit zendesk-ticket --definition updated.json` (or the console entry detail
page's own **Edit**, the identical form pre-filled with the current definition) publishes a new,
immutable version. For an agent that tracks current (unpinned), an approval still pending against
the previous version is refused at grant time — the owner sees "this custom tool was edited... it
must be requested again", never a silent execution against the new definition instead of what was
actually shown and hashed. For an agent pinned to an older version, editing the entry changes
nothing for it at all: its own pending and future requests keep resolving, and executing, against
exactly the version it is pinned to — re-pinning or unpinning the attachment itself is what
invalidates a still-pending request instead, caught the same way (the stored action's pinned
version no longer matching what the agent is now configured to use). A built-in entry's own **Edit**
only ever offers name/description, in either surface — its `kind`, `implementationKey`, risk floor
and supported adapters describe a real integration this release ships, not something an edit can
redefine.

The approval card itself shows an authoritative, secret-free **request preview** — method, the
resolved path, query/header/body field names, a secret-filled slot named but never its value — in
its own block, separate from the model's own free-text summary: the summary is the agent's prose,
the preview is exactly what will run.

### What config rollback covers

`gateway config rollback <revision>` restores a config revision's own bundle and attachments
document — so attaching, detaching, updating or (through "Adopt into the tools hub") converting a
legacy agent's attachments is always covered, since each commits a revision. The catalog entry
itself is not part of any config revision at all: creating a custom HTTPS tool, publishing a new
version of one (`gateway tools custom edit`, the console's own **Edit**), and deleting an entry
with nothing currently attached to it (no `clear_tool_attachments` commit, since there is nothing to
clear) each change the catalog's own tables directly, with no revision recorded and so nothing a
config rollback ever touches. Deleting an entry that *is* attached to at least one agent is a mix of
both: the attachment-clearing half is a revision rollback restores, but the entry's own `deleted_at`
and (for a built-in) its tombstone are not — rolling back to a revision that still named the entry
re-creates its `catalog_attachments` row, never the entry itself, which would fail outright were the
entry actually gone; a deleted entry's row and every past version instead stay readable forever
(ADR-027), exactly so that this restore can still happen. There is no "rollback" for the catalog
tables themselves: a wrong edit or an unwanted delete is undone with another edit, or (for a
non-built-in entry) accepted as permanent — entry ids are never reused.

### Egress, outcomes and the response the agent sees

The tool runner resolves `host` once, refuses a private, loopback, link-local, carrier-grade-NAT,
multicast, reserved or documentation IPv4 address in any notation (dotted, decimal, octal, hex);
IPv6 is an allow-list the other way (only global unicast, `2000::/3`, minus the special-purpose
ranges carved out of it — 6to4, Teredo, documentation, benchmarking, ORCHIDv2, both NAT64
prefixes — and minus every non-global form the IPv4 rules already cover, such as unique-local,
link-local or an IPv4-mapped address). The tool runner then connects to exactly the address it
resolved — never re-resolving, which is what defeats DNS rebinding. Redirects are never followed. A
response over its own size limit settles the moment the overflow is detected, never left waiting on
a further stream event. One overall deadline covers DNS through the response body (`timeoutMs`,
combined with a kill-all/agent-disable/runner-stop signal) — a destination trickling the response
one byte at a time cannot outlast it the way a socket-idle timeout could be made to.

An action's outcome is always one of: `succeeded` (a receipt — status code and a response preview,
collapsed to one line and bounded, every secret value and the forms this executor could have put it
on the wire in scrubbed — best-effort against a destination that echoes it back; a hostile
destination already holds whatever it was sent regardless. A write whose request was fully sent and
that comes back with a content type the definition does not allow is still `succeeded` when the
status is 2xx — the body is withheld, not previewed, since a clean `failed` here is exactly what
would make an owner retry an already-done write under a new idempotency key), `failed` (a clean,
known refusal — blocked address, a `GET` with a bad content type, the destination's own 4xx/5xx), or
`unknown` (an abort — a timeout or a cancellation — or a connection reset **after** the request was
already sent, sent meaning the TLS handshake itself completed, not merely that the body was handed
to the socket — never retried automatically; settle it by hand with `gateway tools settle` after
checking the provider by the action's own idempotency key).

## Packaged utilities

`utility.text-transform` is this release's one packaged utility: a fixed, image-shipped
implementation (not an arbitrary worker command) with a typed input and a bounded,
side-effect-free output, proving the path a future utility would also take. It attaches and
approves exactly like a `custom_https`/`executor` action (see the mode table above) — being
side-effect-free does not exempt it from a human turn, because the broker has no second,
approval-free execution path. Its availability reflects whether a currently running tool runner
actually serves the `utility` namespace. Its input is bounded (400 characters), but `upper`/`lower`
are Unicode case mapping, not a 1:1 substitution, and can still grow past what a receipt field can
hold (`"ß"` → `"SS"`); an input whose transformed output would not fit is refused outright — a
wrong, truncated answer would be worse than no answer at all.

## Rollback safety

Because a hub-managed agent's `permissions` field is kept mirrored to its compiled attachments on
every write, rolling the binary back to a release before this phase (which enforces only
`permissions`, knowing nothing about attachments) still enforces the same effective permissions.
Nothing about attachments or the compiler needs to be undone before a rollback; only outstanding
version 3 turn inputs do (see [ADR-023](../adr/023-console-and-operator.md)'s turn input version 3
section) — settle or cancel them first, the same deploy-runbook step a version 2 rollback already
needed.

**Re-upgrading afterward is also safe, by the same reconciliation every startup already runs.** If
anything was actually changed (a `config apply`, a direct toggle) while the rolled-back, older
release was running, its own writer recorded a new revision with no attachments document at all —
it has no `toolAttachments` parameter to call this release's writer with. Re-upgrading no longer
trusts the live `catalog_attachments`/`agents.tool_attachments_managed` projections at that point —
they could still be exactly what they were *before* the rollback, disagreeing with the revision
that is actually active now. The controller and every CLI session reconcile both projections
against the active revision's own attachments document at startup, right after the existing
configuration-history backfill: a revision with no attachments document of its own means every
agent it names is legacy from here on, enforced exactly from the `permissions` the older release
itself wrote — never a stale, resurrected (or wrongly withheld) attachment. This is a no-op, and
cheap, whenever the projections already agree with the active revision, which is the overwhelming
common case; it only ever has real work to do once, right after a rollback interval like this.
