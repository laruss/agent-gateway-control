import { z } from "zod";
import {
	AgentIdSchema,
	BROADCAST_MENTIONS,
	MattermostNameSchema,
	PromptPathSchema,
	SecretFileSchema,
} from "./common.ts";

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
		/**
		 * The Gateway's own bot: it listens to every managed channel and posts alerts and approval
		 * cards. Its posts never route.
		 */
		listener: z.strictObject({
			username: MattermostNameSchema.refine(
				(name) => !BROADCAST_MENTIONS.includes(name),
				"reserved Mattermost mention name",
			),
			token_secret_file: SecretFileSchema,
		}),
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

/** Daily caps of one scope; a metric left out is not limited. */
export const DailyBudgetSchema = z
	.strictObject({
		cost_usd: z.number().positive().max(1_000_000).optional(),
		/** Input plus output tokens; cached input is part of the input and not added again. */
		tokens: z.int().positive().max(10_000_000_000).optional(),
	})
	.refine(
		(budget) => budget.cost_usd !== undefined || budget.tokens !== undefined,
		"a budget sets cost_usd, tokens or both",
	);
export type DailyBudget = z.infer<typeof DailyBudgetSchema>;

/**
 * Spending limits per UTC day. An agent over its own limit, or everyone over the global one,
 * starts no run until the day changes or the limit is raised (ADR-018).
 */
export const OrganizationBudgetsSchema = z.strictObject({
	per_agent_daily: DailyBudgetSchema.optional(),
	global_daily: DailyBudgetSchema.optional(),
	/**
	 * An attempt that reports neither cost nor tokens: `hold` stops its agent for the day (fail
	 * closed), `allow` counts it as nothing.
	 */
	unmetered: z.enum(["hold", "allow"]).default("hold"),
});
export type OrganizationBudgets = z.infer<typeof OrganizationBudgetsSchema>;

/** Days of one retention period; at least 8, longer than the longest wait (7 days). */
const retentionDays = (fallback: number) => z.int().min(8).max(3650).default(fallback);

/**
 * How long the Gateway keeps message content, in days; the controller removes it hourly.
 * Identifiers, hashes and statuses stay, so dedupe, routing and the audit trail keep working.
 * Approval requests, tool actions and the audit log are records and are kept.
 */
export const OrganizationRetentionSchema = z.strictObject({
	/** Event payloads (posts, mail): only the ids readers join on remain. */
	event_content_days: retentionDays(30),
	/** Finished runs' results, summaries, error details and exact turn inputs. */
	run_content_days: retentionDays(30),
	/** Payloads of delivered outbox items. */
	outbox_sent_days: retentionDays(8),
	/** Payloads of outbox items that could not be delivered. */
	outbox_dead_days: retentionDays(30),
	/** Inputs of policy decisions. */
	policy_input_days: retentionDays(30),
	/** Summaries of threads without activity. */
	thread_summary_days: retentionDays(90),
	/** Rejected and superseded memory items. */
	inactive_memory_days: retentionDays(30),
	/** The usage ledger. */
	usage_days: retentionDays(400),
});
export type OrganizationRetention = z.infer<typeof OrganizationRetentionSchema>;

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
		budgets: OrganizationBudgetsSchema.optional(),
		retention: OrganizationRetentionSchema.prefault({}),
	}),
	mattermost: OrganizationMattermostSchema,
});
export type OrganizationConfig = z.infer<typeof OrganizationConfigSchema>;
