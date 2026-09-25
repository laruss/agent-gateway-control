import { z } from "zod";
import {
	AgentIdSchema,
	MattermostNameSchema,
	MemoryNamespaceSchema,
	PromptPathSchema,
	RuntimeAdapterIdSchema,
	ToolPatternSchema,
	toolPatternOverlaps,
} from "./common.ts";
import { GatewayEventTypeSchema, isReservedEventType } from "./event.ts";

export const SessionPolicySchema = z.enum(["stateless", "resumable-if-available"]);
export type SessionPolicy = z.infer<typeof SessionPolicySchema>;

export const WhileRunningPolicySchema = z.enum(["enqueue", "enqueue-and-coalesce"]);
export type WhileRunningPolicy = z.infer<typeof WhileRunningPolicySchema>;

export const AgentRuntimeConfigSchema = z.strictObject({
	adapter: RuntimeAdapterIdSchema,
	profile: z.string().min(1).default("default"),
	/** Provider model id; left empty in examples and set at deployment. */
	model: z.string().min(1).optional(),
	session_policy: SessionPolicySchema,
	timeout_seconds: z.int().min(10).max(86_400),
});
export type AgentRuntimeConfig = z.infer<typeof AgentRuntimeConfigSchema>;

/**
 * An event type that wakes the agent. Gateway-reserved types (lifecycle, waits, approvals,
 * timers, control) never wake by rule: waits resume their own agent without one.
 */
export const WakeRuleSchema = z.strictObject({
	event_type: GatewayEventTypeSchema.refine(
		(type) => !isReservedEventType(type),
		"Gateway-reserved event types cannot be wake rules",
	),
	target_agent_id: AgentIdSchema.optional(),
});
export type WakeRule = z.infer<typeof WakeRuleSchema>;

export const AgentPermissionsSchema = z
	.strictObject({
		tools_allow: z.array(ToolPatternSchema).max(64),
		tools_require_human_approval: z.array(ToolPatternSchema).max(64),
		tools_deny: z.array(ToolPatternSchema).max(64),
	})
	.check((ctx) => {
		for (const overlap of toolPatternOverlaps(ctx.value)) {
			ctx.issues.push({
				code: "custom",
				input: ctx.value,
				path: [overlap.list],
				message: overlap.message,
			});
		}
	});
export type AgentPermissions = z.infer<typeof AgentPermissionsSchema>;

export const AgentConfigSchema = z.strictObject({
	schema_version: z.literal(1),
	id: AgentIdSchema,
	display_name: z.string().min(1).max(64),
	enabled: z.boolean(),
	mattermost: z.strictObject({
		/** Bot username, equal to the agent id; the bot user id is resolved by bootstrap. */
		username: MattermostNameSchema,
		token_secret_file: z.string().regex(/^\/run\/secrets\/[a-z0-9_]+$/, "path under /run/secrets/"),
		allowed_channels: z.array(MattermostNameSchema).min(1).max(32),
	}),
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
