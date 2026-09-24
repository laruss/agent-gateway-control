# ADR-003. PostgreSQL + pg-boss instead of a separate broker

- Status: Accepted
- Date: 2026-09-24

## Context

The system needs a durable queue, retries with backoff, delayed jobs, a DLQ, and enqueueing a
job in the same transaction as the domain write. Deployment is a single node on a home server.

## Decision

- PostgreSQL is the only data store. Queues are pg-boss in the same database.
- A job is enqueued in the same transaction as the domain write (event, inbox, run result):
  pg-boss accepts the transaction's client through its `db` option.
- Drizzle ORM and Drizzle migrations for the schema; the `pg` (node-postgres) driver, shared with
  pg-boss.

The smoke test `packages/testkit/src/bun-compat.integration.test.ts` confirms that after a
`ROLLBACK` neither the domain row nor the job remains, and after a `COMMIT` both are stored.

## Alternatives

- **Redis/BullMQ.** Another stateful component, and no shared transaction with PostgreSQL.
- **NATS/Kafka.** Overkill for a single node and still needs an outbox on top.
- **Temporal.** A powerful workflow model, but heavy infrastructure for an MVP.

## Consequences

- All load lands on one PostgreSQL instance, which is acceptable at home-server scale.
- Backing up one database covers both state and queues.
