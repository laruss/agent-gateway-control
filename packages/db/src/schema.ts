import type {
	ActionParams,
	AgentConfig,
	AgentTurnInput,
	GatewayEventType,
	JsonObject,
	JsonValue,
	MattermostId,
	OrganizationConfig,
	RuntimeAdapterId,
	RuntimeUsage,
	TurnAuthorityContext,
	WaitCondition,
	WorkingSummary,
} from "@agent-gateway/contracts";
import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

/** Allowed values of a text status column, enforced by a CHECK constraint. */
function oneOf(column: string, values: Readonly<string[]>) {
	return sql.raw(`${column} in (${values.map((v) => `'${v}'`).join(", ")})`);
}

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const AGENT_STATES = [
	"disabled",
	"idle",
	"queued",
	"running",
	"waiting",
	"failed",
	"paused",
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ACTIVE_RUN_STATUSES: Readonly<RunStatus[]> = ["queued", "running"];

export const RUN_OUTCOMES = ["idle", "waiting", "needs_human", "failed"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const ROUTE_DECISIONS = ["wake", "ignore", "wait-match", "blocked"] as const;
export type RouteDecision = (typeof ROUTE_DECISIONS)[number];

export const INBOX_STATUSES = ["pending", "claimed", "consumed", "dead"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export const WAIT_STATUSES = ["active", "matched", "timed_out", "cancelled"] as const;
export type WaitStatus = (typeof WAIT_STATUSES)[number];

export const OUTBOX_STATUSES = ["pending", "sending", "sent", "dead"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const OUTBOX_KINDS = ["mattermost.post", "mattermost.alert", "mattermost.approval"] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

export const APPROVAL_STATUSES = ["pending", "granted", "denied", "expired", "executed"] as const;
export const MEMORY_STATUSES = ["proposed", "accepted", "rejected", "superseded"] as const;
export const VISIBILITIES = ["private", "shared", "public"] as const;
export const POLICY_DECISIONS = ["allow", "deny", "require_approval"] as const;
export const DIRECTORY_KINDS = ["channel", "user"] as const;
export type DirectoryKind = (typeof DIRECTORY_KINDS)[number];

/** Global switches; exactly one row with id 1. */
export const gatewayControls = pgTable(
	"gateway_controls",
	{
		id: integer("id").primaryKey().default(1),
		/** Set by kill-all: no new runs start until an operator releases it. */
		killSwitch: boolean("kill_switch").notNull().default(false),
		activeConfigVersion: text("active_config_version"),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [check("gateway_controls_single_row", sql`${t.id} = 1`)],
);

/** Validated organization + agent configuration, with prompt texts resolved at apply time. */
export const configVersions = pgTable("config_versions", {
	/** sha256 of the canonical bundle. */
	version: text("version").primaryKey(),
	organization: jsonb("organization").$type<OrganizationConfig>().notNull(),
	constitution: text("constitution").notNull(),
	appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agents = pgTable(
	"agents",
	{
		id: text("id").primaryKey(),
		displayName: text("display_name").notNull(),
		enabled: boolean("enabled").notNull(),
		state: text("state").$type<AgentState>().notNull(),
		runtimeAdapter: text("runtime_adapter").$type<RuntimeAdapterId>().notNull(),
		runtimeProfile: text("runtime_profile").notNull(),
		configVersion: text("config_version")
			.notNull()
			.references(() => configVersions.version),
		maxActiveRuns: integer("max_active_runs").notNull(),
		config: jsonb("config").$type<AgentConfig>().notNull(),
		rolePrompt: text("role_prompt").notNull(),
		stateChangedAt: timestamp("state_changed_at", { withTimezone: true }).notNull().defaultNow(),
		createdAt: createdAt(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		check("agents_state", oneOf("state", AGENT_STATES)),
		check("agents_enabled_state", sql`${t.enabled} = (${t.state} <> 'disabled')`),
	],
);

/** Mattermost ids of channels and users, resolved by bootstrap from configured names. */
export const mattermostDirectory = pgTable(
	"mattermost_directory",
	{
		kind: text("kind").$type<DirectoryKind>().notNull(),
		name: text("name").notNull(),
		mattermostId: text("mattermost_id").$type<MattermostId>().notNull(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.kind, t.name] }),
		uniqueIndex("mattermost_directory_id").on(t.kind, t.mattermostId),
		check("mattermost_directory_kind", oneOf("kind", DIRECTORY_KINDS)),
	],
);

export const mattermostIdentities = pgTable("mattermost_identities", {
	agentId: text("agent_id")
		.primaryKey()
		.references(() => agents.id),
	/** Null until bootstrap has resolved the bot account. */
	mattermostUserId: text("mattermost_user_id").$type<MattermostId>().unique(),
	username: text("username").notNull().unique(),
	/** Path of the secret file; the token itself never enters the database. */
	tokenSecretRef: text("token_secret_ref").notNull(),
	lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
});

export const events = pgTable(
	"events",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/** Monotonic acceptance order; timestamps can tie. */
		seq: bigserial("seq", { mode: "number" }).notNull().unique(),
		specversion: text("specversion").notNull(),
		externalId: text("external_id").notNull(),
		source: text("source").notNull(),
		type: text("type").$type<GatewayEventType>().notNull(),
		subject: text("subject"),
		time: timestamp("time", { withTimezone: true }).notNull(),
		correlationId: text("correlation_id").notNull(),
		causationId: text("causation_id"),
		traceparent: text("traceparent"),
		trustLevel: text("trust_level").notNull(),
		hop: integer("hop").notNull(),
		payload: jsonb("payload").$type<JsonObject>().notNull(),
		payloadHash: text("payload_hash").notNull(),
		/** Normalized content hash of posts, for the duplicate-payload loop guard. */
		contentHash: text("content_hash"),
		senderAgentId: text("sender_agent_id"),
		receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("events_source_external_id").on(t.source, t.externalId),
		index("events_correlation").on(t.correlationId),
		index("events_content_hash").on(t.contentHash, t.receivedAt),
		index("events_sender_agent").on(t.senderAgentId, t.receivedAt),
	],
);

export const eventRoutes = pgTable(
	"event_routes",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		eventId: uuid("event_id")
			.notNull()
			.references(() => events.id),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		decision: text("decision").$type<RouteDecision>().notNull(),
		reasonCode: text("reason_code").notNull(),
		waitId: uuid("wait_id"),
		/** `seq` of the human post that started the cascade this wake-up spends budget of. */
		cascadeAnchor: bigint("cascade_anchor", { mode: "number" }),
		policySnapshot: jsonb("policy_snapshot").$type<JsonObject>().notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("event_routes_unique").on(t.eventId, t.agentId, t.decision),
		index("event_routes_agent").on(t.agentId, t.createdAt),
		check("event_routes_decision", oneOf("decision", ROUTE_DECISIONS)),
	],
);

export const agentRuns = pgTable(
	"agent_runs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		triggerEventId: uuid("trigger_event_id")
			.notNull()
			.references(() => events.id),
		/** `agent-run:<agent>:<trigger event>:<generation>`; a redelivery cannot create a second run. */
		idempotencyKey: text("idempotency_key").notNull().unique(),
		status: text("status").$type<RunStatus>().notNull(),
		attempt: integer("attempt").notNull().default(1),
		maxAttempts: integer("max_attempts").notNull(),
		runtimeAdapter: text("runtime_adapter").$type<RuntimeAdapterId>().notNull(),
		runtimeVersion: text("runtime_version"),
		model: text("model"),
		correlationId: text("correlation_id").notNull(),
		hop: integer("hop").notNull(),
		queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
		startedAt: timestamp("started_at", { withTimezone: true }),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		timeoutAt: timestamp("timeout_at", { withTimezone: true }).notNull(),
		/** The time budget of every attempt, fixed when the run was scheduled. */
		timeoutSeconds: integer("timeout_seconds").notNull(),
		outcome: text("outcome").$type<RunOutcome>(),
		errorCode: text("error_code"),
		errorDetailRedacted: text("error_detail_redacted"),
		usage: jsonb("usage").$type<RuntimeUsage>(),
		publicSummary: jsonb("public_summary").$type<WorkingSummary>(),
		/** The validated `AgentTurnResult`. */
		result: jsonb("result").$type<JsonObject>(),
		parentRunId: uuid("parent_run_id"),
		/** pg-boss job id of the current attempt, for cancellation. */
		jobId: text("job_id"),
	},
	(t) => [
		index("agent_runs_agent").on(t.agentId, t.queuedAt),
		index("agent_runs_correlation").on(t.correlationId),
		// max_active_runs = 1 in the MVP: at most one queued or running run per agent.
		uniqueIndex("agent_runs_one_active")
			.on(t.agentId)
			.where(sql`${t.status} in ('queued', 'running')`),
		check("agent_runs_status", oneOf("status", RUN_STATUSES)),
		check("agent_runs_outcome", sql`${t.outcome} is null or ${oneOf("outcome", RUN_OUTCOMES)}`),
	],
);

export const agentInbox = pgTable(
	"agent_inbox",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		eventId: uuid("event_id")
			.notNull()
			.references(() => events.id),
		status: text("status").$type<InboxStatus>().notNull(),
		priority: integer("priority").notNull().default(0),
		availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
		runId: uuid("run_id").references(() => agentRuns.id),
		/** The wait this event resolved; such an entry resumes a waiting agent. */
		waitId: uuid("wait_id"),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("agent_inbox_unique").on(t.agentId, t.eventId),
		index("agent_inbox_pending").on(t.agentId, t.status, t.priority, t.availableAt),
		check("agent_inbox_status", oneOf("status", INBOX_STATUSES)),
	],
);

export const runtimeSessions = pgTable(
	"runtime_sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		adapter: text("adapter").notNull(),
		/** Provider session reference; an optimization, never the source of truth. */
		providerSessionRef: text("provider_session_ref").notNull(),
		runtimeVersion: text("runtime_version").notNull(),
		resumeMetadata: jsonb("resume_metadata").$type<JsonObject>().notNull().default({}),
		lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		status: text("status").notNull(),
	},
	(t) => [
		uniqueIndex("runtime_sessions_agent_adapter").on(t.agentId, t.adapter),
		check("runtime_sessions_status", oneOf("status", ["active", "expired", "revoked"])),
	],
);

export const waitSubscriptions = pgTable(
	"wait_subscriptions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		createdByRunId: uuid("created_by_run_id")
			.notNull()
			.references(() => agentRuns.id),
		status: text("status").$type<WaitStatus>().notNull(),
		eventType: text("event_type").notNull(),
		correlationId: text("correlation_id").notNull(),
		/** The condition as requested, with `timeoutAt` clamped by policy. */
		condition: jsonb("condition").$type<WaitCondition>().notNull(),
		timeoutAt: timestamp("timeout_at", { withTimezone: true }).notNull(),
		matchedEventId: uuid("matched_event_id").references(() => events.id),
		createdAt: createdAt(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
	},
	(t) => [
		index("wait_subscriptions_active").on(t.status, t.correlationId),
		index("wait_subscriptions_agent").on(t.agentId, t.status),
		check("wait_subscriptions_status", oneOf("status", WAIT_STATUSES)),
	],
);

export const contextSnapshots = pgTable("context_snapshots", {
	id: uuid("id").primaryKey().defaultRandom(),
	agentId: text("agent_id")
		.notNull()
		.references(() => agents.id),
	runId: uuid("run_id")
		.notNull()
		.unique()
		.references(() => agentRuns.id),
	configVersion: text("config_version").notNull(),
	threadRef: text("thread_ref"),
	/** The exact input handed to the runtime; contains no secrets by construction. */
	input: jsonb("input").$type<AgentTurnInput>().notNull(),
	/** The authority the result is checked against, fixed when the run was scheduled. */
	authority: jsonb("authority").$type<TurnAuthorityContext>().notNull(),
	sizeBytes: integer("size_bytes").notNull(),
	createdAt: createdAt(),
});

export const memoryItems = pgTable(
	"memory_items",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		namespace: text("namespace").notNull(),
		key: text("key").notNull(),
		content: text("content").notNull(),
		sourceEventId: uuid("source_event_id").references(() => events.id),
		sourceRunId: uuid("source_run_id").references(() => agentRuns.id),
		status: text("status").notNull(),
		visibility: text("visibility").notNull(),
		createdAt: createdAt(),
		supersededAt: timestamp("superseded_at", { withTimezone: true }),
	},
	(t) => [
		index("memory_items_namespace").on(t.namespace, t.key),
		check("memory_items_status", oneOf("status", MEMORY_STATUSES)),
		check("memory_items_visibility", oneOf("visibility", VISIBILITIES)),
	],
);

