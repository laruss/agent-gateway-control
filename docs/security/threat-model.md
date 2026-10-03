# Threat model (draft)

- Status: Draft, updated through Phase 8

## Assets

- Credentials: Mattermost bot tokens, AI provider keys, Google OAuth, financial services.
- Canonical state: events, waits, approvals, audit log.
- Working repositories and artifacts.
- The owner's money and reputation: payments, external email, publications.

## Trust boundaries

| Zone | Trust level | Notes |
|------|-------------|-------|
| Admin CLI/API on localhost or VPN | `system-trusted` | Source of administrative truth |
| Posts by human accounts in managed channels | `human-trusted` | May address agents by mention; grants no tool authority |
| Owners on the allowlist, by Mattermost user id | `human-trusted` | The only approvers (checked by user id, not by the label) |
| Posts by agent bots, other bots, webhooks and plugins | `internal-untrusted` | Text grants no authority |
| Email, web, files, attachments | `external-untrusted` | Always explicitly labeled in context |
| Model output (`AgentTurnResult`) | untrusted | Strict validation, fail-closed |

## Threats and mitigations

### T1. Prompt injection from email, web and Mattermost

- Trust labels on every event and context block.
- Policy and permissions live outside the LLM; external content never changes permissions.
- No secrets in context; tool allowlist; approval gates.
- Status (Phase 0): `trustlevel` on events; model output cannot carry side-effect receipts or a
  risk level; `checkTurnResultAuthority` bounds channels, targets, memory and attachments;
  prompt paths are restricted to `prompts/**.md`. Policy engine in Phase 7.
- Status (Phase 3): the prompt renderer puts every piece of user, agent and connector content
  into a `<data>` block with its trust label, after the trusted layers; content cannot close
  its block. Shared memory, which reaches other agents' turns, is accepted only by an operator,
  so an injected agent cannot plant instructions for others; a turn reads only its own
  namespaces. Waits can name only humans who posted in the run's threads or owners
  ([ADR-013](../adr/013-turn-context.md)).
