import { describe, expect, it } from "vitest";
import {
	AgentPatchSchema,
	AgentRuntimePatchSchema,
	ConsoleAgentDetailSchema,
} from "./console-management.ts";

// ---------------------------------------------------------------------------
// Shape-only tests for the console's own request/response schemas (ADR-025): both findings below
// are shape bugs (a response the server legitimately sends fails to parse, or a legitimate request
// shape is rejected before it ever reaches the server), not behavior that needs a database to
// reproduce.
// ---------------------------------------------------------------------------

function detail(rolePrompt: string) {
	return {
		id: "director",
		activeRevisionId: 1,
		displayName: "Director",
		enabled: true,
		mattermost: {
			username: "director",
			tokenSecretFile: "/run/secrets/mm_director_token",
			allowedChannels: [],
		},
		runtime: {
			adapter: "mock",
			profile: "default",
			session_policy: "stateless",
			timeout_seconds: 60,
		},
		rolePrompt,
		wakeRules: [],
		permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: [] },
		memory: { privateNamespace: "agents/director", sharedNamespaces: [] },
		concurrency: { maxActiveRuns: 1, whileRunning: "enqueue" },
	};
}

describe("ConsoleAgentDetailSchema", () => {
	it("accepts an empty role prompt (an agent that has never had one set)", () => {
		expect(ConsoleAgentDetailSchema.safeParse(detail("")).success).toBe(true);
	});

	it("still accepts a non-empty one", () => {
		expect(ConsoleAgentDetailSchema.safeParse(detail("Be helpful.")).success).toBe(true);
	});
});

describe("AgentRuntimePatchSchema", () => {
	it("accepts model: null as the patch's own 'remove the override' value", () => {
		const parsed = AgentRuntimePatchSchema.safeParse({ model: null });
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.model).toBeNull();
		}
	});

	it("still accepts a non-empty model string", () => {
		const parsed = AgentRuntimePatchSchema.safeParse({ model: "gpt-5" });
		expect(parsed.success).toBe(true);
	});
});

describe("AgentPatchSchema", () => {
	it("accepts a runtime patch of only model: null as a complete, non-empty patch", () => {
		const parsed = AgentPatchSchema.safeParse({ runtime: { model: null } });
		expect(parsed.success).toBe(true);
	});
});
