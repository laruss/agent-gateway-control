import {
	type AgentConfig,
	AgentConfigSchema,
	type ChangeOperation,
	type ChangeSet,
	type OrganizationConfig,
	OrganizationConfigSchema,
} from "@agent-gateway/contracts";
import { canonicalHash } from "@agent-gateway/events";
import { describe, expect, it } from "vitest";
import {
	applyChangeSet,
	type ConfigDraftBundle,
	configDiff,
	draftBundleProblems,
	structuralFieldPaths,
} from "./management.ts";

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
		mattermost: { username: id, token_secret_file: `/run/secrets/mm_${id}_token` },
		runtime: { adapter: "mock", session_policy: "stateless", timeout_seconds: 60 },
		prompts: { role_file: `prompts/${id}.md` },
		wake_rules: [],
		concurrency: { while_running: "enqueue" },
		permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: ["finance.*"] },
		memory: { private_namespace: `agents/${id}`, shared_namespaces: [] },
		...overrides,
	});
}

function bundleOf(agents: Readonly<AgentConfig[]>) {
	return {
		organization: organization(),
		agents: [...agents],
		constitution: "Be helpful.",
		rolePrompts: Object.fromEntries(agents.map((a) => [a.id, `Role prompt for ${a.id}.`])),
	};
}

const EMPTY: ConfigDraftBundle = {
	organization: null,
	agents: [],
	constitution: "",
	rolePrompts: {},
};

function apply(base: ConfigDraftBundle, ...ops: ChangeOperation[]) {
	return applyChangeSet(base, ops as ChangeSet);
}

