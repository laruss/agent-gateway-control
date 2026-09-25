# Threat model (draft)

- Status: Draft, Phase 0

## Assets

- Credentials: Mattermost bot tokens, AI provider keys, Google OAuth, financial services.
- Canonical state: events, waits, approvals, audit log.
- Working repositories and artifacts.
- The owner's money and reputation: payments, external email, publications.

## Trust boundaries

| Zone | Trust level | Notes |
|------|-------------|-------|
| Admin CLI/API on localhost or VPN | `system-trusted` | Source of administrative truth |
| Owners on the allowlist, by Mattermost user id | `human-trusted` | The only approvers |
| Posts by other humans and agents in Mattermost | `internal-untrusted` | Text grants no authority |
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

### T2. Infinite agent loops

- Routing only through structured `targetAgentIds` and HMAC-signed props.
- Hop, cascade and rate limits, a pairwise circuit breaker, a duplicate payload guard, `kill-all`.
- Status (Phase 0): limits in `OrganizationConfig`; unique targets, no self-targeting, no
  `@all/@here/@channel` in agent messages.
- Status (Phase 1): routing enforces self-post, hop, cascade (fan-out counted per run), hourly
  per-agent rate, duplicate normalized payload and pairwise guards on every wake-up; a blocked
  wake-up stops the cascade and posts an alert; `kill-all` pauses every agent and blocks new
  runs. Cascade budgets are serialized per correlation. Lifecycle, wait, approval, timer and
  control events cannot be ingested from outside the Gateway. HMAC-signed props arrive with the
  Mattermost bridge (Phase 2).

### T3. Credential leakage

- Docker secrets/files with `0600`; separate secrets per worker; log redaction.
- Tokens are not passed as command arguments when a file/stdin alternative exists, and never
  reach models.
- Status (Phase 1): every setting `X` can be read from `X_FILE`; JSON logs redact secret field
  names, bearer/API tokens, private keys and URL credentials; stored error details are redacted
  and truncated.
- Status: `token_secret_file` is restricted to `/run/secrets/`; `.gitignore` excludes
  `secrets/`, `*.pem`, `*.key`.

### T4. Compromised runtime worker

- Unprivileged user, read-only rootfs, `cap_drop: [ALL]`, `no-new-privileges`, no Docker socket.
- Bounded workspace mount, egress policy, resource limits, process timeout.
- Status (Phase 1): workers get the complete turn in the job and connect as a role limited to
  their adapter's queue tables (`gateway db grant-worker`), so they cannot touch domain tables,
  other adapters' jobs or timeouts; reports count only for runs of the reporting adapter; every report is re-validated by the controller, checked against the authority and
  run scope fixed at scheduling, and ignored when it is stale or names another agent's run
  ([ADR-011](../adr/011-run-execution-protocol.md)). Container hardening in Phase 4 and 8.

### T5. Supply chain

- Lockfile and exact dependency versions (`bun add -E`), pinned base image digests.
- Dependency lifecycle scripts are blocked by bun by default (`trustedDependencies` is empty).
- SBOM, checksums, provenance, install by digest, never `latest`.
- Status: lockfile and exact versions in Phase 0; release pipeline in Phase 9.

### T6. Runaway spend

- Per-agent and global budgets, max turns, run duration, cascade limits, cost metrics.
- Real payments only through approval ([ADR-007](../adr/007-approval-model.md)).

### T7. Home server exposure

- Only the reverse proxy on 80/443 is exposed; admin API on localhost/VPN; firewall
  deny-by-default.
- SSH keys only, a dedicated service user, regular backups and restore tests.

### T8. Forged approval

- Approval is accepted only from an allowlisted human user id, with a nonce and an expiry.
- The action hash is re-checked before execution; changed parameters need a new approval.
- Status (Phase 0): the draft needs a concrete `actionType` and at least one parameter; a stored
  request cannot be `granted`/`executed` without a decision by an allowlisted user before
  expiry. Config keeps finance tools with `finance_agent_id` only and requires human approval
  for every finance action except `finance.read`. The flow is Phase 7.

## Open questions

- Storage of provider session ids: encrypted in the database or a reference to a secret store,
  decide in Phase 4.
