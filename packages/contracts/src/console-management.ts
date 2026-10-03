import { z } from "zod";
import {
	AgentDisplayNameSchema,
	AgentModelSchema,
	AgentPermissionsSchema,
	AgentRuntimeConfigSchema,
	SessionPolicySchema,
	WakeRuleSchema,
	WhileRunningPolicySchema,
} from "./agent-config.ts";
import {
	AgentLifecycleCheckpointsSchema,
	AgentLifecycleErrorSchema,
	AgentLifecycleOperationKindSchema,
	AgentLifecycleOperationStateSchema,
	AgentLifecycleStatusSchema,
} from "./agent-lifecycle.ts";
import {
	AgentIdSchema,
	MattermostIdSchema,
	MattermostNameSchema,
	MemoryNamespaceSchema,
	RuntimeAdapterIdSchema,
	SecretFileSchema,
	Sha256HexSchema,
	TimestampSchema,
	ToolPatternSchema,
	UuidSchema,
} from "./common.ts";
import {
	ConfigDiffSchema,
	ConfigRevisionReasonSchema,
	ConfigRevisionSourceSchema,
	RolePromptSchema,
} from "./management.ts";
import { TokenSchema } from "./system-status.ts";

/** `GET /api/agents`'s own last-run summary: just enough to show a status and a time, cheaper
 * than `SystemStatusLastRunSchema` (no usage join) since the list view shows neither tokens. */
export const ConsoleAgentLastRunSchema = z.strictObject({
	runId: UuidSchema,
	status: TokenSchema,
	outcome: TokenSchema.nullable(),
	errorCode: TokenSchema.nullable(),
	finishedAt: TimestampSchema.nullable(),
});
export type ConsoleAgentLastRun = z.infer<typeof ConsoleAgentLastRunSchema>;

// ---------------------------------------------------------------------------
// The Agents hub's own management API (ADR-025): request/response DTOs for the `/api/agents` and
// `/api/config/revisions` surface, shared between the controller (`apps/controller/src/
// console-management.ts`, which parses every request body against these schemas) and the console
// frontend (`apps/console`), which parses every response against them at the fetch boundary.
// Every client-facing object is a `z.strictObject`: an unknown field is a shape error, not
// silently dropped. A client never names a database id other than a revision id, a secret/token
// path, or any other field this module does not define as editable.
// ---------------------------------------------------------------------------

/** `GET /api/agents`: one row of the agents table. */
export const ConsoleAgentListItemSchema = z.strictObject({
	id: AgentIdSchema,
	displayName: AgentDisplayNameSchema,
	enabled: z.boolean(),
	state: TokenSchema,
	runtimeAdapter: RuntimeAdapterIdSchema,
	model: AgentModelSchema.nullable(),
	channelCount: z.int().min(0),
	lastRun: ConsoleAgentLastRunSchema.nullable(),
	/** Null for an agent outside the active configuration snapshot: only a `retiring`/`retired`
	 * one is ever listed in that state (see `consoleListAgents`) — every other row's own
	 * `lifecycleStatus` below is never null. */
	activeRevisionId: z.int().positive().nullable(),
	/** Null only for a database whose startup adoption backfill has not run yet. A `retiring`/
	 * `retired` agent is listed specifically so it stays reachable for `Restore` once it has left
	 * the active configuration. */
	lifecycleStatus: AgentLifecycleStatusSchema.nullable(),
});
export type ConsoleAgentListItem = z.infer<typeof ConsoleAgentListItemSchema>;

export const ConsoleAgentListResponseSchema = z.strictObject({
	agents: z.array(ConsoleAgentListItemSchema),
	/** The organization's own configured channels, for the "New agent" dialog's channel picker —
	 * the same list `GET /api/agents/:id` already carries for the editor's own Assignments tab,
	 * here too since a create request needs it before any agent (and so any detail response)
	 * exists to read it from. */
	knownChannels: z.array(MattermostNameSchema),
	/** Every runtime adapter id the Gateway ships, for the "New agent" dialog's runtime picker. */
	knownRuntimeAdapters: z.array(RuntimeAdapterIdSchema),
});
export type ConsoleAgentListResponse = z.infer<typeof ConsoleAgentListResponseSchema>;

