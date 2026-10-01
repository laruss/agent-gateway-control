import { z } from "zod";
import {
	AgentPermissionsSchema,
	AgentRuntimeConfigSchema,
	SessionPolicySchema,
	WakeRuleSchema,
	WhileRunningPolicySchema,
} from "./agent-config.ts";
import {
	AgentIdSchema,
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
import { ModelNameSchema, TokenSchema } from "./system-status.ts";

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
	displayName: z.string().min(1).max(64),
	enabled: z.boolean(),
	state: TokenSchema,
	runtimeAdapter: RuntimeAdapterIdSchema,
	model: ModelNameSchema.nullable(),
	channelCount: z.int().min(0),
	lastRun: ConsoleAgentLastRunSchema.nullable(),
	activeRevisionId: z.int().positive().nullable(),
});
export type ConsoleAgentListItem = z.infer<typeof ConsoleAgentListItemSchema>;

export const ConsoleAgentListResponseSchema = z.strictObject({
	agents: z.array(ConsoleAgentListItemSchema),
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
	displayName: z.string().min(1).max(64),
	enabled: z.boolean(),
	mattermost: ConsoleAgentMattermostSchema,
	runtime: AgentRuntimeConfigSchema,
	/** Not `RolePromptSchema` (which requires non-blank text, for the patch an edit submits): an
	 * agent that has never had one set has an empty string here (`consoleShowAgent`'s own `?? ""`),
	 * and the view must still be able to open to let the owner set one. */
	rolePrompt: z.string().max(50_000),
	wakeRules: z.array(WakeRuleSchema).max(32),
	permissions: AgentPermissionsSchema,
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
		model: z.string().min(1).nullable().optional(),
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
		displayName: z.string().min(1).max(64).optional(),
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
