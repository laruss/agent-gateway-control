# ADR-019. Observability, alert conditions and retention

- Status: Accepted
- Date: 2026-09-28

## Context

Until now the Gateway was observable only through JSON logs and `gateway health`:
- `/metrics` was served but empty;
- the worker had no health endpoint;
- `traceparent` was stored on incoming events and used nowhere;
- alerts were one-time notices, deduplicated by key forever. A lasting problem was posted once
  and never marked as ended; a Mattermost outage, a dead letter or a nearly spent budget raised
  nothing;
- message content (posts, mail, run results, exact turn inputs) was kept forever;
- nothing checked the backups.

The deployment is a single home server with no tracing backend and no monitoring stack yet.
The next phases build the release images and deploy them.

## Decision

### Metrics

- **The format** is the Prometheus text format. A small registry lives in
  `@agent-gateway/service`: counters and histograms kept in process, gauges computed when
  scraped. There is no client library. The widespread ones rely on Node internals Bun does not
  fully provide, and the needed subset is short.
- **Endpoints.** Every service serves `/metrics` next to its health endpoints: the controller,
  the worker (new, port 8081), the Gmail connector and the tool runner. Each also reports
  `gateway_build_info`, uptime, memory, CPU and event loop delay.
- **Database gauges** (runs, queues, dead letters, outbox, approvals, tool actions, usage,
  runtimes, alerts, maintenance, the kill switch) are collected by the controller only:
  - the workers and the tool runner keep their narrow database roles;
  - one collection serves every scrape within 15 seconds;
  - it runs in a read-only transaction with a 2-second statement timeout;
  - a failed collection renders `gateway_metrics_collection_success 0` and none of the
    gauges. An unreachable database never looks like an empty one.
- **Labels** are bounded: service, adapter, queue, status, outcome and alert key. They are never
  message, run or user ids.

### Traces

- **What is built** is trace-correlated logging. Nothing exports spans: there is no backend to
  send them to, and the causal chain is what diagnosis needs.
- **Every stored event gets a trace:**
  - its own valid W3C `traceparent`;
  - else, for an event a run caused (a signed agent post, an approval outcome), a span in that
    run's trace, looked up by `causationid = run:<id>`. An agent-to-agent cascade therefore
    stays in one trace without changing post props;
  - else a new trace.
- **Spans.** A run is a span of its trigger event, and every attempt, outbox delivery and tool
  action gets a span of its own. Run and tool jobs carry their `traceparent`. The worker, the
  outbox and the tool runner bind `trace_id` and `span_id` into their log lines. Migration
  `0012` adds `traceparent` to `agent_runs`, `outbox` and `tool_actions`.
- **Trust.** A trace id is diagnostic only. A forged one merely joins log lines, and trace ids
  are kept apart from correlation and idempotency ids.

### Alert conditions

- **One-time notices and conditions.** One-time notices keep `raiseAlert` (a run failed, a
  forgery, an impersonation). A lasting condition is an episode in `alert_states`:
  - it fires when the condition starts;
  - it posts a reminder every 6 hours while it lasts;
  - it posts "Resolved" when it ends;
  - it fires as a new episode when it recurs.

  Every post has its own idempotency key, so a retried sweep posts nothing twice.
- **The controller's reconcile tick** evaluates the conditions, one sweep at a time (an
  advisory lock). The conditions and their thresholds:

  | Condition | Threshold |
  |-----------|-----------|
  | The Mattermost listener is disconnected | 2 minutes. An outage that fired ends only after 2 minutes connected, and stays firing across a controller restart |
  | A dead letter queue holds jobs | any |
  | Dead outbox items | any |
  | A global or per-agent budget is nearly spent | 80% of the daily limit (before the hold) |
  | Invalid structured output of a runtime | 3 or more in 15 minutes |
  | A Gmail watch expires or has expired | within 24 hours |
  | Retention has not succeeded | 3 hours |
  | The last recorded backup check failed, or none passed within its maximum age | the check's maximum age |

