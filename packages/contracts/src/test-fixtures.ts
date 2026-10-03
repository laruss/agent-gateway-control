import type { z } from "zod";
import type { AgentConfig } from "./agent-config.ts";
import type { GmailMessageData } from "./event.ts";
import { type OrganizationConfig, OrganizationRetentionSchema } from "./organization.ts";
import type { SystemStatus } from "./system-status.ts";
import type { AgentTurnInput, AgentTurnResult, PublicMessage } from "./turn.ts";
import type { WaitCondition } from "./wait.ts";

/** Test-only fixtures. Not exported from the package entry point. */

export const RUN_ID = "0b6f5d8e-3f1c-4c2a-9a57-6f1d2c3b4a5e";
export const CHANNEL_ID = "abcdefghijklmnopqrstuvwxyz";
export const OTHER_CHANNEL_ID = "zyxwvutsrqponmlkjihgfedcba";
export const ROOT_ID = "0123456789abcdefghijklmnop";
export const USER_ID = "u123456789abcdefghijklmnop";

export function gmailMessageData(overrides: Partial<GmailMessageData> = {}): GmailMessageData {
	return {
		mailbox_id: "primary",
		message_id: "18c2a1b2c3d4e5f6",
		thread_id: "18c2a1b2c3d4e5f6",
		received_at: "2026-09-24T14:00:00.000Z",
		from: "Customer <customer@example.com>",
		reply_to: "",
		to: "ops@example.org",
		cc: "",
		subject: "Invoice question",
		rfc822_message_id: "<abc@example.com>",
		body_text: "Hello, where is my invoice?",
		body_format: "plain",
		body_truncated: false,
		hidden_text_removed: false,
		hidden_text_suspected: false,
		attachments: [],
		attachments_omitted: 0,
		...overrides,
	};
}

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

/** A version 1 `AgentTurnInput` without a Mattermost thread; pass `schemaVersion: 2` (with
 * `systemStatus`) for version 2, or `schemaVersion: 3` (with `capabilities`) for version 3. */
export function agentTurnInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
	return {
		schemaVersion: 1,
		runId: RUN_ID,
		agent: {
			agentId: "mail-follower",
			displayName: "Mail Follower",
			mattermostUsername: "mail-follower",
			rolePrompt: "Sort incoming mail.",
			configVersion: "1",
		},
		organization: {
			organizationId: "lab",
			globalGoal: "goal",
			constitution: "rules",
			rules: [],
			limits: organization().organization.default_limits,
			directory: [],
		},
		trigger: {
			specversion: "1.0",
			id: "gmail-message:primary:18c2a1b2c3d4e5f6",
			source: "gmail://primary",
			type: "google.gmail.message.received",
			time: "2026-09-24T14:00:00Z",
			datacontenttype: "application/json",
			correlationid: "gmail-thread:primary:18c2a1b2c3d4e5f6",
			causationid: null,
			trustlevel: "external-untrusted",
			hop: 0,
			data: gmailMessageData(),
		},
		durableState: { previousRunId: null, previousSummary: null, resolvedWaits: [] },
		channels: [{ channelId: CHANNEL_ID, name: "mail" }],
		threadContext: null,
		memories: [],
		memoryNamespaces: { private: "agents/mail-follower", shared: ["organization/customers"] },
		pendingInbox: [],
		workspace: null,
		toolPolicy: { policyVersion: "1", allow: ["mail.read"], requireHumanApproval: [], deny: [] },
		outputSchema: { type: "object" },
		deadline: "2026-09-24T14:15:00Z",
		...overrides,
	};
}

/** An empty but valid `SystemStatus` snapshot (ADR-023); every list defaults to none. */
export function systemStatus(overrides: Partial<SystemStatus> = {}): SystemStatus {
	return {
		asOf: "2026-09-24T14:00:00Z",
		killSwitch: false,
		agents: [],
		omittedAgents: 0,
		runtimes: [],
		queues: [],
		outbox: { pending: 0, dead: 0 },
		approvalsPending: 0,
		toolActionsUnknown: 0,
		alerts: [],
		maintenance: [],
		...overrides,
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
			retention: OrganizationRetentionSchema.parse({}),
		},
		mattermost: {
			team: "lab",
			channels: ["hq", "approvals", "gateway-alerts"],
			approvals_channel: "approvals",
			alerts_channel: "gateway-alerts",
			listener: {
				username: "gateway-listener",
				token_secret_file: "/run/secrets/mm_gateway_listener_token",
			},
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
