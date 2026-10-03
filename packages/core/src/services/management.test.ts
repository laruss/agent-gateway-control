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
		toolAttachments: {},
	};
}

const EMPTY: ConfigDraftBundle = {
	organization: null,
	agents: [],
	constitution: "",
	rolePrompts: {},
	toolAttachments: {},
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

	it("attach_tool adds a new attachment for an agent", () => {
		const base = bundleOf([agent("alpha")]);
		const { draft, problems } = apply(base, {
			type: "attach_tool",
			agentId: "alpha",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
		});
		expect(problems).toEqual([]);
		expect(draft.toolAttachments.alpha).toEqual([
			{ entryId: "gateway-mattermost-post", pinnedVersion: null, mode: "allow", settings: {} },
		]);
	});

	it("attach_tool replaces an existing attachment of the same entry, rather than duplicating it", () => {
		const base = bundleOf([agent("alpha")]);
		const { draft } = apply(
			base,
			{
				type: "attach_tool",
				agentId: "alpha",
				entryId: "gateway-mattermost-post",
				pinnedVersion: null,
				mode: "require_approval",
				settings: {},
			},
			{
				type: "attach_tool",
				agentId: "alpha",
				entryId: "gateway-mattermost-post",
				pinnedVersion: 2,
				mode: "allow",
				settings: { note: "updated" },
			},
		);
		expect(draft.toolAttachments.alpha).toEqual([
			{
				entryId: "gateway-mattermost-post",
				pinnedVersion: 2,
				mode: "allow",
				settings: { note: "updated" },
			},
		]);
	});

	it("attach_tool for an agent that does not exist is a problem", () => {
		const base = bundleOf([agent("alpha")]);
		const { draft, problems } = apply(base, {
			type: "attach_tool",
			agentId: "ghost",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
		});
		expect(draft).toEqual(base);
		expect(problems).toEqual(["attach_tool: agent 'ghost' does not exist"]);
	});

	it("detach_tool removes just the named entry's attachment", () => {
		const base = bundleOf([agent("alpha")]);
		const attached = apply(base, {
			type: "attach_tool",
			agentId: "alpha",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
		}).draft;
		const { draft, problems } = apply(attached, {
			type: "detach_tool",
			agentId: "alpha",
			entryId: "gateway-mattermost-post",
		});
		expect(problems).toEqual([]);
		expect(draft.toolAttachments.alpha).toEqual([]);
	});

	it("detach_tool of something never attached is an idempotent no-op", () => {
		const base = bundleOf([agent("alpha")]);
		const { draft, problems } = apply(base, {
			type: "detach_tool",
			agentId: "alpha",
			entryId: "gateway-mattermost-post",
		});
		expect(problems).toEqual([]);
		expect(draft).toEqual(base);
	});

	it("update_attachment patches only the fields given, leaving the rest", () => {
		const base = bundleOf([agent("alpha")]);
		const attached = apply(base, {
			type: "attach_tool",
			agentId: "alpha",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "allow",
			settings: { a: 1 },
		}).draft;
		const { draft, problems } = apply(attached, {
			type: "update_attachment",
			agentId: "alpha",
			entryId: "gateway-mattermost-post",
			mode: "require_approval",
		});
		expect(problems).toEqual([]);
		expect(draft.toolAttachments.alpha).toEqual([
			{
				entryId: "gateway-mattermost-post",
				pinnedVersion: null,
				mode: "require_approval",
				settings: { a: 1 },
			},
		]);
	});

	it("update_attachment of an entry never attached is a problem", () => {
		const base = bundleOf([agent("alpha")]);
		const { draft, problems } = apply(base, {
			type: "update_attachment",
			agentId: "alpha",
			entryId: "gateway-mattermost-post",
			mode: "allow",
		});
		expect(draft).toEqual(base);
		expect(problems).toEqual([
			"update_attachment: agent 'alpha' has no attachment of 'gateway-mattermost-post'",
		]);
	});

	it("clear_tool_attachments removes one entry's attachment from every agent that has it", () => {
		const base = bundleOf([agent("alpha"), agent("beta")]);
		const attached = apply(
			base,
			{
				type: "attach_tool",
				agentId: "alpha",
				entryId: "gateway-mattermost-post",
				pinnedVersion: null,
				mode: "allow",
				settings: {},
			},
			{
				type: "attach_tool",
				agentId: "alpha",
				entryId: "gateway-memory-write",
				pinnedVersion: null,
				mode: "allow",
				settings: {},
			},
			{
				type: "attach_tool",
				agentId: "beta",
				entryId: "gateway-mattermost-post",
				pinnedVersion: null,
				mode: "allow",
				settings: {},
			},
		).draft;
		const { draft, problems } = apply(attached, {
			type: "clear_tool_attachments",
			entryId: "gateway-mattermost-post",
		});
		expect(problems).toEqual([]);
		expect(draft.toolAttachments.alpha).toEqual([
			{ entryId: "gateway-memory-write", pinnedVersion: null, mode: "allow", settings: {} },
		]);
		expect(draft.toolAttachments.beta).toEqual([]);
	});

	it("set_tool_attachments marks an existing agent hub-managed, even with an explicitly empty list", () => {
		const base = bundleOf([agent("alpha")]);
		const { draft, problems } = apply(base, {
			type: "set_tool_attachments",
			agentId: "alpha",
			attachments: [],
		});
		expect(problems).toEqual([]);
		expect(draft.toolAttachments.alpha).toEqual([]);
	});

	it("set_tool_attachments replaces the whole list in one operation", () => {
		const attached = apply(bundleOf([agent("alpha")]), {
			type: "attach_tool",
			agentId: "alpha",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
		}).draft;
		const { draft, problems } = apply(attached, {
			type: "set_tool_attachments",
			agentId: "alpha",
			attachments: [
				{ entryId: "gateway-memory-write", pinnedVersion: null, mode: "allow", settings: {} },
			],
		});
		expect(problems).toEqual([]);
		expect(draft.toolAttachments.alpha).toEqual([
			{ entryId: "gateway-memory-write", pinnedVersion: null, mode: "allow", settings: {} },
		]);
	});

	it("set_tool_attachments for an agent that does not exist is a problem", () => {
		const base = bundleOf([agent("alpha")]);
		const { draft, problems } = apply(base, {
			type: "set_tool_attachments",
			agentId: "ghost",
			attachments: [],
		});
		expect(draft).toEqual(base);
		expect(problems).toEqual(["set_tool_attachments: agent 'ghost' does not exist"]);
	});

	it("remove_agent also drops the removed agent's own attachments", () => {
		const base = bundleOf([agent("alpha")]);
		const attached = apply(base, {
			type: "attach_tool",
			agentId: "alpha",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
		}).draft;
		const { draft } = apply(attached, { type: "remove_agent", agentId: "alpha" });
		expect(draft.toolAttachments.alpha).toBeUndefined();
	});

	it("replace_bundle with no attachments document carries every existing attachment forward, filtered to the new agents (ADR-027)", () => {
		const attached = apply(bundleOf([agent("alpha"), agent("beta")]), {
			type: "attach_tool",
			agentId: "alpha",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
		}).draft;
		const replacement = bundleOf([agent("alpha"), agent("gamma")]);
		const { draft, problems } = apply(attached, { type: "replace_bundle", bundle: replacement });
		expect(problems).toEqual([]);
		// Carried forward: alpha keeps its attachment even though nothing in `replacement` ever
		// mentioned one.
		expect(draft.toolAttachments.alpha).toEqual([
			{ entryId: "gateway-mattermost-post", pinnedVersion: null, mode: "allow", settings: {} },
		]);
		// `beta` left the configuration: its own attachments (it had none here, but the principle is
		// the same) never survive a replace that drops it.
		expect(draft.toolAttachments.beta).toBeUndefined();
	});

	it("replace_bundle with an explicit attachments document (even {}) replaces the whole document", () => {
		const attached = apply(bundleOf([agent("alpha")]), {
			type: "attach_tool",
			agentId: "alpha",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
		}).draft;
		const replacement = bundleOf([agent("alpha")]);
		const { draft, problems } = apply(attached, {
			type: "replace_bundle",
			bundle: replacement,
			toolAttachments: {},
		});
		expect(problems).toEqual([]);
		expect(draft.toolAttachments).toEqual({});
	});

	it("add_agent with no attachments document starts the agent legacy (no key of its own)", () => {
		const { draft, problems } = apply(bundleOf([agent("alpha")]), {
			type: "add_agent",
			agent: agent("beta"),
			rolePrompt: "Role prompt for beta.",
		});
		expect(problems).toEqual([]);
		expect(Object.hasOwn(draft.toolAttachments, "beta")).toBe(false);
	});

	it("add_agent with an explicit, even empty, attachments list starts the agent hub-managed (restore's own carry-forward)", () => {
		const { draft, problems } = apply(bundleOf([agent("alpha")]), {
			type: "add_agent",
			agent: agent("beta"),
			rolePrompt: "Role prompt for beta.",
			toolAttachments: [],
		});
		expect(problems).toEqual([]);
		expect(draft.toolAttachments.beta).toEqual([]);
	});

	it("canonicalizes every agent's attachments by entryId, regardless of the order they were attached in", () => {
		const { draft } = apply(
			bundleOf([agent("alpha")]),
			{
				type: "attach_tool",
				agentId: "alpha",
				entryId: "native-web-search",
				pinnedVersion: null,
				mode: "allow",
				settings: {},
			},
			{
				type: "attach_tool",
				agentId: "alpha",
				entryId: "gateway-mattermost-post",
				pinnedVersion: null,
				mode: "allow",
				settings: {},
			},
		);
		expect(draft.toolAttachments.alpha?.map((a) => a.entryId)).toEqual([
			"gateway-mattermost-post",
			"native-web-search",
		]);
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

	it("reports a toolAttachments entry naming an agent not in the bundle", () => {
		const base = bundleOf([agent("finance")]);
		const orphaned: ConfigDraftBundle = {
			...base,
			toolAttachments: {
				ghost: [
					{ entryId: "gateway-mattermost-post", pinnedVersion: null, mode: "allow", settings: {} },
				],
			},
		};
		expect(draftBundleProblems(orphaned)).toEqual([
			"toolAttachments: 'ghost' has attachments but is not a configured agent",
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

	it("reports every attachment added, removed or changed, per agent per entry (ADR-027)", () => {
		const before: ConfigDraftBundle = {
			...bundleOf([agent("alpha")]),
			toolAttachments: {
				alpha: [
					{
						entryId: "gateway-mattermost-post",
						pinnedVersion: null,
						mode: "allow",
						settings: {},
					},
					{ entryId: "native-web-search", pinnedVersion: null, mode: "allow", settings: {} },
				],
			},
		};
		const after: ConfigDraftBundle = {
			...before,
			toolAttachments: {
				alpha: [
					// Unchanged: left out of the diff entirely.
					{
						entryId: "gateway-mattermost-post",
						pinnedVersion: null,
						mode: "allow",
						settings: {},
					},
					// native-web-search removed; native-web-fetch added; gateway-memory-write is new too,
					// with a mode change relative to nothing (so "added", not "changed").
					{
						entryId: "native-web-fetch",
						pinnedVersion: null,
						mode: "require_approval",
						settings: {},
					},
				],
			},
		};
		expect(configDiff(before, after).toolAttachments).toEqual([
			{ kind: "added", agentId: "alpha", entryId: "native-web-fetch" },
			{ kind: "removed", agentId: "alpha", entryId: "native-web-search" },
		]);
	});

	it("reports a changed attachment's own fields (mode, pinnedVersion, settings) by name", () => {
		const before: ConfigDraftBundle = {
			...bundleOf([agent("alpha")]),
			toolAttachments: {
				alpha: [
					{
						entryId: "gateway-mattermost-post",
						pinnedVersion: null,
						mode: "allow",
						settings: { a: 1 },
					},
				],
			},
		};
		const after: ConfigDraftBundle = {
			...before,
			toolAttachments: {
				alpha: [
					{
						entryId: "gateway-mattermost-post",
						pinnedVersion: 2,
						mode: "require_approval",
						settings: { a: 2 },
					},
				],
			},
		};
		expect(configDiff(before, after).toolAttachments).toEqual([
			{
				kind: "changed",
				agentId: "alpha",
				entryId: "gateway-mattermost-post",
				fields: ["mode", "pinnedVersion", "settings"],
			},
		]);
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
