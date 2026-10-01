# Observability, alerts and retention

What each service reports, what raises an alert, how long content is kept and which limits
protect the host. The design is [ADR-019](../adr/019-observability-and-retention.md); backups
are in [backups.md](backups.md).

## Health endpoints and metrics

Every service serves these endpoints on `HEALTH_HOST` (loopback by default) and `HEALTH_PORT`:
- `/health/live`;
- `/health/ready` (503 while a check fails);
- `/health/dependencies` (the checks);
- `/metrics` (Prometheus text format).

| Service | Default port | Ready when |
|---------|--------------|------------|
| controller | 8080 | PostgreSQL reachable, the schema certified for its release (`gateway db status`), the Mattermost listener connected (in `mattermost` mode) |
| worker | 8081 | the runtime probe passes and the worker takes jobs of the probed version |
| connector-gmail | 8082 | PostgreSQL reachable, the credential accepted, notifications pulled and the watch active (Pub/Sub mode), the last sync recent |
| tool-runner | 8083 | PostgreSQL reachable and not stopping |

Health details are redacted like log lines. Bind `HEALTH_HOST` to a private network only.

Metrics every service reports:
- `gateway_build_info{service,version}`;
- `process_uptime_seconds`, `process_resident_memory_bytes`, `process_heap_used_bytes`,
  `process_cpu_seconds`;
- `process_event_loop_delay_seconds`: the worst delay since the last scrape.

The controller also reports:

| Metric | Meaning |
|--------|---------|
| `gateway_metrics_collection_success` | 1 when the database gauges below are current. 0: the database did not answer within 2 seconds, and the gauges are left out, not zeroed |
| `gateway_agents{state}` | agents by state |
| `gateway_runs_active{status,adapter}` | queued and running runs |
| `gateway_queue_jobs{queue,state}`, `gateway_queue_oldest_job_seconds{queue}` | waiting, retrying and active jobs, and the age of the oldest waiting one |
| `gateway_dead_letter_jobs{queue}` | jobs in dead letter queues |
| `gateway_outbox_items{status}` | outbox items not delivered yet, dead ones included |
| `gateway_approvals_pending`, `gateway_tool_actions_open{status}` | approvals waiting for an owner; tool actions queued, running or unknown |
| `gateway_usage_today_cost_usd`, `gateway_usage_today_tokens` | usage booked today (UTC) |
| `gateway_runtime_available{adapter}` | whether a ready worker serves the runtime |
| `gateway_alert_firing{key}` | alert conditions that hold now |
| `gateway_maintenance_last_success_timestamp_seconds{task}` | retention and the recorded backup check |
| `gateway_kill_switch` | 1 while kill-all is on |
| `gateway_mattermost_connected` | the listener's WebSocket |
| `gateway_run_reports_total`, `gateway_tool_reports_total`, `gateway_outbox_deliveries_total`, `gateway_reconcile_failures_total{step}` | what the controller processed and what failed |

Each other service reports its own:
- the worker: `gateway_worker_run_jobs_total{adapter,outcome}`,
  `gateway_worker_run_job_duration_seconds`, `gateway_worker_run_jobs_active` and
  `gateway_worker_ready`;
- the tool runner: `gateway_tool_jobs_total{namespace,outcome}`,
  `gateway_tool_job_duration_seconds` and `gateway_tool_jobs_active`;
- the Gmail connector: `gateway_gmail_authorized`, `gateway_gmail_last_sync_timestamp_seconds`,
  `gateway_gmail_watch_expiry_timestamp_seconds` and `gateway_gmail_pulling`.

## The console

Health endpoints and metrics are for machines; the owner's console
([console.md](console.md), [ADR-023](../adr/023-console-and-operator.md)) is the human view of
the same operational state — agent states, current tasks, queues, alerts, budgets and the
Gateway's own context measurements, refreshed every 15 seconds. It is off by default
(`CONSOLE_ENABLED`) and, once a password is set, reachable only through the home server's Caddy
at `https://gateway.local`, authenticated with HTTP Basic against one Argon2id hash. It never
shows message bodies, run summaries or anything a log line already redacts.

