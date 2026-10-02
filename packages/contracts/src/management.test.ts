import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentConfigSchema } from "./agent-config.ts";
import { AgentIdSchema } from "./common.ts";
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
import { OrganizationConfigSchema } from "./organization.ts";
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
		attachmentsSnapshotHash: null,
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

	it("accepts a revision naming its own attachments snapshot (ADR-027)", () => {
		expect(
			issuePaths(ConfigRevisionSchema, { ...revision, attachmentsSnapshotHash: "b".repeat(64) }),
		).toEqual([]);
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

	it("accepts replace_bundle with an explicit attachments document (ADR-027)", () => {
		const bundle = {
			organization: organization(),
			agents: [agent("alpha")],
			constitution: "Be helpful.",
			rolePrompts: { alpha: "Role prompt." },
		};
		expect(
			issuePaths(ChangeOperationSchema, {
				type: "replace_bundle",
				bundle,
				toolAttachments: { alpha: [] },
			}),
		).toEqual([]);
	});

	it("accepts replace_bundle with no attachments document at all (carry-forward, ADR-027)", () => {
		const bundle = {
			organization: organization(),
			agents: [agent("alpha")],
			constitution: "Be helpful.",
			rolePrompts: { alpha: "Role prompt." },
		};
		expect(issuePaths(ChangeOperationSchema, { type: "replace_bundle", bundle })).toEqual([]);
	});

	it("accepts add_agent with an explicit, even empty, attachments list (ADR-027)", () => {
		expect(
			issuePaths(ChangeOperationSchema, {
				type: "add_agent",
				agent: agent("beta"),
				rolePrompt: "Role prompt.",
				toolAttachments: [],
			}),
		).toEqual([]);
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
			toolAttachments: [
				{ kind: "added", agentId: "gamma", entryId: "native-repository-read" },
				{ kind: "removed", agentId: "gamma", entryId: "gateway-memory-write" },
				{
					kind: "changed",
					agentId: "gamma",
					entryId: "executor-finance-payment-create",
					fields: ["mode", "settings"],
				},
			],
		};
		expect(issuePaths(ConfigDiffSchema, diff)).toEqual([]);
	});

	it("accepts an empty diff (a no-op change set)", () => {
		expect(
			issuePaths(ConfigDiffSchema, {
				agents: [],
				organizationFieldPaths: [],
				constitution: { changed: false, beforeSize: 11, afterSize: 11 },
				toolAttachments: [],
			}),
		).toEqual([]);
	});

	it("rejects a changed attachment with no fields named", () => {
		expect(
			issuePaths(ConfigDiffSchema, {
				agents: [],
				organizationFieldPaths: [],
				constitution: { changed: false, beforeSize: 11, afterSize: 11 },
				toolAttachments: [{ kind: "changed", agentId: "gamma", entryId: "x", fields: [] }],
			}),
		).not.toEqual([]);
	});
});

describe("ConfigSnapshotBundleSchema stays the shape release 0.6.0 reads (ADR-027)", () => {
	/**
	 * `v0.6.0`'s own `ConfigSnapshotBundleSchema` (`git show v0.6.0:packages/contracts/src/management.ts`),
	 * pinned here rather than fetched: a `strictObject` over the same four fields, built from the
	 * same `OrganizationConfigSchema`/`AgentConfigSchema`/`AgentIdSchema` this file still imports
	 * (neither has gained a new *required* field since, so reusing them here still exercises the
	 * one thing this test actually guards — that nothing this release adds to the *outer* bundle
	 * shape, like a `toolAttachments` key, breaks a 0.6.0 `strictObject`'s "no unknown keys" rule).
	 */
	const Pinned060ConfigSnapshotBundleSchema = z.strictObject({
		organization: OrganizationConfigSchema,
		agents: z.array(AgentConfigSchema),
		constitution: z.string().min(1),
		rolePrompts: z.record(AgentIdSchema, z.string().min(1)),
	});

	it("parses a bundle this release's ConfigSnapshotBundleSchema produces", () => {
		const value = bundle();
		// A round-trip through JSON, the same lossy boundary a `jsonb` column actually stores
		// through, so this exercises exactly what `config_snapshots.bundle` would hold.
		const stored = JSON.parse(JSON.stringify(ConfigSnapshotBundleSchema.parse(value)));
		expect(issuePaths(Pinned060ConfigSnapshotBundleSchema, stored)).toEqual([]);
	});

	it("rejects a bundle carrying toolAttachments directly: exactly what this schema must never do", () => {
		const withAttachments = { ...bundle(), toolAttachments: { alpha: [] } };
		expect(issuePaths(Pinned060ConfigSnapshotBundleSchema, withAttachments)).toEqual([""]);
	});
});
