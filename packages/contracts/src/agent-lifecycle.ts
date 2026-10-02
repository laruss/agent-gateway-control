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
	/** The organization's own Mattermost team name this operation actually joined, recorded
	 * alongside `team_joined` (ADR-026): lets a resumed operation tell a team changed since a
	 * previous checkpoint apart from one that has not, so `team_joined`/`channels_joined` (both
	 * scoped to the team they were recorded against) are redone for the now-current team rather
	 * than skipped as already done for one the agent is no longer meant to be in. */
	team: MattermostNameSchema.optional(),
	/** Channel ids this pass itself confirmed joined (already a member, or just added) —
	 * a progress marker only, reset at the start of every pass, never read
	 * back to decide whether a channel still needs joining (that is always a live check against
	 * Mattermost, never this). Bounded the same way `allowed_channels` itself is (at most 32
	 * configured channels per agent), so a single pass's own, deduplicated set can never exceed it —
	 * unlike the name-keyed array this replaces, which could accumulate past the cap across two
	 * stale reads of a changing configuration and fail to parse back out of storage. */
	channels_joined: z.array(MattermostIdSchema).max(32).optional(),
	/** `retire`'s own steps: every token revoked server-side, the bot account disabled, every
	 * channel it was a member of (by id, since a `retire` operation lists them live rather than
	 * from a configured name list) left, and its local token file (lifecycle-owned agents only)
	 * removed. */
	tokens_revoked: z.boolean().optional(),
	bot_disabled: z.boolean().optional(),
	channels_left: z.array(MattermostIdSchema).max(64).optional(),
	token_file_deleted: z.boolean().optional(),
	/** Set instead of resolving a bot id when retirement finds a plain bot at the agent's own
	 * configured username whose owner is neither the current provisioning admin nor any admin this
	 * Gateway has ever recorded (`loadKnownProvisioningAdminIds`): its Mattermost-side cleanup is
	 * skipped either way (never adopts an unproven account), but this is worth an operator's own
	 * look (`gateway doctor`), since this Gateway's own admin-rotation history — had any of it been
	 * lost — could in principle have vindicated the same bot instead of leaving it skipped. */
	owner_unverified: z.boolean().optional(),
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
 * An agent's Mattermost identity as a create request supplies it: `token_secret_file` is dropped
 * entirely, never a field a caller may set. A lifecycle-created agent's bot token file is always
 * generated server-side under `/run/bot-secrets/` (`defaultBotSecretFile`, ADR-026) — a client
 * naming one of its own, say a controller secret it has no business touching, is refused outright
 * (`z.strictObject`'s own unrecognized-key rejection), never silently overridden or ignored.
 */
export const AgentCreateMattermostInputSchema = AgentMattermostConfigSchema.omit({
	token_secret_file: true,
});
export type AgentCreateMattermostInput = z.input<typeof AgentCreateMattermostInputSchema>;

/**
 * An agent definition as `requestAgentCreate` accepts it: the same shape as `AgentConfig` minus
 * `schema_version` (fixed) and `enabled` (always created enabled), with `runtime` optional for the
 * same reason, `mattermost.token_secret_file` dropped (see `AgentCreateMattermostInputSchema`),
 * and `permissions` optional — left unset, `requestAgentCreate` defaults it with
 * `defaultAgentPermissions` (`config-bundle.ts`), the same rule `validateConfigBundle` enforces on
 * every agent but the organization's own finance agent.
 */
export const AgentCreateInputSchema = AgentConfigSchema.omit({
	schema_version: true,
	enabled: true,
	runtime: true,
	mattermost: true,
	permissions: true,
}).extend({
	runtime: AgentCreateRuntimeInputSchema.optional(),
	mattermost: AgentCreateMattermostInputSchema,
	permissions: AgentConfigSchema.shape.permissions.optional(),
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
	/**
	 * Required, and naming a different, currently configured agent, when `agentId` is the
	 * organization's own `finance_agent_id`: retiring the finance agent is refused unless the same
	 * request reassigns the role, committed as part of the same change set (`set_finance_agent`,
	 * `@agent-gateway/contracts`'s own `ChangeOperation`) so the configuration is never left
	 * naming a finance agent that no longer exists.
	 */
	reassignFinanceTo: AgentIdSchema.optional(),
});
export type RequestAgentRetireInput = z.input<typeof RequestAgentRetireInputSchema>;

export const RequestAgentRestoreInputSchema = z.strictObject({
	agentId: AgentIdSchema,
	actor: z.string().min(1).max(200),
	source: AgentLifecycleSourceSchema,
	idempotencyKey: IdempotencyKeySchema.optional(),
	/**
	 * Reassigns the organization's `finance_agent_id` to the restored agent, atomically with the
	 * restore itself (`set_finance_agent`, committed in the same change set): without it, an agent
	 * restored from a historical configuration in which it *was* the finance agent has its
	 * permissions normalized instead — any finance-touching `tools_allow`/`tools_require_human_approval`
	 * entry stripped, `finance.*` added to `tools_deny` — since a non-finance agent may not keep
	 * them (`validateConfigBundle`'s own finance rule, `@agent-gateway/contracts`'s own
	 * `financeIssues`). Refused the same way `requestAgentRetire`'s own `reassignFinanceTo` is when
	 * the resulting bundle is otherwise invalid (an existing finance agent left holding finance
	 * tools it may no longer have, say): a plain configuration error, nothing special-cased here.
	 */
	makeFinanceAgent: z.boolean().optional(),
});
export type RequestAgentRestoreInput = z.input<typeof RequestAgentRestoreInputSchema>;

/**
 * Requests a fresh attempt of an agent's own current operation, for a `failed` agent (its
 * `create`/`restore`/`reprovision` operation did not succeed) or a `retiring` one whose `retire`
 * operation itself failed permanently: `requestOperationRetry` queues a new operation of the same
 * kind, carrying the failed operation's own checkpoints forward (a step it already completed is
 * not repeated), rather than resurrecting the failed row itself — the operation journal is
 * append-only (ADR-026), so a terminal row never moves backward. Refused for an agent whose
 * current operation is not actually `failed` (nothing to retry).
 */
export const RequestOperationRetryInputSchema = z.strictObject({
	agentId: AgentIdSchema,
	actor: z.string().min(1).max(200),
	source: AgentLifecycleSourceSchema,
	idempotencyKey: IdempotencyKeySchema.optional(),
});
export type RequestOperationRetryInput = z.input<typeof RequestOperationRetryInputSchema>;
