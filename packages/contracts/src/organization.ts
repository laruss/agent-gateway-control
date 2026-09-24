import { z } from "zod";
import { AgentIdSchema, MattermostNameSchema, PromptPathSchema } from "./common.ts";

export const OrganizationRuleSchema = z.strictObject({
	id: z.string().regex(/^[a-z][a-z0-9-]*$/),
	text: z.string().min(1).max(2000),
});
export type OrganizationRule = z.infer<typeof OrganizationRuleSchema>;

export const OrganizationLimitsSchema = z.strictObject({
	max_agent_hops: z.int().min(1).max(64),
	max_turns_per_cascade: z.int().min(1).max(500),
	max_runs_per_agent_per_hour: z.int().min(1).max(1000),
	default_run_timeout_seconds: z.int().min(10).max(86_400),
});
export type OrganizationLimits = z.infer<typeof OrganizationLimitsSchema>;

/**
 * Channels are referenced by name in config. `gateway mattermost bootstrap`
 * resolves names to ids and stores them in the database.
 */
export const OrganizationMattermostSchema = z
	.strictObject({
		team: MattermostNameSchema,
		channels: z.array(MattermostNameSchema).min(1).max(100),
		approvals_channel: MattermostNameSchema,
		alerts_channel: MattermostNameSchema,
	})
	.check((ctx) => {
		const { channels, approvals_channel, alerts_channel } = ctx.value;
		for (const [field, name] of [
			["approvals_channel", approvals_channel],
			["alerts_channel", alerts_channel],
		] as const) {
			if (!channels.includes(name)) {
				ctx.issues.push({
					code: "custom",
					input: name,
					path: [field],
					message: `channel '${name}' is not listed in mattermost.channels`,
				});
			}
		}
	});
export type OrganizationMattermost = z.infer<typeof OrganizationMattermostSchema>;

export const OrganizationConfigSchema = z.strictObject({
	schema_version: z.literal(1),
	organization: z.strictObject({
		id: z.string().regex(/^[a-z][a-z0-9-]*$/),
		display_name: z.string().min(1),
		global_goal: z.string().min(1),
		constitution_file: PromptPathSchema,
		/** Humans allowed to approve high-risk actions. Resolved to user ids at bootstrap. */
		owner_mattermost_usernames: z.array(MattermostNameSchema).min(1).max(16),
		/** The only agent that may hold finance tools; every finance action still needs a human. */
		finance_agent_id: AgentIdSchema,
		rules: z.array(OrganizationRuleSchema).max(100),
		default_limits: OrganizationLimitsSchema,
	}),
	mattermost: OrganizationMattermostSchema,
});
export type OrganizationConfig = z.infer<typeof OrganizationConfigSchema>;
