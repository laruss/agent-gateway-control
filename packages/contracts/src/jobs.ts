import { z } from "zod";
import { AgentIdSchema, type JsonObject, type RuntimeAdapterId, UuidSchema } from "./common.ts";
import { AgentTurnInputSchema, RuntimeSessionHandleSchema, RuntimeUsageSchema } from "./turn.ts";

/**
 * Queue names shared by the controller and the workers. A queue carries exactly one payload
 * schema; both sides parse it, a worker never trusts the controller's payload blindly and the
 * controller never trusts a worker's report. Every runtime adapter has its own run, report and
 * dead letter queue, each in its own table, so a worker's database role can be limited to its
 * adapter's jobs.
 */
export const QUEUES = {
	/** Controller -> controller: a run exceeded its deadline. */
	agentTimeout: "agent.timeout",
	/** Controller -> controller: a durable wait reached its timeout. */
	waitTimeout: "wait.timeout",
	/** Controller -> controller: perform one outbox side effect. */
	outboxDeliver: "outbox.deliver",
	/** Dead letter queues of controller queues. */
	deadLetterReports: "dlq.agent.run.report",
	deadLetterOutbox: "dlq.outbox",
	deadLetterTimeouts: "dlq.timeout",
} as const;

export type RunQueueName = `agent.run.${RuntimeAdapterId}`;
export type ReportQueueName = `agent.run.report.${RuntimeAdapterId}`;
export type RunDeadLetterQueueName = `dlq.agent.run.${RuntimeAdapterId}`;
export type QueueName =
	| (typeof QUEUES)[keyof typeof QUEUES]
	| RunQueueName
	| ReportQueueName
	| RunDeadLetterQueueName;

/** Controller -> worker queue of one runtime adapter. */
export function runQueue(adapter: RuntimeAdapterId): RunQueueName {
	return `agent.run.${adapter}`;
}

/** Worker -> controller: run started, finished or failed, for runs of one adapter. */
export function reportQueue(adapter: RuntimeAdapterId): ReportQueueName {
	return `agent.run.report.${adapter}`;
}

/** Expired or failed run jobs of one adapter. */
export function runDeadLetterQueue(adapter: RuntimeAdapterId): RunDeadLetterQueueName {
	return `dlq.agent.run.${adapter}`;
}

export type SendOptions = Readonly<{
	/** Earliest start. */
	startAfter?: Date;
	/** Overrides the queue expiration for this job, e.g. a run with a long timeout. */
	expireInSeconds?: number;
	singletonKey?: string;
}>;

/**
 * Enqueues jobs. Bound to a database transaction, a job becomes visible exactly when the
 * transaction commits and disappears with a rollback. Implemented over pg-boss by
 * `@agent-gateway/queue`; the domain only sees this port.
 */
export type JobSink = Readonly<{
	send: (queue: QueueName, data: JsonObject, options?: SendOptions) => Promise<string>;
}>;

/** A run attempt handed to a worker; the input is complete, the worker reads no domain state. */
export const RunJobSchema = z.strictObject({
	runId: UuidSchema,
	attempt: z.int().min(1),
	/** The run's time budget; the worker sets `input.deadline` from it when the run starts. */
	timeoutSeconds: z.int().min(1).max(86_400),
	input: AgentTurnInputSchema,
});
export type RunJob = z.infer<typeof RunJobSchema>;

export const RunErrorCodeSchema = z.enum([
	/** The runtime did not finish before the deadline. */
	"timeout",
	/** The run was cancelled by an operator or kill-all. */
	"cancelled",
	/** Output failed validation, including after the one repair attempt. */
	"invalid_output",
	/** The runtime failed in a way that may succeed on another attempt. */
	"runtime_retryable",
	/** The runtime failed in a way another attempt will not fix. */
	"runtime_permanent",
	/** The worker could not parse the job it received. */
	"invalid_job",
]);
export type RunErrorCode = z.infer<typeof RunErrorCodeSchema>;

export const RunErrorSchema = z.strictObject({
	code: RunErrorCodeSchema,
	retryable: z.boolean(),
	/** Redacted and truncated by the worker; never contains raw model output. */
	detail: z.string().max(2000),
});
export type RunError = z.infer<typeof RunErrorSchema>;

const ReportBase = {
	runId: UuidSchema,
	attempt: z.int().min(1),
	agentId: AgentIdSchema,
};

/**
 * Worker -> controller report. `result` is untrusted: the controller validates it again and
 * checks its authority before persisting anything.
 */
export const RunReportSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		...ReportBase,
		kind: z.literal("started"),
		runtimeVersion: z.string().max(128),
	}),
	z.strictObject({
		...ReportBase,
		kind: z.literal("completed"),
		runtimeVersion: z.string().max(128),
		result: z.json(),
	}),
	z.strictObject({
		...ReportBase,
		kind: z.literal("failed"),
		runtimeVersion: z.string().max(128),
		error: RunErrorSchema,
		usage: RuntimeUsageSchema.nullable(),
		session: RuntimeSessionHandleSchema.nullable(),
	}),
]);
export type RunReport = z.infer<typeof RunReportSchema>;

export const RunTimeoutJobSchema = z.strictObject({ runId: UuidSchema, attempt: z.int().min(1) });
export type RunTimeoutJob = z.infer<typeof RunTimeoutJobSchema>;

export const WaitTimeoutJobSchema = z.strictObject({ waitId: UuidSchema });
export type WaitTimeoutJob = z.infer<typeof WaitTimeoutJobSchema>;

export const OutboxDeliverJobSchema = z.strictObject({ outboxId: UuidSchema });
export type OutboxDeliverJob = z.infer<typeof OutboxDeliverJobSchema>;
