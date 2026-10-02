import { z } from "zod";
import {
	AgentConfigSchema,
	AgentMattermostConfigSchema,
	AgentRuntimeConfigSchema,
} from "./agent-config.ts";
import {
	AgentIdSchema,
	MattermostIdSchema,
	MattermostNameSchema,
	SecretFileSchema,
	TimestampSchema,
	UuidSchema,
} from "./common.ts";
import {
	ConfigRevisionReasonSchema,
	IdempotencyKeySchema,
	RolePromptSchema,
} from "./management.ts";

/**
 * Provisioning status of an agent's Mattermost identity, kept apart from its *desired*
 * configuration (`AgentConfig.enabled`, which the configuration journal already tracks). An agent
 * can be configured (`enabled: true`) while its identity is still `pending`: the scheduler gates
 * on this status, never only on `enabled` (see `requireAgentLifecycleReady` in
 * `@agent-gateway/core`'s scheduler).
 *
 * - `pending`: desired, nothing provisioned yet (a fresh `create`, or an agent adopted without a
 *   resolved Mattermost identity).
 * - `reconciling`: a provisioning operation is actively running (`markProvisioning`).
 * - `ready`: provisioned and schedulable.
 * - `failed`: the last operation did not succeed; `last_error` names why.
 * - `retiring`: a `retire` operation has been requested and its configuration change committed;
 *   cleanup (later work) has not finished yet.
 * - `retired`: terminal; the agent id is never reused (see `requestAgentCreate`).
 */
export const AGENT_LIFECYCLE_STATUSES = [
	"pending",
	"reconciling",
	"ready",
	"failed",
	"retiring",
	"retired",
] as const;
export const AgentLifecycleStatusSchema = z.enum(AGENT_LIFECYCLE_STATUSES);
export type AgentLifecycleStatus = z.infer<typeof AgentLifecycleStatusSchema>;

/** What a lifecycle operation is pursuing. `adopt` is written only by the startup backfill. */
export const AGENT_LIFECYCLE_OPERATION_KINDS = [
	"create",
	"retire",
	"restore",
	"reprovision",
	"adopt",
] as const;
export const AgentLifecycleOperationKindSchema = z.enum(AGENT_LIFECYCLE_OPERATION_KINDS);
export type AgentLifecycleOperationKind = z.infer<typeof AgentLifecycleOperationKindSchema>;

/** `pending -> running -> {succeeded, failed}`, or `{pending, running} -> cancelled`. */
export const AGENT_LIFECYCLE_OPERATION_STATES = [
	"pending",
	"running",
	"succeeded",
	"failed",
	"cancelled",
] as const;
export const AgentLifecycleOperationStateSchema = z.enum(AGENT_LIFECYCLE_OPERATION_STATES);
export type AgentLifecycleOperationState = z.infer<typeof AgentLifecycleOperationStateSchema>;

/** The surface that asked for a lifecycle operation: a CLI session, the console, or an agent. */
export const AGENT_LIFECYCLE_SOURCES = ["cli", "console", "agent"] as const;
export const AgentLifecycleSourceSchema = z.enum(AGENT_LIFECYCLE_SOURCES);
export type AgentLifecycleSource = z.infer<typeof AgentLifecycleSourceSchema>;

/**
 * Checkpoints a provisioning operation records as it goes: ids and references only, never a
 * token's value. Empty for every operation this release writes (`create`/`retire`/`restore`
 * commit no Mattermost call yet); later work's provisioner fills these in as it completes each
 * step, so a crashed controller can tell what already happened from what still needs doing.
 */
export const AgentLifecycleCheckpointsSchema = z.strictObject({
	bot_user_id: MattermostIdSchema.optional(),
	token_ref: SecretFileSchema.optional(),
	team_joined: z.boolean().optional(),
	channels_joined: z.array(MattermostNameSchema).max(32).optional(),
});
export type AgentLifecycleCheckpoints = z.infer<typeof AgentLifecycleCheckpointsSchema>;

/** Bounded, never a credential: the last operation's own failure, for an owner to read. */
export const AgentLifecycleErrorSchema = z.string().min(1).max(2000);

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export const AgentLifecycleSchema = z.strictObject({
	agentId: AgentIdSchema,
	status: AgentLifecycleStatusSchema,
	generation: z.int().nonnegative(),
	operationId: UuidSchema.nullable(),
	lastError: AgentLifecycleErrorSchema.nullable(),
	statusChangedAt: TimestampSchema,
	createdAt: TimestampSchema,
	retiredAt: TimestampSchema.nullable(),
});
export type AgentLifecycle = z.infer<typeof AgentLifecycleSchema>;

