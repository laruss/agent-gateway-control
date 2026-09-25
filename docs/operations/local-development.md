# Local development

Everything below runs on a laptop with Bun and Docker. No Mattermost server is needed yet: the
controller can feed agent posts back to itself (`OUTBOX_DELIVERY=loopback`), so agent-to-agent
cascades run end to end on the mock runtime.

## Infrastructure

```bash
cp .env.example .env          # development values only; bun loads .env automatically
bun run dev:infra             # PostgreSQL 17.6 on 127.0.0.1:5433 (deploy/dev/compose.yaml)
bun run gateway db migrate    # database migrations and the pg-boss schema
```

The Compose file uses a fixed development password and binds to the loopback interface. It is
not a deployment: production reads `DATABASE_URL_FILE` from a secret file (every setting `X`
also accepts `X_FILE`, which wins over `X`).

## Configuration

```bash
bun run gateway config validate config/examples
bun run gateway config apply config/examples --mock-runtimes
```

`--mock-runtimes` runs every agent on the mock runtime, whatever `runtime.adapter` says.
Channel and user ids normally come from the Mattermost bootstrap; until it exists, set them by
hand (any 26 lowercase alphanumerics):

```bash
bun run gateway directory set channel hq hq000000000000000000000000
bun run gateway directory set user owner owner0000000000000000000aa
```

Every channel an agent is allowed in needs an id before that agent can run.

## Processes

```bash
OUTBOX_DELIVERY=loopback bun run dev   # controller and a mock worker
bun run gateway doctor
curl -s localhost:8080/health/ready
```

| Setting | Default | Meaning |
|---------|---------|---------|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `GATEWAY_ENV` | unset | `development` or `test` is required for the non-delivering outbox modes |
| `OUTBOX_DELIVERY` | required | `dry-run` logs side effects; `loopback` also ingests agent posts as events |
| `HEALTH_PORT` / `HEALTH_HOST` | `8080` / `127.0.0.1` | controller health endpoints |
| `WORKER_ADAPTER` | `mock` | runtime adapter the worker serves |
| `WORKER_CONCURRENCY` | `1` | parallel runs per worker process |

## Driving the mock runtime

Events are ingested from JSON files in the CloudEvents shape (`bun run gateway events ingest
event.json`). The mock runtime picks its behaviour from a directive in the post text:

| Directive | Result |
|-----------|--------|
| none | reply in the thread, idle; answers an agent that asked a question (post ends with `?`) |
| `[mock:mention <agent>]` | address another agent, idle |
| `[mock:wait <agent>]` | ask the agent and wait for its reply in the thread, addressed to it |
| `[mock:wait-open <agent>]` | the same, but any reply of that agent in the thread counts |
| `[mock:artifact]` | publish a link artifact and attach it |
| `[mock:approval <tool>]` | request human approval for a tool action |
| `[mock:fail]` | report a failure (agent becomes FAILED) |
| `[mock:invalid]` / `[mock:invalid-once]` | invalid output, also on repair / only the first time |
| `[mock:retryable]` / `[mock:flaky]` / `[mock:permanent]` | runtime errors |
| `[mock:slow]` | never finishes; exercises timeouts and cancellation |

## Operations

```bash
bun run gateway agents list
bun run gateway runs list --agent developer
bun run gateway runs redrive <run-id>   # FAILED agent: re-run its latest failed run
bun run gateway agents pause developer  # cancels a run in progress; inbox is kept
bun run gateway agents resume developer
bun run gateway kill-all                # no new runs, every agent paused
bun run gateway kill-all --release
bun run gateway dlq list
bun run gateway outbox list --status dead
bun run gateway outbox redrive <outbox-id>
```

A FAILED agent keeps its failure through pause, disable/enable and kill-all; `runs redrive`
is the only way out. Disabling an agent cancels its waits and expires its pending approvals.

## Worker database role

A worker needs only its adapter's pg-boss queues. Create a role per adapter and limit it:

```bash
psql "$DATABASE_URL" -c "create role gateway_worker login password '<secret>'"
bun run gateway db grant-worker gateway_worker mock   # after db migrate; one role per adapter
```

Then give the worker `DATABASE_URL` (or `DATABASE_URL_FILE`) with that role. `grant-worker`
refuses the owning role, superusers and roles that bypass row-level security. The controller
and the CLI must use the role that owns the tables (the one that ran `db migrate`): the
pg-boss job table has row-level security, and any other role sees none of its rows. In
development the worker may simply use the owner role without running `grant-worker`.

## Schema changes

Change `packages/db/src/schema.ts`, then `bun run db:generate` creates a new migration. Never
edit a committed migration. CI fails when the schema and the migrations disagree.
