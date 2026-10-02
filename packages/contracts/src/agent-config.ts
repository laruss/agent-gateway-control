import { z } from "zod";
import {
	AgentIdSchema,
	MattermostNameSchema,
	MemoryNamespaceSchema,
	PromptPathSchema,
	RuntimeAdapterIdSchema,
	SecretFileSchema,
	ToolPatternSchema,
	toolPatternOverlaps,
} from "./common.ts";
import { GatewayEventTypeSchema, isRecordOnlyEventType, isReservedEventType } from "./event.ts";

export const SessionPolicySchema = z.enum(["stateless", "resumable-if-available"]);
export type SessionPolicy = z.infer<typeof SessionPolicySchema>;

export const WhileRunningPolicySchema = z.enum(["enqueue", "enqueue-and-coalesce"]);
export type WhileRunningPolicy = z.infer<typeof WhileRunningPolicySchema>;

/**
 * An agent's display name, shared by `AgentConfigSchema.display_name` and every console DTO that
 * reads or writes it (`console-management.ts`'s list/detail responses and `AgentPatchSchema`): one
 * bound, so a name a write accepts is always one a later read can parse back.
 */
export const AgentDisplayNameSchema = z.string().min(1).max(64);

/**
 * Provider model id, shared by `AgentRuntimeConfigSchema.model` and every console DTO that reads
 * or writes it (`console-management.ts`'s list/detail responses and `AgentRuntimePatchSchema`):
 * one bound, so a model a write accepts is always one a later read can parse back. Left empty in
 * examples and set at deployment.
 */
export const AgentModelSchema = z.string().min(1).max(255);

export const AgentRuntimeConfigSchema = z.strictObject({
	adapter: RuntimeAdapterIdSchema,
	profile: z.string().min(1).default("default"),
	model: AgentModelSchema.optional(),
	session_policy: SessionPolicySchema,
	timeout_seconds: z.int().min(10).max(86_400),
});
export type AgentRuntimeConfig = z.infer<typeof AgentRuntimeConfigSchema>;

/**
 * An event type that wakes the agent. Gateway-reserved types (lifecycle, waits, approvals,
 * timers, control) never wake by rule: waits resume their own agent without one. Edits and
 * deletions are record-only.
 */
export const WakeRuleSchema = z
	.strictObject({
		event_type: GatewayEventTypeSchema.refine(
			(type) => !isReservedEventType(type),
			"Gateway-reserved event types cannot be wake rules",
		).refine(
			(type) => !isRecordOnlyEventType(type),
			"edits, deletions and notifications never wake an agent",
		),
		target_agent_id: AgentIdSchema.optional(),
	})
	.refine(
		(rule) => rule.target_agent_id !== undefined || !rule.event_type.startsWith("mattermost."),
		{
			message:
				"Mattermost posts wake only the agents they address; an untargeted Mattermost wake rule would bypass mentions and channel permissions",
			path: ["target_agent_id"],
		},
	);

export type WakeRule = z.infer<typeof WakeRuleSchema>;

export const AgentPermissionsSchema = z
	.strictObject({
		tools_allow: z.array(ToolPatternSchema).max(64),
		tools_require_human_approval: z.array(ToolPatternSchema).max(64),
		tools_deny: z.array(ToolPatternSchema).max(64),
		/**
		 * The agent's turns carry the Gateway's system status: states, runs, queues and alerts of
		 * every agent, as operational metadata (ADR-023). For an operator agent; off by default.
		 */
		observe_system: z.boolean().optional(),
	})
	.check((ctx) => {
		const { tools_allow, tools_require_human_approval, tools_deny } = ctx.value;
		for (const overlap of toolPatternOverlaps({
			tools_allow,
			tools_require_human_approval,
			tools_deny,
		})) {
			ctx.issues.push({
				code: "custom",
				input: ctx.value,
				path: [overlap.list],
				message: overlap.message,
			});
		}
	});
export type AgentPermissions = z.infer<typeof AgentPermissionsSchema>;

/**
 * An agent's Mattermost identity as its configuration names it: the bot username (the bot user id
 * itself is resolved by bootstrap or the lifecycle provisioner, never configured) and its
 * channels. Named and exported so `AgentCreateMattermostInputSchema`
 * (`agent-lifecycle.ts`) can vary it slightly — a create request leaves `token_secret_file`
 * unset for the provisioner to generate — without duplicating the rest of the shape.
 */
export const AgentMattermostConfigSchema = z.strictObject({
	/** Bot username, equal to the agent id; the bot user id is resolved by bootstrap. */
	username: MattermostNameSchema,
	token_secret_file: SecretFileSchema,
	/**
	 * Channels given in the configuration. Optional: an owner or system admin can also give a
	 * channel by adding the bot there in Mattermost (ADR-022).
	 */
	allowed_channels: z.array(MattermostNameSchema).max(32).default([]),
});
export type AgentMattermostConfig = z.infer<typeof AgentMattermostConfigSchema>;

export const AgentConfigSchema = z.strictObject({
	schema_version: z.literal(1),
	id: AgentIdSchema,
	display_name: AgentDisplayNameSchema,
	enabled: z.boolean(),
	mattermost: AgentMattermostConfigSchema,
	runtime: AgentRuntimeConfigSchema,
	prompts: z.strictObject({
		role_file: PromptPathSchema,
	}),
	wake_rules: z.array(WakeRuleSchema).max(32),
	concurrency: z.strictObject({
		max_active_runs: z.int().min(1).max(8).default(1),
		while_running: WhileRunningPolicySchema,
	}),
	permissions: AgentPermissionsSchema,
	memory: z.strictObject({
		private_namespace: MemoryNamespaceSchema.refine(
			(ns) => ns.startsWith("agents/"),
			"private namespace must be 'agents/<id>'",
		),
		shared_namespaces: z
			.array(
				MemoryNamespaceSchema.refine(
					(ns) => ns.startsWith("organization/"),
					"shared namespace must start with 'organization/'",
				),
			)
			.max(16),
	}),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
