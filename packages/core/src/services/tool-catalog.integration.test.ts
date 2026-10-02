import type { AgentConfig, OrganizationConfig } from "@agent-gateway/contracts";
import { AgentConfigSchema, OrganizationConfigSchema } from "@agent-gateway/contracts";
import { createPool, migrateSchema } from "@agent-gateway/db";
import { DEVELOPMENT_VERSION, silentLogger } from "@agent-gateway/logging";
import { createBoss, migrateQueues, transactionalJobSink } from "@agent-gateway/queue";
import { startTestPostgres, type TestPostgres } from "@agent-gateway/testkit";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyConfig, configSnapshotBundle, inTransaction } from "./admin.ts";
import type { ControlPlaneDeps } from "./deps.ts";
import {
	activeConfigRevisionId,
	commitChange,
	dropAttachmentsToUnknownEntriesIn,
	loadActiveBundle,
	prepareChange,
} from "./management.ts";
import {
	attachTool,
	deleteCatalogEntry,
	detachTool,
	editCatalogEntry,
	ensureToolCatalogSeeded,
	getCatalogEntry,
	listCatalogEntries,
	listCatalogEntryVersions,
	updateAttachment,
} from "./tool-catalog.ts";

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

describe("tool catalog service (ADR-027)", () => {
	let postgres: TestPostgres;
	let pool: pg.Pool;
	let boss: Awaited<ReturnType<typeof createBoss>>;
	let deps: ControlPlaneDeps;

	beforeAll(async () => {
		postgres = await startTestPostgres();
		pool = createPool(postgres.connectionString, 8);
		await migrateSchema({
			pool,
			connectionString: postgres.connectionString,
			release: DEVELOPMENT_VERSION,
			migrateQueues: () => migrateQueues(postgres.connectionString),
		});
		boss = createBoss(postgres.connectionString, "client");
		await boss.start();
		deps = {
			pool,
			jobs: (tx) => transactionalJobSink(boss, tx.client),
			clock: () => new Date(),
			random: Math.random,
			log: silentLogger,
		};
	});

	afterAll(async () => {
		await boss?.stop({ graceful: false });
		await pool?.end();
		await postgres?.stop();
	});

	/** A fresh active configuration with `alpha`/`beta` (plus the required finance agent). Catalog
	 * tables are never truncated: built-in ids are stable and idempotently reseeded, a custom
	 * entry's own id is never reused, and `catalog_entry_versions` refuses truncation outright
	 * (append-only, migration 0029) — exactly as production never resets them either. Truncating
	 * `agents` still clears `catalog_attachments` (its own FK cascades), so a stale attachment from
	 * an earlier test never leaks into the next one's assertions. */
	async function reset(): Promise<void> {
		await pool.query(
			"truncate agent_lifecycle_operations, agent_lifecycle, agent_runs, agent_inbox, mattermost_identities, agents, config_versions, gateway_controls, runtime_workers, runtime_availability restart identity cascade",
		);
		const configured = [agent("finance"), agent("alpha"), agent("beta")];
		await applyConfig(
			deps,
			{
				organization: organization(),
				agents: configured,
				constitution: "Be helpful.",
				rolePrompts: Object.fromEntries(configured.map((a) => [a.id, `Role prompt for ${a.id}.`])),
			},
			"test",
		);
		await ensureToolCatalogSeeded(deps, "test");
	}

	beforeEach(async () => {
		await reset();
	});

	it("seeds every built-in exactly once, idempotently", async () => {
		const entries = await listCatalogEntries(deps, {
			installedAdapters: new Set(),
			registeredExecutorActionTypes: new Set(),
		});
		const builtinIds = entries
			.filter((e) => e.isBuiltin)
			.map((e) => e.id)
			.sort();
		expect(builtinIds).toEqual(
			[
				"executor-finance-payment-create",
				"executor-finance-subscription-create",
				"gateway-mattermost-post",
				"gateway-memory-write",
				"native-repository-read",
				"native-tests-run",
				"native-web-fetch",
				"native-web-search",
				"native-workspace-write",
			].sort(),
		);
		const versionIdsBefore = entries.map((e) => e.currentVersion.id).sort();

		// Reseeding again writes nothing new: no second version, no duplicate entry.
		await ensureToolCatalogSeeded(deps, "test");
		const again = await listCatalogEntries(deps, {
			installedAdapters: new Set(),
			registeredExecutorActionTypes: new Set(),
		});
		expect(again.map((e) => e.id).sort()).toEqual(entries.map((e) => e.id).sort());
		expect(again.map((e) => e.currentVersion.id).sort()).toEqual(versionIdsBefore);
		expect(again.every((e) => e.currentVersion.version === 1)).toBe(true);
	});

	it("a tombstoned built-in never comes back across reseeding, while the rest still do", async () => {
		await deleteCatalogEntry(deps, "executor-finance-subscription-create", "test");
		await ensureToolCatalogSeeded(deps, "test");

		const deleted = await getCatalogEntry(deps, "executor-finance-subscription-create", {
			installedAdapters: new Set(),
			registeredExecutorActionTypes: new Set(),
		});
		expect(deleted).toBeNull();
		const survivor = await getCatalogEntry(deps, "executor-finance-payment-create", {
			installedAdapters: new Set(),
			registeredExecutorActionTypes: new Set(),
		});
		expect(survivor).not.toBeNull();

		const [tombstone] = (
			await pool.query(
				"select kind, deleted_by from catalog_entry_tombstones where entry_id = $1",
				["executor-finance-subscription-create"],
			)
		).rows;
		expect(tombstone).toMatchObject({ kind: "executor", deleted_by: "test" });
	});

	it("editing a built-in's name/description publishes a new, immutable version; history stays readable", async () => {
		const edited = await editCatalogEntry(deps, {
			entryId: "gateway-mattermost-post",
			name: "Post in Mattermost",
			actor: "test",
		});
		expect(edited.currentVersion.version).toBe(2);
		expect(edited.currentVersion.name).toBe("Post in Mattermost");
		expect(edited.currentVersion.implementationKey).toBe("mattermost.post");

		const history = await listCatalogEntryVersions(deps, "gateway-mattermost-post");
		expect(history.map((v) => v.version)).toEqual([1, 2]);
		expect(history[0]?.name).not.toBe("Post in Mattermost");
		expect(history[1]?.name).toBe("Post in Mattermost");

		// The guard trigger (migration 0029) refuses any direct mutation of a version row.
		await expect(
			pool.query("update catalog_entry_versions set name = 'tampered' where id = $1", [
				history[0]?.id,
			]),
		).rejects.toThrow(/append-only/);
		await expect(
			pool.query("delete from catalog_entry_versions where id = $1", [history[0]?.id]),
		).rejects.toThrow(/append-only/);
	});

	it("refuses editing a built-in's riskFloor, configSchema or supportedAdapters", async () => {
		await expect(
			editCatalogEntry(deps, {
				entryId: "gateway-mattermost-post",
				riskFloor: "require_approval",
				actor: "test",
			}),
		).rejects.toThrow(/immutable for a built-in entry/);
	});

	it("deleting an entry removes its attachment from every agent that has it, in one commit", async () => {
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "console",
		});
		await attachTool(deps, {
			agentId: "beta",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "console",
		});
		const attachedRows = (
			await pool.query("select agent_id from catalog_attachments where entry_id = $1", [
				"gateway-mattermost-post",
			])
		).rows;
		expect(attachedRows).toHaveLength(2);

		await deleteCatalogEntry(deps, "gateway-mattermost-post", "test");

		const remaining = (
			await pool.query("select agent_id from catalog_attachments where entry_id = $1", [
				"gateway-mattermost-post",
			])
		).rows;
		expect(remaining).toHaveLength(0);
		expect(
			await getCatalogEntry(deps, "gateway-mattermost-post", {
				installedAdapters: new Set(),
				registeredExecutorActionTypes: new Set(),
			}),
		).toBeNull();
	});

	it("deleting a nonexistent entry fails closed, leaving every other entry and attachment untouched", async () => {
		// Not `gateway-mattermost-post`: an earlier test in this file permanently tombstones it
		// (deletion is forever, by design — ADR-027), and `reset()` never undoes a tombstone.
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "gateway-memory-write",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "console",
		});
		await expect(deleteCatalogEntry(deps, "does-not-exist", "test")).rejects.toThrow(
			/does not exist/,
		);
		const stillThere = (
			await pool.query("select agent_id from catalog_attachments where entry_id = $1", [
				"gateway-memory-write",
			])
		).rows;
		expect(stillThere).toHaveLength(1);
	});

	it("attach/detach/update each commit a config revision carrying the given source, covered by rollback", async () => {
		const attach = await attachTool(deps, {
			agentId: "alpha",
			entryId: "gateway-memory-write",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "owner",
			source: "console",
		});
		const [attachRevision] = (
			await pool.query("select source, actor from config_revisions where id = $1", [
				attach.revisionId,
			])
		).rows;
		expect(attachRevision).toMatchObject({ source: "console", actor: "owner" });

		const updated = await updateAttachment(deps, {
			agentId: "alpha",
			entryId: "gateway-memory-write",
			mode: "require_approval",
			actor: "owner",
			source: "console",
		});
		const { bundle: afterUpdate } = await inTransaction(deps, ({ tx }) =>
			loadActiveBundle(tx.db, updated.revisionId),
		);
		expect(afterUpdate.toolAttachments.alpha).toEqual([
			{
				entryId: "gateway-memory-write",
				pinnedVersion: null,
				mode: "require_approval",
				settings: {},
			},
		]);

		const detach = await detachTool(deps, {
			agentId: "alpha",
			entryId: "gateway-memory-write",
			actor: "owner",
			source: "console",
		});
		const { bundle: afterDetach } = await inTransaction(deps, ({ tx }) =>
			loadActiveBundle(tx.db, detach.revisionId),
		);
		expect(afterDetach.toolAttachments.alpha).toEqual([]);

		// Rolling back to the attach revision restores exactly that attachment.
		const { bundle: attachBundle } = await inTransaction(deps, ({ tx }) =>
			loadActiveBundle(tx.db, attach.revisionId),
		);
		if (attachBundle.organization === null) {
			throw new Error("expected an organization");
		}
		const rollbackChangeSet = [
			{
				type: "replace_bundle" as const,
				bundle: configSnapshotBundle({
					organization: attachBundle.organization,
					agents: attachBundle.agents,
					constitution: attachBundle.constitution,
					rolePrompts: attachBundle.rolePrompts,
				}),
				// The attachments document is a sibling field of the operation, not part of `bundle`
				// itself (ADR-027): omitting it would carry the *current* (detached) state
				// forward instead of restoring what this rollback actually means to restore.
				toolAttachments: attachBundle.toolAttachments,
			},
		];
		const rolledBack = await commitChange(deps, {
			changeSet: rollbackChangeSet,
			baseRevisionId: detach.revisionId,
			actor: "owner",
			source: "rollback",
		});
		const { bundle: rolledBackBundle } = await inTransaction(deps, ({ tx }) =>
			loadActiveBundle(tx.db, rolledBack.revisionId),
		);
		expect(rolledBackBundle.toolAttachments.alpha).toEqual([
			{ entryId: "gateway-memory-write", pinnedVersion: null, mode: "allow", settings: {} },
		]);
	});

	it("refuses attaching 'allow' once the entry's risk floor requires approval", async () => {
		await expect(
			attachTool(deps, {
				agentId: "alpha",
				entryId: "executor-finance-payment-create",
				pinnedVersion: null,
				mode: "allow",
				settings: {},
				actor: "test",
				source: "console",
			}),
		).rejects.toThrow(/requires at least 'require_approval'/);
		// 'require_approval' and 'disabled' both still work.
		await expect(
			attachTool(deps, {
				agentId: "alpha",
				entryId: "executor-finance-payment-create",
				pinnedVersion: null,
				mode: "require_approval",
				settings: {},
				actor: "test",
				source: "console",
			}),
		).resolves.toMatchObject({ noop: false });
	});

	/** Whether `error`, or anything in its `cause` chain, is Postgres's own "deadlock detected" —
	 * the same helper `agent-lifecycle.integration.test.ts` uses for its own lock-order races. */
	function isDeadlock(error: unknown): boolean {
		for (let current: unknown = error; current instanceof Error; current = current.cause) {
			if (/deadlock detected/i.test(current.message)) {
				return true;
			}
		}
		return false;
	}

	it("deleteCatalogEntry racing a concurrent attach never deadlocks (lock order: gateway_controls, then catalog_entries)", async () => {
		// `deleteCatalogEntry` now locks `gateway_controls` before `catalog_entries`, the same order
		// every configuration writer keeps (`commitChangeIn`'s own first lock) — taking
		// `catalog_entries` first, as an earlier version did, risked a deadlock (40P01) against a
		// concurrent `attach_tool`/`update_attachment` commit, which always reaches for
		// `gateway_controls` first through `commitChangeIn`. A deleted built-in is tombstoned
		// forever (never reseeded), so each iteration below deletes a distinct one — never one an
		// earlier or later test in this file still needs fresh — racing the attach against a fixed
		// entry ("native-repository-read") none of them ever is.
		const toDelete = [
			"native-tests-run",
			"native-web-fetch",
			"native-web-search",
			"native-workspace-write",
		];
		for (const entryId of toDelete) {
			const deleting = deleteCatalogEntry(deps, entryId, "test");
			await new Promise((resolve) => setTimeout(resolve, 5));
			const results = await Promise.allSettled([
				deleting,
				attachTool(deps, {
					agentId: "alpha",
					entryId: "native-repository-read",
					pinnedVersion: null,
					mode: "allow",
					settings: {},
					actor: "test",
					source: "console",
				}),
			]);
			for (const result of results) {
				if (result.status === "rejected") {
					expect(isDeadlock(result.reason)).toBe(false);
				}
			}
			await detachTool(deps, {
				agentId: "alpha",
				entryId: "native-repository-read",
				actor: "test",
				source: "console",
			});
		}
	});

	it("refuses attaching an entry that does not exist, and a pinned version that does not exist", async () => {
		await expect(
			attachTool(deps, {
				agentId: "alpha",
				entryId: "ghost-entry",
				pinnedVersion: null,
				mode: "allow",
				settings: {},
				actor: "test",
				source: "console",
			}),
		).rejects.toThrow(/does not exist/);
		await expect(
			attachTool(deps, {
				agentId: "alpha",
				entryId: "gateway-memory-write",
				pinnedVersion: 9,
				mode: "allow",
				settings: {},
				actor: "test",
				source: "console",
			}),
		).rejects.toThrow(/has no version 9/);
	});

	it("a direct commitChange naming a nonexistent catalog entry is refused, not only attachTool's own checkAttachable", async () => {
		// `config import`/a direct `commitChange` (a console patch, say) never calls `checkAttachable`
		// at all; the shared commit boundary (`attachmentCatalogProblems`) must refuse it on its own.
		const revisionId = await activeConfigRevisionId(deps);
		const { bundle } = await inTransaction(deps, ({ tx }) => loadActiveBundle(tx.db, revisionId));
		if (bundle.organization === null) {
			throw new Error("expected an organization");
		}
		const changeSet = [
			{
				type: "replace_bundle" as const,
				bundle: configSnapshotBundle({
					organization: bundle.organization,
					agents: bundle.agents,
					constitution: bundle.constitution,
					rolePrompts: bundle.rolePrompts,
				}),
				toolAttachments: {
					alpha: [
						{ entryId: "ghost-entry", pinnedVersion: null, mode: "allow" as const, settings: {} },
					],
				},
			},
		];
		await expect(
			commitChange(deps, {
				changeSet,
				baseRevisionId: revisionId,
				actor: "test",
				source: "import",
			}),
		).rejects.toThrow(/ghost-entry.*does not exist/);
		// `prepareChange` (`config diff`) reports the exact same problem, read-only.
		const preview = await prepareChange(deps, changeSet);
		expect(preview.problems.some((p) => /ghost-entry.*does not exist/.test(p))).toBe(true);
	});

	it("rolling back to a revision that attached a since-deleted entry drops it instead of FK-failing or resurrecting it", async () => {
		const attach = await attachTool(deps, {
			agentId: "alpha",
			entryId: "gateway-memory-write",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "console",
		});
		await deleteCatalogEntry(deps, "gateway-memory-write", "test");

		// The entry's own row still exists (soft-deleted), so inserting a `catalog_attachments` row
		// for it on rollback no longer fails on a foreign key — but the rollback must still not
		// silently bring the deleted capability back.
		const { bundle: attachBundle } = await inTransaction(deps, ({ tx }) =>
			loadActiveBundle(tx.db, attach.revisionId),
		);
		if (attachBundle.organization === null) {
			throw new Error("expected an organization");
		}
		const { toolAttachments: filtered, dropped } = await inTransaction(deps, ({ tx }) =>
			dropAttachmentsToUnknownEntriesIn(tx.db, attachBundle.toolAttachments),
		);
		expect(dropped).toEqual([{ agentId: "alpha", entryId: "gateway-memory-write" }]);
		const revisionId = await activeConfigRevisionId(deps);
		const changeSet = [
			{
				type: "replace_bundle" as const,
				bundle: configSnapshotBundle({
					organization: attachBundle.organization,
					agents: attachBundle.agents,
					constitution: attachBundle.constitution,
					rolePrompts: attachBundle.rolePrompts,
				}),
				toolAttachments: filtered,
			},
		];
		const rolledBack = await commitChange(deps, {
			changeSet,
			baseRevisionId: revisionId,
			actor: "test",
			source: "rollback",
		});
		const { bundle: rolledBackBundle } = await inTransaction(deps, ({ tx }) =>
			loadActiveBundle(tx.db, rolledBack.revisionId),
		);
		expect(rolledBackBundle.toolAttachments.alpha).toEqual([]);
		const row = (
			await pool.query("select deleted_at from catalog_entries where id = $1", [
				"gateway-memory-write",
			])
		).rows[0];
		expect(row.deleted_at).not.toBeNull();
	});
});