describe("applyChangeSet", () => {
	it("replace_bundle sets the whole draft, discarding whatever base it had", () => {
		const base = bundleOf([agent("alpha")]);
		const replacement = bundleOf([agent("beta")]);
		const { draft, problems } = apply(base, { type: "replace_bundle", bundle: replacement });
		expect(problems).toEqual([]);
		expect(draft).toEqual(replacement);
	});

	it("set_constitution replaces only the constitution", () => {
		const base = bundleOf([agent("alpha")]);
		const { draft, problems } = apply(base, {
			type: "set_constitution",
			constitution: "Updated.",
		});
		expect(problems).toEqual([]);
		expect(draft.constitution).toBe("Updated.");
		expect(draft.agents).toBe(base.agents);
	});

	it("update_agent replaces an existing agent's definition in place", () => {
		const base = bundleOf([agent("alpha"), agent("beta")]);
		const updated = agent("alpha", { display_name: "Alpha II" });
		const { draft, problems } = apply(base, { type: "update_agent", agent: updated });
		expect(problems).toEqual([]);
		expect(draft.agents.map((a) => a.id)).toEqual(["alpha", "beta"]);
		expect(draft.agents.find((a) => a.id === "alpha")?.display_name).toBe("Alpha II");
		// Its role prompt is untouched by update_agent.
		expect(draft.rolePrompts.alpha).toBe(base.rolePrompts.alpha);
	});

	it("update_agent of an agent that does not exist is a problem, not a crash", () => {
		const base = bundleOf([agent("alpha")]);
		const { draft, problems } = apply(base, { type: "update_agent", agent: agent("ghost") });
		expect(draft).toEqual(base);
		expect(problems).toEqual(["update_agent: agent 'ghost' does not exist"]);
	});

	it("add_agent appends a new agent with its role prompt", () => {
		const base = bundleOf([agent("alpha")]);
		const { draft, problems } = apply(base, {
			type: "add_agent",
			agent: agent("beta"),
			rolePrompt: "Role prompt for beta.",
		});
		expect(problems).toEqual([]);
		expect(draft.agents.map((a) => a.id)).toEqual(["alpha", "beta"]);
		expect(draft.rolePrompts.beta).toBe("Role prompt for beta.");
	});

	it("add_agent of an id already configured is a problem", () => {
		const base = bundleOf([agent("alpha")]);
		const { draft, problems } = apply(base, {
			type: "add_agent",
			agent: agent("alpha"),
			rolePrompt: "Role prompt.",
		});
		expect(draft).toEqual(base);
		expect(problems).toEqual(["add_agent: agent 'alpha' already exists"]);
	});

	it("remove_agent takes the agent, and its role prompt, out of the bundle", () => {
		const base = bundleOf([agent("alpha"), agent("beta")]);
		const { draft, problems } = apply(base, { type: "remove_agent", agentId: "beta" });
		expect(problems).toEqual([]);
		expect(draft.agents.map((a) => a.id)).toEqual(["alpha"]);
		expect(draft.rolePrompts.beta).toBeUndefined();
	});

	it("remove_agent of an id not configured is a problem", () => {
		const base = bundleOf([agent("alpha")]);
		const { draft, problems } = apply(base, { type: "remove_agent", agentId: "ghost" });
		expect(draft).toEqual(base);
		expect(problems).toEqual(["remove_agent: agent 'ghost' does not exist"]);
	});

	it("set_role_prompt replaces only the named agent's role prompt", () => {
		const base = bundleOf([agent("alpha"), agent("beta")]);
		const { draft, problems } = apply(base, {
			type: "set_role_prompt",
			agentId: "alpha",
			rolePrompt: "New role prompt.",
		});
		expect(problems).toEqual([]);
		expect(draft.rolePrompts.alpha).toBe("New role prompt.");
		expect(draft.rolePrompts.beta).toBe(base.rolePrompts.beta);
		expect(draft.agents).toBe(base.agents);
	});

	it("set_role_prompt of an agent that does not exist is a problem", () => {
		const base = bundleOf([agent("alpha")]);
		const { draft, problems } = apply(base, {
			type: "set_role_prompt",
			agentId: "ghost",
			rolePrompt: "Text.",
		});
		expect(draft).toEqual(base);
		expect(problems).toEqual(["set_role_prompt: agent 'ghost' does not exist"]);
	});

	it("set_agent_enabled flips only the enabled flag", () => {
		const base = bundleOf([agent("alpha", { enabled: true })]);
		const { draft, problems } = apply(base, {
			type: "set_agent_enabled",
			agentId: "alpha",
			enabled: false,
		});
		expect(problems).toEqual([]);
		expect(draft.agents[0]).toMatchObject({ id: "alpha", enabled: false });
	});

	it("set_agent_enabled of an agent that does not exist is a problem", () => {
		const base = bundleOf([agent("alpha")]);
		const { draft, problems } = apply(base, {
			type: "set_agent_enabled",
			agentId: "ghost",
			enabled: false,
		});
		expect(draft).toEqual(base);
		expect(problems).toEqual(["set_agent_enabled: agent 'ghost' does not exist"]);
	});

	it("applies an ordered list of operations in order, collecting every problem", () => {
		const base = bundleOf([agent("alpha")]);
		const { draft, problems } = apply(
			base,
			{ type: "add_agent", agent: agent("beta"), rolePrompt: "Role prompt for beta." },
			{ type: "set_agent_enabled", agentId: "beta", enabled: false },
			{ type: "remove_agent", agentId: "ghost" },
		);
		expect(problems).toEqual(["remove_agent: agent 'ghost' does not exist"]);
		expect(draft.agents.map((a) => [a.id, a.enabled])).toEqual([
			["alpha", true],
			["beta", false],
		]);
	});

	it("starting from the empty bundle, only replace_bundle produces a usable draft", () => {
		const { draft, problems } = apply(EMPTY, {
			type: "set_constitution",
			constitution: "Be helpful.",
		});
		expect(problems).toEqual([]);
		expect(draftBundleProblems(draft)).toEqual([
			"organization: configuration is missing; the first change must replace_bundle",
		]);
	});
});

describe("draftBundleProblems", () => {
	it("is empty for a valid, fully configured draft", () => {
		expect(draftBundleProblems(bundleOf([agent("finance")]))).toEqual([]);
	});

	it("reports the same problems configBundleProblems would, for an invalid bundle", () => {
		const base = bundleOf([agent("finance")]);
		const missingPrompt: ConfigDraftBundle = { ...base, rolePrompts: {} };
		expect(draftBundleProblems(missingPrompt)).toEqual([
			"agent finance: role prompt is missing or empty",
		]);
	});
});

describe("structuralFieldPaths", () => {
	it("is empty for identical values", () => {
		expect(
			structuralFieldPaths({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } }, Number.POSITIVE_INFINITY),
		).toEqual([]);
	});

	it("reports only the top-level key at maxDepth 1, however deep the actual change is", () => {
		const before = { a: { b: { c: 1 } }, d: 1 };
		const after = { a: { b: { c: 2 } }, d: 1 };
		expect(structuralFieldPaths(before, after, 1)).toEqual(["a"]);
		expect(structuralFieldPaths(before, after, Number.POSITIVE_INFINITY)).toEqual(["a.b.c"]);
	});

	it("compares arrays as a whole, not element by element", () => {
		const before = { items: [1, 2, 3] };
		const after = { items: [1, 2, 4] };
		expect(structuralFieldPaths(before, after, Number.POSITIVE_INFINITY)).toEqual(["items"]);
	});

	it("visits keys in sorted order regardless of insertion order", () => {
		const before = { z: 1, a: 1 };
		const after = { z: 2, a: 2 };
		expect(structuralFieldPaths(before, after, Number.POSITIVE_INFINITY)).toEqual(["a", "z"]);
	});
});

