import type {
	ActionParams,
	AgentConfig,
	AgentLifecycleCheckpoints,
	AgentLifecycleOperationKind,
	AgentLifecycleOperationState,
	AgentLifecycleSource,
	AgentLifecycleStatus,
	AgentTurnInput,
	ConfigAttachmentsSnapshot,
	ConfigRevisionSource,
	ConfigSnapshotBundle,
	GatewayEventType,
	GmailMode,
	JsonObject,
	JsonValue,
	MattermostId,
	OrganizationConfig,
	RuntimeAdapterId,
	RuntimeUsage,
	ThreadSummary,
	ToolActionStatus,
	ToolAttachmentMode,
	ToolCatalogEntryKind,
	ToolCatalogRiskFloor,
	ToolNamespace,
	ToolReceipt,
	TurnAuthorityContext,
	WaitCondition,
	WorkerStatus,
	WorkingSummary,
} from "@agent-gateway/contracts";
import {
	AGENT_LIFECYCLE_OPERATION_KINDS,
	AGENT_LIFECYCLE_OPERATION_STATES,
	AGENT_LIFECYCLE_SOURCES,
	AGENT_LIFECYCLE_STATUSES,
	APPROVAL_STATUSES,
	CONFIG_REVISION_SOURCES,
	GMAIL_MODES,
	TOOL_ACTION_STATUSES,
	TOOL_ATTACHMENT_MODES,
	TOOL_CATALOG_ENTRY_KINDS,
	TOOL_CATALOG_RISK_FLOORS,
	TOOL_NAMESPACES,
	WorkerStatusSchema,
} from "@agent-gateway/contracts";
import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	bigserial,
	boolean,
	check,
	index,
	integer,
	jsonb,
	numeric,
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

/** `cancelled` is a terminal status a delivery never reaches on its own: only a retired agent's
 * still-pending items are moved there (ADR-026), never retried, distinct from `dead` (attempts
 * exhausted — `redriveOutbox` can still give it a fresh set). */
