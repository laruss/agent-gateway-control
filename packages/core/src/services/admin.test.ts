import {
	type AgentConfig,
	AgentConfigSchema,
	OrganizationConfigSchema,
} from "@agent-gateway/contracts";
import { canonicalHash } from "@agent-gateway/events";
import { describe, expect, it } from "vitest";
import { type ConfigApplyInput, configBundleProblems, configSnapshotBundle } from "./admin.ts";

function organization() {
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

function agent(id: string): AgentConfig {
	return AgentConfigSchema.parse({
		schema_version: 1,
		id,
		display_name: id,
		enabled: true,
		mattermost: { username: id, token_secret_file: `/run/secrets/mm_${id}_token` },
		runtime: { adapter: "mock", session_policy: "stateless", timeout_seconds: 60 },
		prompts: { role_file: `prompts/${id}.md` },
		wake_rules: [],
		concurrency: { while_running: "enqueue" },
		permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: [] },
		memory: { private_namespace: `agents/${id}`, shared_namespaces: [] },
	});
}

function input(agents: Readonly<AgentConfig[]>): ConfigApplyInput {
	return {
		organization: organization(),
		agents,
		constitution: "Be helpful.",
		rolePrompts: Object.fromEntries(agents.map((a) => [a.id, `Role prompt for ${a.id}.`])),
	};
}

describe("configSnapshotBundle", () => {
	it("hashes to the same value whatever order the agents are given in", () => {
		const alpha = agent("alpha");
		const beta = agent("beta");
		const forward = canonicalHash(configSnapshotBundle(input([alpha, beta])));
		const backward = canonicalHash(configSnapshotBundle(input([beta, alpha])));
		expect(forward).toBe(backward);
	});

	it("changes the hash when any part of the bundle changes", () => {
		const base = input([agent("alpha")]);
		const hash = canonicalHash(configSnapshotBundle(base));
		expect(canonicalHash(configSnapshotBundle({ ...base, constitution: "Different." }))).not.toBe(
			hash,
		);
		expect(
			canonicalHash(configSnapshotBundle({ ...base, rolePrompts: { alpha: "Different role." } })),
		).not.toBe(hash);
		expect(canonicalHash(configSnapshotBundle(input([agent("alpha"), agent("beta")])))).not.toBe(
			hash,
		);
	});
});

describe("configBundleProblems: shared role_file/constitution_file text", () => {
	// `config export` writes one file per distinct path, verbatim: two agents (or an agent and
	// the constitution) sharing a path must agree on its text, or an export would silently keep
	// only one of them.
	function withRoleFile(id: string, roleFile: string): AgentConfig {
		return { ...agent(id), prompts: { role_file: roleFile } };
	}

	it("two agents sharing a role_file with identical role prompt text is not a problem", () => {
		const alpha = withRoleFile("alpha", "prompts/shared.md");
		const beta = withRoleFile("beta", "prompts/shared.md");
		const bundle = input([alpha, beta]);
		const shared = "Shared role prompt.";
		const problems = configBundleProblems({
			...bundle,
			rolePrompts: { alpha: shared, beta: shared },
		});
		expect(problems.some((p) => p.includes("share role_file"))).toBe(false);
	});

	it("two agents sharing a role_file with different role prompt text is refused", () => {
		const alpha = withRoleFile("alpha", "prompts/shared.md");
		const beta = withRoleFile("beta", "prompts/shared.md");
		const bundle = input([alpha, beta]);
		const problems = configBundleProblems({
			...bundle,
			rolePrompts: { alpha: "Alpha's text.", beta: "Beta's text." },
		});
		expect(
			problems.some(
				(p) => p.includes("share role_file") && p.includes("alpha") && p.includes("beta"),
			),
		).toBe(true);
	});

	it("a role prompt for an agent the bundle does not configure is refused", () => {
		const alpha = agent("alpha");
		const bundle = input([alpha]);
		const problems = configBundleProblems({
			...bundle,
			rolePrompts: { ...bundle.rolePrompts, ghost: "A role prompt for an agent that is gone." },
		});
		expect(problems.some((p) => p.includes("rolePrompts") && p.includes("'ghost'"))).toBe(true);
	});

	it("enforces the same bound config import does (RolePromptSchema) on a role prompt and the constitution", () => {
		const alpha = agent("alpha");
		const bundle = input([alpha]);
		const tooLong = configBundleProblems({
			...bundle,
			rolePrompts: { alpha: "a".repeat(50_001) },
		});
		expect(tooLong.some((p) => p.includes("alpha") && p.includes("role prompt"))).toBe(true);

		const unsafe = configBundleProblems({
			...bundle,
			rolePrompts: { alpha: "Has a control character: \u0000." },
		});
		expect(unsafe.some((p) => p.includes("alpha") && p.includes("role prompt"))).toBe(true);

		const constitutionTooLong = configBundleProblems({
			...bundle,
			constitution: "a".repeat(50_001),
		});
		expect(constitutionTooLong.some((p) => p.includes("constitution"))).toBe(true);
	});

	it("an agent's role_file equal to the constitution file must hold the constitution's own text", () => {
		const constitutionPath = organization().organization.constitution_file;
		const mismatched = withRoleFile("alpha", constitutionPath);
		const bundle = input([mismatched]);
		const problems = configBundleProblems({
			...bundle,
			constitution: "The organization's constitution.",
			rolePrompts: { alpha: "A different text entirely." },
		});
		expect(problems.some((p) => p.includes("is also the constitution file"))).toBe(true);

		const matched = configBundleProblems({
			...bundle,
			constitution: "The same text.",
			rolePrompts: { alpha: "The same text." },
		});
		expect(matched.some((p) => p.includes("is also the constitution file"))).toBe(false);
	});
});
