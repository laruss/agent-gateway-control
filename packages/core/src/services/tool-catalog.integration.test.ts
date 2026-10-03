import { randomUUID } from "node:crypto";
import type {
	AgentConfig,
	CustomHttpsDefinition,
	OrganizationConfig,
} from "@agent-gateway/contracts";
import { AgentConfigSchema, OrganizationConfigSchema } from "@agent-gateway/contracts";
import { createPool, migrateSchema } from "@agent-gateway/db";
import { DEVELOPMENT_VERSION, silentLogger } from "@agent-gateway/logging";
import { createBoss, migrateQueues, transactionalJobSink } from "@agent-gateway/queue";
import { startTestPostgres, type TestPostgres } from "@agent-gateway/testkit";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyConfig, configSnapshotBundle, inTransaction } from "./admin.ts";
import type { ControlPlaneDeps } from "./deps.ts";
import { knownCatalogEntries } from "./effective-permissions.ts";
import {
	activeConfigRevisionId,
	commitChange,
	dropAttachmentsToUnknownEntriesIn,
	loadActiveBundle,
	ManagementConflictError,
	prepareChange,
	WidensPermissionsError,
} from "./management.ts";
import {
	adoptAgentToolAttachments,
	attachmentsConversionHash,
	attachTool,
	createCustomHttpsTool,
	deleteCatalogEntry,
	detachTool,
	editCatalogEntry,
	ensureToolCatalogSeeded,
	getCatalogEntry,
	legacyAgentsGrantingTool,
	legacyAttachmentsFromPermissions,
	listCatalogEntries,
	listCatalogEntryVersions,
	loadAgentToolAttachments,
	loadEffectivePermissionsIn,
	StaleConversionError,
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
			registeredNamespaces: new Set(),
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
				"utility-utility-text-transform",
			].sort(),
		);
		const versionIdsBefore = entries.map((e) => e.currentVersion.id).sort();

		// Reseeding again writes nothing new: no second version, no duplicate entry.
		await ensureToolCatalogSeeded(deps, "test");
		const again = await listCatalogEntries(deps, {
			installedAdapters: new Set(),
			registeredExecutorActionTypes: new Set(),
			registeredNamespaces: new Set(),
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
			registeredNamespaces: new Set(),
		});
		expect(deleted).toBeNull();
		const survivor = await getCatalogEntry(deps, "executor-finance-payment-create", {
			installedAdapters: new Set(),
			registeredExecutorActionTypes: new Set(),
			registeredNamespaces: new Set(),
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

		// `source` defaults to `cli_apply` when a caller gives none (the CLI's own convention), but
		// the console's own delete action threads its caller's source through the same way every
		// other catalog-mutating call already does, rather than hard-coding `cli_apply` regardless.
		await deleteCatalogEntry(deps, "gateway-mattermost-post", "test", "console");

		const remaining = (
			await pool.query("select agent_id from catalog_attachments where entry_id = $1", [
				"gateway-mattermost-post",
			])
		).rows;
		expect(remaining).toHaveLength(0);
		const [revision] = (
			await pool.query(
				"select source from config_revisions where id = (select max(id) from config_revisions)",
			)
		).rows;
		expect(revision.source).toBe("console");
		expect(
			await getCatalogEntry(deps, "gateway-mattermost-post", {
				installedAdapters: new Set(),
				registeredExecutorActionTypes: new Set(),
				registeredNamespaces: new Set(),
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

	it("refuses to delete an entry still granted by a legacy agent's own permissions, until it adopts", async () => {
		const entryId = "legacy-covered-tool";
		await createCustomHttpsTool(deps, {
			entryId,
			name: "Legacy covered tool",
			description: "A test custom HTTPS tool.",
			httpsDefinition: {
				host: "api.example.test",
				pathTemplate: "/items/{id}",
				method: "GET",
				parameters: [
					{ name: "id", slot: "path", slotName: "id", type: "string", minLength: 1, maxLength: 20 },
				],
				secretSlots: [],
				idempotency: null,
				responseLimits: {
					maxResponseBytes: 65_536,
					allowedContentTypes: ["application/json"],
					timeoutMs: 5000,
					includeBodyPreview: true,
				},
			},
			actor: "test",
		});

		// `beta` is still legacy (no attachments document of its own): its own
		// `tools_require_human_approval` names this entry's own tool (`custom.<entry-id>`) directly,
		// which the catalog never consults for a legacy agent's own enforcement (ADR-027) — deleting
		// the entry would make the hub show it as gone everywhere while `beta` keeps using the exact
		// same tool, unaffected.
		const [betaConfig] = (await pool.query("select config from agents where id = 'beta'")).rows;
		await commitChange(deps, {
			changeSet: [
				{
					type: "update_agent",
					agent: {
						...betaConfig.config,
						permissions: {
							tools_allow: [],
							tools_require_human_approval: [`custom.${entryId}`],
							tools_deny: ["finance.*"],
						},
					},
				},
			],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "test",
			source: "cli_apply",
		});

		// Disabled, not removed: re-enabling it later would hand the deleted tool straight back.
		await commitChange(deps, {
			changeSet: [{ type: "set_agent_enabled", agentId: "beta", enabled: false }],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "test",
			source: "cli_apply",
		});
		await expect(deleteCatalogEntry(deps, entryId, "test")).rejects.toThrow(
			/legacy permissions.*beta.*gateway tools adopt/s,
		);
		await commitChange(deps, {
			changeSet: [{ type: "set_agent_enabled", agentId: "beta", enabled: true }],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "test",
			source: "cli_apply",
		});
		expect(
			await getCatalogEntry(deps, entryId, {
				installedAdapters: new Set(),
				registeredExecutorActionTypes: new Set(),
				registeredNamespaces: new Set(),
			}),
		).not.toBeNull();

		// Adopting `beta` converts its legacy coverage into a real attachment; the delete then
		// succeeds and clears it like any other hub-managed attachment.
		await adoptAgentToolAttachments(deps, {
			agentIds: ["beta"],
			dryRun: false,
			actor: "test",
		});
		await deleteCatalogEntry(deps, entryId, "test");
		expect(
			await getCatalogEntry(deps, entryId, {
				installedAdapters: new Set(),
				registeredExecutorActionTypes: new Set(),
				registeredNamespaces: new Set(),
			}),
		).toBeNull();
	});

	it("a console confirm bound to a stale preview's conversion is refused, even though baseRevisionId alone would not catch it", async () => {
		// A catalog entry created between preview and confirm changes what `custom.*` resolves to
		// without moving any config revision at all (catalog entries carry no revision of their own,
		// ADR-027) — `baseRevisionId` alone cannot catch this; `expectedAttachmentsHash` does.
		// Placed early in this file, before any test that pushes the shared catalog's own `custom.*`
		// coverage toward `MAX_ATTACHMENTS_PER_AGENT` (the "wide legacy wildcard"/"past
		// MAX_ATTACHMENTS_PER_AGENT" tests below) — this agent's own resolution must stay small and
		// clean, or it would hit that problem path (an unrelated, already-covered case) instead of the
		// one this test is actually about.
		const definition: CustomHttpsDefinition = {
			host: "api.example.test",
			pathTemplate: "/items",
			method: "GET",
			parameters: [],
			secretSlots: [],
			idempotency: null,
			responseLimits: {
				maxResponseBytes: 65_536,
				allowedContentTypes: ["application/json"],
				timeoutMs: 5000,
				includeBodyPreview: true,
			},
		};
		await createCustomHttpsTool(deps, {
			entryId: "race-tool-1",
			name: "Race tool 1",
			description: "A test custom HTTPS tool.",
			httpsDefinition: definition,
			actor: "test",
		});
		await applyConfig(
			deps,
			{
				organization: organization(),
				agents: [
					agent("finance"),
					agent("racer", {
						permissions: {
							tools_allow: [],
							// `custom_https` entries support only `require_approval`/`disabled`
							// (`MODES_BY_KIND`), never `allow` — `tools_require_human_approval`, not
							// `tools_allow`, is the legacy list that resolves cleanly against them.
							tools_require_human_approval: ["custom.*"],
							tools_deny: ["finance.*"],
						},
					}),
				],
				constitution: "Be helpful.",
				rolePrompts: { finance: "x", racer: "x" },
			},
			"test",
		);

		// `custom.*` also matches every `custom_https` entry earlier tests in this shared-catalog file
		// already created (`reset`'s own doc comment: catalog entries are never reset between tests),
		// so the exact count here is relative, never an absolute number.
		const [stalePreview] = await adoptAgentToolAttachments(deps, {
			agentIds: ["racer"],
			dryRun: true,
			actor: "test",
		});
		const staleCount = stalePreview?.attachments.length ?? 0;
		expect(staleCount).toBeGreaterThan(0);
		const staleHash = stalePreview?.conversionHash;
		expect(typeof staleHash).toBe("string");

		// A second entry, also matching `custom.*`, created while the (simulated) owner is still
		// looking at the first preview.
		await createCustomHttpsTool(deps, {
			entryId: "race-tool-2",
			name: "Race tool 2",
			description: "A test custom HTTPS tool.",
			httpsDefinition: definition,
			actor: "test",
		});

		await expect(
			adoptAgentToolAttachments(deps, {
				agentIds: ["racer"],
				dryRun: false,
				actor: "test",
				expectedAttachmentsHash: staleHash,
			}),
		).rejects.toThrow(StaleConversionError);
		// Nothing committed: `racer` is still legacy.
		const [stillLegacy] = await adoptAgentToolAttachments(deps, {
			agentIds: ["racer"],
			dryRun: true,
			actor: "test",
		});
		expect(stillLegacy?.alreadyHubManaged).toBe(false);
		expect(stillLegacy?.attachments).toHaveLength(staleCount + 1);

		// A fresh preview's own (now one entry wider) hash commits cleanly.
		const freshHash = stillLegacy?.conversionHash;
		const [committed] = await adoptAgentToolAttachments(deps, {
			agentIds: ["racer"],
			dryRun: false,
			actor: "test",
			expectedAttachmentsHash: freshHash,
		});
		expect(committed?.commit).not.toBeNull();
		expect(committed?.attachments).toHaveLength(staleCount + 1);
	});

	it("attachTool's own implicit legacy conversion is refused once baseRevisionId no longer names the active revision", async () => {
		await applyConfig(
			deps,
			{
				organization: organization(),
				agents: [agent("finance"), agent("staleattach")],
				constitution: "Be helpful.",
				rolePrompts: { finance: "x", staleattach: "x" },
			},
			"test",
		);
		const staleBase = await activeConfigRevisionId(deps);

		// An unrelated commit moves the active revision on, exactly like a second browser tab (or
		// another operator) committing something else while the console's own agent-tools page sits
		// open, its `baseRevisionId` now stale.
		await attachTool(deps, {
			agentId: "finance",
			entryId: "native-repository-read",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "console",
		});

		await expect(
			attachTool(deps, {
				agentId: "staleattach",
				entryId: "native-repository-read",
				pinnedVersion: null,
				mode: "allow",
				settings: {},
				actor: "test",
				source: "console",
				baseRevisionId: staleBase,
			}),
		).rejects.toThrow(ManagementConflictError);
		// Nothing committed: `staleattach` is still legacy.
		const [stillLegacy] = await adoptAgentToolAttachments(deps, {
			agentIds: ["staleattach"],
			dryRun: true,
			actor: "test",
		});
		expect(stillLegacy?.alreadyHubManaged).toBe(false);

		// A fresh `baseRevisionId` (what the console's own reloaded page would show) commits cleanly.
		const freshBase = await activeConfigRevisionId(deps);
		const attached = await attachTool(deps, {
			agentId: "staleattach",
			entryId: "native-repository-read",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "console",
			baseRevisionId: freshBase,
		});
		expect(attached.noop).toBe(false);
	});

	it("attach/detach/update each commit a config revision carrying the given source, covered by rollback", async () => {
		// `alpha` is still legacy: this first attachment converts its own `tools_deny: ["finance.*"]`
		// (`agent()`'s own default, above) into the same disabled attachment(s) `gateway tools adopt`
		// would, alongside the attachment actually requested — never just the one attachment on its
		// own (ADR-027). Only `executor-finance-payment-create` still resolves: an earlier test in
		// this file ("a tombstoned built-in never comes back across reseeding") permanently deletes
		// `executor-finance-subscription-create`, and `reset()` never undoes a tombstone. Stays in
		// place (unaffected) through every step below.
		const financeDeny = [
			{
				entryId: "executor-finance-payment-create",
				pinnedVersion: null,
				mode: "disabled" as const,
				settings: {},
			},
		];
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

		// `gateway-memory-write` is a `gateway`-kind entry: it supports `allow`/`disabled` only
		// (`modeSupportedByKind`), never `require_approval` — no enforcement point can pause a turn
		// mid-flight for a human to approve a direct Gateway action.
		const updated = await updateAttachment(deps, {
			agentId: "alpha",
			entryId: "gateway-memory-write",
			mode: "disabled",
			actor: "owner",
			source: "console",
		});
		const { bundle: afterUpdate } = await inTransaction(deps, ({ tx }) =>
			loadActiveBundle(tx.db, updated.revisionId),
		);
		expect(afterUpdate.toolAttachments.alpha).toEqual([
			...financeDeny,
			{
				entryId: "gateway-memory-write",
				pinnedVersion: null,
				mode: "disabled",
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
		expect(afterDetach.toolAttachments.alpha).toEqual(financeDeny);

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
			...financeDeny,
			{ entryId: "gateway-memory-write", pinnedVersion: null, mode: "allow", settings: {} },
		]);
	});

	it(
		"updateAttachment replays an already-committed idempotency key even after the entry it " +
			"targeted was deleted since, rather than refusing it as if it had never committed",
		async () => {
			const entryId = "retry-after-delete";
			const definition: CustomHttpsDefinition = {
				host: "api.example.test",
				pathTemplate: "/items/{id}",
				method: "GET",
				parameters: [
					{ name: "id", slot: "path", slotName: "id", type: "string", minLength: 1, maxLength: 20 },
				],
				secretSlots: [],
				idempotency: null,
				responseLimits: {
					maxResponseBytes: 65_536,
					allowedContentTypes: ["application/json"],
					timeoutMs: 5000,
					includeBodyPreview: true,
				},
			};
			await createCustomHttpsTool(deps, {
				entryId,
				name: "Retry test tool",
				description: "A test custom HTTPS tool.",
				httpsDefinition: definition,
				actor: "test",
			});
			await attachTool(deps, {
				agentId: "alpha",
				entryId,
				pinnedVersion: null,
				mode: "disabled",
				settings: {},
				actor: "test",
				source: "console",
			});
			const idempotencyKey = randomUUID();
			const first = await updateAttachment(deps, {
				agentId: "alpha",
				entryId,
				mode: "require_approval",
				actor: "test",
				source: "console",
				idempotencyKey,
			});
			expect(first.replayed).toBe(false);

			await deleteCatalogEntry(deps, entryId, "test");

			// Previously, `checkAttachable` ran before the idempotency-key replay check: a retry
			// here would throw "catalog entry 'retry-after-delete' does not exist" instead of
			// replaying the commit that already happened (`attachTool`'s own ordering, mirrored).
			const retry = await updateAttachment(deps, {
				agentId: "alpha",
				entryId,
				mode: "require_approval",
				actor: "test",
				source: "console",
				idempotencyKey,
			});
			expect(retry.replayed).toBe(true);
			expect(retry.revisionId).toBe(first.revisionId);
		},
	);

	it(
		"a wide legacy wildcard (more attachments than MAX_CHANGE_SET_OPERATIONS) converts and " +
			"attaches in a single bounded set_tool_attachments operation, not one attach_tool per " +
			"attachment",
		async () => {
			const WIDE_COUNT = 51;
			const definition: CustomHttpsDefinition = {
				host: "api.example.test",
				pathTemplate: "/items",
				method: "GET",
				parameters: [],
				secretSlots: [],
				idempotency: null,
				responseLimits: {
					maxResponseBytes: 65_536,
					allowedContentTypes: ["application/json"],
					timeoutMs: 5000,
					includeBodyPreview: true,
				},
			};
			for (let i = 0; i < WIDE_COUNT; i++) {
				await createCustomHttpsTool(deps, {
					entryId: `wide-tool-${i}`,
					name: `Wide tool ${i}`,
					description: "A test custom HTTPS tool.",
					httpsDefinition: definition,
					actor: "test",
				});
			}
			await applyConfig(
				deps,
				{
					organization: organization(),
					agents: [
						agent("finance"),
						agent("wide", {
							permissions: {
								tools_allow: [],
								tools_require_human_approval: [],
								tools_deny: ["finance.*", "custom.*"],
							},
						}),
					],
					constitution: "Be helpful.",
					rolePrompts: { finance: "x", wide: "x" },
				},
				"test",
			);

			// Before this fix, the legacy conversion committed one `attach_tool` per resolved
			// attachment (at least 51, one per `wide-tool-N`, plus `finance.*`'s own coverage) plus
			// the one actually requested here — over `MAX_CHANGE_SET_OPERATIONS` (50) — so this would
			// have thrown "cannot be converted automatically here" even though every individual
			// attachment resolves cleanly on its own.
			const attached = await attachTool(deps, {
				agentId: "wide",
				entryId: "gateway-memory-write",
				pinnedVersion: null,
				mode: "allow",
				settings: {},
				actor: "test",
				source: "console",
			});
			// `finance.*`'s own resolved coverage is not asserted exactly here: an earlier test in
			// this file permanently tombstones `executor-finance-subscription-create`, so it varies
			// with run order — only that every `wide-tool-N` resolved is asserted below.
			expect(attached.legacyConversion.length).toBeGreaterThanOrEqual(WIDE_COUNT);
			const wideToolIds = new Set(Array.from({ length: WIDE_COUNT }, (_, i) => `wide-tool-${i}`));
			const resolvedWideIds = new Set(
				attached.legacyConversion.filter((a) => wideToolIds.has(a.entryId)).map((a) => a.entryId),
			);
			expect(resolvedWideIds.size).toBe(WIDE_COUNT);
			const { bundle } = await inTransaction(deps, ({ tx }) =>
				loadActiveBundle(tx.db, attached.revisionId),
			);
			expect(
				bundle.toolAttachments.wide?.some(
					(a) => a.entryId === "gateway-memory-write" && a.mode === "allow",
				),
			).toBe(true);
			expect(bundle.toolAttachments.wide?.length ?? 0).toBeGreaterThanOrEqual(WIDE_COUNT + 1);
		},
	);

	it(
		"adoptAgentToolAttachments reports a resolution past MAX_ATTACHMENTS_PER_AGENT as a " +
			"problem, dry-run included, rather than only failing opaquely once a commit is attempted",
		async () => {
			// Builds on the custom entries the previous test already created (catalog entries are
			// never reset between tests in this file — see `reset`'s own doc comment) with enough
			// more that `custom.*` now resolves past `MAX_ATTACHMENTS_PER_AGENT` (128) for a fresh
			// agent of its own.
			const EXTRA_COUNT = 90;
			const definition: CustomHttpsDefinition = {
				host: "api.example.test",
				pathTemplate: "/items",
				method: "GET",
				parameters: [],
				secretSlots: [],
				idempotency: null,
				responseLimits: {
					maxResponseBytes: 65_536,
					allowedContentTypes: ["application/json"],
					timeoutMs: 5000,
					includeBodyPreview: true,
				},
			};
			for (let i = 0; i < EXTRA_COUNT; i++) {
				await createCustomHttpsTool(deps, {
					entryId: `too-wide-tool-${i}`,
					name: `Too wide tool ${i}`,
					description: "A test custom HTTPS tool.",
					httpsDefinition: definition,
					actor: "test",
				});
			}
			await applyConfig(
				deps,
				{
					organization: organization(),
					agents: [
						agent("finance"),
						agent("toowide", {
							permissions: {
								tools_allow: [],
								tools_require_human_approval: [],
								tools_deny: ["finance.*", "custom.*"],
							},
						}),
					],
					constitution: "Be helpful.",
					rolePrompts: { finance: "x", toowide: "x" },
				},
				"test",
			);

			const [preview] = await adoptAgentToolAttachments(deps, {
				agentIds: ["toowide"],
				dryRun: true,
				actor: "test",
			});
			expect(preview?.commit).toBeNull();
			expect(
				preview?.problems.some((p) => p.includes("more than the") && p.includes("may hold")),
			).toBe(true);

			// Not only previewed: attempting the real commit refuses the same way, never partially
			// committing a truncated list.
			const [committed] = await adoptAgentToolAttachments(deps, {
				agentIds: ["toowide"],
				dryRun: false,
				actor: "test",
			});
			expect(committed?.commit).toBeNull();
			expect(committed?.problems.length).toBeGreaterThan(0);
		},
	);

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

	it("deleteCatalogEntry refuses when clearing an attachment would widen an agent's effective permissions", async () => {
		// `workspace.write` explicitly `disabled` wins over `tests.run`'s own implication
		// (`compileAttachments`'s "an explicit restriction on the implied tool wins" rule); clearing
		// it away (as deleting its entry would) lets `tests.run`'s implication through instead.
		// Placed here, before "deleteCatalogEntry racing a concurrent attach" below (which
		// permanently tombstones `native-tests-run`/`native-workspace-write`/`native-web-search`/
		// `native-web-fetch` — a deleted built-in never comes back, and catalog entries are never
		// reset between tests in this file): this test and the two after it only attach/detach
		// (never delete) these entries, so they stay fresh for that test afterward.
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "native-tests-run",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "native-workspace-write",
			pinnedVersion: null,
			mode: "disabled",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});

		const deleteAttempt = deleteCatalogEntry(deps, "native-workspace-write", "test");
		await expect(deleteAttempt).rejects.toThrow(WidensPermissionsError);
		await expect(deleteAttempt).rejects.toMatchObject({
			widenings: [
				{ agentId: "alpha", tools: [{ tool: "workspace.write", from: "deny", to: "allow" }] },
			],
		});
		// Nothing committed: the entry still exists and alpha's attachment of it is untouched.
		expect(
			await getCatalogEntry(deps, "native-workspace-write", {
				installedAdapters: new Set(),
				registeredExecutorActionTypes: new Set(),
				registeredNamespaces: new Set(),
			}),
		).not.toBeNull();
		const stillAttached = await loadAgentToolAttachments(deps, "alpha");
		expect(stillAttached.attachments).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ entryId: "native-workspace-write", mode: "disabled" }),
			]),
		);
	});

	it("detachTool refuses the same widening unless acceptWidening matches, then succeeds", async () => {
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "native-tests-run",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "native-workspace-write",
			pinnedVersion: null,
			mode: "disabled",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});

		const detachAttempt = detachTool(deps, {
			agentId: "alpha",
			entryId: "native-workspace-write",
			actor: "test",
			source: "cli_apply",
		});
		await expect(detachAttempt).rejects.toThrow(WidensPermissionsError);
		await expect(detachAttempt).rejects.toMatchObject({
			widenings: [
				{ agentId: "alpha", tools: [{ tool: "workspace.write", from: "deny", to: "allow" }] },
			],
		});
		const stillAttached = await loadAgentToolAttachments(deps, "alpha");
		expect(stillAttached.attachments.some((a) => a.entryId === "native-workspace-write")).toBe(
			true,
		);

		// The hash a caller echoes back is exactly what the refusal itself just computed — never a
		// bare boolean (ADR-027: `confirmWidening` was "a bare boolean not bound to the widening the
		// owner saw").
		const refusal = await detachTool(deps, {
			agentId: "alpha",
			entryId: "native-workspace-write",
			actor: "test",
			source: "cli_apply",
		}).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(WidensPermissionsError);
		const { acceptWidening } = refusal as InstanceType<typeof WidensPermissionsError>;

		await detachTool(deps, {
			agentId: "alpha",
			entryId: "native-workspace-write",
			actor: "test",
			source: "cli_apply",
			acceptWidening,
		});
		const afterConfirm = await loadAgentToolAttachments(deps, "alpha");
		expect(afterConfirm.attachments.some((a) => a.entryId === "native-workspace-write")).toBe(
			false,
		);

		// workspace.write is now implied-allow via tests.run, with nothing explicit suppressing it.
		const revisionId = await activeConfigRevisionId(deps);
		const { bundle } = await inTransaction(deps, ({ tx }) => loadActiveBundle(tx.db, revisionId));
		const alphaConfig = bundle.agents.find((a) => a.id === "alpha");
		if (alphaConfig === undefined) {
			throw new Error("expected 'alpha' to still be configured");
		}
		const effective = await inTransaction(deps, (uow) =>
			loadEffectivePermissionsIn(
				uow.tx,
				{ id: "alpha", config: alphaConfig, toolAttachmentsManaged: true },
				"finance",
			),
		);
		expect(effective.toolPolicy.allow).toContain("workspace.write");
	});

	it("detachTool refuses a stale acceptWidening hash, naming the fresh one actually computed now", async () => {
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "native-tests-run",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "native-workspace-write",
			pinnedVersion: null,
			mode: "disabled",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});

		// A well-formed hash (the right shape) that simply never matches what this commit, run right
		// now, actually computes — a forged or merely out-of-date confirm can never slip through.
		const staleHash = "f".repeat(64);
		const attempt = detachTool(deps, {
			agentId: "alpha",
			entryId: "native-workspace-write",
			actor: "test",
			source: "cli_apply",
			acceptWidening: staleHash,
		});
		await expect(attempt).rejects.toThrow(WidensPermissionsError);
		const rejection = await attempt.catch((error: unknown) => error);
		const { acceptWidening, widenings } = rejection as InstanceType<typeof WidensPermissionsError>;
		expect(acceptWidening).not.toBe(staleHash);
		expect(widenings).toEqual([
			{ agentId: "alpha", tools: [{ tool: "workspace.write", from: "deny", to: "allow" }] },
		]);
		const stillAttached = await loadAgentToolAttachments(deps, "alpha");
		expect(stillAttached.attachments.some((a) => a.entryId === "native-workspace-write")).toBe(
			true,
		);
	});

	it("a keyed detach retry replays its own committed result rather than re-evaluating the widening check against newer state", async () => {
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "native-tests-run",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "native-workspace-write",
			pinnedVersion: null,
			mode: "disabled",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});

		const idempotencyKey = randomUUID();
		const refusal = await detachTool(deps, {
			agentId: "alpha",
			entryId: "native-workspace-write",
			actor: "test",
			source: "cli_apply",
			idempotencyKey,
		}).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(WidensPermissionsError);
		const { acceptWidening } = refusal as InstanceType<typeof WidensPermissionsError>;

		const committed = await detachTool(deps, {
			agentId: "alpha",
			entryId: "native-workspace-write",
			actor: "test",
			source: "cli_apply",
			idempotencyKey,
			acceptWidening,
		});
		expect(committed.replayed).toBe(false);

		// The catalog moves on after the commit: re-evaluating the widening check fresh right now
		// would no longer find the same thing (or anything at all, once `native-tests-run` no longer
		// implies anything) — the retry below must never reach that check, only replay what this
		// exact key already committed (ADR-027: "a keyed detach retry is refused by the precheck
		// instead of replaying").
		await updateAttachment(deps, {
			agentId: "alpha",
			entryId: "native-tests-run",
			mode: "disabled",
			actor: "test",
			source: "cli_apply",
		});

		const retried = await detachTool(deps, {
			agentId: "alpha",
			entryId: "native-workspace-write",
			actor: "test",
			source: "cli_apply",
			idempotencyKey,
		});
		expect(retried.replayed).toBe(true);
		expect(retried.revisionId).toBe(committed.revisionId);
	});

	it("detachTool's widening check runs against whichever state actually committed first, never a separate, earlier read a concurrent change could race", async () => {
		// alpha starts attached only to `native-workspace-write` (disabled); nothing implies
		// `workspace.write` yet, so detaching it right now would widen nothing — the old precheck
		// (a separate, non-transactional read taken before the commit even began) and the new, single
		// boundary check inside the commit both agree, up to this point.
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "native-workspace-write",
			pinnedVersion: null,
			mode: "disabled",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});

		// Every commit serializes on the same `gateway_controls` lock: whichever of the two below
		// actually acquires it first commits and moves the active revision on, and the other then
		// finds its own, earlier-read `baseRevisionId` stale — an ordinary optimistic-concurrency
		// conflict, unrelated to this fix (the same thing any two unrelated concurrent configuration
		// writes race on), retried here exactly as a real caller would. What this proves is what
		// happens next: once retried, each one's own widening check reads whichever state actually
		// committed first — never a separate, earlier read a concurrent change could land after.
		async function retryOnConflict<T>(run: () => Promise<T>): Promise<T> {
			for (;;) {
				try {
					return await run();
				} catch (error) {
					if (error instanceof ManagementConflictError) {
						continue;
					}
					throw error;
				}
			}
		}

		const [detaching, attaching] = await Promise.allSettled([
			retryOnConflict(() =>
				detachTool(deps, {
					agentId: "alpha",
					entryId: "native-workspace-write",
					actor: "test",
					source: "cli_apply",
				}),
			),
			retryOnConflict(() =>
				attachTool(deps, {
					agentId: "alpha",
					entryId: "native-tests-run",
					pinnedVersion: null,
					mode: "allow",
					settings: {},
					actor: "test",
					source: "cli_apply",
				}),
			),
		]);
		// The concurrent attach never depends on the detach, so it always eventually commits.
		expect(attaching.status).toBe("fulfilled");

		if (detaching.status === "fulfilled") {
			// The detach's own commit (its first attempt, or a retry after losing the ordinary
			// optimistic-concurrency race above) serialized before `native-tests-run`'s own effects
			// were visible to it: nothing implied `workspace.write` yet, a clean, unwidened success.
			const after = await loadAgentToolAttachments(deps, "alpha");
			expect(after.attachments.some((a) => a.entryId === "native-tests-run")).toBe(true);
			expect(after.attachments.some((a) => a.entryId === "native-workspace-write")).toBe(false);
			return;
		}
		// `native-tests-run` was already committed and visible by the time the detach's own fresh
		// check ran, under its own lock, never a separate, earlier read the attach could have landed
		// after: it correctly refuses instead of silently widening access.
		expect(detaching.reason).toBeInstanceOf(WidensPermissionsError);
		const { acceptWidening, widenings } = detaching.reason as InstanceType<
			typeof WidensPermissionsError
		>;
		expect(widenings).toEqual([
			{ agentId: "alpha", tools: [{ tool: "workspace.write", from: "deny", to: "allow" }] },
		]);
		await detachTool(deps, {
			agentId: "alpha",
			entryId: "native-workspace-write",
			actor: "test",
			source: "cli_apply",
			acceptWidening,
		});
		const after = await loadAgentToolAttachments(deps, "alpha");
		expect(after.attachments.some((a) => a.entryId === "native-workspace-write")).toBe(false);
	});

	it("deleteCatalogEntry refuses while an agent effectively holds the entry's capability only through another attached tool's own implication", async () => {
		// alpha attaches only `native-tests-run` (which implies `workspace.write`/`repository.read`)
		// — never `native-workspace-write` itself, so no agent is directly attached to the entry being
		// deleted (`affected` would be empty) even though the compiler still grants `workspace.write`
		// through the implication.
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "native-tests-run",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});

		await expect(deleteCatalogEntry(deps, "native-workspace-write", "test")).rejects.toThrow(
			/still effectively granted, through another attached tool's own implication/,
		);
		expect(
			await getCatalogEntry(deps, "native-workspace-write", {
				installedAdapters: new Set(),
				registeredExecutorActionTypes: new Set(),
				registeredNamespaces: new Set(),
			}),
		).not.toBeNull();
		const stillImplied = await loadAgentToolAttachments(deps, "alpha");
		expect(stillImplied.attachments.some((a) => a.entryId === "native-tests-run")).toBe(true);
	});

	it("detachTool does not require acceptWidening when detaching widens nothing", async () => {
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "native-web-search",
			pinnedVersion: null,
			mode: "disabled",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});
		await detachTool(deps, {
			agentId: "alpha",
			entryId: "native-web-search",
			actor: "test",
			source: "cli_apply",
		});
		const after = await loadAgentToolAttachments(deps, "alpha");
		expect(after.attachments.some((a) => a.entryId === "native-web-search")).toBe(false);
	});

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
		// `alpha` was still legacy when `attachTool` above first ran: its own `tools_deny:
		// ["finance.*"]` converted into this disabled attachment alongside `gateway-memory-write`
		// (ADR-027) — neither dropped nor deleted, so it remains. Only
		// `executor-finance-payment-create` resolves here: an earlier test in this file ("a
		// tombstoned built-in never comes back across reseeding") permanently deletes
		// `executor-finance-subscription-create`, and `reset()` never undoes a tombstone.
		expect(rolledBackBundle.toolAttachments.alpha).toEqual([
			{
				entryId: "executor-finance-payment-create",
				pinnedVersion: null,
				mode: "disabled",
				settings: {},
			},
		]);
		const row = (
			await pool.query("select deleted_at from catalog_entries where id = $1", [
				"gateway-memory-write",
			])
		).rows[0];
		expect(row.deleted_at).not.toBeNull();
	});

	it("refuses 'require_approval' for a native entry, and 'allow' for an executor entry, by kind", async () => {
		await expect(
			attachTool(deps, {
				agentId: "alpha",
				entryId: "native-repository-read",
				pinnedVersion: null,
				mode: "require_approval",
				settings: {},
				actor: "test",
				source: "console",
			}),
		).rejects.toThrow(/does not support mode 'require_approval'/);
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
	});

	it("attachTool refuses converting a still-legacy agent whose permissions include an unresolved pattern", async () => {
		const [betaRow] = (await pool.query("select config from agents where id = 'beta'")).rows;
		await commitChange(deps, {
			changeSet: [
				{
					type: "update_agent",
					agent: {
						...betaRow.config,
						permissions: {
							tools_allow: [],
							// `mail.send` names no catalog entry known right now (not a seeded built-in,
							// and no custom tool anywhere in this file ever creates one).
							tools_require_human_approval: ["mail.send"],
							tools_deny: ["finance.*"],
						},
					},
				},
			],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "test",
			source: "cli_apply",
		});

		await expect(
			attachTool(deps, {
				agentId: "beta",
				entryId: "native-repository-read",
				pinnedVersion: null,
				mode: "allow",
				settings: {},
				actor: "test",
				source: "cli_apply",
			}),
		).rejects.toThrow(/gateway tools adopt/);

		const stillLegacy = await loadAgentToolAttachments(deps, "beta");
		expect(stillLegacy.hubManaged).toBe(false);
	});

	it("attachTool converts a still-legacy agent whose only unresolved patterns are denials", async () => {
		const [betaRow] = (await pool.query("select config from agents where id = 'beta'")).rows;
		await commitChange(deps, {
			changeSet: [
				{
					type: "update_agent",
					agent: {
						...betaRow.config,
						permissions: {
							tools_allow: [],
							tools_require_human_approval: [],
							// `deploy.*` names no catalog entry: dropping it loses nothing, since a
							// hub-managed agent is granted only what it is attached to.
							tools_deny: ["finance.*", "deploy.*"],
						},
					},
				},
			],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "test",
			source: "cli_apply",
		});

		await attachTool(deps, {
			agentId: "beta",
			entryId: "native-repository-read",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});

		const converted = await loadAgentToolAttachments(deps, "beta");
		expect(converted.hubManaged).toBe(true);
		expect(converted.attachments.map((attachment) => attachment.entryId)).toContain(
			"native-repository-read",
		);
	});

	it("legacyAgentsGrantingTool includes an enabled agent whose own config_version lags behind the active one", async () => {
		const [alphaRow] = (await pool.query("select config from agents where id = 'alpha'")).rows;
		await commitChange(deps, {
			changeSet: [
				{
					type: "update_agent",
					agent: {
						...alphaRow.config,
						permissions: {
							tools_allow: ["repository.read"],
							tools_require_human_approval: [],
							tools_deny: ["finance.*"],
						},
					},
				},
			],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "test",
			source: "cli_apply",
		});
		const [{ active_config_version: staleVersion }] = (
			await pool.query("select active_config_version from gateway_controls")
		).rows;

		// A further, unrelated commit moves the active version on; `alpha`'s own row is pinned back
		// to the stale one below, left `enabled`, simulating exactly the drift an older release's
		// own direct toggle (or a pre-configuration-history re-enable) can leave behind —
		// `legacyAgentsGrantingTool`'s own doc comment.
		await commitChange(deps, {
			changeSet: [{ type: "set_agent_enabled", agentId: "beta", enabled: false }],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "test",
			source: "cli_apply",
		});
		await pool.query("update agents set config_version = $1 where id = 'alpha'", [staleVersion]);
		const [{ config_version: alphaVersion, enabled: alphaEnabled }] = (
			await pool.query("select config_version, enabled from agents where id = 'alpha'")
		).rows;
		const [{ active_config_version: liveVersion }] = (
			await pool.query("select active_config_version from gateway_controls")
		).rows;
		expect(alphaEnabled).toBe(true);
		expect(alphaVersion).not.toBe(liveVersion);

		const granting = await inTransaction(deps, ({ tx }) =>
			legacyAgentsGrantingTool(tx.db, "repository.read"),
		);
		expect(granting.map((g) => g.agentId)).toContain("alpha");

		await expect(deleteCatalogEntry(deps, "native-repository-read", "test")).rejects.toThrow(
			/alpha/,
		);
	});

	it("legacyAgentsGrantingTool excludes an agent whose own tools_deny covers the key", async () => {
		// A fresh, disposable `custom_https` entry (never a shared built-in): this test actually
		// deletes it on success, unlike every other test here, which only ever attaches/detaches the
		// shared natives — deleting one of those would tombstone it forever for the rest of this
		// file (catalog entries are never reset between tests).
		const entryId = "deny-exclusion-tool";
		await createCustomHttpsTool(deps, {
			entryId,
			name: "Deny exclusion tool",
			description: "A test custom HTTPS tool.",
			httpsDefinition: {
				host: "api.example.test",
				pathTemplate: "/items",
				method: "GET",
				parameters: [],
				secretSlots: [],
				idempotency: null,
				responseLimits: {
					maxResponseBytes: 65_536,
					allowedContentTypes: ["application/json"],
					timeoutMs: 5000,
					includeBodyPreview: true,
				},
			},
			actor: "test",
		});
		const implementationKey = `custom.${entryId}`;
		const [betaRow] = (await pool.query("select config from agents where id = 'beta'")).rows;
		await commitChange(deps, {
			changeSet: [
				{
					type: "update_agent",
					agent: {
						...betaRow.config,
						permissions: {
							tools_allow: [],
							tools_require_human_approval: [],
							tools_deny: ["finance.*", implementationKey],
						},
					},
				},
			],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "test",
			source: "cli_apply",
		});

		const granting = await inTransaction(deps, ({ tx }) =>
			legacyAgentsGrantingTool(tx.db, implementationKey),
		);
		expect(granting.map((g) => g.agentId)).not.toContain("beta");

		// Nothing else grants it (alpha/finance keep their defaults), so the delete proceeds.
		await deleteCatalogEntry(deps, entryId, "test");
		expect(
			await getCatalogEntry(deps, entryId, {
				installedAdapters: new Set(),
				registeredExecutorActionTypes: new Set(),
				registeredNamespaces: new Set(),
			}),
		).toBeNull();
	});

	it("attachTool refuses an implicit legacy conversion whose expectedConversionHash is stale", async () => {
		const [betaRow] = (await pool.query("select config from agents where id = 'beta'")).rows;
		await commitChange(deps, {
			changeSet: [
				{
					type: "update_agent",
					agent: {
						...betaRow.config,
						permissions: {
							tools_allow: ["repository.read"],
							tools_require_human_approval: [],
							tools_deny: ["finance.*"],
						},
					},
				},
			],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "test",
			source: "cli_apply",
		});

		// Any hash that does not match what beta's legacy `permissions` resolve to right now stands
		// in for a catalog entry created, edited or deleted since a console preview was shown (and
		// before its own confirm) — the mechanism under test is the comparison itself
		// (`attachTool`'s own `expectedConversionHash` check), not reconstructing that whole race.
		const staleHash = attachmentsConversionHash([]);

		await expect(
			attachTool(deps, {
				agentId: "beta",
				entryId: "native-repository-read",
				pinnedVersion: null,
				mode: "allow",
				settings: {},
				actor: "test",
				source: "console",
				expectedConversionHash: staleHash,
			}),
		).rejects.toThrow(StaleConversionError);
		// Nothing committed: `beta` is still legacy, with no attachment of `native-repository-read`
		// either.
		const stillLegacy = await loadAgentToolAttachments(deps, "beta");
		expect(stillLegacy.hubManaged).toBe(false);

		// The correctly recomputed hash (what the console's own agent-tools read would now show)
		// lets the same attach through.
		const known = await inTransaction(deps, ({ tx }) => knownCatalogEntries(tx.db));
		const correctHash = attachmentsConversionHash(
			legacyAttachmentsFromPermissions(
				{
					tools_allow: ["repository.read"],
					tools_require_human_approval: [],
					tools_deny: ["finance.*"],
				},
				known,
			).attachments,
		);
		await attachTool(deps, {
			agentId: "beta",
			entryId: "native-repository-read",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "console",
			expectedConversionHash: correctHash,
		});
		const nowHubManaged = await loadAgentToolAttachments(deps, "beta");
		expect(nowHubManaged.hubManaged).toBe(true);
	});

	it("an agent literally named 'constructor' never crashes a commit or a tool-attachments read", async () => {
		await applyConfig(
			deps,
			{
				organization: organization(),
				agents: [agent("finance"), agent("alpha"), agent("beta"), agent("constructor")],
				constitution: "Be helpful.",
				rolePrompts: {
					finance: "x",
					alpha: "x",
					beta: "x",
					constructor: "x",
				},
			},
			"test",
		);

		// Before the fix, `mirrorCompiledAttachmentPermissions` (reached from `writeConfigRevisionIn`
		// on every committed change) would read `toolAttachments["constructor"]` through plain
		// bracket access: absent as an own property, it resolves through the prototype chain to
		// `Object.prototype.constructor` (a function, not `undefined`), which `compileAttachments`
		// then fails to iterate over — a `TypeError` on this and every other commit, for any
		// configuration that simply names such an agent, attached to anything or not. An ordinary
		// attach for a different agent exercises exactly that path.
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "native-repository-read",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});

		const read = await loadAgentToolAttachments(deps, "constructor");
		expect(read.hubManaged).toBe(false);
		// Legacy, converted fresh from its own (default) `tools_deny: ["finance.*"]` — never the
		// inherited `Object.prototype.constructor` function a plain bracket lookup would otherwise
		// have returned in its place.
		expect(Array.isArray(read.attachments)).toBe(true);
		expect(read.unresolved).toEqual([]);
	});
});
