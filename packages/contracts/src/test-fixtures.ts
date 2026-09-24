import type { z } from "zod";
import type { AgentConfig } from "./agent-config.ts";
import type { OrganizationConfig } from "./organization.ts";
import type { AgentTurnResult, PublicMessage } from "./turn.ts";
import type { WaitCondition } from "./wait.ts";

/** Test-only fixtures. Not exported from the package entry point. */

export const RUN_ID = "0b6f5d8e-3f1c-4c2a-9a57-6f1d2c3b4a5e";
export const CHANNEL_ID = "abcdefghijklmnopqrstuvwxyz";
export const OTHER_CHANNEL_ID = "zyxwvutsrqponmlkjihgfedcba";
export const ROOT_ID = "0123456789abcdefghijklmnop";
export const USER_ID = "u123456789abcdefghijklmnop";

export function idleResult(): AgentTurnResult {
	return {
		schemaVersion: 1,
		runId: RUN_ID,
		publicMessages: [],
		nextState: { kind: "idle" },
		publicSummary: {
			assigned: "Check the budget with finance",
			facts: [],
			decisions: [],
			done: [],
			remaining: [],
			waitingFor: [],
			risks: [],
		},
		memoryProposals: [],
		artifacts: [],
		usage: null,
		session: null,
	};
}

export function message(overrides: Partial<PublicMessage> = {}): PublicMessage {
	return {
		channelId: CHANNEL_ID,
		rootPostId: ROOT_ID,
		markdown: "Нужен бюджет 50 USD на домен.",
		targetAgentIds: ["finance"],
		attachments: [],
		...overrides,
	};
}

export function financeReplyWait(overrides: Partial<WaitCondition> = {}): WaitCondition {
	return {
		eventType: "mattermost.thread.reply",
		correlationId: `thread:${ROOT_ID}`,
		expectedSenderAgentIds: ["finance"],
		expectedSenderUserIds: [],
		requireTargetAgentId: "developer",
		timeoutAt: "2026-09-25T14:00:00Z",
		...overrides,
	};
}

export function organization(): OrganizationConfig {
	return {
		schema_version: 1,
		organization: {
			id: "lab",
			display_name: "Lab",
			global_goal: "goal",
			constitution_file: "prompts/constitution.md",
			owner_mattermost_usernames: ["owner"],
			finance_agent_id: "finance",
			rules: [],
			default_limits: {
				max_agent_hops: 8,
				max_turns_per_cascade: 20,
				max_runs_per_agent_per_hour: 30,
				default_run_timeout_seconds: 1800,
			},
		},
		mattermost: {
			team: "lab",
			channels: ["hq", "approvals", "gateway-alerts"],
			approvals_channel: "approvals",
			alerts_channel: "gateway-alerts",
		},
	};
}

export function agent(id: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		schema_version: 1,
		id,
		display_name: id,
		enabled: true,
		mattermost: {
			username: id,
			token_secret_file: `/run/secrets/mm_${id}_token`,
			allowed_channels: ["hq"],
		},
		runtime: {
			adapter: "mock",
			profile: "default",
			session_policy: "stateless",
			timeout_seconds: 60,
		},
		prompts: { role_file: `prompts/${id}.md` },
		wake_rules: [],
		concurrency: { max_active_runs: 1, while_running: "enqueue" },
		permissions: {
			tools_allow: [],
			tools_require_human_approval: [],
			tools_deny: id === "finance" ? [] : ["finance.*"],
		},
		memory: { private_namespace: `agents/${id}`, shared_namespaces: [] },
		...overrides,
	};
}

/** Dotted paths of all issues, or `[]` when the value is valid. */
export function issuePaths(schema: z.ZodType, value: unknown): string[] {
	const parsed = schema.safeParse(value);
	return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
}