/**
 * `GET /api/agents/:id`: the agent's full editable configuration, read from the active snapshot,
 * plus the read-only identity fields and choices the editor offers (`knownChannels`,
 * `knownRuntimeAdapters`). State, current task and recent runs are not repeated here: the console
 * already has them from `GET /api/status`, polled separately.
 */
export const ConsoleAgentMattermostSchema = z.strictObject({
	/** Read-only: the bot username is the agent id and is never edited from the console. */
	username: MattermostNameSchema,
	/** Read-only metadata; a client can display the path but never set it (ADR-025). */
	tokenSecretFile: SecretFileSchema,
	allowedChannels: z.array(MattermostNameSchema).max(32),
});
export type ConsoleAgentMattermost = z.infer<typeof ConsoleAgentMattermostSchema>;

export const ConsoleAgentMemorySchema = z.strictObject({
	privateNamespace: MemoryNamespaceSchema,
	sharedNamespaces: z.array(MemoryNamespaceSchema).max(16),
});
export type ConsoleAgentMemory = z.infer<typeof ConsoleAgentMemorySchema>;

export const ConsoleAgentConcurrencySchema = z.strictObject({
	maxActiveRuns: z.int().min(1).max(8),
	whileRunning: WhileRunningPolicySchema,
});
export type ConsoleAgentConcurrency = z.infer<typeof ConsoleAgentConcurrencySchema>;

export const ConsoleAgentDetailSchema = z.strictObject({
	id: AgentIdSchema,
	/** The revision whose snapshot this view was read from; `preview`/`commit`'s `baseRevisionId`. */
	activeRevisionId: z.int().positive().nullable(),
	displayName: AgentDisplayNameSchema,
	enabled: z.boolean(),
	mattermost: ConsoleAgentMattermostSchema,
	runtime: AgentRuntimeConfigSchema,
	/** Not `RolePromptSchema` (which requires non-blank text, for the patch an edit submits): an
	 * agent that has never had one set has an empty string here (`consoleShowAgent`'s own `?? ""`),
	 * and the view must still be able to open to let the owner set one. */
	rolePrompt: z.string().max(50_000),
	wakeRules: z.array(WakeRuleSchema).max(32),
	permissions: AgentPermissionsSchema,
	/** `true`: the active revision's attachments document has an entry for this agent, even an
	 * explicitly empty one (ADR-027) — its `permissions` above is a mirror of its compiled
	 * attachments, kept in sync on every attachment write, and is never independently editable here
	 * (the editor shows it read-only; a patch that tries anyway is refused). `false`: a legacy
	 * agent, whose `permissions` are exactly what a patch sets, unchanged. */
	toolsHubManaged: z.boolean(),
	memory: ConsoleAgentMemorySchema,
	concurrency: ConsoleAgentConcurrencySchema,
});
export type ConsoleAgentDetail = z.infer<typeof ConsoleAgentDetailSchema>;

export const ConsoleAgentDetailResponseSchema = z.strictObject({
	agent: ConsoleAgentDetailSchema,
	/** The organization's own configured channels, for the allowed-channels picker. */
	knownChannels: z.array(MattermostNameSchema),
	/** Every runtime adapter id the Gateway ships, for the runtime adapter picker. */
	knownRuntimeAdapters: z.array(RuntimeAdapterIdSchema),
	/** The organization's own `finance_agent_id`, null when none is configured: the Retire
	 * dialog requires `reassignFinanceTo` exactly when this equals the agent's own id
	 * (`requestAgentRetire`). */
	financeAgentId: AgentIdSchema.nullable(),
});
export type ConsoleAgentDetailResponse = z.infer<typeof ConsoleAgentDetailResponseSchema>;

// ---------------------------------------------------------------------------
// Preview / commit: a patch of only the fields the editor's tabs expose, translated server-side
// into the typed change operations `prepareChange`/`commitChange` already understand (ADR-024).
// ---------------------------------------------------------------------------

export const AgentRuntimePatchSchema = z
	.strictObject({
		adapter: RuntimeAdapterIdSchema.optional(),
		profile: z.string().min(1).optional(),
		/** `null` removes the override (the agent falls back to the runtime adapter's own default
		 * model); `undefined`/absent leaves it unchanged. A JSON body cannot tell "absent" and
		 * "explicitly `undefined`" apart, which is exactly why clearing the field needs its own
		 * value instead of reusing `undefined` for it. */
		model: AgentModelSchema.nullable().optional(),
		session_policy: SessionPolicySchema.optional(),
		timeout_seconds: z.int().min(10).max(86_400).optional(),
	})
	.refine((patch) => Object.keys(patch).length > 0, "runtime patch must change at least one field");