export const OUTBOX_STATUSES = ["pending", "sending", "sent", "dead", "cancelled"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const OUTBOX_KINDS = [
	"mattermost.post",
	"mattermost.alert",
	"mattermost.approval",
	"mattermost.approval.reply",
] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

export const MEMORY_STATUSES = ["proposed", "accepted", "rejected", "superseded"] as const;
export const VISIBILITIES = ["private", "shared", "public"] as const;
export const POLICY_DECISIONS = ["allow", "deny", "require_approval"] as const;
export const DIRECTORY_KINDS = ["channel", "user", "team"] as const;
export type DirectoryKind = (typeof DIRECTORY_KINDS)[number];

/**
 * How a `config_snapshots` row came to exist: `applied` is every snapshot a configuration apply
 * stored; `backfill` is one `ensureConfigHistory` synthesized for a database upgraded from a
 * release before this history existed, from whatever the active `config_versions` and `agents`
 * rows still held (older, since-replaced agent definitions are not reconstructed).
 */
export const CONFIG_SNAPSHOT_ORIGINS = ["applied", "backfill"] as const;
export type ConfigSnapshotOrigin = (typeof CONFIG_SNAPSHOT_ORIGINS)[number];

/** Global switches; exactly one row with id 1. */
export const gatewayControls = pgTable(
	"gateway_controls",
	{
		id: integer("id").primaryKey().default(1),
		/** Set by kill-all: no new runs start until an operator releases it. */
		killSwitch: boolean("kill_switch").notNull().default(false),
		activeConfigVersion: text("active_config_version"),
		/** Incremented by every config apply: tells whether anything was applied in between. */
		configGeneration: bigint("config_generation", { mode: "number" }).notNull().default(0),
		/**
		 * The revision that produced the active configuration; null until the first apply or
		 * backfill records one. No foreign key (like `active_config_version`): the row this points
		 * to is written in the same transaction that sets it, never before.
		 */
		activeConfigRevision: bigint("active_config_revision", { mode: "number" }),
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

/**
 * An immutable, content-addressed complete configuration bundle: organization, every agent
 * definition and its resolved role prompt, and the constitution text, exactly as
 * `ConfigSnapshotBundleSchema` describes — deliberately never a tool attachment (see
 * `configAttachmentSnapshots` below; ADR-027). `hash` is the same canonical sha256 as
 * `config_versions.version` of the same content, so the two agree without a foreign key between
 * them (not every `config_versions` row has a snapshot; see `origin`). A trigger (migration
 * 0019) rejects UPDATE and DELETE.
 */
export const configSnapshots = pgTable(
	"config_snapshots",
	{
		hash: text("hash").primaryKey(),
		bundle: jsonb("bundle").$type<ConfigSnapshotBundle>().notNull(),
		format: integer("format").notNull(),
		origin: text("origin").$type<ConfigSnapshotOrigin>().notNull(),
		createdAt: createdAt(),
	},
	() => [check("config_snapshots_origin", oneOf("origin", CONFIG_SNAPSHOT_ORIGINS))],
);

/**
 * An immutable, content-addressed attachments document: every agent's tool-catalog attachments,
 * keyed by agent id (`ConfigAttachmentsSnapshotSchema`, ADR-027) — stored apart from
 * `config_snapshots` precisely so that table stays exactly the shape a release before this table
 * existed already reads. No `origin` column: unlike a configuration bundle, nothing ever backfills an
 * attachments document (a database upgraded from before attachments existed has none to
 * reconstruct — `config_revisions.attachments_snapshot_hash` is simply null for it), so every row
 * this table ever holds was written by an actual commit. A trigger (migration after this one)
 * rejects UPDATE and DELETE, the same guard `config_snapshots` already has.
 */
export const configAttachmentSnapshots = pgTable("config_attachment_snapshots", {
	hash: text("hash").primaryKey(),
	bundle: jsonb("bundle").$type<ConfigAttachmentsSnapshot>().notNull(),
	format: integer("format").notNull(),
	createdAt: createdAt(),
});

/**
 * The configuration's chronological journal: one row per applied change, even one that repeats
 * an earlier snapshot's content verbatim (a rollback gets its own revision id, pointing at the
 * same `snapshot_hash`). A trigger (migration 0019) rejects UPDATE and DELETE.
 */
export const configRevisions = pgTable(
	"config_revisions",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		snapshotHash: text("snapshot_hash")
			.notNull()
			.references(() => configSnapshots.hash),
		/** This same revision's own attachments document (ADR-027); null when it carries none —
		 * a revision recorded before this column existed, or one whose resulting configuration has no
		 * agent ever touched through the tool-catalog hub (`{}`, never given its own stored row — see
		 * `configAttachmentSnapshots`). A release before this column existed does not know it exists. */
		attachmentsSnapshotHash: text("attachments_snapshot_hash").references(
			() => configAttachmentSnapshots.hash,
		),
		/** The revision this one replaced; null for the first revision ever recorded. */
		parentRevisionId: bigint("parent_revision_id", { mode: "number" }).references(
			(): AnyPgColumn => configRevisions.id,
		),
		/** Equal to the `gateway_controls.config_generation` this revision produced. */
		generation: bigint("generation", { mode: "number" }).notNull(),
		actor: text("actor").notNull(),
		source: text("source").$type<ConfigRevisionSource>().notNull(),
		reason: text("reason"),
		/**
		 * A caller-supplied token that makes a `commitChange` retry safe: a second commit with the
		 * same key returns this row instead of writing another one. Set at insert only (the
		 * append-only trigger forbids any later UPDATE).
		 */
		idempotencyKey: text("idempotency_key"),
		/** sha256 of the change set that produced this revision; catches a key reused for a different change. */
		changeHash: text("change_hash"),
		createdAt: createdAt(),
	},
	(t) => [
		index("config_revisions_snapshot").on(t.snapshotHash),
		uniqueIndex("config_revisions_idempotency_key")
			.on(t.idempotencyKey)
			.where(sql`${t.idempotencyKey} is not null`),
		check("config_revisions_source", oneOf("source", CONFIG_REVISION_SOURCES)),
	],
);

/**
 * A human's acknowledgement of one configuration revision — typically a `backfill` with a
 * parent, which the `config:backfill` alert and `gateway doctor`'s `config_history` check name as
 * drift (see `configHistoryConditions`): `commitChange` treats identical content as a no-op, so
 * recommitting the reviewed configuration (or `config rollback` to it) writes no new revision to
 * supersede it, and an explicit acknowledgement is the only way to clear the alert/check for it
 * short of a later, actually different change. One row per revision; acknowledging it again (the
 * same actor or another) replaces the row rather than failing.
 */
export const configRevisionAcks = pgTable("config_revision_acks", {
	revisionId: bigint("revision_id", { mode: "number" })
		.primaryKey()
		.references(() => configRevisions.id),
	actor: text("actor").notNull(),
	ackedAt: timestamp("acked_at", { withTimezone: true }).notNull().defaultNow(),
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
		/**
		 * Whether the active revision's attachments document has an entry for this agent at all
		 * (ADR-027): hub-managed, even with an explicitly empty attachment list (detached from
		 * everything), rather than legacy. The live counterpart of
		 * `ConfigSnapshotBundle.toolAttachments`'s own per-agent key, reconciled by
		 * `writeConfigRevisionIn` exactly like `catalogAttachments`'s own rows — cheap to read
		 * without deserializing a historical snapshot, which `catalogAttachments` alone cannot
		 * distinguish from "never touched" once an agent's list is emptied back out.
		 */
		toolAttachmentsManaged: boolean("tool_attachments_managed").notNull().default(false),
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

/**
 * Provisioning status of one agent id, kept apart from its desired configuration
 * (`agents.enabled`): one row per agent id ever created through the lifecycle service or adopted
 * at startup from a pre-existing configuration. The id is never reused — a row here in any status,
 * including `retired`, refuses a later `add_agent` of the same id (`requestAgentCreate`).
 */
export const agentLifecycle = pgTable(
	"agent_lifecycle",
	{
		agentId: text("agent_id")
			.primaryKey()
			.references(() => agents.id),
		status: text("status").$type<AgentLifecycleStatus>().notNull(),
		/** Bumped by every desired-state change (`create`/`retire`/`restore`/`reprovision`). */
		generation: bigint("generation", { mode: "number" }).notNull().default(0),
		/** The lifecycle operation currently (or last) pursuing `generation`; no foreign key, since
		 * the operation row referencing this agent is written in the same transaction, right after
		 * this row exists (see `agent_lifecycle_operations.agent_id`'s own foreign key). */
		operationId: uuid("operation_id"),
		/** Bounded, never a secret; the last operation's own failure. */
		lastError: text("last_error"),
		statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
		createdAt: createdAt(),
		retiredAt: timestamp("retired_at", { withTimezone: true }),
	},
	() => [check("agent_lifecycle_status", oneOf("status", AGENT_LIFECYCLE_STATUSES))],
);

/**
 * Append-only journal of lifecycle operations (migration 0025 guards it: only `state`,
 * `checkpoints`, `error` and the timestamps besides `created_at` may ever change; every other
 * column, and the row itself, is immutable once written).
 */
export const agentLifecycleOperations = pgTable(
	"agent_lifecycle_operations",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agentLifecycle.agentId),
		kind: text("kind").$type<AgentLifecycleOperationKind>().notNull(),
		requestedBy: text("requested_by").notNull(),
		source: text("source").$type<AgentLifecycleSource>().notNull(),
		/** A caller-supplied retry token: a repeat with the same key replays this row. */
		idempotencyKey: text("idempotency_key"),
		/** The configuration revision that carried this operation's desired-state change. */
		configRevisionId: bigint("config_revision_id", { mode: "number" }).references(
			() => configRevisions.id,
		),
		/** The `agent_lifecycle.generation` this operation pursues; see `completeOperation`. */
		generation: bigint("generation", { mode: "number" }).notNull(),
		/** Set only by `requestOperationRetry`, naming the `failed` operation it retried: lets a
		 * repeated `idempotencyKey` be told apart from one already used for a different kind of
		 * request (`requestAgentCreate`, say) that merely happens to share this row's own `kind` —
		 * `kind` alone cannot, since a retry's own operation carries the kind it is retrying, never a
		 * kind of its own (migration 0027). Null for every operation no retry ever produced. */
		retryOf: uuid("retry_of").references((): AnyPgColumn => agentLifecycleOperations.id),
		state: text("state").$type<AgentLifecycleOperationState>().notNull(),
		/** Ids and references only, set by the provisioner as it completes each step; never a
		 * token value (see `AgentLifecycleCheckpointsSchema`). */
		checkpoints: jsonb("checkpoints").$type<AgentLifecycleCheckpoints>().notNull().default({}),
		error: text("error"),
		createdAt: createdAt(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
	},
	(t) => [
		index("agent_lifecycle_operations_agent").on(t.agentId),
		uniqueIndex("agent_lifecycle_operations_idempotency_key")
			.on(t.idempotencyKey)
			.where(sql`${t.idempotencyKey} is not null`),
		check("agent_lifecycle_operations_kind", oneOf("kind", AGENT_LIFECYCLE_OPERATION_KINDS)),
		check("agent_lifecycle_operations_source", oneOf("source", AGENT_LIFECYCLE_SOURCES)),
		check("agent_lifecycle_operations_state", oneOf("state", AGENT_LIFECYCLE_OPERATION_STATES)),
	],
);

// ---------------------------------------------------------------------------
// Tool catalog (ADR-027): catalog entries, their immutable versions, agents' attachments and
// built-in retirement tombstones.
// ---------------------------------------------------------------------------

/**
 * One catalog entry's own, immutable identity: `kind`/`implementationKey` never change across its
 * versions, and `isBuiltin` decides whether deleting it (`deleteCatalogEntry`) also writes a
 * tombstone. `currentVersionId` has no foreign key: it is set right after the first version row is
 * inserted, in the same transaction (the same reason `agent_lifecycle.operation_id` has none).
 *
 * Deleting an entry never removes this row — `deletedAt`/`deletedBy` mark it retired instead
 * (`deleteCatalogEntry`'s own fix): the row, and so `currentVersionId` and every past version,
 * stay referenceable, which is what lets a historical `config_revisions` snapshot that once
 * attached this entry still be rolled back to without a foreign-key failure inserting
 * `catalog_attachments`. A deleted entry is simply excluded from every active listing/attach
 * check (`listCatalogEntries`/`getCatalogEntry`/`checkAttachable`'s own `loadEntry`) and can never
 * be attached again; it is never un-deleted, and `ensureToolCatalogSeeded` never revives a
 * deleted built-in (its own `catalog_entry_tombstones` row is unaffected by this).
 */
export const catalogEntries = pgTable(
	"catalog_entries",
	{
		id: text("id").primaryKey(),
		kind: text("kind").$type<ToolCatalogEntryKind>().notNull(),
		implementationKey: text("implementation_key").notNull(),
		isBuiltin: boolean("is_builtin").notNull().default(false),
		currentVersionId: bigint("current_version_id", { mode: "number" }),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
		deletedBy: text("deleted_by"),
		createdAt: createdAt(),
	},
	() => [check("catalog_entries_kind", oneOf("kind", TOOL_CATALOG_ENTRY_KINDS))],
);

/**
 * Append-only history of a catalog entry's own content (migration's own guard trigger rejects
 * UPDATE, DELETE and TRUNCATE outright — unlike `agent_lifecycle_operations`, no column of a
 * version ever changes once written). `entryId` carries no foreign key: deleting an entry
 * (`deleteCatalogEntry`) never touches its past versions, which stay exactly as inspectable
 * history, entry gone or not.
 */
export const catalogEntryVersions = pgTable(
	"catalog_entry_versions",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		entryId: text("entry_id").notNull(),
		version: integer("version").notNull(),
		kind: text("kind").$type<ToolCatalogEntryKind>().notNull(),
		implementationKey: text("implementation_key").notNull(),
		name: text("name").notNull(),
		description: text("description").notNull(),
		configSchema: jsonb("config_schema").$type<JsonObject>().notNull().default({}),
		riskFloor: text("risk_floor").$type<ToolCatalogRiskFloor>().notNull(),
		supportedAdapters: jsonb("supported_adapters")
			.$type<RuntimeAdapterId[]>()
			.notNull()
			.default([]),
		createdBy: text("created_by").notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("catalog_entry_versions_entry_version").on(t.entryId, t.version),
		index("catalog_entry_versions_entry").on(t.entryId),
		check("catalog_entry_versions_kind", oneOf("kind", TOOL_CATALOG_ENTRY_KINDS)),
		check("catalog_entry_versions_risk_floor", oneOf("risk_floor", TOOL_CATALOG_RISK_FLOORS)),
	],
);

/**
 * The current projection of `ConfigSnapshotBundle.toolAttachments` (ADR-027) — one row per
 * (agent, entry) binding, reconciled by `writeConfigRevisionIn` on every commit exactly the way
 * `agents` projects `ConfigSnapshotBundle.agents`. The bundle itself, not this table, is what
 * config history, rollback and export/import carry; this table only ever mirrors it for a cheap
 * current-state read (listing an agent's attachments, or every agent attached to an entry).
 */
export const catalogAttachments = pgTable(
	"catalog_attachments",
	{
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		entryId: text("entry_id")
			.notNull()
			.references(() => catalogEntries.id),
		pinnedVersion: integer("pinned_version"),
		mode: text("mode").$type<ToolAttachmentMode>().notNull(),
		settings: jsonb("settings").$type<JsonObject>().notNull().default({}),
		createdAt: createdAt(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.agentId, t.entryId] }),
		index("catalog_attachments_entry").on(t.entryId),
		check("catalog_attachments_mode", oneOf("mode", TOOL_ATTACHMENT_MODES)),
	],
);

