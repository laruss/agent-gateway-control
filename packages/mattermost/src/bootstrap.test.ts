import {
	type AgentConfig,
	AgentConfigSchema,
	type OrganizationConfig,
	OrganizationConfigSchema,
} from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import { mattermostPlan } from "./bootstrap.ts";

function organization(): OrganizationConfig {
	return OrganizationConfigSchema.parse({
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
			channels: ["hq"],
			approvals_channel: "hq",
			alerts_channel: "hq",
			listener: {
				username: "gateway-listener",
				token_secret_file: "/run/secrets/mm_listener_token",
			},
		},
	});
}

function agent(id: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return AgentConfigSchema.parse({
		schema_version: 1,
		id,
		display_name: id,
		enabled: true,
		mattermost: {
			username: id,
			token_secret_file: `/run/secrets/mm_${id}_token`,
			allowed_channels: ["hq"],
		},
		runtime: { adapter: "mock", session_policy: "stateless", timeout_seconds: 60 },
		prompts: { role_file: `prompts/${id}.md` },
		wake_rules: [],
		concurrency: { while_running: "enqueue" },
		permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: [] },
		memory: { private_namespace: `agents/${id}`, shared_namespaces: [] },
		...overrides,
	});
}

describe("mattermostPlan", () => {
	it("skips exactly the agents the database names as lifecycle-owned, plans an adopted agent normally", () => {
		const adopted = agent("adopted");
		const owned = agent("owned", {
			mattermost: {
				username: "owned",
				token_secret_file: "/run/bot-secrets/mm_owned_token",
				allowed_channels: ["hq"],
			},
		});
		const plan = mattermostPlan(
			organization(),
			[adopted, owned],
			(ref) => `/secrets/${ref}`,
			[],
			new Set(["owned"]),
		);
		const usernames = plan.bots.map((bot) => bot.username);
		expect(usernames).toContain("adopted");
		expect(usernames).not.toContain("owned");
	});

	it("never skips by token path alone: an agent under /run/bot-secrets/ that the database does not name as lifecycle-owned is still planned, since the database is the one source of truth", () => {
		const stray = agent("stray", {
			mattermost: {
				username: "stray",
				token_secret_file: "/run/bot-secrets/mm_stray_token",
				allowed_channels: ["hq"],
			},
		});
		const plan = mattermostPlan(organization(), [stray], (ref) => `/secrets/${ref}`, [], new Set());
		expect(plan.bots.map((bot) => bot.username)).toContain("stray");
	});

	it("excludes a lifecycle-owned agent from the retired-cleanup plan too, even though its stale 'agents' row still names it", () => {
		const plan = mattermostPlan(
			organization(),
			[],
			(ref) => `/secrets/${ref}`,
			[
				{ agentId: "restoring", username: "restoring", userId: "user0000000000000000000001" },
				{ agentId: "gone", username: "gone", userId: "user0000000000000000000002" },
			],
			new Set(["restoring"]),
		);
		const retiredUsernames = plan.retiredBots.map((bot) => bot.username);
		expect(retiredUsernames).not.toContain("restoring");
		expect(retiredUsernames).toContain("gone");
	});
});