export type AgentRuntimePatch = z.infer<typeof AgentRuntimePatchSchema>;

export const AgentPermissionsPatchSchema = z
	.strictObject({
		tools_allow: z.array(ToolPatternSchema).max(64).optional(),
		tools_require_human_approval: z.array(ToolPatternSchema).max(64).optional(),
		tools_deny: z.array(ToolPatternSchema).max(64).optional(),
		observe_system: z.boolean().optional(),
	})
	.refine(
		(patch) => Object.keys(patch).length > 0,
		"permissions patch must change at least one field",
	);
export type AgentPermissionsPatch = z.infer<typeof AgentPermissionsPatchSchema>;

/**
 * The editable surface of one agent, exactly the fields the editor's tabs expose (Instructions,
 * Runtime, Assignments, Permissions, plus the display name and enabled switch shown alongside
 * state in Overview). Everything else an `AgentConfig` holds (the Mattermost identity, memory
 * namespaces, concurrency, the schema version) is read-only in this phase: there is no tab for
 * it, and `commitChange` does not expose the whole `AgentConfig` surface as a client-facing
 * patch. At least one field must be set, or there is nothing to preview or commit.
 */
export const AgentPatchSchema = z
	.strictObject({
		displayName: AgentDisplayNameSchema.optional(),
		enabled: z.boolean().optional(),
		rolePrompt: RolePromptSchema.optional(),
		runtime: AgentRuntimePatchSchema.optional(),
		wakeRules: z.array(WakeRuleSchema).max(32).optional(),
		allowedChannels: z.array(MattermostNameSchema).max(32).optional(),
		permissions: AgentPermissionsPatchSchema.optional(),
	})
	.refine((patch) => Object.keys(patch).length > 0, "patch must change at least one field");
export type AgentPatch = z.infer<typeof AgentPatchSchema>;
export type AgentPatchInput = z.input<typeof AgentPatchSchema>;

export const ConsolePreviewRequestSchema = z.strictObject({
	baseRevisionId: z.int().positive().nullable(),
	changes: AgentPatchSchema,
});
export type ConsolePreviewRequest = z.infer<typeof ConsolePreviewRequestSchema>;

/**
 * `prepareChange`'s own preview, plus `impact`: a short list of human-readable, destructive or
 * authority-reducing consequences the UI must surface for explicit confirmation before a commit
 * (disabling the agent, removing a channel, removing a tool grant or `observe_system`) — derived
 * from the same before/after agent definitions the diff is built from, never from `fieldPaths`
 * alone (which names *that* something in a list changed, not what left it).
 */
export const ConsolePreviewResponseSchema = z.strictObject({
	baseRevisionId: z.int().positive().nullable(),
	baseHash: Sha256HexSchema.nullable(),
	newHash: Sha256HexSchema,
	noop: z.boolean(),
	diff: ConfigDiffSchema,
	problems: z.array(z.string()),
	impact: z.array(z.string()),
});
export type ConsolePreviewResponse = z.infer<typeof ConsolePreviewResponseSchema>;

export const ConsoleCommitRequestSchema = z.strictObject({
	baseRevisionId: z.int().positive().nullable(),
	changes: AgentPatchSchema,
	idempotencyKey: UuidSchema,
	reason: ConfigRevisionReasonSchema.optional(),
});
export type ConsoleCommitRequest = z.infer<typeof ConsoleCommitRequestSchema>;

export const ConsoleCommitResponseSchema = z.strictObject({
	revisionId: z.int().positive(),
	hash: Sha256HexSchema,
	noop: z.boolean(),
	replayed: z.boolean(),
	activeRevisionId: z.int().positive().nullable(),
});
export type ConsoleCommitResponse = z.infer<typeof ConsoleCommitResponseSchema>;

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export const ConsoleRevisionListItemSchema = z.strictObject({
	id: z.int().positive(),
	createdAt: z.string(),
	actor: z.string(),
	source: ConfigRevisionSourceSchema,
	reason: z.string().nullable(),
	snapshotHashPrefix: z.string(),
	parentRevisionId: z.int().positive().nullable(),
});
export type ConsoleRevisionListItem = z.infer<typeof ConsoleRevisionListItemSchema>;

