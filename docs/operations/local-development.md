# Local development

Everything below runs on a laptop with Bun and Docker. Two ways to run it:

- **Without Mattermost:** the controller feeds agent posts back to itself
  (`OUTBOX_DELIVERY=loopback`), so agent-to-agent cascades run end to end on the mock runtime.
- **With Mattermost:** the development Compose also starts Mattermost 11.7.11; after the
  bootstrap, humans and agents talk in real channels (see [With Mattermost](#with-mattermost)).

## Infrastructure

```bash
cp .env.example .env          # development values only; bun loads .env automatically
bun run dev:infra             # PostgreSQL 17.6 on 127.0.0.1:5433, Mattermost on 127.0.0.1:8065
bun run gateway db migrate    # database migrations and the pg-boss schema
```

The Compose file uses fixed development passwords and binds to the loopback interface. It is
not a deployment: production reads `DATABASE_URL_FILE` from a secret file (every setting `X`
also accepts `X_FILE`, which wins over `X`). The Mattermost image is amd64 only; on Apple
silicon Docker runs it emulated, which is slower but works.

## Configuration

```bash
bun run gateway config validate config/examples
bun run gateway config apply config/examples --mock-runtimes
```

`--mock-runtimes` runs every agent on the mock runtime, whatever `runtime.adapter` says.
Channel and user ids come from the Mattermost bootstrap. Without Mattermost, set them by hand
(any 26 lowercase alphanumerics):

```bash
bun run gateway directory set team autonomous-lab team00000000000000000000aa
bun run gateway directory set channel hq hq000000000000000000000000
bun run gateway directory set user owner owner0000000000000000000aa
```

Every channel an agent is allowed in needs an id before that agent can run, and channel ids
count only once the configured team has one.

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
| `OUTBOX_DELIVERY` | required | `mattermost` delivers for real; `dry-run` logs side effects; `loopback` also ingests agent posts as events |
| `MATTERMOST_URL` | required with `mattermost` | Mattermost base URL |
| `GATEWAY_ROUTING_KEY` | required with `mattermost` | HMAC key of agent routing props (use `_FILE`) |
| `SECRETS_DIR` | unset | directory standing in for `/run/secrets/` (bot tokens) |
| `HEALTH_PORT` / `HEALTH_HOST` | `8080` / `127.0.0.1` | controller health endpoints |
| `WORKER_ADAPTER` | `mock` | runtime adapter the worker serves |
| `WORKER_CONCURRENCY` | `1` | parallel runs per worker process |

## With Mattermost

1. Open http://127.0.0.1:8065 once `curl -s 127.0.0.1:8065/api/v4/system/ping` answers, and
   follow the manual steps of the [Mattermost guide](mattermost.md#manual-steps-first): the
   first account (admin), the team `autonomous-lab`, the channels of
   `config/examples/organization.yaml`, the `owner` account, an admin access token.
2. Apply the configuration, bootstrap and check:

   ```bash
   bun run gateway config apply config/examples --mock-runtimes
   read -rs MATTERMOST_ADMIN_TOKEN && export MATTERMOST_ADMIN_TOKEN
   MATTERMOST_URL=http://127.0.0.1:8065 bun run gateway mattermost bootstrap --secrets-dir secrets
   MATTERMOST_URL=http://127.0.0.1:8065 bun run gateway mattermost reconcile --secrets-dir secrets
   ```

   `secrets/` is git-ignored; it now holds the bot tokens and the routing key.
3. Switch `.env` to the Mattermost block of `.env.example` and start `bun run dev`. As
   `owner`, write `@developer how is the build going?` in `#hq`: the developer bot answers in
   the thread. `@research look at X [mock:mention finance]` makes research hand over to
   finance, which answers too.

## Driving the mock runtime

Without Mattermost, events are ingested from JSON files in the CloudEvents shape (`bun run
gateway events ingest event.json`); with it, they are simply posts. The mock runtime picks its
behaviour from a directive in the post text:

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