- **An independent route** is not built into the Gateway. When Mattermost or the database is
  down, the alert waits in the outbox. `/health/ready`, `/metrics` and the exit codes of
  `gateway health` and `gateway backup check` are what an external monitor watches.

### Retention

- **Where it is configured.** `organization.retention` sets how many days content is kept. Every
  period is at least 8 days, longer than the longest wait (7 days), so a waiting run never
  loses what it waits on. The defaults:

  | Setting | Default |
  |---------|---------|
  | Event payloads | 30 |
  | Run results, summaries, error details and exact turn inputs (`context_snapshots`) | 30 |
  | Delivered outbox payloads | 8 |
  | Dead outbox payloads | 30 |
  | Policy decision inputs | 30 |
  | Inactive thread summaries | 90 |
  | Rejected and superseded memory | 30 |
  | The usage ledger | 400 |

- **Content is removed in place.** Identifiers, hashes and statuses stay, so dedupe, the loop
  guards, routing and the audit trail keep working:
  - an expired event keeps only the ids thread lookups join on (`channel_id`, `root_id`,
    `post_id`);
  - the row is marked `content_expired_at`;
  - an expired dead outbox item cannot be redriven;
  - a run whose events lost their content cannot be redriven.
- **What is exempt:**
  - the events of pending or claimed work;
  - the events of a FAILED agent's latest run, which an operator may still redrive;
  - the edits and deletions of those posts, so a turn shows a post as it is now;
  - the content and snapshot of a run whose wait still has work waiting;
  - a dead outbox item's payload for its whole period after the last attempt, not after its
    creation.

  A reader that meets an expired event skips it (late wait matches) or shows its columns
  (`gateway events show`); it never parses it as an envelope.
- **Turn inputs go with the run's content,** not sooner. The next run's context shows a
  previous run's summary only together with its snapshot, which tells which thread it was
  about.
- **Kept:** approval requests, tool actions and the audit log. They are records (payments,
  decisions); their immutability triggers stay untouched.
- **How it runs:** hourly, in a loop of the controller's own, apart from the reconcile tick:
  - an advisory lock held for the pass keeps passes from overlapping, and a row update in
    `maintenance_status` claims at most one pass per interval;
  - each statement changes at most 500 rows, so transactions stay short;
  - it can be interrupted and resumed;
  - it records its outcome for the alert sweep, the metrics and `gateway doctor`.
- **Queue copies.** Completed jobs are deleted after pg-boss's default 7 days, which bounds
  the copies of turn inputs in the queue.

### Backups

The Gateway verifies backups; it does not make them:
- `scripts/backup-gateway-db.sh` is a reference producer: `pg_dump -Fc` plus a manifest written
  last;
- `gateway backup check` verifies the newest backup: manifest, age, size, checksum, database
  identity, schema, archive, and optionally a restore into a scratch database;
- `--record` stores the result, and the alert sweep turns a failed or stale result into an
  alert.

Encryption, off-host copies and Mattermost's data belong to the deployment.

### Resource limits

This phase adds limits in the application:
- a 2 MiB cap on a serialized turn input, behind the context budgets;
- statement, lock, idle-in-transaction and connection timeouts on the services' database
  pools (not on migrations or restores);
- removal of run workspaces a crashed worker left behind (untouched for 48 hours);
- the existing output, time and process-group limits of runtime CLIs.

Container limits come with the release images:
- a non-root user, a read-only root filesystem, dropped capabilities, no-new-privileges;
- CPU, memory and PID limits and separate networks.

Per-run containment of the unconfined runtimes remains a release gate: a limit on the worker
container does not stop a detached command of one run.

## Consequences

- Operators get one scrape target per service and alerts that say when a problem ends.
- A deployment without Prometheus still has `gateway doctor`, which now also reports firing
  alerts and retention.
- Old threads lose the content of expired posts in later turns' context; their summaries (90
  days) carry what matters.
- Spans can later be exported by adding an exporter that reads the same trace context. Stored
  rows need no change.
- Approval and tool records grow without bound until a separate archival policy exists.