- Status (Phase 6): every Gmail event is `external-untrusted`, enforced by the event contract.
  Mail bodies reach the model as plain text only, taken from the HTML part a reader sees:
  scripts, styles, forms, frames, media and text hidden from the reader (inline or by the
  mail's stylesheet) are removed, control and invisible characters stripped, link
  targets shown next to their text. Attachments are described, never read. An email that talks
  the model into a finance action or a secret gets a refused run with `deny` policy decisions
  and an alert, and nothing is published (integration test)
  ([ADR-016](../adr/016-gmail-connector.md)).
- Status (Phase 7): a policy engine outside the model (`@agent-gateway/policy`) decides every
  approval request before a card is shown: deny wins, anything no list names is denied,
  finance belongs to the finance agent only and every finance write needs a human, and finance
  actions need their full typed parameter set. An injected agent can at most ask; nothing runs
  without an owner's reply ([ADR-018](../adr/018-approval-decisions-and-tool-broker.md)).

### T2. Infinite agent loops

- Routing only through structured `targetAgentIds` and HMAC-signed props.
- Hop, cascade and rate limits, a pairwise circuit breaker, a duplicate payload guard, `kill-all`.
- Status (Phase 0): limits in `OrganizationConfig`; unique targets, no self-targeting, no
  `@all/@here/@channel` in agent messages.
- Status (Phase 1): routing enforces self-post, hop, cascade (fan-out counted per run), hourly
  per-agent rate, duplicate normalized payload and pairwise guards on every wake-up; a blocked
  wake-up stops the cascade and posts an alert; `kill-all` pauses every agent and blocks new
  runs. Cascade budgets are serialized per correlation. Lifecycle, wait, approval, timer and
  control events cannot be ingested from outside the Gateway.
- Status (Phase 2): agent posts route only by HMAC-signed props bound to the exact post
  (channel, thread, text) and to the posting bot's own agent; the run's correlation is signed,
  so a new thread does not reset the cascade budget. Human posts route by exact mentions
  outside code and quotes, only to agents allowed in the channel. Edits, deletions and posts
  by integrations never wake anyone. A thread may grant at most 30 wake-ups per 10 minutes
  across cascades. Guard alerts are posted to the alerts channel by the listener bot.

### T3. Credential leakage

- Docker secrets/files with `0600`; separate secrets per worker; log redaction.
- Tokens are not passed as command arguments when a file/stdin alternative exists, and never
  reach models.
- Status (Phase 1): every setting `X` can be read from `X_FILE`; JSON logs redact secret field
  names, bearer/API tokens, private keys and URL credentials; stored error details are redacted
  and truncated.
- Status: `token_secret_file` is restricted to `/run/secrets/`; `.gitignore` excludes
  `secrets/`, `*.pem`, `*.key`.
- Status (Phase 2): bootstrap writes bot tokens straight into secret files (mode 0600, atomic,
  never through a symlink) and never prints them; the admin token is needed only for bootstrap.
  Bot tokens and the routing key are read only by the controller; in a deployment workers get
  neither (the secrets are mounted into the controller container only). In local development
  both processes run as one user in one working tree, so this boundary does not hold there.
- Status (Phase 6): the Google refresh token is held only by the Gmail connector process, in
  a mode-0600 file read once at start (a new consent applies after a restart, where the
  account check runs); `gateway gmail authorize` writes it without printing it. The
  credential grants reading mail only (polling, the default; ADR-017), or reading mail and
  pulling notifications with the optional Pub/Sub mode. A token with any
  other scope (sending, drafts, modification) is refused on every refresh, so a mistaken or
  widened grant cannot give the Gateway send permission. Google API errors are reduced to
  Google's error code before logging; mailbox addresses are not logged, and the mailbox is
  named by the operator's id (`GMAIL_MAILBOX_ID`) in events and alerts.
- Status (Phase 8): redaction also covers `Authorization` and API key headers in text, Google
  refresh and access tokens, JWTs, fine-grained GitHub tokens, secret URL query parameters and
  email addresses. It bounds strings, arrays and lines, and applies to health details as well as
  to logs and stored errors. Gitleaks scans the whole git history on every push, pull request
  and daily. Retention removes message content (posts, mail, run results, turn inputs) after
  its configured period, so a database backup holds less of it
  ([ADR-019](../adr/019-observability-and-retention.md)).

### T4. Compromised runtime worker

- Unprivileged user, read-only rootfs, `cap_drop: [ALL]`, `no-new-privileges`, no Docker socket.
- Bounded workspace mount, egress policy, resource limits, process timeout.
- Status (Phase 1): workers get the complete turn in the job and connect as a role limited to
  their adapter's queue tables (`gateway db grant-worker`), so they cannot touch domain tables,
  other adapters' jobs or timeouts; reports count only for runs of the reporting adapter; every report is re-validated by the controller, checked against the authority and
  run scope fixed at scheduling, and ignored when it is stale or names another agent's run
  ([ADR-011](../adr/011-run-execution-protocol.md)). Container hardening in Phase 8.
- Status (Phase 4): the Codex and Claude Code adapters run each call in its own process group,
  stopped as a whole on deadline and cancellation. Each run works in its own workspace, removed
  afterwards. The runtime process gets a clean environment (no database URL, no worker
  settings), and the commands the model runs get no credentials. Built-in tools follow the
  agent's tool policy, fail-closed; user config, skills, AGENTS.md/CLAUDE.md, plugins, hooks,
  MCP and connectors are off. Commands run in the runtime's OS sandbox: they cannot read the
  home directory, the CLI's login and session files, other runs' workspaces or `/run/secrets`,
  write only into the workspace and have no network. System paths stay readable (reported by
  `gateway runtime doctor`) ([ADR-014](../adr/014-cli-runtime-adapters.md)).
- Status (Phase 5): the Grok, Kiro, OpenCode and Hermes CLIs cannot confine every tool, so a
  built-in tool is granted only where the runtime keeps it inside the workspace and off its
  login: web tools for Grok, Kiro and Hermes, file and web tools for OpenCode, never their
  commands. Each runs with a home directory the Gateway owns and rewrites (Grok and Hermes also
  with an empty `HOME`), so the operator's own logins, settings, memory and messaging gateway
  stay out of reach; Hermes borrows no other CLI's login. A worker whose runtime fails stays
  up without taking jobs, and only that adapter's agents are degraded
  ([ADR-015](../adr/015-unconfined-runtimes-and-runtime-health.md)).
- Status (Phase 7): approved actions run only in the tool runner, a separate process that
  holds the tool credentials (finance) and connects as a role limited to its namespaces'
  queues and one `SECURITY DEFINER` function, `gateway_begin_tool_action`. Runtime workers
  cannot publish execute jobs (row-level security on the job table), and a fetched job
  authorizes nothing: the runner recomputes the hash, and `begin` checks the approval, the
  hash, the deadline, the agent and the kill switch under the controls row.
- Status (Phase 8): the services' database pools cut off long statements, lock waits and idle
  transactions; a turn input above 2 MiB is refused; workspaces a crashed worker left behind are
  removed. Container hardening (non-root, read-only rootfs, dropped capabilities, CPU, memory
  and PID limits, separate networks) and per-run containment of the unconfined runtimes are
  part of the release images; a limit on the worker container alone does not stop a detached
  command of one run.
- Status (Phase 9): the release stack runs every container as uid 10001 (the services refuse
  root), on a read-only root filesystem, without capabilities, with `no-new-privileges`, CPU,
  memory and PID limits and no published port. A worker mounts only its own secrets and
  volumes and is not on the Mattermost network; host firewall rules close its egress to the
  LAN. The Codex worker's seccomp profile adds only the namespace and mount calls bubblewrap
  needs, and the install test proves the sandbox inside the container: no login, no writes
  outside the workspace, no network. Grok, Kiro, OpenCode and Hermes ship no image until
  per-run containment exists ([ADR-020](../adr/020-release-pipeline.md)).

### T5. Supply chain

- Lockfile and exact dependency versions (`bun add -E`), pinned base image digests.
- Dependency lifecycle scripts are blocked by bun by default (`trustedDependencies` is empty).
- SBOM, checksums, provenance, install by digest, never `latest`.
- Status: lockfile and exact versions in Phase 0; release pipeline in Phase 9.
- Status (Phase 8): every GitHub Action is pinned by commit SHA. OSV-Scanner checks `bun.lock`
  (development dependencies included) for vulnerabilities and licenses against an allowlist,
  and exceptions expire ([security scans](../operations/security-scans.md)).
- Status (Phase 9): images build from digest-pinned bases, a fixed Debian snapshot with exact
  package versions, `bun.lock` without install scripts, and runtime CLIs checked by SHA-256.
  They reproduce bit for bit (CI builds twice and compares). The release publishes the tested
  image bytes, with build provenance and SPDX SBOM attestations, a checksummed and attested
  bundle, and `images.lock`; the stack runs every image by digest. Claude Code is never
  redistributed: the operator builds its worker from a pinned, checksummed binary
  ([ADR-020](../adr/020-release-pipeline.md)).

### T6. Runaway spend

- Per-agent and global budgets, max turns, run duration, cascade limits, cost metrics.
- Status (Phase 4): every turn is killed at its deadline. Claude Code calls are bounded by
  `CLAUDE_MAX_TURNS` and, optionally, `CLAUDE_MAX_BUDGET_USD`. Runtime usage (tokens, and cost
  where the CLI reports it) is stored per run.
- Status (Phase 5): Grok and Hermes calls are bounded by `GROK_MAX_TURNS` and
  `HERMES_MAX_TURNS`. Kiro meters credits and records no token usage; OpenCode Go and Hermes
  report no cost.
- Real payments only through approval ([ADR-007](../adr/007-approval-model.md)).
- Status (Phase 7): per-agent and global daily limits on cost and tokens
  (`organization.budgets`), summed from a ledger that books every attempt's usage, retried and
  cancelled ones included. An agent over its limit (or everyone over the global one) starts no
  run, retry or redrive until the UTC day changes or the limit is raised; unmetered attempts
  hold the agent unless `unmetered: allow`. Work in flight is not stopped, so a limit can be
  overshot by the runs already started.
- Status (Phase 8): an alert fires at 80% of a daily budget, before the hold, and is resolved
  when usage falls below it (the next day). Metrics report today's cost and tokens.

### T7. Home server exposure

- Only the reverse proxy on 80/443 is exposed; admin API on localhost/VPN; firewall
  deny-by-default.
- SSH keys only, a dedicated service user, regular backups and restore tests.
- Status (Phase 8): health and metrics endpoints bind to loopback unless `HEALTH_HOST` says
  otherwise, and carry no credentials. `gateway backup check` verifies backups, optionally with
  a restore into a scratch database, and the controller alerts when the recorded check fails or
  goes stale.

### T8. Forged approval

- Approval is accepted only from an allowlisted human user id, with a nonce and an expiry.
- The action hash is re-checked before execution; changed parameters need a new approval.
- Status (Phase 0): the draft needs a concrete `actionType` and at least one parameter; a stored
  request cannot be `granted`/`executed` without a decision by an allowlisted user before
  expiry. Config keeps finance tools with `finance_agent_id` only and requires human approval
  for every finance action except `finance.read`. The flow is Phase 7.
- Status (Phase 7): a decision is an owner's reply `approve <code>` / `deny <code>` in the
  card's thread, read by the listener and handed to a dedicated decision path (generic event
  ingest never decides). It counts only from an active human account that is both in the
  request's approver snapshot and a current owner, checked by a fresh account lookup, without
  webhook, bot or plugin props, before expiry by the controller's clock, with the request's
  code (derived from its id, nonce and hash; shown to the channel, it binds a reply to one
  request and authorizes nothing by itself). Other attempts are audited and
  alerted; the first valid decision wins and a replayed post decides nothing. Triggers keep
  the request (action, parameters, hash, approvers, expiry) immutable and the decision final.
  The grant re-checks the policy with the active configuration; the runner and `begin` check
  the hash again, so a changed amount runs nothing. Kill-all cancels pending approvals and
  queued actions and aborts running executors (integration and Mattermost e2e tests).
  Residual risk: any credential of an owner's own account (a session, a personal access token
  or an OAuth app acting as the owner) can decide; only webhook, bot and plugin props are
  told apart.