/**
 * A built-in catalog entry the owner deleted: reseeding (`ensureToolCatalogSeeded`, run at every
 * controller start and CLI session) never re-adds an id recorded here. Never written for a
 * non-built-in entry's deletion — nothing ever reseeds those.
 */
export const catalogEntryTombstones = pgTable("catalog_entry_tombstones", {
	entryId: text("entry_id").primaryKey(),
	kind: text("kind").$type<ToolCatalogEntryKind>().notNull(),
	deletedBy: text("deleted_by").notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const CHANNEL_GRANT_STATES = ["active", "revoked"] as const;
export type ChannelGrantState = (typeof CHANNEL_GRANT_STATES)[number];

/**
 * Channels an owner or system admin gave an agent by adding its bot in Mattermost. A grant holds
 * for the bot it names only (a replaced bot starts without), and a revoked one stays as a
 * tombstone: a later add must be newer than `since_ms` to count.
 */
export const mattermostChannelGrants = pgTable(
	"mattermost_channel_grants",
	{
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		channelId: text("channel_id").$type<MattermostId>().notNull(),
		teamId: text("team_id").$type<MattermostId>().notNull(),
		/** The channel's name when the grant was last checked; ids decide, names are for people. */
		channelName: text("channel_name").notNull(),
		botUserId: text("bot_user_id").$type<MattermostId>().notNull(),
		state: text("state").$type<ChannelGrantState>().notNull(),
		/**
		 * Who added the bot, from the channel's system post of the add. Null for a tombstone the
		 * configuration wrote (a channel taken out of `allowed_channels`).
		 */
		grantorUserId: text("grantor_user_id").$type<MattermostId>(),
		evidencePostId: text("evidence_post_id").$type<MattermostId>(),
		/** When the bot was added: the agent sees nothing created at or before it. */
		sinceMs: bigint("since_ms", { mode: "number" }).notNull(),
		/**
		 * Up to when (ms) the channel's posts were checked for a re-add of the bot: the next check
		 * reads only what came after, across restarts too.
		 */
		checkedAtMs: bigint("checked_at_ms", { mode: "number" }),
		/** Incremented by every grant and revocation of this agent in this channel. */
		generation: integer("generation").notNull().default(1),
		revokedReason: text("revoked_reason"),
		grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(t) => [
		primaryKey({ columns: [t.agentId, t.channelId] }),
		index("mattermost_channel_grants_channel").on(t.channelId),
		check("mattermost_channel_grants_state", oneOf("state", CHANNEL_GRANT_STATES)),
		check(
			"mattermost_channel_grants_revoked",
			sql`(${t.state} = 'revoked') = (${t.revokedAt} is not null)`,
		),
	],
);

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
		/**
		 * Retention removed the content: the payload keeps only the ids readers join on
		 * (`channel_id`, `root_id`, `post_id`); the hashes stay for dedupe.
		 */
		contentExpiredAt: timestamp("content_expired_at", { withTimezone: true }),
	},
	(t) => [
		uniqueIndex("events_source_external_id").on(t.source, t.externalId),
		index("events_correlation").on(t.correlationId),
		index("events_content_hash").on(t.contentHash, t.receivedAt),
		index("events_sender_agent").on(t.senderAgentId, t.receivedAt),
		/** Finds the posts a run published (`run:<id>`). */
		index("events_causation").on(t.causationId).where(sql`${t.causationId} is not null`),
		/** Finds the events of one Mattermost post (`channel/<id>/post/<id>`). */
		index("events_subject").on(t.source, t.subject),
		index("events_retention").on(t.receivedAt).where(sql`${t.contentExpiredAt} is null`),
		/** Finds the posts of one Mattermost thread: channel, then root (a root is its own). */
		index("events_thread")
			.on(
				sql`(${t.payload}->>'channel_id')`,
				sql`coalesce(${t.payload}->>'root_id', ${t.payload}->>'post_id')`,
			)
			.where(sql`${t.payload} ? 'post_id'`),
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
		/** W3C trace context of the run: a span in its trigger event's trace. */
		traceparent: text("traceparent"),
		/** Retention removed the result, summary and error detail. */
		contentExpiredAt: timestamp("content_expired_at", { withTimezone: true }),
	},
	(t) => [
		index("agent_runs_agent").on(t.agentId, t.queuedAt),
		index("agent_runs_correlation").on(t.correlationId),
		index("agent_runs_retention").on(t.finishedAt).where(sql`${t.contentExpiredAt} is null`),
		/** The invalid-output alert counts recent ones per runtime. */
		index("agent_runs_invalid_output")
			.on(t.runtimeAdapter)
			.where(sql`${t.errorCode} = 'invalid_output'`),
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
		/** Retention asks, per event, whether work still needs it. */
		index("agent_inbox_event").on(t.eventId),
		/** Retention asks which waits still have work waiting. */
		index("agent_inbox_open_wait").on(t.waitId).where(sql`${t.status} in ('pending', 'claimed')`),
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

/** The last heartbeat of every worker process, as reported on its adapter's report queue. */
export const runtimeWorkers = pgTable(
	"runtime_workers",
	{
		workerId: uuid("worker_id").primaryKey(),
		adapter: text("adapter").$type<RuntimeAdapterId>().notNull(),
		status: text("status").$type<WorkerStatus>().notNull(),
		/** The report's sequence number: only a later report of the worker replaces it. */
		sequence: bigint("sequence", { mode: "number" }).notNull(),
		runtimeVersion: text("runtime_version").notNull(),
		detail: text("detail").notNull(),
		firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("runtime_workers_adapter").on(t.adapter, t.lastSeenAt),
		check("runtime_workers_status", oneOf("status", WorkerStatusSchema.options)),
	],
);

/**
 * Whether each adapter has a ready worker, as last settled; a change that lasts raises one alert.
 * Agents of an unavailable adapter are degraded: their runs wait in the queue.
 */
export const runtimeAvailability = pgTable("runtime_availability", {
	adapter: text("adapter").$type<RuntimeAdapterId>().primaryKey(),
	available: boolean("available").notNull(),
	/** Versions of the adapter's ready workers, sorted. */
	runtimeVersions: jsonb("runtime_versions").$type<Readonly<string[]>>().notNull(),
	changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
	/** Since when health has differed from `available`; a change counts once it lasts. */
	pendingSince: timestamp("pending_since", { withTimezone: true }),
});

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
		/**
		 * Thread roots a reply must be in: the threads of the waiting run's conversation. Replies in
		 * threads the run itself started count too. Null for waits not bound to a thread.
		 */
		threadRootIds: jsonb("thread_root_ids").$type<MattermostId[]>(),
		timeoutAt: timestamp("timeout_at", { withTimezone: true }).notNull(),
		matchedEventId: uuid("matched_event_id").references(() => events.id),
		createdAt: createdAt(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
	},
	(t) => [
		index("wait_subscriptions_active").on(t.status, t.correlationId),
		index("wait_subscriptions_agent").on(t.agentId, t.status),
		index("wait_subscriptions_created_by").on(t.createdByRunId),
		check("wait_subscriptions_status", oneOf("status", WAIT_STATUSES)),
	],
);

export const contextSnapshots = pgTable(
	"context_snapshots",
	{
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
	},
	(t) => [index("context_snapshots_created").on(t.createdAt)],
);

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
		index("memory_items_status").on(t.status, t.namespace, t.createdAt),
		/** At most one accepted item per key: accepting a newer one supersedes the older. */
		uniqueIndex("memory_items_accepted_key")
			.on(t.namespace, t.key)
			.where(sql`${t.status} = 'accepted'`),
		check("memory_items_status", oneOf("status", MEMORY_STATUSES)),
		check("memory_items_visibility", oneOf("visibility", VISIBILITIES)),
	],
);