The `operator` example agent answers the same "what's going on" question inside Mattermost,
from `permissions.observe_system` rather than the console's own cached projection: the scheduler
hands its turn a `SystemStatus` snapshot (agent states, run ids, queue depths, alert keys,
token and cost counts — the same operational metadata the console shows, never message content)
alongside the ordinary turn input. `observe_system` is off by default and, when granted, spans
every agent's state and the whole queue, not only the channels the observing agent shares —
deliberately more than any channel grant conveys (ADR-022), which is why it is its own explicit
permission rather than something every agent receives. The operator has no other grant: no
shell, filesystem, web, admin or execution tool, and an explicit `memory.write` deny leaves it
no writable namespace at all; it can only reply in its channels and tell the owner which
`gateway` command to run.

## Logs and traces

Every service writes one JSON object per line to stdout. Each line has:
- `timestamp`, `level`, `service`, `version`, `environment` and `message`;
- where known: `event_id`, `run_id`, `agent_id`, `job_id`, `correlation_id`, `trace_id`,
  `span_id` and `error_code`.

`version` is `GATEWAY_VERSION`, plus the first 12 characters of `GATEWAY_COMMIT` when set; it
is `0.0.0` in development.

Redaction applies to every line, to health details and to stored error details:
- fields named like a secret (`token`, `password`, `authorization`, `cookie`, `api_key`, …);
- bearer and basic credentials, `Authorization` and API key headers;
- provider tokens (OpenAI-style `sk-`, GitHub, Slack, AWS, Google refresh and access tokens,
  JWTs);
- private keys and credentials in connection URLs;
- secret query parameters;
- email addresses (`[email]`).

A string is cut at 4 KiB, an array at 100 items and a line at 32 KiB. Prompts, mail bodies and
raw CLI output are never logged.

**Following one piece of work** needs no tracing backend:
1. Every stored event gets a W3C trace: its own `traceparent` if valid; the trace of the run
   that caused it (an agent's post, an approval's outcome); else a new one.
2. The runs, attempts, deliveries and tool actions it leads to are spans in that trace.
3. To see the whole chain, across agents, filter all services' logs by one `trace_id`.
4. `agent_runs.traceparent`, `outbox.traceparent` and `tool_actions.traceparent` hold the
   same trace for queries.

## Alerts

The listener bot posts alerts in `mattermost.alerts_channel`.

**One-time notices** are posted once each. They cover:
- a run that failed, or could not start;
- invalid output of a run;
- authority, policy and forgery refusals;
- impersonation;
- a loop breaker;
- a budget hold;
- unknown or late tool outcomes;
- runtime availability changes;
- Gmail credential and sync problems.

**Conditions** fire when they start, remind every 6 hours while they last, and post
"Resolved" when they end. They are evaluated on every reconcile tick of the controller:

| Key | Fires when |
|-----|-----------|
| `mattermost:disconnected` | the listener has been disconnected for 2 minutes; resolved once it stayed connected for 2 minutes |
| `dlq:<queue>` | a dead letter queue holds jobs (`gateway dlq list`) |
| `outbox:dead` | outbox items could not be delivered (`gateway outbox list --status dead`) |
| `budget:global`, `budget:agent:<id>` | 80% of a daily budget is used (the hold comes at 100%) |
| `invalid-output:<adapter>` | 3 or more runs of a runtime returned invalid output in 15 minutes |
| `gmail-watch:<mailbox>` | a Gmail watch (Pub/Sub mode) expires within 24 hours or has expired |
| `maintenance:retention` | retention has not succeeded for 3 hours |
| `maintenance:backup` | the last recorded backup check failed, or none passed within its maximum age |

`gateway doctor` lists the firing conditions (`alerts`). Metrics show them as
`gateway_alert_firing`.

