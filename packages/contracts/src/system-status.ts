import { z } from "zod";
import { AgentIdSchema, RuntimeAdapterIdSchema, TimestampSchema, UuidSchema } from "./common.ts";
import { GatewayEventTypeSchema } from "./event.ts";

// ---------------------------------------------------------------------------
// SystemStatus: the Gateway's own read-only snapshot of its operation, handed to agents whose
// configuration says `permissions.observe_system` (ADR-023). Operational metadata only: states,
// ids, counts, timestamps and codes. No message text, summary, wait condition or alert text,
// so it carries nothing across the channel boundaries of ADR-022.
// ---------------------------------------------------------------------------

/**
 * A state, status, queue name, alert key or error code: Gateway-made identifiers, never free
 * text. The charset leaves no room for markup or prose. Exported for `console-status.ts`, which
 * reuses this same shape for the console's own run/task status, outcome and error code fields.
 */
export const TokenSchema = z.string().regex(/^[A-Za-z0-9._:@/-]{1,200}$/);

const CountSchema = z.int().min(0);

/**
 * Provider model id, typed as broadly as `RuntimeUsageSchema.model` and `RunRuntimeSchema.model`
 * type it elsewhere in the contracts (turn.ts, jobs.ts): a bounded string, not `TokenSchema`'s
 * restrictive charset, which a legitimate model name (spaces, `+`, parentheses) could fail.
 * Exported for `console-status.ts`'s `ConsoleContext.model`.
 */
export const ModelNameSchema = z.string().min(1).max(255);

/** Runtime CLI version string, as `RuntimeSessionHandleSchema.runtimeVersion` types it elsewhere. */
const RuntimeVersionSchema = z.string().min(1).max(128);

export const SystemStatusRunSchema = z.strictObject({
	runId: UuidSchema,
	status: TokenSchema,
	attempt: z.int().min(1),
	maxAttempts: z.int().min(1),
	/** The type of the event that started the run (for example `mattermost.agent.mentioned`). */
	triggerType: GatewayEventTypeSchema,
	queuedAt: TimestampSchema,
	startedAt: TimestampSchema.nullable(),
});
export type SystemStatusRun = z.infer<typeof SystemStatusRunSchema>;

export const SystemStatusLastRunSchema = z.strictObject({
	runId: UuidSchema,
	status: TokenSchema,
	outcome: TokenSchema.nullable(),
	errorCode: TokenSchema.nullable(),
	finishedAt: TimestampSchema.nullable(),
	/** Input tokens of the run's last reported attempt; null when the runtime reported none. */
	inputTokens: CountSchema.nullable(),
	outputTokens: CountSchema.nullable(),
});
export type SystemStatusLastRun = z.infer<typeof SystemStatusLastRunSchema>;

export const SystemStatusAgentSchema = z.strictObject({
	agentId: AgentIdSchema,
	state: TokenSchema,
	enabled: z.boolean(),
	stateSince: TimestampSchema,
	runtimeAdapter: RuntimeAdapterIdSchema,
	model: ModelNameSchema.nullable(),
	activeRuns: z.array(SystemStatusRunSchema).max(8),
	lastRun: SystemStatusLastRunSchema.nullable(),
	activeWaits: CountSchema,
	nextWaitTimeoutAt: TimestampSchema.nullable(),
	pendingInbox: CountSchema,
	/** Input plus output tokens booked today (UTC), and their cost when reported. */
	tokensToday: CountSchema,
	costTodayUsd: z.number().min(0),
});
export type SystemStatusAgent = z.infer<typeof SystemStatusAgentSchema>;

export const SystemStatusRuntimeSchema = z.strictObject({
	adapter: RuntimeAdapterIdSchema,
	available: z.boolean(),
	versions: z.array(RuntimeVersionSchema).max(8),
	changedAt: TimestampSchema,
});
export type SystemStatusRuntime = z.infer<typeof SystemStatusRuntimeSchema>;

export const SystemStatusQueueSchema = z.strictObject({
	queue: TokenSchema,
	/** Due jobs waiting to be taken, new or retrying. */
	waiting: CountSchema,
	active: CountSchema,
	/** Age of the oldest due waiting job; null when none waits. */
	oldestWaitingSeconds: z.number().min(0).nullable(),
});
export type SystemStatusQueue = z.infer<typeof SystemStatusQueueSchema>;

export const SystemStatusAlertSchema = z.strictObject({
	key: TokenSchema,
	firedAt: TimestampSchema,
});
export type SystemStatusAlert = z.infer<typeof SystemStatusAlertSchema>;

export const SystemStatusMaintenanceSchema = z.strictObject({
	task: TokenSchema,
	lastSuccessAt: TimestampSchema.nullable(),
});
export type SystemStatusMaintenance = z.infer<typeof SystemStatusMaintenanceSchema>;

/** Every list is bounded: the snapshot stays small whatever the Gateway's size. */
export const SYSTEM_STATUS_LIMITS = {
	agents: 64,
	runtimes: 16,
	queues: 64,
	alerts: 32,
	maintenance: 16,
} as const;

export const SystemStatusSchema = z.strictObject({
	asOf: TimestampSchema,
	killSwitch: z.boolean(),
	agents: z.array(SystemStatusAgentSchema).max(SYSTEM_STATUS_LIMITS.agents),
	/** Agents left out by the limit. */
	omittedAgents: CountSchema,
	runtimes: z.array(SystemStatusRuntimeSchema).max(SYSTEM_STATUS_LIMITS.runtimes),
	/** Queues with jobs waiting or active; dead letter queues are named `dlq.*`. */
	queues: z.array(SystemStatusQueueSchema).max(SYSTEM_STATUS_LIMITS.queues),
	outbox: z.strictObject({ pending: CountSchema, dead: CountSchema }),
	approvalsPending: CountSchema,
	toolActionsUnknown: CountSchema,
	/** Alert conditions that hold now (the texts are in the alerts channel). */
	alerts: z.array(SystemStatusAlertSchema).max(SYSTEM_STATUS_LIMITS.alerts),
	maintenance: z.array(SystemStatusMaintenanceSchema).max(SYSTEM_STATUS_LIMITS.maintenance),
});
export type SystemStatus = z.infer<typeof SystemStatusSchema>;