### T9. Bot impersonation and forged routing

- Anyone can set `props` on a post, including `from_bot` and a copy of the Gateway's routing
  metadata; a leaked bot token lets someone post as an agent.
- Status (Phase 2): senders are identified by Mattermost user id only. An agent bot's post
  without a valid signature for exactly that post is not ingested, is audited once
  (`mattermost.post.rejected`) and raises an alert; an exact copy of a signed post is the same
  event (keyed by its signed idempotency key) and is rejected as a replay. Other bot accounts
  are recognized by user id and never address anyone; a wait for a human's user id is
  satisfied only by that human's own post, not by a webhook or plugin posting under the
  account. A signed post counts only as the exact post the outbox delivered with its key. Humans' copied metadata is ignored; their
  posts route by their own mentions only. Bots are plain members, added only to their
  channels ([ADR-012](../adr/012-mattermost-bridge.md)).

### T10. SSRF through an owner-defined custom HTTPS tool

- An owner's own HTTPS tool (ADR-027) names a destination host the Gateway did not choose; a
  malicious or compromised definition — or a hostname whose DNS answer changes after the
  definition was approved — could otherwise reach the host's loopback, the LAN, or a cloud
  metadata endpoint instead of the intended external API.
- Status (Phase 15): the tool runner's egress guard resolves a definition's host exactly once
  and connects only to that resolved address, never re-resolving — a second answer (the
  destination's own DNS TTL expiring, an attacker racing it) can never redirect an
  already-approved call. Every literal and resolved address is classified before a socket ever
  opens and refused if private (RFC 1918), loopback, link-local (the cloud metadata address,
  `169.254.169.254`, included), carrier-grade NAT, multicast, reserved, a documentation/
  benchmark range, or an IPv6 form aliasing any of these (unique-local, link-local, an
  IPv4-mapped address, NAT64) — classified from the literal numeric value regardless of
  notation (dotted, decimal, octal, hex for IPv4), closing the classic bypass of a hostname
  that is itself a numeric literal in an unusual base. Redirects are never followed. Every
  parameter is mapped into exactly one encoded slot (a path segment, a query entry, a header,
  a JSON body field) — never interpolated as a string, and never evaluated as code or a shell
  command — so even a value that reached execution unvalidated (a forged job) cannot escape
  its own slot. A definition's own secrets are named by alias only and resolved by the tool
  runner alone, from a dedicated, read-only secrets mount; a value is scrubbed from a receipt
  or an error even where a destination echoes it back, and is never part of the approval hash,
  a log line or a database row. Editing a definition after a request was made invalidates it
  at grant time, so a request is always executed exactly as it was shown and approved
  ([ADR-027](../adr/027-tool-catalog.md)).

## Open questions

- None open. Provider session ids (decided in Phase 4) are stored in plain text. A session id is
  only a reference: the history it names lives in the worker's `CODEX_HOME` or
  `CLAUDE_CONFIG_DIR`, and resuming it takes that directory and the worker's login.