export const ConsoleRevisionListResponseSchema = z.strictObject({
	revisions: z.array(ConsoleRevisionListItemSchema),
});
export type ConsoleRevisionListResponse = z.infer<typeof ConsoleRevisionListResponseSchema>;

export const ConsoleRevisionDiffResponseSchema = z.strictObject({
	revisionId: z.int().positive(),
	parentRevisionId: z.int().positive().nullable(),
	diff: ConfigDiffSchema,
});
export type ConsoleRevisionDiffResponse = z.infer<typeof ConsoleRevisionDiffResponseSchema>;

/** A plain `{error}` body: every management route's own error shape, for both a shape/validation
 * failure (400/422) and a conflict (409, which also carries `currentRevisionId`). */
export const ConsoleErrorBodySchema = z.strictObject({
	error: z.string(),
	problems: z.array(z.string()).optional(),
	currentRevisionId: z.int().positive().nullable().optional(),
});
export type ConsoleErrorBody = z.infer<typeof ConsoleErrorBodySchema>;

// ---------------------------------------------------------------------------
// Lifecycle (ADR-026): create, retry, retire, restore; an agent's own provisioning status and
// operation journal; its channel assignments with provenance, and revoking a directly granted
// one. Every mutating route below carries a client-generated `idempotencyKey` (a repeated POST
// replays the first call's own result) — never a `baseRevisionId` the way `preview`/`commit`
// do: unlike editing an agent's own definition, none of `requestAgentCreate`/`requestAgentRetire`/
// `requestAgentRestore`/`requestOperationRetry` are asked to apply against a specific, previously
// loaded configuration snapshot (they always act on whatever is live, the same way the CLI's own
// `gateway agents create|retire|restore|retry` already do); a stale page is instead caught by
// each one's own business-rule refusal (`AdminError`, surfaced as `422`) — "already retired",
// "not failed, nothing to retry" — which is more specific than a bare conflict would be. The rare
// `ManagementConflictError` `commitWithinLock`'s own internal retry can still raise (a
// configuration-history backfill racing this very request) is mapped to `409` regardless.
// ---------------------------------------------------------------------------

export const ConsoleAgentCreateRuntimeSchema = z.strictObject({
	adapter: RuntimeAdapterIdSchema.optional(),
	model: AgentModelSchema.optional(),
});
export type ConsoleAgentCreateRuntime = z.infer<typeof ConsoleAgentCreateRuntimeSchema>;

export const ConsoleAgentCreateRequestSchema = z.strictObject({
	idempotencyKey: UuidSchema,
	id: AgentIdSchema,
	displayName: AgentDisplayNameSchema,
	allowedChannels: z.array(MattermostNameSchema).max(32),
	rolePrompt: RolePromptSchema,
	/** Left unset: the deployment's Codex defaults (`resolveCreateRuntime`, `@agent-gateway/core`). */
	runtime: ConsoleAgentCreateRuntimeSchema.optional(),
});
export type ConsoleAgentCreateRequest = z.infer<typeof ConsoleAgentCreateRequestSchema>;

export const ConsoleAgentCreateResponseSchema = z.strictObject({
	agentId: AgentIdSchema,
	operationId: UuidSchema,
	revisionId: z.int().positive(),
});
export type ConsoleAgentCreateResponse = z.infer<typeof ConsoleAgentCreateResponseSchema>;

export const ConsoleAgentRetireRequestSchema = z.strictObject({
	idempotencyKey: UuidSchema,
	reason: ConfigRevisionReasonSchema.optional(),
	/** Required, naming a different, currently configured agent, when the retiring agent is the
	 * organization's own finance agent (`requestAgentRetire`). */
	reassignFinanceTo: AgentIdSchema.optional(),
});
export type ConsoleAgentRetireRequest = z.infer<typeof ConsoleAgentRetireRequestSchema>;

export const ConsoleAgentRetireResponseSchema = z.strictObject({
	operationId: UuidSchema,
	revisionId: z.int().positive(),
});
export type ConsoleAgentRetireResponse = z.infer<typeof ConsoleAgentRetireResponseSchema>;

