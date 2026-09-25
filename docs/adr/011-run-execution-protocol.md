# ADR-011. Run execution protocol between controller and workers

- Status: Accepted
- Date: 2026-09-25

## Context

The control plane owns all domain state; workers run untrusted runtimes and must not read or
write it (ADR-002). A run crosses the process boundary twice: the controller hands a worker a
turn, and the worker hands back a result. Both directions go through pg-boss queues in the same
PostgreSQL (ADR-003), with at-least-once delivery (ADR-004). A runtime adapter interface that
returns a finished `AgentTurnResult` would hide where validation happens and whether a
controlled repair is allowed.

## Decision

- **Controller -> worker.** The controller assembles the complete `AgentTurnInput` and the
  `TurnAuthorityContext` from the same sources in one transaction, stores both in
  `context_snapshots`, and enqueues `agent.run.<adapter>` with `{runId, attempt, input}`. The
  worker needs no database access beyond its queue.
- **Adapters return untrusted output.** `RuntimeAdapter.startTurn/continueTurn/repairTurn`
  return `RuntimeTurnOutput` with a raw `modelOutput`. `executeTurn` in the runtime SDK
  validates it against `AgentTurnModelOutput`, asks for exactly one repair on failure, and
  enforces the deadline and cancellation. Raw invalid output never leaves the worker.
- **Worker -> controller.** The worker sends `agent.run.report` jobs: `started`, `completed`
  (with the result as plain JSON) or `failed` (with a classified, redacted `RunError`). The
  controller treats every report as untrusted: it ignores reports for unknown runs, for another
  agent's run, or for a stale attempt, validates the result again with Zod, and applies
  `checkTurnResultAuthority` plus the run scope check (waits only on the run's correlations,
  replies only in the run's threads) against the snapshot. A result with any issue fails the
  run, records `policy_decisions` and publishes nothing.
- **Retries belong to the controller.** A retryable runtime error (including a run that hit its
  deadline; an operator's cancellation is not retryable) returns the same run to
  `queued` with `attempt + 1` and exponential backoff with jitter, at most three attempts.
  pg-boss never re-executes a run job (`retryLimit: 0`); an expired or failed job goes to the
  dead letter queue. Invalid output and permanent errors fail the run and put the agent in
  `FAILED`, which only a redrive clears (not pause/resume, disable/enable or kill-all).
- **The time budget starts at the start.** The job carries `timeoutSeconds`; the worker sets the
  turn's deadline when it starts the run, and the controller sets the run's deadline when the
  `started` report arrives. Time spent queued never counts. A started attempt without a report
  by its deadline (the worker died) fails as a retryable `timeout`; an attempt no worker picks up
  within its budget only raises an alert, because the work should wait for a worker.
- **Lost jobs are reconciled.** Run and timeout jobs are retained for 90 days, and the
  controller periodically fails as retryable any queued attempt whose job is gone from the
  queue (and any running attempt past its deadline whose backstop never fired), fenced by the
  attempt's job id; an overdue active wait gets a new timeout job.
- **Workers are confined to their adapter's queues.** Every adapter has its own run, report and
  dead letter queue, each in a dedicated pg-boss table. A worker connects as a PostgreSQL role
  that may only fetch and settle its adapter's run jobs, send its adapter's reports and
  dead-letter its failed jobs (`gateway db grant-worker <role> <adapter>`); the one insert
  pg-boss makes through the shared parent table when it settles a failed job is limited to the
  adapter's own queues by row-level security. It cannot read or
  write domain tables, other adapters' jobs or the controller's timeout jobs. The controller
  accepts a report only for a run of the adapter whose report queue delivered it.
- **One active run per agent.** A partial unique index on `agent_runs` enforces at most one
  queued or running run per agent; `max_active_runs` other than 1 is rejected at config apply.
- **Lock order.** Cascade advisory locks (per correlation, sorted; taken by ingest, by the
  report path for the waits it creates, and by wait timeouts) come first, then agent rows in
  id order (`FOR NO KEY UPDATE`), then run and wait rows. Every use case follows it; ingest
  locks every agent it may wake before changing anything.
- **Cascade budget.** A cascade starts with the latest human post of a correlation (by event
  sequence); its budget (`max_turns_per_cascade`) counts granted wake-ups since then, including
  late wait matches, and is spent by tier: exact wait matches first, then targets, then
  subscriptions.
- **Reserved events.** Lifecycle, wait, approval, timer and control events are emitted by the
  controller only: external ingest rejects them, and a wait on such an event matches only a
  system-trusted event from the Gateway source. A model cannot create approval waits.

## Consequences

- A compromised worker can read the turn inputs of its own adapter's runs and report results
  for them, but every result is still bounded by the authority of the agent whose run it is.
  It cannot touch other adapters' runs, domain state or timeouts.
- `AgentTurnInput.deadline` is authoritative for the worker; a retry rewrites it in the
  snapshot before enqueueing the next attempt.
- A late report after cancellation, timeout or a successful retry is harmless.
