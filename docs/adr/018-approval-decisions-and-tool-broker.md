# ADR-018. Approval decisions, the tool broker and budgets

- Status: Accepted
- Date: 2026-09-27
- Amends: [ADR-007](007-approval-model.md) (statuses, decision channel, execution)

## Context

ADR-007 defined an immutable approval request, and the Gateway already stores it, posts its
card and makes the agent wait. Three things are missing:
- a way for a human to decide;
- a boundary that executes the approved action and nothing else;
- a spending limit.

The decision must not be forgeable:
- another bot writing "APPROVED" must not count;
- a webhook or plugin on an owner's account must not count;
- a connector that can ingest events must not count;
- neither must a reply that arrives after the request expired.

Execution must not depend on the model or on the worker that ran it. The finance credential
must be held by nothing else.

## Decision

### Deciding

- **In the card's thread.** The owner replies `approve <code>` or `deny <code>`. The card
  prints the code: 12 Crockford Base32 characters, shown as `XXXX-XXXX-XXXX`, derived from a
  domain-separated SHA-256 over the request id, its random nonce and the action hash.
  - The code binds a reply to one request; it is shown to the channel, so identity is what
    authorizes it.
  - The whole message must be that one command. Case and grouping of the code do not matter,
    but trailing prose, a quote, code formatting or a missing code is malformed and consumes
    nothing.
- **Only through the listener.** The listener recognizes a command attempt before any trust
  filter, so attempts by bots are audited too. It hands the attempt to a dedicated
  control-plane operation, never to generic event ingest, so no connector or CLI-ingested
  event can decide.
  - The attempt must be a created post: edits and recovered posts never decide.
  - It must be in the thread whose root is the card post recorded in the card's delivery
    receipt, in that receipt's channel.
  - A command in a card's thread is the decision path's alone: it is recorded there by post
    id and never also routed as a post, so it cannot address an agent.
  - A reply that arrives before the receipt is retried (the channel's cursor waits), never
    dropped. It waits only when the thread's root is the listener bot's own post claiming that
    card's key: a command in any other thread is no decision and holds nothing up.
- **Owner identity.** The author's user id must be in the request's approver snapshot and
  among the currently resolved owners. It is checked by a fresh account lookup at decision
  time (`is_bot` false, `delete_at` 0), and the post must carry no `from_webhook`, `from_bot`
  or `from_plugin`. Anything else is rejected, audited and alerted.
- **Expiry** is checked under the request's lock with the controller's clock (`now <
  expires_at`), never with the post's timestamp: a catch-up does not backdate a decision.
- **Once.** The first valid decision committed under the request lock wins. Every processed
  reply is recorded by post id, so a replay changes nothing. Later commands get "already
  decided". Deleting an accepted reply does not revoke the decision.
- The listener bot acknowledges every command attempt in the thread. The texts are fixed, and
  the variable parts sit in code. Answers stay in the card's own channel while it is managed,
  also after the approvals channel moved.
- A card is posted only while its request is pending. A card that got posted anyway as its
  request ended gets the request's last word (withdrawn, expired, the execution's outcome)
  from the controller's sweep, so no card is left inviting a decision.

### Statuses

- **Approval:** `pending -> granted | denied | expired | cancelled`. `executed` is retired: a
  granted approval stays granted whatever its execution does.
- **Tool action** (one per approval, `UNIQUE(approval_id)`):
  - `queued -> running -> succeeded | failed | unknown`;
  - `queued -> cancelled`.
  - `failed` is a known failure. A runner that began and never reported leaves the action
    `unknown`, and an unknown action is never retried automatically. A truthful receipt that
    arrives later is still recorded; otherwise an operator settles it by hand
    (`gateway tools settle`, audited) after checking the provider.
- Database triggers keep an approval's identity, action, parameters, hash, nonce, approvers
  and expiry immutable. The decision, once set, cannot change, and no status leaves a terminal
  state. The same holds for a tool action's action and hash.

### Resuming the agent

The agent waits on one Gateway-created wait for `approval.resolved`, correlation
`approval:<id>`:
- A denial, a cancellation or a policy refusal resolves the wait at once.
- A grant keeps the agent waiting: the wait is extended to the action's execution deadline
  plus a grace period, and it is resolved when the action settles. The approval's own expiry
  never changes.
- `approval.granted` and `approval.denied` are still emitted, as records.
- `approval.resolved` carries:
  - the decision;
  - the execution outcome (`denied`, `cancelled`, `succeeded`, `failed` or `unknown`);
  - the receipt or error.
- The wait match is exempt from loop guards, as a wait timeout is: it resolves a wait the
  agent already holds, at most once. Kill-all or a budget hold only defers the run. The
  result stays in the inbox.

### Executing

- **`tool-runner` is a separate process.** It serves configured namespaces, the first segment
  of an action type (`finance`, `mail`, `deploy`, `publish`, `issue`, `custom`, `utility` — the
  last two added for owner-defined HTTPS tools and packaged utilities, ADR-027). Each namespace
  has its own queues:
  - `tool.execute.<ns>`;
  - `tool.report.<ns>`;
  - `dlq.tool.execute.<ns>`.

  The runner's database role reaches only those queue tables and one function. Runtime
  workers cannot publish execute jobs. The runner holds its executors' credentials; nothing
  else does.