export const ConsoleAgentRestoreRequestSchema = z.strictObject({
	idempotencyKey: UuidSchema,
});
export type ConsoleAgentRestoreRequest = z.infer<typeof ConsoleAgentRestoreRequestSchema>;

export const ConsoleAgentRestoreResponseSchema = z.strictObject({
	operationId: UuidSchema,
	revisionId: z.int().positive(),
});
export type ConsoleAgentRestoreResponse = z.infer<typeof ConsoleAgentRestoreResponseSchema>;

export const ConsoleAgentRetryRequestSchema = z.strictObject({
	idempotencyKey: UuidSchema,
});
export type ConsoleAgentRetryRequest = z.infer<typeof ConsoleAgentRetryRequestSchema>;

export const ConsoleAgentRetryResponseSchema = z.strictObject({
	operationId: UuidSchema,
	kind: AgentLifecycleOperationKindSchema,
});
export type ConsoleAgentRetryResponse = z.infer<typeof ConsoleAgentRetryResponseSchema>;

/** `GET /api/agents/:id/lifecycle`'s own view of one operation: the journal's identity columns
 * (`requestedBy`, `source`, `idempotencyKey`, `configRevisionId`, `generation`) are omitted —
 * operator detail the console's progress view has no use for, not a redaction of anything
 * sensitive. */
export const ConsoleLifecycleOperationSchema = z.strictObject({
	id: UuidSchema,
	kind: AgentLifecycleOperationKindSchema,
	state: AgentLifecycleOperationStateSchema,
	checkpoints: AgentLifecycleCheckpointsSchema,
	/** Already redacted and bounded at write time (`failOperation`, `redactForStorage`); never a
	 * secret. */
	error: AgentLifecycleErrorSchema.nullable(),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
	finishedAt: TimestampSchema.nullable(),
});
export type ConsoleLifecycleOperation = z.infer<typeof ConsoleLifecycleOperationSchema>;

export const ConsoleAgentLifecycleResponseSchema = z.strictObject({
	status: AgentLifecycleStatusSchema,
	generation: z.int().nonnegative(),
	lastError: AgentLifecycleErrorSchema.nullable(),
	statusChangedAt: TimestampSchema,
	retiredAt: TimestampSchema.nullable(),
	/** Newest first, bounded the same way `gateway agents operations` already is. */
	operations: z.array(ConsoleLifecycleOperationSchema),
});
export type ConsoleAgentLifecycleResponse = z.infer<typeof ConsoleAgentLifecycleResponseSchema>;

export const ConsoleChannelProvenanceSchema = z.enum(["configured", "granted"]);
export type ConsoleChannelProvenance = z.infer<typeof ConsoleChannelProvenanceSchema>;

export const ConsoleAgentChannelAssignmentSchema = z.strictObject({
	channelId: MattermostIdSchema,
	channelName: MattermostNameSchema,
	provenance: ConsoleChannelProvenanceSchema,
	/** Set only for `granted`: who gave it, when, and the post it was decided from. */
	grantedByUserId: MattermostIdSchema.nullable(),
	grantedAt: TimestampSchema.nullable(),
	evidencePostId: MattermostIdSchema.nullable(),
});
export type ConsoleAgentChannelAssignment = z.infer<typeof ConsoleAgentChannelAssignmentSchema>;

export const ConsoleAgentChannelsResponseSchema = z.strictObject({
	channels: z.array(ConsoleAgentChannelAssignmentSchema),
});
export type ConsoleAgentChannelsResponse = z.infer<typeof ConsoleAgentChannelsResponseSchema>;

export const ConsoleRevokeGrantRequestSchema = z.strictObject({
	channelId: MattermostIdSchema,
});
export type ConsoleRevokeGrantRequest = z.infer<typeof ConsoleRevokeGrantRequestSchema>;

export const ConsoleRevokeGrantResponseSchema = z.strictObject({
	channelId: MattermostIdSchema,
	channelName: z.string().nullable(),
	/** Whether the channel is still followed for someone else (another agent's grant, or it stays
	 * configured) — the same thing `gateway agents revoke-grant` itself prints. */
	stillFollowed: z.boolean(),
});
export type ConsoleRevokeGrantResponse = z.infer<typeof ConsoleRevokeGrantResponseSchema>;
