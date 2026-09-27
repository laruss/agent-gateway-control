# Approvals, the tool runner and budgets

How a human decides what an agent asked for, how an approved action runs, and how spending is
limited. The design is [ADR-018](../adr/018-approval-decisions-and-tool-broker.md); the approval
model itself is [ADR-007](../adr/007-approval-model.md).

## What needs an approval

- Every action in an agent's `tools_require_human_approval`. Every finance write
  (`finance.*` except `finance.read`) must be there, and only for the agent named by
  `organization.finance_agent_id`.
- An agent asks by ending its turn with `needs_human`. The policy checks the request before any
  card is shown:
  - the action is approval-gated for this agent and not denied;
  - `finance.*` comes only from the finance agent;
  - a tool namespace executes it (`finance`, `mail`, `deploy`, `publish`, `issue`);
  - the parameters fit the action's typed set.

  A refused request fails the run with `deny` policy decisions and an alert; no card is posted.

Typed parameter sets:

| Action | Parameters (exactly these) |
|--------|----------------------------|
| `finance.payment.create` | `amount` (positive decimal with the currency's digits: `120.00`, `12000` for JPY), `currency` (EUR, USD, GBP, CHF, JPY), `recipient` (an exact identifier such as an IBAN), `purpose`, `recurring` (`false`; recurring payments are subscriptions) |
| `finance.subscription.create` | `amount`, `currency`, `recipient`, `purpose`, `interval` (`month` or `year`), `first_payment_date` (`YYYY-MM-DD`) |

Any other finance write has no typed set and cannot be approved. Actions in other namespaces
keep free-form parameters.

## Deciding in Mattermost

The listener bot posts a card in the approvals channel. The card shows:
- the agent's summary;
- the parameters the hash covers;
- a warning when a value mixes alphabets (a Cyrillic "а" in a Latin IBAN);
- the request's code, `XXXX-XXXX-XXXX`. It binds a reply to this request; it is visible to the
  channel, so it authorizes nothing by itself.

To decide, an owner replies **in the card's thread** with exactly one line:

```text
approve 7F3K-92QA-M4TX
deny 7F3K-92QA-M4TX
```

Case and hyphens in the code do not matter. Anything else does not decide:
- trailing text, a second line, a missing code, Markdown, a quote or code formatting make the
  reply malformed (the listener bot says so);
- an edited reply never counts;
- `APPROVED` is not a command.

Only these replies count:
- a reply by an owner listed in `owner_mattermost_usernames` (resolved by bootstrap). The owner
  must be among the request's approvers and still an owner now;
- from their own, active account;
- without `from_webhook`, `from_bot` or `from_plugin`;
- before the request expires (24 hours, by the Gateway's clock).

A reply from a bot, an integration, another human or a deactivated account is ignored,
audited (`approval.decision_rejected`) and alerted, once per request and author. Any
credential of an owner's own account (a session, a personal access token) can decide: keep
them to the owner. The first valid decision wins. The listener bot answers every command in the
thread:
- approved;
- denied;
- refused (the policy, or the kill switch, no longer lets it run);
- not an approver;
- malformed;
- wrong code;
- already decided;
- expired;
- withdrawn (kill-all, the agent disabled, or a configuration change).

When the execution ends, it posts the receipt there too.

A grant is checked against the policy again, with the active configuration. If the agent was
disabled, the action is no longer approval-gated for it, its parameters or hash no longer hold,
or the kill switch is on, the approval is cancelled and nothing runs. Moving
`approvals_channel` to another channel (or changing the team) withdraws every request still
waiting for a decision: its card stays behind in the old channel, where replies no longer
count, and says so. A card is only posted while its request is pending.

## What the agent sees

The agent waits for one event, `approval.resolved`. Its outcome is one of:
- `denied`;
- `expired`;
- `cancelled`;
- `succeeded`, with the receipt;
- `failed`;
- `unknown`.

After a grant the agent keeps waiting until the action settles, so it is resumed once, with the
result.

## Running the tool runner

The tool runner is the only process that executes approved actions, and the only one that
holds their credentials. It serves one or more namespaces:

```bash
# once per database, and again after `gateway db migrate`: a role limited to the namespace's
# queues and to the begin check
gateway db grant-tool-runner gateway_tool_runner finance

DATABASE_URL=postgres://gateway_tool_runner:...@db/gateway \
TOOL_RUNNER_NAMESPACES=finance \
bun apps/tool-runner/src/main.ts
```

| Setting | Default | Meaning |
|---------|---------|---------|
| `DATABASE_URL` | required | A role limited by `gateway db grant-tool-runner` |
| `TOOL_RUNNER_NAMESPACES` | required | Comma-separated namespaces this runner serves |
| `TOOL_RUNNER_CONCURRENCY` | 1 | Actions run at once |
| `TOOL_RUNNER_SANDBOX` | off | `true` registers sandbox finance executors that only record the call; development or test only |
| `HEALTH_PORT` | 8083 | `/health/live`, `/health/ready` |

No real payment or mail integration ships yet. Without executors, every approved action fails
as known, and nothing happens.

For each job, the runner:
1. recomputes the action's hash from the job;
2. checks the parameters;
3. calls `gateway_begin_tool_action`, which lets the action start only if:
   - the approval is granted;
   - the action is still queued;
   - the hash matches;
   - its deadline (15 minutes after the grant) is ahead;
   - the agent is enabled;
   - the kill switch is off;
   - the runner's role serves the action's namespace;
4. runs the executor with the idempotency key `begin` hands out, `tool-action:<approval
   id>:<hash>`, and checks every two seconds whether the action was asked to stop (kill-all,
   the agent disabled). A stop aborts the executor's call; an executor that honours it reports
   a known failure when nothing was sent.

A job that is not exactly what was approved is refused and runs nothing. A card delivered just
as its request ended gets the request's last word within a reconcile tick (for requests up to
two days old).

## Tool action statuses

| Status | Meaning |
|--------|---------|
| `queued` | Granted, waiting for a runner |
| `running` | `begin` agreed; the executor is working |
| `succeeded` | The executor returned a receipt |
| `failed` | A known failure: the provider said no, or nothing began (no executor) |
| `unknown` | The executor began and did not answer (it threw, or the runner died) |
| `cancelled` | Withdrawn before it began: kill-all, the agent disabled, a configuration change, or its deadline passed |

The controller's sweep, on every reconcile tick, settles what is overdue:
- a queued action that did not begin by its deadline is cancelled;
- a running one silent for 15 minutes past its deadline becomes `unknown`.

**An unknown action is never retried.** It raises an alert and fails the `tool_actions` check
of `gateway health`. A truthful report that arrives later is still recorded. Otherwise check the
provider by the idempotency key and record what happened:

```bash
gateway approvals list [--status pending]   # requests and their execution status
gateway tools list --open                   # queued, running and unknown actions
gateway tools settle <action-id> succeeded --note "provider shows payment 1234"
```

## Kill-all

`gateway kill-all`, in one transaction:
- cancels pending approvals;
- cancels queued actions;
- asks running ones to stop (the runner aborts the executor's call);
- pauses every agent.

A provider call already made may still complete; the action's report counts either way. Releasing the switch resurrects nothing: a cancelled
action needs a fresh request and approval.

## Budgets

```yaml
# organization.yaml
organization:
  budgets:
    per_agent_daily: { cost_usd: 5, tokens: 2000000 }
    global_daily: { cost_usd: 20 }
    unmetered: hold          # or allow
```

- Limits are per UTC day. A metric left out is not limited.
- Tokens are input plus output tokens; cached input is part of the input.
- Every run attempt that reports usage is booked once, including failed, retried and cancelled
  ones, on the UTC day the usage is reported. A failure that never reached the model books
  nothing.
- The limits admit new work:
  - an agent over its limit, or every agent over the global one, starts no run or redrive;
  - a retry the limit holds is deferred: the run ends as cancelled and its work goes back to
    the inbox;
  - the work stays in the inbox and starts when the day changes or the limit is raised;
  - work already running is not stopped, so the limits can be overshot by the runs in flight.
- An attempt that reports neither cost nor tokens (Kiro reports none) is unmetered:
  - with `unmetered: hold` it holds its agent for the day;
  - with `unmetered: allow` it counts as nothing.
- A hold raises one alert per scope and day. It is independent of pause and kill-all:
  `agents resume` does not lift it.

```bash
gateway budgets    # today's usage per agent and in total, limits and holds
```
