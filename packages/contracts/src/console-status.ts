import { z } from "zod";
import {
	AgentIdSchema,
	MattermostIdSchema,
	MattermostNameSchema,
	TimestampSchema,
	UuidSchema,
} from "./common.ts";
import { GatewayEventTypeSchema } from "./event.ts";
import { DailyBudgetSchema } from "./organization.ts";
import {
	ModelNameSchema,
	SystemStatusAgentSchema,
	SystemStatusSchema,
	TokenSchema,
} from "./system-status.ts";

// ---------------------------------------------------------------------------
// ConsoleStatus: everything the owner's console shows (ADR-023), on top of `SystemStatus` —
// tasks, context measurements and recent runs. Shared between the controller, which builds and
// serves it (`apps/controller/src/console-status.ts`), and the console frontend
// (`apps/console`), which parses `/api/status` against these same schemas at the fetch boundary
// rather than trusting the response shape. Never message text, summary or wait-condition prose:
// the same metadata/content boundary `SystemStatus` itself keeps.
// ---------------------------------------------------------------------------

export const ConsoleTaskSchema = z.strictObject({
	runId: UuidSchema,
	status: TokenSchema,
	attempt: z.int().min(1),
	maxAttempts: z.int().min(1),
	queuedAt: TimestampSchema,
	startedAt: TimestampSchema.nullable(),
	deadlineAt: TimestampSchema,
	triggerType: GatewayEventTypeSchema,
	/** The channel's configured or granted name; null outside Mattermost or when unresolved. */
	channel: MattermostNameSchema.nullable(),
	/** The thread's root post id; null for a run outside any thread. */
	threadRootId: MattermostIdSchema.nullable(),
});
export type ConsoleTask = z.infer<typeof ConsoleTaskSchema>;

/** The Gateway's own budgets in characters and bytes, and the tokens the runtime reported for a
 * run's last attempt; never a context-window fill percentage (ADR-023). */
export const ConsoleContextSchema = z.strictObject({
	runId: UuidSchema,
	inputBytes: z.int().min(0),
	inputLimitBytes: z.int().min(0),
	rootChars: z.int().min(0),
	rootLimitChars: z.int().min(0),
	threadPosts: z.int().min(0),
	omittedPosts: z.int().min(0),
	recentRepliesChars: z.int().min(0),
	recentRepliesLimitChars: z.int().min(0),
	summaryChars: z.int().min(0),
	summaryLimitChars: z.int().min(0),
	memoryItems: z.int().min(0),
	memoryChars: z.int().min(0),
	memoryLimitChars: z.int().min(0),
	pendingEvents: z.int().min(0),
	inputTokens: z.int().min(0).nullable(),
	cachedInputTokens: z.int().min(0).nullable(),
	outputTokens: z.int().min(0).nullable(),
	model: ModelNameSchema.nullable(),
});
export type ConsoleContext = z.infer<typeof ConsoleContextSchema>;

/** `wait_subscriptions.event_type` is always one of `WaitableEventTypeSchema`'s values (nothing
 * else can be waited on), but is read back here as the same plain token shape the rest of this
 * module uses, not that narrower enum, since the row it is read from is typed as a plain
 * string column, not re-validated against the waitable set on this read-only path. */
export const ConsoleWaitSchema = z.strictObject({
	eventType: TokenSchema,
	timeoutAt: TimestampSchema,
});
export type ConsoleWait = z.infer<typeof ConsoleWaitSchema>;

export const ConsoleSessionSchema = z.strictObject({
	lastUsedAt: TimestampSchema,
	expiresAt: TimestampSchema.nullable(),
});
export type ConsoleSession = z.infer<typeof ConsoleSessionSchema>;

export const ConsoleAgentSchema = z.strictObject({
	status: SystemStatusAgentSchema,
	displayName: z.string().min(1).max(64),
	/** The queued or running run's task; null while the agent has none. */
	current: ConsoleTaskSchema.nullable(),
	waits: z.array(ConsoleWaitSchema),
	/** Of the current run, else of the latest one; null once its snapshot has expired under
	 * retention. */
	context: ConsoleContextSchema.nullable(),
	/** The largest input tokens a single run's last stored attempt reported in the last 7 days. */
	maxInputTokens7d: z.int().min(0).nullable(),
	session: ConsoleSessionSchema.nullable(),
	budget: DailyBudgetSchema.nullable(),
});
export type ConsoleAgent = z.infer<typeof ConsoleAgentSchema>;

export const ConsoleRunSchema = z.strictObject({
	runId: UuidSchema,
	agentId: AgentIdSchema,
	status: TokenSchema,
	outcome: TokenSchema.nullable(),
	errorCode: TokenSchema.nullable(),
	triggerType: GatewayEventTypeSchema,
	queuedAt: TimestampSchema,
	startedAt: TimestampSchema.nullable(),
	finishedAt: TimestampSchema.nullable(),
	inputTokens: z.int().min(0).nullable(),
	outputTokens: z.int().min(0).nullable(),
});
export type ConsoleRun = z.infer<typeof ConsoleRunSchema>;

/** The alert's own message: already sent to the owner's alerts channel, never a run's or a
 * channel's content. */
export const ConsoleAlertSchema = z.strictObject({
	key: TokenSchema,
	message: z.string().min(1).max(2000),
	firedAt: TimestampSchema,
});
export type ConsoleAlert = z.infer<typeof ConsoleAlertSchema>;

export const ConsoleStatusSchema = z.strictObject({
	system: SystemStatusSchema,
	agents: z.array(ConsoleAgentSchema),
	recentRuns: z.array(ConsoleRunSchema),
	alerts: z.array(ConsoleAlertSchema),
});
export type ConsoleStatus = z.infer<typeof ConsoleStatusSchema>;

/**
 * What a console request is handed: a fresh collection, one kept past its cache window because
 * the next one failed or ran too long (still labeled with its own, older, time), or — only
 * before any collection has ever succeeded — nothing at all. Never an empty, healthy-looking
 * system in place of a real failure (ADR-023). This is the exact shape `GET /api/status` and
 * `GET /` (while a session is valid) return; the console frontend parses it with this schema at
 * the fetch boundary.
 */
export const ConsoleSnapshotSchema = z.discriminatedUnion("state", [
	z.strictObject({
		state: z.literal("ok"),
		asOf: TimestampSchema,
		status: ConsoleStatusSchema,
	}),
	z.strictObject({
		state: z.literal("stale"),
		asOf: TimestampSchema,
		status: ConsoleStatusSchema,
		error: z.string(),
	}),
	z.strictObject({ state: z.literal("unavailable"), error: z.string() }),
]);
export type ConsoleSnapshot = z.infer<typeof ConsoleSnapshotSchema>;