export const artifacts = pgTable(
	"artifacts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		runId: uuid("run_id")
			.notNull()
			.references(() => agentRuns.id),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		key: text("key").notNull(),
		kind: text("kind").notNull(),
		workspacePath: text("workspace_path"),
		url: text("url"),
		sha256: text("sha256"),
		mimeType: text("mime_type"),
		sizeBytes: integer("size_bytes"),
		visibility: text("visibility").notNull(),
		description: text("description"),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("artifacts_run_key").on(t.runId, t.key),
		check("artifacts_visibility", oneOf("visibility", VISIBILITIES)),
		check("artifacts_location", sql`(${t.workspacePath} is null) <> (${t.url} is null)`),
	],
);

export const outbox = pgTable(
	"outbox",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		kind: text("kind").$type<OutboxKind>().notNull(),
		/** Human-readable target, e.g. `channel/<id>`; the payload is authoritative. */
		destination: text("destination").notNull(),
		payload: jsonb("payload").$type<JsonObject>().notNull(),
		idempotencyKey: text("idempotency_key").notNull().unique(),
		status: text("status").$type<OutboxStatus>().notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		maxAttempts: integer("max_attempts").notNull(),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
		/** Lease of the delivery in progress; an expired lease makes the item deliverable again. */
		lockedUntil: timestamp("locked_until", { withTimezone: true }),
		lastErrorRedacted: text("last_error_redacted"),
		receipt: jsonb("receipt").$type<JsonValue>(),
		runId: uuid("run_id").references(() => agentRuns.id),
		createdAt: createdAt(),
		sentAt: timestamp("sent_at", { withTimezone: true }),
	},
	(t) => [
		index("outbox_due").on(t.status, t.nextAttemptAt),
		check("outbox_status", oneOf("status", OUTBOX_STATUSES)),
		check("outbox_kind", oneOf("kind", OUTBOX_KINDS)),
	],
);