/** The durable summary of a Mattermost thread, from the public summaries of its runs. */
export const threadSummaries = pgTable(
	"thread_summaries",
	{
		channelId: text("channel_id").$type<MattermostId>().notNull(),
		rootPostId: text("root_post_id").$type<MattermostId>().notNull(),
		summary: jsonb("summary").$type<ThreadSummary>().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.channelId, t.rootPostId] })],
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
		/** W3C trace context of the delivery: a span in the trace of what enqueued it. */
		traceparent: text("traceparent"),
		/** Retention removed the payload of a sent or dead item; it can no longer be redriven. */
		contentExpiredAt: timestamp("content_expired_at", { withTimezone: true }),
	},
	(t) => [
		index("outbox_due").on(t.status, t.nextAttemptAt),
		index("outbox_retention").on(t.status, t.createdAt).where(sql`${t.contentExpiredAt} is null`),
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
		/** The owner's reply that decided, by Mattermost post id. */
		decisionPostId: text("decision_post_id"),
		/** When `approval.resolved` was emitted for the requesting agent; null until then. */
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
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
		/** Retention removed the input. */
		contentExpiredAt: timestamp("content_expired_at", { withTimezone: true }),
	},
	(t) => [
		index("policy_decisions_run").on(t.runId),
		check("policy_decisions_decision", oneOf("decision", POLICY_DECISIONS)),
		index("policy_decisions_retention").on(t.createdAt).where(sql`${t.contentExpiredAt} is null`),
	],
);