- **Grant-time checks.** A grant re-evaluates the policy against the active configuration:
  - the agent is enabled;
  - the action is approval-gated for it and not denied;
  - `finance.*` is allowed only for the finance agent;
  - the parameters satisfy the action's typed schema;
  - the recomputed hash equals the stored one;
  - the kill switch is off.

  A refusal cancels the approval. A config apply re-evaluates queued actions and cancels those
  it no longer permits; moving the approvals channel (or changing the team) withdraws every
  pending request (its card stays in the old channel, where replies no longer count).
- **`begin` is the last gate.** A fetched job does not authorize anything. Before calling its
  executor, the runner recomputes the hash from the job and calls
  `gateway_begin_tool_action(id, attempt, hash)`, a `SECURITY DEFINER` function. Under the
  controls row (share) and the action's row lock, it checks that:
  - the kill switch is off;
  - the approval is granted and the action is queued;
  - the hash matches;
  - the deadline has not passed;
  - the agent is enabled;
  - the calling role may settle that namespace's execute jobs (a runner of another namespace
    cannot begin it).

  Only then does it move the action to `running` and hand out the action's stored idempotency
  key (the job's is never used). Kill-all takes the controls row exclusively, so either
  kill-all comes first and nothing runs, or `begin` comes first and kill-all records a stop
  request on a running action. The runner polls `gateway_tool_action_stop_requested` while
  its executor works and aborts the executor's call; an executor that honours the abort
  reports `failed` when nothing was sent.
- **Executors** are a static registry. Each executor takes the action and an idempotency key,
  `tool-action:<approval_id>:<hash>`, and must be idempotent by that key at the provider. An
  executor either returns a receipt or a known failure; an executor that throws leaves the
  outcome `unknown`.
  - The `custom` namespace is the one exception to "static": an owner-created `custom_https`
    entry's action type (`custom.<entry-id>`) is unbounded and unknown at startup, so a runner
    serving `custom` also carries a *dynamic* executor, tried only once the static registry has
    no exact match — it resolves the specific entry (and its exact approved definition version,
    read through `gateway_custom_tool_definition`, the one additional narrow function this
    namespace needs) at job time instead. `utility` stays fully static: its one action type this
    release ships, `utility.text-transform`, is fixed, image-shipped code, known at startup like
    any other executor (ADR-027).
  - The MVP ships no real integration, only test executors. A runner without an executor for
    the action fails it as known once `begin` vouched for the job, before anything is sent.
- **Reports** are bound to the report queue's namespace, the action and the attempt. The
  controller stores the outcome and posts the receipt in the card's thread. It resolves the
  agent's wait.
- **Deadline sweep.** When the deadline passes, a controller sweep settles the action: a
  queued action is cancelled (it never began), a running one becomes `unknown` and raises an
  alert.

### Typed parameters

- `finance.payment.create` takes exactly these parameters:
  - `amount`: a positive decimal with the currency's precision;
  - `currency`: one of EUR, USD, GBP, CHF or JPY;
  - `recipient`: an exact identifier;
  - `purpose`;
  - `recurring = false`. Recurring payments are refused.
- `finance.subscription.create` also names its terms: `interval` and `first_payment_date`.
- Any other `finance.*` write is denied: it has no schema. Parameters are validated before
  the card is shown and again at grant and in the runner. Other namespaces keep free-form
  parameters.

### Budgets

- `organization.budgets` sets per-agent and global limits on cost (USD) and on tokens per UTC
  day.
  - Tokens are input plus output tokens; cached input is part of the input, never added
    twice.
  - Each metric is enforced independently.
- **A usage ledger** keyed by `(run_id, attempt)` records every attempt that reports usage,
  including failed, retried and late cancelled ones, on the UTC day it is reported. A
  completed turn without usage counts as unmetered; a failure without usage (the model was
  never reached) counts as nothing.
- An attempt with neither cost nor tokens is **unmetered**. With `unmetered: hold` (the
  default) it holds the agent for the day. With `unmetered: allow` it counts as nothing.
- **The gate** runs when a run is scheduled, retried or redriven:
  - an agent over its limit is held; a held retry is deferred (the run ends as cancelled and
    its work goes back to the inbox), never failed;
  - the global limit holds every agent;
  - an alert is raised once per scope and day.

  A hold is computed, not stored, so it ends when the day changes or a limit is raised. It is
  independent of pause and kill-all, and resuming an agent cannot bypass it. Work in flight is
  not stopped: the limits admit work based on reported consumption and can be overshot by the
  runs already started.

### Kill-all

Kill-all also:
- cancels pending approvals and queued tool actions (a cancelled action needs a fresh
  approval);
- records a stop request on running ones, which the runner turns into an abort of the
  executor's call.

Releasing the switch resurrects nothing. Their `approval.resolved` events and a "withdrawn"
notice on the card are emitted by the controller's sweep, outside kill-all's transaction, in
the usual lock order. The sweep also expires a pending request past its expiry whose wait is
gone.

## Alternatives

- **Buttons on the card.** Mattermost would call the controller over HTTP, and the button's
  context is visible to channel members. It needs an inbound endpoint and gives weaker
  provenance than the listener's own read of the post.
- **Emoji reactions.** Easy to click by accident, and no code binds the reaction to the
  exact request.
- **Executors inside the controller.** One process fewer, but the controller would hold the
  finance credential.
- **Emit `approval.granted` at decision time and wake the agent again later.** That costs an
  extra model turn just to say "queued", and needs a second continuation mechanism.

## Consequences

- One more process (`apps/tool-runner`) and one more database role (`gateway db
  grant-tool-runner`).
- `begin` is the only domain state the runner touches, through a narrow function; it reads
  nothing else.
- An action whose runner crashed after `begin` needs an operator. It is `unknown`, alerted,
  and never retried blindly.
