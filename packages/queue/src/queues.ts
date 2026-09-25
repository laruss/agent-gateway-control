import {
	QUEUES,
	type QueueName,
	type RuntimeAdapterId,
	reportQueue,
	runDeadLetterQueue,
	runQueue,
} from "@agent-gateway/contracts";
import type { PgBoss } from "pg-boss";

type QueuePolicy = Readonly<{
	retryLimit: number;
	retryDelay?: number;
	retryBackoff?: boolean;
	retryDelayMax?: number;
	expireInSeconds: number;
	deadLetter?: QueueName;
	/** A dedicated table; per-adapter queues use it so worker grants can be table-scoped. */
	partition?: boolean;
	/** How long a queued job is kept before pg-boss deletes it unprocessed. */
	retentionSeconds?: number;
}>;

/**
 * Queued run and timeout jobs must outlive any worker outage and the longest wait: pg-boss
 * deletes unprocessed jobs after their retention (14 days by default). The controller also
 * reconciles runs and waits whose job disappeared.
 */
const LONG_RETENTION_SECONDS = 90 * 24 * 3600;

/** Exponential backoff (pg-boss adds jitter) capped at five minutes, then the dead letter queue. */
const BACKOFF = { retryDelay: 5, retryBackoff: true, retryDelayMax: 300 } as const;

const DEAD_LETTER: QueuePolicy = { retryLimit: 0, expireInSeconds: 60 };

const REPORT_POLICY: QueuePolicy = {
	...BACKOFF,
	retryLimit: 5,
	expireInSeconds: 120,
	deadLetter: QUEUES.deadLetterReports,
	partition: true,
};

/**
 * A run job is never retried by pg-boss: the controller owns the attempt counter and retries a
 * silent attempt after its deadline. An expired or failed job goes to the dead letter queue.
 */
function runQueuePolicy(adapter: RuntimeAdapterId): QueuePolicy {
	return {
		retryLimit: 0,
		// Each run job sets its own expiration from the agent's timeout.
		expireInSeconds: MAX_JOB_EXPIRATION_SECONDS,
		deadLetter: runDeadLetterQueue(adapter),
		partition: true,
		retentionSeconds: LONG_RETENTION_SECONDS,
	};
}

const CONTROLLER_QUEUES: Readonly<Record<string, QueuePolicy>> = {
	[QUEUES.agentTimeout]: {
		...BACKOFF,
		retryLimit: 5,
		expireInSeconds: 120,
		retentionSeconds: LONG_RETENTION_SECONDS,
		deadLetter: QUEUES.deadLetterTimeouts,
	},
	[QUEUES.waitTimeout]: {
		...BACKOFF,
		retryLimit: 5,
		expireInSeconds: 120,
		retentionSeconds: LONG_RETENTION_SECONDS,
		deadLetter: QUEUES.deadLetterTimeouts,
	},
	[QUEUES.outboxDeliver]: {
		...BACKOFF,
		retryLimit: 8,
		expireInSeconds: 120,
		deadLetter: QUEUES.deadLetterOutbox,
	},
};

const CONTROLLER_DEAD_LETTER_QUEUES: Readonly<QueueName[]> = [
	QUEUES.deadLetterReports,
	QUEUES.deadLetterOutbox,
	QUEUES.deadLetterTimeouts,
];

/** Every dead letter queue, for `doctor` and `dlq list`. */
export function deadLetterQueues(adapters: Readonly<RuntimeAdapterId[]>): Readonly<QueueName[]> {
	return [...CONTROLLER_DEAD_LETTER_QUEUES, ...adapters.map(runDeadLetterQueue)];
}

/** pg-boss caps job expiration at 24 hours. */
export const MAX_JOB_EXPIRATION_SECONDS = 86_400;

async function ensureQueue(boss: PgBoss, name: string, policy: QueuePolicy): Promise<void> {
	const existing = await boss.getQueue(name);
	if (existing === null) {
		await boss.createQueue(name, policy);
		return;
	}
	// The table layout is fixed at creation; only retry and expiry settings can change.
	const { partition: _layout, ...settings } = policy;
	await boss.updateQueue(name, settings);
}

/** Creates or updates every queue. Dead letter queues come first: others reference them. */
export async function ensureQueues(
	boss: PgBoss,
	adapters: Readonly<RuntimeAdapterId[]>,
): Promise<void> {
	for (const name of CONTROLLER_DEAD_LETTER_QUEUES) {
		await ensureQueue(boss, name, DEAD_LETTER);
	}
	for (const [name, policy] of Object.entries(CONTROLLER_QUEUES)) {
		await ensureQueue(boss, name, policy);
	}
	for (const adapter of adapters) {
		await ensureQueue(boss, runDeadLetterQueue(adapter), { ...DEAD_LETTER, partition: true });
		await ensureQueue(boss, runQueue(adapter), runQueuePolicy(adapter));
		await ensureQueue(boss, reportQueue(adapter), REPORT_POLICY);
	}
}
