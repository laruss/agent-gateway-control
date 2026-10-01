import { describe, expect, it } from "vitest";
import {
	ChangeOperationSchema,
	ChangeSetSchema,
	CONFIG_REVISION_SOURCES,
	ConfigDiffSchema,
	ConfigRevisionSchema,
	ConfigSnapshotBundleSchema,
	IdempotencyKeySchema,
	MAX_CHANGE_SET_OPERATIONS,
	RolePromptSchema,
} from "./management.ts";
import { agent, issuePaths, organization } from "./test-fixtures.ts";

function bundle() {
	const agents = [agent("alpha"), agent("beta")];
	return {
		organization: organization(),
		agents,
		constitution: "Be helpful.",
		rolePrompts: Object.fromEntries(agents.map((a) => [a.id, `Role prompt for ${a.id}.`])),
	};
}

describe("ConfigSnapshotBundleSchema", () => {
	it("accepts a complete configuration bundle", () => {
		expect(issuePaths(ConfigSnapshotBundleSchema, bundle())).toEqual([]);
	});

	it("rejects unknown fields at the top level", () => {
		expect(issuePaths(ConfigSnapshotBundleSchema, { ...bundle(), extra: true })).toEqual([""]);
	});

	it("rejects an empty constitution", () => {
		expect(issuePaths(ConfigSnapshotBundleSchema, { ...bundle(), constitution: "" })).toEqual([
			"constitution",
		]);
	});

	it("rejects a role prompt that is blank", () => {
		const value = bundle();
		expect(
			issuePaths(ConfigSnapshotBundleSchema, {
				...value,
				rolePrompts: { ...value.rolePrompts, alpha: "" },
			}),
		).toEqual(["rolePrompts.alpha"]);
	});
});

describe("ConfigRevisionSchema", () => {
	const revision = {
		id: 1,
		snapshotHash: "a".repeat(64),
		parentRevisionId: null,
		generation: 1,
		actor: "cli:owner",
		source: "cli_apply",
		reason: null,
		idempotencyKey: null,
		changeHash: null,
		createdAt: "2026-09-30T12:00:00.000Z",
	};

	it("accepts a revision with no parent and no reason", () => {
		expect(issuePaths(ConfigRevisionSchema, revision)).toEqual([]);
	});

	it("accepts every known revision source", () => {
		for (const source of CONFIG_REVISION_SOURCES) {
			expect(issuePaths(ConfigRevisionSchema, { ...revision, source })).toEqual([]);
		}
	});

	it("rejects an unknown revision source", () => {
		expect(issuePaths(ConfigRevisionSchema, { ...revision, source: "console_v2" })).toEqual([
			"source",
		]);
	});
});

describe("RolePromptSchema", () => {
	it("accepts non-blank text within the bound", () => {
		expect(issuePaths(RolePromptSchema, "Follow the plan.")).toEqual([]);
	});

	it("rejects blank text", () => {
		expect(issuePaths(RolePromptSchema, "   ")).toEqual([""]);
	});

	it("rejects text over the bound", () => {
		expect(issuePaths(RolePromptSchema, "a".repeat(50_001))).toEqual([""]);
	});
});

describe("IdempotencyKeySchema", () => {
	it("accepts a short opaque token", () => {
		expect(issuePaths(IdempotencyKeySchema, "retry-2026-09-30-01")).toEqual([]);
	});

	it("rejects an empty key", () => {
		expect(issuePaths(IdempotencyKeySchema, "")).not.toEqual([]);
	});
});

describe("ChangeOperationSchema", () => {
	it("accepts one of each known operation type", () => {
		const bundle = {
			organization: organization(),
			agents: [agent("alpha")],
			constitution: "Be helpful.",
			rolePrompts: { alpha: "Role prompt." },
		};
		const operations: unknown[] = [
			{ type: "replace_bundle", bundle },
			{ type: "update_agent", agent: agent("alpha") },
			{ type: "set_role_prompt", agentId: "alpha", rolePrompt: "Role prompt." },
			{ type: "set_agent_enabled", agentId: "alpha", enabled: false },
			{ type: "add_agent", agent: agent("beta"), rolePrompt: "Role prompt." },
			{ type: "remove_agent", agentId: "alpha" },
			{ type: "set_constitution", constitution: "Be helpful." },
		];
		for (const operation of operations) {
			expect(issuePaths(ChangeOperationSchema, operation)).toEqual([]);
		}
	});

	it("rejects an unknown operation type", () => {
		expect(
			issuePaths(ChangeOperationSchema, { type: "delete_everything", agentId: "alpha" }),
		).not.toEqual([]);
	});

	it("rejects an operation with unknown fields", () => {
		expect(
			issuePaths(ChangeOperationSchema, {
				type: "set_agent_enabled",
				agentId: "alpha",
				enabled: false,
				extra: true,
			}),
		).not.toEqual([]);
	});
});

describe("ChangeSetSchema", () => {
	const operation = { type: "set_agent_enabled" as const, agentId: "alpha", enabled: false };

	it("accepts a non-empty, bounded list of operations", () => {
		expect(issuePaths(ChangeSetSchema, [operation])).toEqual([]);
	});

	it("rejects an empty change set", () => {
		expect(issuePaths(ChangeSetSchema, [])).toEqual([""]);
	});

	it("rejects more operations than the bound allows", () => {
		const tooMany = Array.from({ length: MAX_CHANGE_SET_OPERATIONS + 1 }, () => operation);
		expect(issuePaths(ChangeSetSchema, tooMany)).toEqual([""]);
	});
});

describe("ConfigDiffSchema", () => {
	it("accepts a diff with every agent kind and a changed organization and constitution", () => {
		const diff = {
			agents: [
				{ kind: "added", agentId: "alpha" },
				{ kind: "removed", agentId: "beta" },
				{
					kind: "changed",
					agentId: "gamma",
					fieldPaths: ["runtime"],
					rolePrompt: { changed: true, beforeSize: 10, afterSize: 20 },
				},
			],
			organizationFieldPaths: ["mattermost.channels"],
			constitution: { changed: false, beforeSize: 11, afterSize: 11 },
		};
		expect(issuePaths(ConfigDiffSchema, diff)).toEqual([]);
	});

	it("accepts an empty diff (a no-op change set)", () => {
		expect(
			issuePaths(ConfigDiffSchema, {
				agents: [],
				organizationFieldPaths: [],
				constitution: { changed: false, beforeSize: 11, afterSize: 11 },
			}),
		).toEqual([]);
	});
});
