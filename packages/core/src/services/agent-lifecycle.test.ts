import type { AgentConfig } from "@agent-gateway/contracts";
import { AgentConfigSchema, RequestAgentCreateInputSchema } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import { resolveCreateRuntime } from "./agent-lifecycle.ts";

function codexAgent(id: string, model?: string): AgentConfig {
	return AgentConfigSchema.parse({
		schema_version: 1,
		id,
		display_name: id,
		enabled: true,
		mattermost: { username: id, token_secret_file: `/run/secrets/mm_${id}_token` },
		runtime: {
			adapter: "codex",
			session_policy: "resumable-if-available",
			timeout_seconds: 1800,
			...(model === undefined ? {} : { model }),
		},
		prompts: { role_file: `prompts/${id}.md` },
		wake_rules: [],
		concurrency: { while_running: "enqueue" },
		permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: [] },
		memory: { private_namespace: `agents/${id}`, shared_namespaces: [] },
	});
}

function mockAgent(id: string): AgentConfig {
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

describe("resolveCreateRuntime (ADR-026)", () => {
	it("defaults to codex with no model when nothing is given and no codex agent exists", () => {
		expect(resolveCreateRuntime([], undefined)).toEqual({
			adapter: "codex",
			profile: "default",
			session_policy: "resumable-if-available",
			timeout_seconds: 1800,
		});
	});

	it("picks up the one model every existing codex agent agrees on", () => {
		const existing = [codexAgent("aa", "gpt-5-codex"), codexAgent("bb", "gpt-5-codex")];
		expect(resolveCreateRuntime(existing, undefined)).toMatchObject({
			adapter: "codex",
			model: "gpt-5-codex",
		});
	});

	it("leaves the model unset when existing codex agents disagree", () => {
		const existing = [codexAgent("aa", "gpt-5-codex"), codexAgent("bb", "gpt-5-codex-mini")];
		const runtime = resolveCreateRuntime(existing, undefined);
		expect(runtime.adapter).toBe("codex");
		expect(runtime.model).toBeUndefined();
	});

	it("leaves the model unset when no existing codex agent has one set", () => {
		const existing = [codexAgent("aa"), codexAgent("bb")];
		expect(resolveCreateRuntime(existing, undefined).model).toBeUndefined();
	});

	it("never consults existing codex agents' models for an explicitly different adapter", () => {
		const existing = [codexAgent("aa", "gpt-5-codex")];
		const runtime = resolveCreateRuntime(existing, { adapter: "mock" });
		expect(runtime).toEqual({
			adapter: "mock",
			profile: "default",
			session_policy: "resumable-if-available",
			timeout_seconds: 1800,
		});
	});

	it("keeps an explicit model even when existing codex agents disagree", () => {
		const existing = [codexAgent("aa", "gpt-5-codex"), codexAgent("bb", "gpt-5-codex-mini")];
		expect(resolveCreateRuntime(existing, { model: "gpt-5.5-codex" }).model).toBe("gpt-5.5-codex");
	});

	it("fills in only what is missing, keeping every explicit field", () => {
		const runtime = resolveCreateRuntime([mockAgent("aa")], {
			adapter: "claude-code",
			profile: "fast",
			timeout_seconds: 42,
		});
		expect(runtime).toEqual({
			adapter: "claude-code",
			profile: "fast",
			session_policy: "resumable-if-available",
			timeout_seconds: 42,
		});
	});
});

describe("AgentCreateInput validation (ADR-026)", () => {
	function createInput(overrides: Record<string, unknown> = {}) {
		return {
			agent: {
				id: "newagent",
				display_name: "New Agent",
				mattermost: { username: "newagent", token_secret_file: "/run/secrets/mm_newagent_token" },
				prompts: { role_file: "prompts/newagent.md" },
				wake_rules: [],
				concurrency: { while_running: "enqueue" },
				permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: [] },
				memory: { private_namespace: "agents/newagent", shared_namespaces: [] },
				...overrides,
			},
			rolePrompt: "You are a new agent.",
			actor: "owner",
			source: "cli",
		};
	}

	it("accepts a request with no runtime at all", () => {
		const parsed = RequestAgentCreateInputSchema.safeParse(createInput());
		expect(parsed.success).toBe(true);
	});

	it("accepts a runtime with only some fields set", () => {
		const parsed = RequestAgentCreateInputSchema.safeParse(
			createInput({ runtime: { adapter: "codex" } }),
		);
		expect(parsed.success).toBe(true);
	});

	it("refuses an id that is not a valid agent id", () => {
		const parsed = RequestAgentCreateInputSchema.safeParse(createInput({ id: "Not Valid!" }));
		expect(parsed.success).toBe(false);
	});

	it("refuses a username with characters Mattermost does not allow", () => {
		const parsed = RequestAgentCreateInputSchema.safeParse(
			createInput({ mattermost: { username: "Not Valid!", token_secret_file: "/run/secrets/x" } }),
		);
		expect(parsed.success).toBe(false);
	});

	it("refuses enabled or schema_version on the create input (set by the service, not the caller)", () => {
		expect(RequestAgentCreateInputSchema.safeParse(createInput({ enabled: true })).success).toBe(
			false,
		);
		expect(
			RequestAgentCreateInputSchema.safeParse(createInput({ schema_version: 1 })).success,
		).toBe(false);
	});
});