describe("configDiff", () => {
	it("is deterministic: the same two bundles always produce the same diff", () => {
		const before = bundleOf([agent("alpha"), agent("beta")]);
		const after = bundleOf([agent("alpha", { display_name: "Alpha II" }), agent("gamma")]);
		const first = configDiff(before, after);
		const second = configDiff(before, after);
		expect(first).toEqual(second);
	});

	it("reports added, removed and changed agents, and omits an unchanged one", () => {
		const before = bundleOf([agent("alpha"), agent("beta")]);
		const after = bundleOf([agent("alpha", { display_name: "Alpha II" }), agent("gamma")]);
		const diff = configDiff(before, after);
		const alphaPromptSize = "Role prompt for alpha.".length;
		expect(diff.agents).toEqual([
			{
				kind: "changed",
				agentId: "alpha",
				fieldPaths: ["display_name"],
				rolePrompt: { changed: false, beforeSize: alphaPromptSize, afterSize: alphaPromptSize },
			},
			{ kind: "removed", agentId: "beta" },
			{ kind: "added", agentId: "gamma" },
		]);
	});

	it("reports a role prompt change alongside its sizes, even with no field change", () => {
		const before = bundleOf([agent("alpha")]);
		const after: ConfigDraftBundle = {
			...before,
			rolePrompts: { alpha: "A longer role prompt for alpha." },
		};
		const diff = configDiff(before, after);
		expect(diff.agents).toEqual([
			{
				kind: "changed",
				agentId: "alpha",
				fieldPaths: [],
				rolePrompt: {
					changed: true,
					beforeSize: "Role prompt for alpha.".length,
					afterSize: "A longer role prompt for alpha.".length,
				},
			},
		]);
	});

	it("diffs the organization down to its field paths, not just its top-level keys", () => {
		const before = bundleOf([]);
		const after: ConfigDraftBundle = {
			...before,
			organization: {
				...(before.organization as OrganizationConfig),
				mattermost: {
					...(before.organization as OrganizationConfig).mattermost,
					channels: ["hq", "general"],
				},
			},
		};
		expect(configDiff(before, after).organizationFieldPaths).toEqual(["mattermost.channels"]);
	});

	it("reports the constitution's change and sizes", () => {
		const before = bundleOf([]);
		const after: ConfigDraftBundle = { ...before, constitution: "Be helpful and concise." };
		expect(configDiff(before, after).constitution).toEqual({
			changed: true,
			beforeSize: "Be helpful.".length,
			afterSize: "Be helpful and concise.".length,
		});
	});

	it("reports every field of a brand new organization when there was no base at all", () => {
		const after = bundleOf([]);
		const diff = configDiff(EMPTY, after);
		expect(diff.organizationFieldPaths.length).toBeGreaterThan(0);
		expect(diff.constitution).toEqual({
			changed: true,
			beforeSize: 0,
			afterSize: "Be helpful.".length,
		});
	});
});

describe("change set hash stability", () => {
	function changeSet(): ChangeSet {
		return [
			{ type: "set_agent_enabled", agentId: "alpha", enabled: false },
			{ type: "set_role_prompt", agentId: "beta", rolePrompt: "Text." },
		];
	}

	it("hashes identically for the same change set built twice, independently", () => {
		expect(canonicalHash(changeSet())).toBe(canonicalHash(changeSet()));
	});

	it("changes the hash when the change set's content changes", () => {
		const changed: ChangeSet = [
			{ type: "set_agent_enabled", agentId: "alpha", enabled: true },
			{ type: "set_role_prompt", agentId: "beta", rolePrompt: "Text." },
		];
		expect(canonicalHash(changed)).not.toBe(canonicalHash(changeSet()));
	});

	it("changes the hash when operations are reordered", () => {
		const reordered: ChangeSet = [...changeSet()].reverse() as ChangeSet;
		expect(canonicalHash(reordered)).not.toBe(canonicalHash(changeSet()));
	});
});