/**
 * The execution of a granted approval, at most one per approval. Its action and hash are copied
 * from the approval and immutable (a trigger); the tool runner may start it only through
 * `gateway_begin_tool_action`, which checks the approval, the hash and the kill switch.
 */
export const toolActions = pgTable(
	"tool_actions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		approvalId: uuid("approval_id")
			.notNull()
			.unique()
			.references(() => approvalRequests.id),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		namespace: text("namespace").$type<ToolNamespace>().notNull(),
		actionType: text("action_type").notNull(),
		actionParams: jsonb("action_params").$type<ActionParams>().notNull(),
		immutableActionHash: text("immutable_action_hash").notNull(),
		/** `tool-action:<approval id>:<hash>`: executors are idempotent by it at their provider. */
		idempotencyKey: text("idempotency_key").notNull().unique(),
		status: text("status").$type<ToolActionStatus>().notNull(),
		attempt: integer("attempt").notNull().default(1),
		/** The configuration the grant was checked against. */
		configVersion: text("config_version").notNull(),
		/** `begin` refuses after it; the controller's sweep settles the action then. */
		deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
		/** Kill-all asked a running action to stop; the runner's report still counts. */
		cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
		startedAt: timestamp("started_at", { withTimezone: true }),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		receipt: jsonb("receipt").$type<ToolReceipt>(),
		errorRedacted: text("error_redacted"),
		createdAt: createdAt(),
		/** W3C trace context of the execution: a span in the requesting run's trace. */
		traceparent: text("traceparent"),
	},
	(t) => [
		index("tool_actions_open").on(t.status, t.deadlineAt),
		check("tool_actions_status", oneOf("status", TOOL_ACTION_STATUSES)),
		check("tool_actions_namespace", oneOf("namespace", TOOL_NAMESPACES)),
	],
);