**When Mattermost or the database is down,** the alerts channel cannot tell you. The alerts
wait in the outbox until Mattermost is back. Watch these from outside the Gateway (a cron job,
an uptime monitor, Prometheus):
- `/health/ready` of every service;
- the exit code of `gateway health`;
- the exit code of `gateway backup check`.

What to do when a condition fires:

| Condition | First steps |
|-----------|-------------|
| `mattermost:disconnected` | Check the Mattermost container and the network. The listener reconnects and catches up by itself. |
| `dlq:*` | Read `gateway dlq list`, fix the cause, then `gateway dlq redrive`. |
| `outbox:dead` | Read `gateway outbox list --status dead` (`last_error_redacted`), then `gateway outbox redrive <id>`. |
| `budget:*` | Check `gateway budgets`. Raise the limit in `organization.yaml` if the spending is expected. |
| `invalid-output:*` | Run `gateway runtime doctor <adapter>`: a CLI or model change. |
| `gmail-watch:*` | Read the connector's logs, then `gateway gmail status`. |
| `maintenance:retention` | Read the controller's `retention failed` log lines. |
| `maintenance:backup` | See [backups.md](backups.md). |

## Retention

The controller removes old content hourly. Periods are in days, each at least 8:

```yaml
# organization.yaml
organization:
  retention:
    event_content_days: 30      # posts and mail in event payloads
    run_content_days: 30        # run results, summaries, error details, exact turn inputs
    outbox_sent_days: 8         # payloads of delivered posts and alerts
    outbox_dead_days: 30        # payloads of undeliverable items, from their last attempt
    policy_input_days: 30       # inputs of policy decisions
    thread_summary_days: 90     # summaries of inactive threads
    inactive_memory_days: 30    # rejected and superseded memory
    usage_days: 400             # the usage ledger
```

Leaving the section out keeps these defaults.

Content is removed in place:
- ids, hashes, statuses and timestamps stay, so a redelivered event is still a duplicate and
  the audit trail stays whole;
- an expired event keeps only `channel_id`, `root_id` and `post_id`;
- the row is marked `content_expired_at`.

Never expired:
- the events of pending work;
- the events of a FAILED agent's latest run, so `runs redrive` still works;
- the edits and deletions of those posts;
- the content and turn input of a run whose wait still has work waiting (a timeout of a paused
  agent finds its thread through them);
- approval requests and tool actions (records of decisions and payments);
- the audit log.

After expiry:
- a dead outbox item whose payload expired cannot be redriven;
- a run whose events lost their content cannot be redriven;
- older posts drop out of the thread context of later turns; the thread's summary remains.

Completed queue jobs, which copy run inputs, are deleted by pg-boss after 7 days.

`gateway doctor` shows the last successful run (`retention`); metrics have the same as
`gateway_maintenance_last_success_timestamp_seconds{task="retention"}`.

## Resource limits

| Limit | Value | Where |
|-------|-------|-------|
| Turn input | 2 MiB serialized; a larger one is refused with an alert (the context budgets keep inputs far below) | scheduler |
| Database statements of the services | 60 s statement, 30 s lock wait, 60 s idle in a transaction, 10 s to connect (tool runner: 30 s, 15 s, 30 s, 10 s) | service pools; migrations and restores are unlimited |
| Metrics collection | 2 s per scrape, cached for 15 s | controller |
| Runtime CLI output | 8 MiB per stream; the head and tail are kept | runtime SDK |
| Runtime CLI time | the run's timeout (at most 24 h), then SIGTERM, then SIGKILL of the process group after 5 s | runtime SDK |
| Run workspaces | removed after each attempt; leftovers of a crashed worker are removed after 48 h without change | worker, at start and hourly |
| Worker concurrency | `WORKER_CONCURRENCY`, 1 by default | worker |

The release images add container limits (CPU, memory, PIDs), a non-root user, a read-only root
filesystem and dropped capabilities.
