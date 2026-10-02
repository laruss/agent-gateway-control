import type { ConsoleAgentDetail } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import { clearAppliedFields, rebaseDraft } from "./rebase-draft.ts";

function detail(overrides: Partial<ConsoleAgentDetail> = {}): ConsoleAgentDetail {
	return {
		id: "director",
		activeRevisionId: 7,
		displayName: "Director",
		enabled: true,
		mattermost: {
			username: "director",
			tokenSecretFile: "/run/secrets/mm_director_token",
			allowedChannels: ["hq"],
		},
		runtime: {
			adapter: "claude-code",
			profile: "default",
			session_policy: "resumable-if-available",
			timeout_seconds: 1800,
		},
		rolePrompt: "You are the director.",
		wakeRules: [{ event_type: "mattermost.agent.mentioned", target_agent_id: "director" }],
		permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: ["finance.*"] },
		memory: { privateNamespace: "agents/director", sharedNamespaces: [] },
		concurrency: { maxActiveRuns: 1, whileRunning: "enqueue-and-coalesce" },
		...overrides,
	};
}

describe("rebaseDraft", () => {
	it("keeps a dirty field whose own live value did not change upstream", () => {
		const previous = detail();
		const next = detail({ enabled: false }); // some other field changed upstream
		const { rebased, discardedFields } = rebaseDraft(previous, next, {
			rolePrompt: "A new role prompt the owner is still editing.",
		});
		expect(rebased).toEqual({ rolePrompt: "A new role prompt the owner is still editing." });
		expect(discardedFields).toEqual([]);
	});

	it("discards a dirty field whose own live value changed upstream, and names it", () => {
		const previous = detail();
		const next = detail({ rolePrompt: "Someone else's new role prompt." });
		const { rebased, discardedFields } = rebaseDraft(previous, next, {
			rolePrompt: "The owner's own, now-conflicting edit.",
			displayName: "New name", // unaffected, survives
		});
		expect(rebased).toEqual({ displayName: "New name" });
		expect(discardedFields).toEqual(["role prompt"]);
	});

	it("treats a reordered-but-identical array as unchanged (content, not just reference)", () => {
		const previous = detail({ mattermost: { ...detail().mattermost, allowedChannels: ["hq"] } });
		const next = detail({ mattermost: { ...detail().mattermost, allowedChannels: ["hq"] } });
		const { rebased, discardedFields } = rebaseDraft(previous, next, {
			allowedChannels: ["hq", "research"],
		});
		expect(rebased).toEqual({ allowedChannels: ["hq", "research"] });
		expect(discardedFields).toEqual([]);
	});

	it("discards every conflicting dirty field, not merely the first", () => {
		const previous = detail();
		const next = detail({ enabled: false, displayName: "Renamed upstream" });
		const { rebased, discardedFields } = rebaseDraft(previous, next, {
			enabled: false,
			displayName: "Renamed by the owner",
			rolePrompt: "Still fine.",
		});
		expect(rebased).toEqual({ rolePrompt: "Still fine." });
		expect([...discardedFields].sort()).toEqual(["display name", "enabled switch"].sort());
	});

	it("returns an empty draft and no discards when the draft itself was empty", () => {
		const previous = detail();
		const next = detail({ enabled: false });
		const { rebased, discardedFields } = rebaseDraft(previous, next, {});
		expect(rebased).toEqual({});
		expect(discardedFields).toEqual([]);
	});
});

describe("clearAppliedFields", () => {
	it("removes every field the applied patch touched", () => {
		const draft = { rolePrompt: "New prompt.", displayName: "New name" };
		expect(clearAppliedFields(draft, { rolePrompt: "New prompt." })).toEqual({
			displayName: "New name",
		});
	});

	it("leaves a field untouched that the applied patch never mentioned — e.g. edited after the reviewed snapshot was taken", () => {
		const draft = { rolePrompt: "New prompt.", displayName: "Edited after the snapshot" };
		expect(clearAppliedFields(draft, { rolePrompt: "New prompt." })).toEqual({
			displayName: "Edited after the snapshot",
		});
	});

	it("clears the whole draft when the applied patch is everything that was in it", () => {
		const draft = { rolePrompt: "New prompt.", displayName: "New name" };
		expect(clearAppliedFields(draft, draft)).toEqual({});
	});
});