/**
 * Every approval command the listener handed over, by the post that carried it: a replayed
 * post decides nothing twice and gets no second acknowledgement.
 */
export const approvalReplies = pgTable("approval_replies", {
	postId: text("post_id").primaryKey(),
	approvalId: uuid("approval_id")
		.notNull()
		.references(() => approvalRequests.id),
	userId: text("user_id").notNull(),
	/** What the reply got: the notice posted in the thread. */
	notice: text("notice").notNull(),
	createdAt: createdAt(),
});

/**
 * Usage of every run attempt that reported it, booked once per attempt on the UTC day its run
 * was queued. Budgets sum this ledger, never `agent_runs.usage` (which keeps the last attempt
 * only).
 */
export const runUsage = pgTable(
	"run_usage",
	{
		runId: uuid("run_id")
			.notNull()
			.references(() => agentRuns.id),
		attempt: integer("attempt").notNull(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		/** `YYYY-MM-DD`, UTC. */
		day: text("day").notNull(),
		/** Null: the runtime reported no cost. */
		costUsd: numeric("cost_usd", { precision: 14, scale: 6, mode: "number" }),
		/** Input plus output tokens; null: the runtime reported none. */
		tokens: bigint("tokens", { mode: "number" }),
		recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.runId, t.attempt] }),
		index("run_usage_day").on(t.day, t.agentId),
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

