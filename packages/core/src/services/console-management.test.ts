import { type AgentConfig, AgentConfigSchema, type AgentPatch } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import { agentPatchImpact, planAgentPatch } from "./console-management.ts";

// ---------------------------------------------------------------------------
// The Agents hub's pure change-set translation and impact analysis (ADR-025): `planAgentPatch`
// and `agentPatchImpact` need no database, unlike `previewAgentPatch`/`commitAgentPatch`
// themselves (covered against a real PostgreSQL in
// `apps/controller/src/console-management.integration.test.ts`).
// ---------------------------------------------------------------------------

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return AgentConfigSchema.parse({
		schema_version: 1,
		id: "director",
		display_name: "Director",
		enabled: true,
		mattermost: { username: "director", token_secret_file: "/run/secrets/mm_director_token" },
		runtime: { adapter: "mock", session_policy: "stateless", timeout_seconds: 60 },
		prompts: { role_file: "prompts/director.md" },
		wake_rules: [],
		concurrency: { while_running: "enqueue" },
		permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: ["finance.*"] },
		memory: { private_namespace: "agents/director", shared_namespaces: [] },
		...overrides,
	});
}

describe("agentPatchImpact", () => {
	it("is empty when nothing changed", () => {
		const before = agent();
		expect(agentPatchImpact(before, before)).toEqual([]);
	});

	it("flags disabling and enabling the agent", () => {
		const before = agent({ enabled: true });
		const after = agent({ enabled: false });
		expect(agentPatchImpact(before, after)).toEqual(["disables the agent"]);
		expect(agentPatchImpact(after, before)).toEqual(["enables the agent"]);
	});

	it("flags a removed channel as a reduction and an added one as an increase", () => {
		const before = agent({
			mattermost: {
				username: "director",
				token_secret_file: "/run/secrets/mm_director_token",
				allowed_channels: ["hq"],
			},
		});
		const after = agent({
			mattermost: {
				username: "director",
				token_secret_file: "/run/secrets/mm_director_token",
				allowed_channels: ["research"],
			},
		});
		expect(agentPatchImpact(before, after)).toEqual(
			expect.arrayContaining(["removes channel 'hq'", "adds channel 'research'"]),
		);
	});

	it("flags a granted tool, a removed deny rule and a removed human-approval requirement as increases", () => {
		const before = agent({
			permissions: {
				tools_allow: [],
				tools_require_human_approval: ["finance.payment.create"],
				tools_deny: ["deploy.*"],
			},
		});
		const after = agent({
			permissions: {
				tools_allow: ["mattermost.post"],
				tools_require_human_approval: [],
				tools_deny: [],
			},
		});
		const impact = agentPatchImpact(before, after);
		expect(impact).toEqual(
			expect.arrayContaining([
				"grants tool 'mattermost.post'",
				"removes the deny rule for 'deploy.*'",
				"removes the human-approval requirement for 'finance.payment.create'",
			]),
		);
	});

	it("flags adding a tool pattern to tools_require_human_approval as an authority increase, when it was not already allowed", () => {
		const before = agent({
			permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: [] },
		});
		const after = agent({
			permissions: {
				tools_allow: [],
				tools_require_human_approval: ["deploy.rollback"],
				tools_deny: [],
			},
		});
		expect(agentPatchImpact(before, after)).toEqual([
			"allows 'deploy.rollback' with human approval",
		]);
	});

	it("flags moving an already-allowed tool pattern to tools_require_human_approval as a behavior change, not a plain increase", () => {
		// `AgentConfigSchema` forbids a pattern in both lists at once, so the realistic patch this
		// covers moves the pattern across — out of tools_allow, into tools_require_human_approval —
		// in the same commit, rather than merely adding it to the second list.
		const before = agent({
			permissions: {
				tools_allow: ["deploy.rollback"],
				tools_require_human_approval: [],
				tools_deny: [],
			},
		});
		const after = agent({
			permissions: {
				tools_allow: [],
				tools_require_human_approval: ["deploy.rollback"],
				tools_deny: [],
			},
		});
		expect(agentPatchImpact(before, after)).toEqual([
			"removes tool grant 'deploy.rollback'",
			"now requires human approval for 'deploy.rollback'",
		]);
	});

	describe("every permissions list, added and removed", () => {
		it("tools_allow: add", () => {
			const before = agent({
				permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: [] },
			});
			const after = agent({
				permissions: {
					tools_allow: ["mattermost.post"],
					tools_require_human_approval: [],
					tools_deny: [],
				},
			});
			expect(agentPatchImpact(before, after)).toEqual(["grants tool 'mattermost.post'"]);
		});

		it("tools_allow: remove", () => {
			const before = agent({
				permissions: {
					tools_allow: ["mattermost.post"],
					tools_require_human_approval: [],
					tools_deny: [],
				},
			});
			const after = agent({
				permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: [] },
			});
			expect(agentPatchImpact(before, after)).toEqual(["removes tool grant 'mattermost.post'"]);
		});

		it("tools_deny: add is not flagged (narrowing access needs no owner confirmation)", () => {
			const before = agent({
				permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: [] },
			});
			const after = agent({
				permissions: {
					tools_allow: [],
					tools_require_human_approval: [],
					tools_deny: ["deploy.*"],
				},
			});
			expect(agentPatchImpact(before, after)).toEqual([]);
		});

		it("tools_deny: remove", () => {
			const before = agent({
				permissions: {
					tools_allow: [],
					tools_require_human_approval: [],
					tools_deny: ["deploy.*"],
				},
			});
			const after = agent({
				permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: [] },
			});
			expect(agentPatchImpact(before, after)).toEqual(["removes the deny rule for 'deploy.*'"]);
		});

		it("tools_require_human_approval: add, not previously allowed — an increase", () => {
			const before = agent({
				permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: [] },
			});
			const after = agent({
				permissions: {
					tools_allow: [],
					tools_require_human_approval: ["finance.payment.create"],
					tools_deny: [],
				},
			});
			expect(agentPatchImpact(before, after)).toEqual([
				"allows 'finance.payment.create' with human approval",
			]);
		});

		it("tools_require_human_approval: add (moved from tools_allow) — a reduction, still flagged", () => {
			const before = agent({
				permissions: {
					tools_allow: ["finance.payment.create"],
					tools_require_human_approval: [],
					tools_deny: [],
				},
			});
			const after = agent({
				permissions: {
					tools_allow: [],
					tools_require_human_approval: ["finance.payment.create"],
					tools_deny: [],
				},
			});
			expect(agentPatchImpact(before, after)).toEqual([
				"removes tool grant 'finance.payment.create'",
				"now requires human approval for 'finance.payment.create'",
			]);
		});

		it("tools_require_human_approval: remove", () => {
			const before = agent({
				permissions: {
					tools_allow: [],
					tools_require_human_approval: ["finance.payment.create"],
					tools_deny: [],
				},
			});
			const after = agent({
				permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: [] },
			});
			expect(agentPatchImpact(before, after)).toEqual([
				"removes the human-approval requirement for 'finance.payment.create'",
			]);
		});
	});

	it("flags observe_system granted and removed symmetrically", () => {
		const before = agent({
			permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: [] },
		});
		const after = agent({
			permissions: {
				tools_allow: [],
				tools_require_human_approval: [],
				tools_deny: [],
				observe_system: true,
			},
		});
		expect(agentPatchImpact(before, after)).toEqual(["grants observe_system"]);
		expect(agentPatchImpact(after, before)).toEqual(["removes observe_system"]);
	});
});

