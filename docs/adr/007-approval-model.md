# ADR-007. Human approval model

- Status: Accepted
- Date: 2026-09-24

## Context

Financial operations, external sends, deploys and data deletion must not happen without a human
decision. A text "APPROVED" can be forged by another agent or by external content.

## Decision

1. The agent returns `nextState.kind = "needs_human"` with an `ApprovalRequestDraft`: a concrete
   `actionType` without wildcards, plus every parameter of the action.
2. The Gateway stores an immutable request: a sha256 of the canonicalized `actionType` and
   `actionParams` (for finance: amount, currency, recipient, purpose, recurring flag), an expiry
   and a one-time nonce.
3. An approval card is posted to the approvals channel.
4. A decision is accepted only from a Mattermost user id on the owner allowlist. Bot accounts are
   never approvers.
5. Before execution the Gateway re-checks the hash; any parameter change requires a new approval.
6. Only then is a separate side-effect job created. The receipt is stored and posted.

In the MVP every real financial action requires human approval regardless of what `@finance`
decides.

## Alternatives

- **Approval by text in a thread.** Forgeable and not bound to the action parameters.
- **Trust the `@finance` agent's decision.** Does not protect against prompt injection.

## Consequences

- A canonical JSON form is needed for the hash (key ordering, number normalization).
- Expired approvals move to `expired` and are never executed.