export const approvalRequests = pgTable(
	"approval_requests",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		requestedByAgentId: text("requested_by_agent_id")
			.notNull()
			.references(() => agents.id),
		runId: uuid("run_id")
			.notNull()
			.unique()
			.references(() => agentRuns.id),
		actionType: text("action_type").notNull(),
		actionParams: jsonb("action_params").$type<ActionParams>().notNull(),
		immutableActionHash: text("immutable_action_hash").notNull(),
		actionSummary: text("action_summary").notNull(),
		riskLevel: text("risk_level").notNull(),
		status: text("status").notNull(),
		allowedApproverUserIds: jsonb("allowed_approver_user_ids").$type<MattermostId[]>().notNull(),
		nonce: text("nonce").notNull(),
		createdAt: createdAt(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		decidedByUserId: text("decided_by_user_id"),
		decidedAt: timestamp("decided_at", { withTimezone: true }),
	},
	(t) => [
		check("approval_requests_status", oneOf("status", APPROVAL_STATUSES)),
		check("approval_requests_risk", oneOf("risk_level", ["low", "medium", "high", "critical"])),
		check("approval_requests_expiry", sql`${t.expiresAt} > ${t.createdAt}`),
	],
);

export const policyDecisions = pgTable(
	"policy_decisions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		runId: uuid("run_id").references(() => agentRuns.id),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		action: text("action").notNull(),
		decision: text("decision").notNull(),
		reason: text("reason").notNull(),
		policyVersion: text("policy_version").notNull(),
		inputRedacted: jsonb("input_redacted").$type<JsonObject>().notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		index("policy_decisions_run").on(t.runId),
		check("policy_decisions_decision", oneOf("decision", POLICY_DECISIONS)),
	],
);

/** Append-only: a trigger in the migrations rejects UPDATE and DELETE. */
export const auditLog = pgTable(
	"audit_log",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
		/** `system`, `cli:<os user>` or `agent:<id>`. */
		actor: text("actor").notNull(),
		action: text("action").notNull(),
		subjectType: text("subject_type").notNull(),
		subjectId: text("subject_id").notNull(),
		detail: jsonb("detail").$type<JsonObject>().notNull().default({}),
	},
	(t) => [index("audit_log_subject").on(t.subjectType, t.subjectId)],
);

export const sourceCursors = pgTable("source_cursors", {
	sourceId: text("source_id").primaryKey(),
	cursorType: text("cursor_type").notNull(),
	cursorValue: text("cursor_value").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
