import type { JobSink } from "@agent-gateway/contracts";
import type { Transaction } from "@agent-gateway/db";
import type { Logger } from "@agent-gateway/logging";
import type pg from "pg";

/** Everything the control plane use cases need; injected so tests control time and queues. */
export type ControlPlaneDeps = Readonly<{
	pool: pg.Pool;
	/** A job sink bound to the transaction, so jobs commit and roll back with domain writes. */
	jobs: (transaction: Transaction) => JobSink;
	clock: () => Date;
	random: () => number;
	log: Logger;
}>;

/** A transaction plus the deps, passed through one use case. */
export type UnitOfWork = Readonly<{
	deps: ControlPlaneDeps;
	tx: Transaction;
	jobs: JobSink;
	now: Date;
}>;