export const AgentLifecycleOperationSchema = z.strictObject({
	id: UuidSchema,
	agentId: AgentIdSchema,
	kind: AgentLifecycleOperationKindSchema,
	requestedBy: z.string().min(1),
	source: AgentLifecycleSourceSchema,
	idempotencyKey: IdempotencyKeySchema.nullable(),
	/** The configuration revision that carried this operation's desired-state change; null for
	 * none (not expected today — every kind this release writes commits or reads one). */
	configRevisionId: z.int().positive().nullable(),
	/** The `agent_lifecycle.generation` this operation pursues; see `completeOperation`. */
	generation: z.int().nonnegative(),
	state: AgentLifecycleOperationStateSchema,
	checkpoints: AgentLifecycleCheckpointsSchema,
	error: AgentLifecycleErrorSchema.nullable(),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
	finishedAt: TimestampSchema.nullable(),
});
export type AgentLifecycleOperation = z.infer<typeof AgentLifecycleOperationSchema>;

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

/**
 * The runtime a create request supplies, every field optional: `requestAgentCreate` fills in
 * whatever is missing from the deployment's Codex defaults (see its own doc comment), and refuses
 * an explicit adapter that is not installed and qualified on this deployment.
 */
export const AgentCreateRuntimeInputSchema = AgentRuntimeConfigSchema.partial({
	adapter: true,
	session_policy: true,
	timeout_seconds: true,
});
/** Before schema defaults (`profile`, `allowed_channels`, ...) are filled in — the shape a caller
 * actually supplies, matching `ChangeSetInput`'s own `z.input` convention. */
export type AgentCreateRuntimeInput = z.input<typeof AgentCreateRuntimeInputSchema>;

/**
 * An agent's Mattermost identity as a create request supplies it: `token_secret_file` is optional
 * and, left unset, generated server-side under `/run/bot-secrets/` (ADR-026) — a lifecycle-created
 * agent's bot token file is never a client's to choose.
 */
export const AgentCreateMattermostInputSchema = AgentMattermostConfigSchema.extend({
	token_secret_file: SecretFileSchema.optional(),
});
export type AgentCreateMattermostInput = z.input<typeof AgentCreateMattermostInputSchema>;

/**
 * An agent definition as `requestAgentCreate` accepts it: the same shape as `AgentConfig` minus
 * `schema_version` (fixed) and `enabled` (always created enabled), with `runtime` optional for the
 * same reason and `mattermost.token_secret_file` optional (see `AgentCreateMattermostInputSchema`).
 */
export const AgentCreateInputSchema = AgentConfigSchema.omit({
	schema_version: true,
	enabled: true,
	runtime: true,
	mattermost: true,
}).extend({
	runtime: AgentCreateRuntimeInputSchema.optional(),
	mattermost: AgentCreateMattermostInputSchema,
});
/** Before schema defaults are filled in (see `AgentCreateRuntimeInput`); this is the type every
 * `requestAgentCreate` caller actually builds. */
export type AgentCreateInput = z.input<typeof AgentCreateInputSchema>;

export const RequestAgentCreateInputSchema = z.strictObject({
	agent: AgentCreateInputSchema,
	rolePrompt: RolePromptSchema,
	actor: z.string().min(1).max(200),
	source: AgentLifecycleSourceSchema,
	idempotencyKey: IdempotencyKeySchema.optional(),
});
export type RequestAgentCreateInput = z.input<typeof RequestAgentCreateInputSchema>;

export const RequestAgentRetireInputSchema = z.strictObject({
	agentId: AgentIdSchema,
	actor: z.string().min(1).max(200),
	source: AgentLifecycleSourceSchema,
	idempotencyKey: IdempotencyKeySchema.optional(),
	reason: ConfigRevisionReasonSchema.optional(),
});
export type RequestAgentRetireInput = z.input<typeof RequestAgentRetireInputSchema>;

export const RequestAgentRestoreInputSchema = z.strictObject({
	agentId: AgentIdSchema,
	actor: z.string().min(1).max(200),
	source: AgentLifecycleSourceSchema,
	idempotencyKey: IdempotencyKeySchema.optional(),
});
export type RequestAgentRestoreInput = z.input<typeof RequestAgentRestoreInputSchema>;