/**
 * A watched Gmail mailbox: its history cursor and watch. The cursor moves in the transaction
 * that ingests the messages up to it, so a restart resumes exactly after them.
 */
export const gmailMailboxes = pgTable(
	"gmail_mailboxes",
	{
		/** The Gateway's name for the mailbox (`GMAIL_MAILBOX_ID`), never the address. */
		mailboxId: text("mailbox_id").primaryKey(),
		/**
		 * SHA-256 of the account's address (lowercased): the cursor belongs to that account, and a
		 * credential of another one is refused rather than read from this cursor. Not the address.
		 */
		accountHash: text("account_hash").notNull(),
		/** Gmail history id every change up to which is ingested; a uint64. */
		historyId: numeric("history_id", { precision: 20, scale: 0 }).notNull(),
		watchExpiresAt: timestamp("watch_expires_at", { withTimezone: true }),
		watchRenewedAt: timestamp("watch_renewed_at", { withTimezone: true }),
		lastNotificationAt: timestamp("last_notification_at", { withTimezone: true }),
		lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
		/** The last time history was gone and recent messages were listed instead. */
		lastFullSyncAt: timestamp("last_full_sync_at", { withTimezone: true }),
		/**
		 * How the running connector learns of new mail, `poll` or `pubsub`, and how often it syncs:
		 * recorded by the connector, so health checks what that mode needs.
		 */
		mode: text("mode").$type<GmailMode>().notNull().default("pubsub"),
		syncSeconds: integer("sync_seconds"),
		createdAt: createdAt(),
	},
	() => [check("gmail_mailboxes_mode", oneOf("mode", GMAIL_MODES))],
);