describe("planAgentPatch", () => {
	it("removes the runtime model override when the patch sets it to null, never merely omitting it", () => {
		const before = agent({
			runtime: {
				adapter: "mock",
				profile: "default",
				model: "gpt-5",
				session_policy: "stateless",
				timeout_seconds: 60,
			},
		});
		const patch: AgentPatch = { runtime: { model: null } };
		const plan = planAgentPatch(before, patch);
		expect(plan.after.runtime.model).toBeUndefined();
		expect("model" in plan.after.runtime).toBe(false);
	});

	it("leaves the runtime model untouched when the patch does not mention it", () => {
		const before = agent({
			runtime: {
				adapter: "mock",
				profile: "default",
				model: "gpt-5",
				session_policy: "stateless",
				timeout_seconds: 60,
			},
		});
		const patch: AgentPatch = { runtime: { timeout_seconds: 120 } };
		const plan = planAgentPatch(before, patch);
		expect(plan.after.runtime.model).toBe("gpt-5");
		expect(plan.after.runtime.timeout_seconds).toBe(120);
	});

	it("sets the runtime model when the patch gives it a value", () => {
		const before = agent({
			runtime: {
				adapter: "mock",
				profile: "default",
				session_policy: "stateless",
				timeout_seconds: 60,
			},
		});
		const patch: AgentPatch = { runtime: { model: "gpt-5" } };
		const plan = planAgentPatch(before, patch);
		expect(plan.after.runtime.model).toBe("gpt-5");
	});
});