export const ALERT_STATES = ["firing", "resolved"] as const;
export type AlertState = (typeof ALERT_STATES)[number];

/**
 * An alert raised while a condition holds, as opposed to a one-time notice: it fires once when
 * the condition starts, reminds while it lasts, and is resolved (and may fire again) when it
 * ends. `episode` counts the times it fired.
 */
export const alertStates = pgTable(
	"alert_states",
	{
		key: text("key").primaryKey(),
		state: text("state").$type<AlertState>().notNull(),
		episode: integer("episode").notNull(),
		message: text("message").notNull(),
		firedAt: timestamp("fired_at", { withTimezone: true }).notNull(),
		notifiedAt: timestamp("notified_at", { withTimezone: true }).notNull(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
	},
	() => [check("alert_states_state", oneOf("state", ALERT_STATES))],
);

/** The last run of each maintenance task (retention, backup check): its health and metrics. */
export const maintenanceStatus = pgTable("maintenance_status", {
	task: text("task").primaryKey(),
	lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
	lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
	lastErrorRedacted: text("last_error_redacted"),
	/** What the last run did, e.g. rows expired per table. */
	detail: jsonb("detail").$type<JsonObject>().notNull().default({}),
});

/**
 * Which releases may run against which migration history: `gateway db migrate` of a release
 * certifies itself and the earlier releases its migrations stay compatible with. A release
 * starts only against a history it is certified for (see `compatibility.ts`).
 */
export const schemaCertifications = pgTable(
	"schema_certifications",
	{
		release: text("release").notNull(),
		/** `historyFingerprint` of the applied migrations. */
		fingerprint: text("fingerprint").notNull(),
		certifiedAt: timestamp("certified_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.release, t.fingerprint] })],
);

/**
 * The owner's console session cookies (ADR-025): `token_hash` is the sha256 of the random token
 * the cookie carries — the raw value is never stored. `csrf_token_hash` is unused: the CSRF token
 * is derived from the session's own raw token on every check instead, never stored at all (see
 * the column's own comment below). `password_hash_fingerprint` is a sha256 of the Argon2id hash
 * file's own content at session creation; a password rotation
 * changes that content, so every session bound to the old hash stops matching it on its next
 * request even without a database write (`gateway console password set` also revokes rows
 * directly when it has database access). A session is valid only while `revoked_at` is null,
 * `expires_at` is in the future (the fixed 12-hour absolute lifetime) and `last_seen_at` is within
 * the 30-minute idle window; `last_seen_at` itself advances at most once a minute to bound write
 * amplification from an otherwise-idle, actively-polling tab.
 */
export const consoleSessions = pgTable(
	"console_sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tokenHash: text("token_hash").notNull(),
		/** Unused since the console's CSRF token became derived, not stored (ADR-025): kept
		 * nullable, and never written, so a release before that change rolls back to a schema it
		 * still fully understands. */
		csrfTokenHash: text("csrf_token_hash"),
		passwordHashFingerprint: text("password_hash_fingerprint").notNull(),
		createdAt: createdAt(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		revokedReason: text("revoked_reason"),
	},
	(t) => [
		uniqueIndex("console_sessions_token_hash").on(t.tokenHash),
		index("console_sessions_active").on(t.revokedAt, t.expiresAt),
	],
);
