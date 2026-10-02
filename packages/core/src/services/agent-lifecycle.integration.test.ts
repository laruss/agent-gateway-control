import { randomUUID } from "node:crypto";
import type { AgentConfig, ChangeSet, OrganizationConfig } from "@agent-gateway/contracts";
import { AgentConfigSchema, OrganizationConfigSchema } from "@agent-gateway/contracts";
import { createPool, migrateSchema } from "@agent-gateway/db";
import { DEVELOPMENT_VERSION, silentLogger } from "@agent-gateway/logging";
import { createBoss, migrateQueues, transactionalJobSink } from "@agent-gateway/queue";
import { startTestPostgres, type TestPostgres } from "@agent-gateway/testkit";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdminError, applyConfig, inTransaction } from "./admin.ts";
import {
	checkpointOperation,
	completeOperation,
	ensureAgentLifecycleAdoption,
	failOperation,
	listLifecycleOperations,
	listRunningLifecycleOperations,
	markProvisioning,
	type RequestOperationRetryResult,
	requestAgentCreate,
	requestAgentRestore,
	requestAgentRetire,
	requestOperationRetry,
	StaleLifecycleOperationError,
} from "./agent-lifecycle.ts";
import type { ControlPlaneDeps } from "./deps.ts";
import {
	activeConfigRevisionId,
	commitChange,
	commitChangeIn,
	loadActiveBundle,
} from "./management.ts";
import { listMemory } from "./memory.ts";
import { handleRunReport } from "./runs.ts";
import { recordWorkerStatus } from "./runtime-health.ts";
import { attachTool, deleteCatalogEntry, ensureToolCatalogSeeded } from "./tool-catalog.ts";

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
	// `token_secret_file` allows only `[a-z0-9_]` after `/run/secrets/`; an id with a hyphen (a
	// valid `AgentIdSchema`) needs it replaced for the secret path alone.
	const secretId = id.replace(/-/g, "_");
	return AgentConfigSchema.parse({
		schema_version: 1,
		id,
		display_name: id,
		enabled: true,
		mattermost: { username: id, token_secret_file: `/run/secrets/mm_${secretId}_token` },
		runtime: { adapter: "mock", session_policy: "stateless", timeout_seconds: 60 },
		prompts: { role_file: `prompts/${id}.md` },
		wake_rules: [],
		concurrency: { while_running: "enqueue" },
		permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: ["finance.*"] },
		memory: { private_namespace: `agents/${id}`, shared_namespaces: [] },
		...overrides,
	});
}

/** A fresh agent's create input, reusing the mock adapter every ready-runtime check below marks
 * available (`markMockReady`). */
function createInput(id: string, overrides: Record<string, unknown> = {}) {
	return {
		agent: {
			id,
			display_name: id,
			// Never `token_secret_file`: a create request may not choose it (ADR-026); the service
			// always generates `/run/bot-secrets/mm_<id>_token` itself.
			mattermost: { username: id },
			runtime: {
				adapter: "mock" as const,
				session_policy: "stateless" as const,
				timeout_seconds: 60,
			},
			prompts: { role_file: `prompts/${id}.md` },
			wake_rules: [],
			concurrency: { max_active_runs: 1, while_running: "enqueue" as const },
			permissions: {
				tools_allow: [],
				tools_require_human_approval: [],
				tools_deny: ["finance.*"],
			},
			memory: { private_namespace: `agents/${id}`, shared_namespaces: [] },
			...overrides,
		},
		rolePrompt: `Role prompt for ${id}.`,
		actor: "test",
		source: "cli" as const,
	};
}

describe("agent lifecycle service (ADR-026)", () => {
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

	/** A fresh active configuration with `preexisting` agents, and the mock runtime marked ready
	 * (every new agent in these tests requests the mock adapter). Every test starts here, so no
	 * lifecycle or configuration state leaks between tests. */
	async function reset(preexisting: Readonly<AgentConfig[]> = []): Promise<void> {
		// Never `config_revisions`/`config_snapshots`/`audit_log`: all three are append-only and
		// refuse TRUNCATE itself (migrations 0001/0019). They simply keep growing across tests;
		// every assertion against them is a delta or scoped to one test's own agent id.
		await pool.query(
			"truncate agent_lifecycle_operations, agent_lifecycle, agent_runs, agent_inbox, mattermost_identities, agents, config_versions, gateway_controls, runtime_workers, runtime_availability restart identity cascade",
		);
		// `organization().finance_agent_id` must name a configured agent (`validateConfigBundle`);
		// present in every reset so every test's own bundle validates, whether or not that test
		// cares about it.
		const configured = [agent("finance"), ...preexisting];
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
		await recordWorkerStatus(
			deps,
			"mock",
			{
				kind: "worker_status",
				workerId: randomUUID(),
				sequence: 1,
				status: "ready",
				runtimeVersion: "test",
				detail: "",
			},
			new Date(),
		);
	}

	beforeEach(async () => {
		await reset();
	});

	it("create commits a config revision and records lifecycle+operation pending, atomically", async () => {
		const before = (await pool.query("select count(*)::int as n from config_revisions")).rows[0].n;
		const created = await requestAgentCreate(deps, createInput("alpha"));
		expect(created.agentId).toBe("alpha");

		const [lifecycle] = (
			await pool.query(
				"select status, generation::int, operation_id from agent_lifecycle where agent_id = $1",
				["alpha"],
			)
		).rows;
		expect(lifecycle).toMatchObject({
			status: "pending",
			generation: 1,
			operation_id: created.operationId,
		});

		const [operation] = (
			await pool.query(
				"select kind, state, config_revision_id::int from agent_lifecycle_operations where id = $1",
				[created.operationId],
			)
		).rows;
		expect(operation).toMatchObject({
			kind: "create",
			state: "pending",
			config_revision_id: created.revisionId,
		});

		const after = (await pool.query("select count(*)::int as n from config_revisions")).rows[0].n;
		expect(after).toBe(before + 1);
		expect(await activeConfigRevisionId(deps)).toBe(created.revisionId);
	});

	it("generates a bot-secrets token file for a create request that leaves it unset", async () => {
		const input = createInput("betagen");
		const mattermost = { username: "betagen" };
		await requestAgentCreate(deps, { ...input, agent: { ...input.agent, mattermost } });

		const [identity] = (
			await pool.query("select token_secret_ref from mattermost_identities where agent_id = $1", [
				"betagen",
			])
		).rows;
		expect(identity.token_secret_ref).toBe("/run/bot-secrets/mm_betagen_token");
	});

	it("refuses a /run/bot-secrets/ token path in configuration for an agent that is not lifecycle-owned", async () => {
		// `finance` comes from `reset()` through `applyConfig` alone: no `agent_lifecycle` row at
		// all, so it is certainly not lifecycle-owned (neither a `create` nor a `restore` operation
		// ever named it).
		const revisionId = await activeConfigRevisionId(deps);
		const [{ config }] = (await pool.query("select config from agents where id = 'finance'")).rows;
		const claimed: AgentConfig = {
			...config,
			mattermost: { ...config.mattermost, token_secret_file: "/run/bot-secrets/mm_finance_token" },
		};
		await expect(
			commitChange(deps, {
				changeSet: [{ type: "update_agent", agent: claimed }],
				baseRevisionId: revisionId,
				actor: "test",
				source: "console",
			}),
		).rejects.toThrow(/not created or restored through the lifecycle/);
	});

	it("config apply (the deprecated whole-bundle path) refuses the same /run/bot-secrets/ path, and queues a reprovision the same way a managed commit does", async () => {
		const [{ config: financeConfig }] = (
			await pool.query("select config from agents where id = 'finance'")
		).rows;
		const claimed: AgentConfig = {
			...financeConfig,
			mattermost: {
				...financeConfig.mattermost,
				token_secret_file: "/run/bot-secrets/mm_finance_token",
			},
		};
		await expect(
			applyConfig(
				deps,
				{
					organization: organization(),
					agents: [claimed],
					constitution: "Be helpful.",
					rolePrompts: { finance: "Role prompt for finance." },
				},
				"test",
			),
		).rejects.toThrow(/not created or restored through the lifecycle/);

		const org = organization();
		const extendedOrg = { ...org, mattermost: { ...org.mattermost, channels: ["hq", "research"] } };
		const created = await requestAgentCreate(
			deps,
			createInput("apply-reprovision", {
				mattermost: { username: "apply-reprovision", allowed_channels: ["hq"] },
			}),
		);
		await markProvisioning(deps, created.operationId, "test");
		await completeOperation(deps, created.operationId, "test");
		const [{ config: appliedConfig }] = (
			await pool.query("select config from agents where id = 'apply-reprovision'")
		).rows;
		const changed: AgentConfig = {
			...appliedConfig,
			mattermost: { ...appliedConfig.mattermost, allowed_channels: ["hq", "research"] },
		};
		await applyConfig(
			deps,
			{
				organization: extendedOrg,
				agents: [financeConfig, changed],
				constitution: "Be helpful.",
				rolePrompts: { finance: "Role prompt for finance.", "apply-reprovision": "Role prompt." },
			},
			"test",
		);
		const [queued] = (
			await pool.query(
				"select kind, state from agent_lifecycle_operations where agent_id = 'apply-reprovision' order by created_at desc limit 1",
			)
		).rows;
		expect(queued).toMatchObject({ kind: "reprovision", state: "pending" });
	});

	it("refuses changing a ready lifecycle-owned agent's token_secret_file via a managed commit: it is server-generated and immutable for it", async () => {
		const created = await requestAgentCreate(deps, createInput("tokenpath-guard"));
		await markProvisioning(deps, created.operationId, "test");
		await completeOperation(deps, created.operationId, "test");

		const revisionId = await activeConfigRevisionId(deps);
		const [{ config }] = (
			await pool.query("select config from agents where id = 'tokenpath-guard'")
		).rows;
		const redirected: AgentConfig = {
			...config,
			mattermost: {
				...config.mattermost,
				token_secret_file: "/run/bot-secrets/mm_tokenpath_guard_other_token",
			},
		};
		await expect(
			commitChange(deps, {
				changeSet: [{ type: "update_agent", agent: redirected }],
				baseRevisionId: revisionId,
				actor: "test",
				source: "console",
			}),
		).rejects.toThrow(/token_secret_file is server-generated/);
	});

	it("config apply (the deprecated whole-bundle path) refuses the same token_secret_file redirection for a ready lifecycle-owned agent", async () => {
		const created = await requestAgentCreate(deps, createInput("tokenpath-guard-apply"));
		await markProvisioning(deps, created.operationId, "test");
		await completeOperation(deps, created.operationId, "test");

		const [{ config: financeConfig }] = (
			await pool.query("select config from agents where id = 'finance'")
		).rows;
		const [{ config }] = (
			await pool.query("select config from agents where id = 'tokenpath-guard-apply'")
		).rows;
		const redirected: AgentConfig = {
			...config,
			mattermost: {
				...config.mattermost,
				token_secret_file: "/run/bot-secrets/mm_tokenpath_guard_apply_other_token",
			},
		};
		await expect(
			applyConfig(
				deps,
				{
					organization: organization(),
					agents: [financeConfig, redirected],
					constitution: "Be helpful.",
					rolePrompts: {
						finance: "Role prompt for finance.",
						"tokenpath-guard-apply": "Role prompt.",
					},
				},
				"test",
			),
		).rejects.toThrow(/token_secret_file is server-generated/);
	});

	it("config apply that only changes the organization's Mattermost team queues a reprovision for a ready lifecycle-owned agent whose own channels never changed", async () => {
		const created = await requestAgentCreate(
			deps,
			createInput("team-move", {
				mattermost: { username: "team-move", allowed_channels: ["hq"] },
			}),
		);
		await markProvisioning(deps, created.operationId, "test");
		await completeOperation(deps, created.operationId, "test");

		const [{ config: financeConfig }] = (
			await pool.query("select config from agents where id = 'finance'")
		).rows;
		const [{ config: movedConfig }] = (
			await pool.query("select config from agents where id = 'team-move'")
		).rows;
		const org = organization();
		const movedOrg = { ...org, mattermost: { ...org.mattermost, team: "lab2" } };
		await applyConfig(
			deps,
			{
				organization: movedOrg,
				agents: [financeConfig, movedConfig],
				constitution: "Be helpful.",
				rolePrompts: { finance: "Role prompt for finance.", "team-move": "Role prompt." },
			},
			"test",
		);
		const [queued] = (
			await pool.query(
				"select kind, state from agent_lifecycle_operations where agent_id = 'team-move' order by created_at desc limit 1",
			)
		).rows;
		expect(queued).toMatchObject({ kind: "reprovision", state: "pending" });
	});

	it("a managed commit that only changes the organization's Mattermost team queues a reprovision for a ready lifecycle-owned agent whose own channels never changed", async () => {
		const created = await requestAgentCreate(
			deps,
			createInput("team-move-managed", {
				mattermost: { username: "team-move-managed", allowed_channels: ["hq"] },
			}),
		);
		await markProvisioning(deps, created.operationId, "test");
		await completeOperation(deps, created.operationId, "test");

		const [{ config: financeConfig }] = (
			await pool.query("select config from agents where id = 'finance'")
		).rows;
		const [{ config: movedConfig }] = (
			await pool.query("select config from agents where id = 'team-move-managed'")
		).rows;
		const org = organization();
		const movedOrg = { ...org, mattermost: { ...org.mattermost, team: "lab2" } };
		await commitChange(deps, {
			changeSet: [
				{
					type: "replace_bundle",
					bundle: {
						organization: movedOrg,
						agents: [financeConfig, movedConfig],
						constitution: "Be helpful.",
						rolePrompts: {
							finance: "Role prompt for finance.",
							"team-move-managed": "Role prompt.",
						},
					},
				},
			],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "owner",
			source: "console",
		});
		const [queued] = (
			await pool.query(
				"select kind, state from agent_lifecycle_operations where agent_id = 'team-move-managed' order by created_at desc limit 1",
			)
		).rows;
		expect(queued).toMatchObject({ kind: "reprovision", state: "pending" });
	});

	it("an invalid agent definition leaves no trace: no revision, no agent row, no lifecycle row", async () => {
		const revisionsBefore = (await pool.query("select count(*)::int as n from config_revisions"))
			.rows[0].n;
		await expect(
			requestAgentCreate(
				deps,
				createInput("broken", { concurrency: { max_active_runs: 2, while_running: "enqueue" } }),
			),
		).rejects.toThrow(AdminError);

		const revisionsAfter = (await pool.query("select count(*)::int as n from config_revisions"))
			.rows[0].n;
		expect(revisionsAfter).toBe(revisionsBefore);
		expect((await pool.query("select 1 from agents where id = 'broken'")).rowCount).toBe(0);
		expect(
			(await pool.query("select 1 from agent_lifecycle where agent_id = 'broken'")).rowCount,
		).toBe(0);
	});

	it("replays a duplicate create carrying the same idempotency key", async () => {
		const input = createInput("replayed", {});
		const first = await requestAgentCreate(deps, { ...input, idempotencyKey: "create-replayed-1" });
		const second = await requestAgentCreate(deps, {
			...input,
			idempotencyKey: "create-replayed-1",
		});
		expect(second).toEqual(first);
		const count = (
			await pool.query(
				"select count(*)::int as n from agent_lifecycle_operations where agent_id = $1",
				["replayed"],
			)
		).rows[0].n;
		expect(count).toBe(1);
	});

	it("refuses the same agent id again in any status, including retired", async () => {
		const created = await requestAgentCreate(deps, createInput("gamma"));
		await expect(requestAgentCreate(deps, createInput("gamma"))).rejects.toThrow(AdminError);

		await markProvisioning(deps, created.operationId, "test");
		await completeOperation(deps, created.operationId, "test");
		await requestAgentRetire(deps, { agentId: "gamma", actor: "test", source: "cli" });

		await expect(requestAgentCreate(deps, createInput("gamma"))).rejects.toThrow(
			/agent ids are never reused/,
		);
	});

	it("refuses a Mattermost username already used by another agent", async () => {
		await requestAgentCreate(deps, createInput("delta"));
		await expect(
			requestAgentCreate(
				deps,
				createInput("epsilon", {
					mattermost: { username: "delta" },
				}),
			),
		).rejects.toThrow(/username/);
	});

	it("refuses an explicit runtime adapter with no ready worker on this deployment", async () => {
		await expect(
			requestAgentCreate(
				deps,
				createInput("zeta", {
					runtime: { adapter: "claude-code", session_policy: "stateless", timeout_seconds: 60 },
				}),
			),
		).rejects.toThrow(/not installed and qualified/);
	});

	it("refuses the default codex adapter when codex has no ready worker either", async () => {
		await expect(
			requestAgentCreate(deps, createInput("eta", { runtime: undefined })),
		).rejects.toThrow(/not installed and qualified/);
	});

	it("lets exactly one of two concurrent creates of the same id succeed", async () => {
		const results = await Promise.allSettled([
			requestAgentCreate(deps, createInput("theta")),
			requestAgentCreate(deps, createInput("theta")),
		]);
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		const count = (
			await pool.query("select count(*)::int as n from agent_lifecycle where agent_id = 'theta'")
		).rows[0].n;
		expect(count).toBe(1);
	});

	it("retire moves the agent to retiring and removes it from the active configuration", async () => {
		const created = await requestAgentCreate(deps, createInput("iota"));
		await markProvisioning(deps, created.operationId, "test");
		await completeOperation(deps, created.operationId, "test");

		const retired = await requestAgentRetire(deps, {
			agentId: "iota",
			actor: "test",
			source: "cli",
			reason: "no longer needed",
		});
		const [lifecycle] = (
			await pool.query(
				"select status, generation::int from agent_lifecycle where agent_id = 'iota'",
			)
		).rows;
		expect(lifecycle).toMatchObject({ status: "retiring", generation: 2 });

		const activeRevisionId = await activeConfigRevisionId(deps);
		expect(activeRevisionId).toBe(retired.revisionId);
		const [enabled] = (await pool.query("select enabled from agents where id = 'iota'")).rows;
		expect(enabled.enabled).toBe(false);
	});

	it("restore re-adds a retired agent's last configuration, pending again", async () => {
		const created = await requestAgentCreate(deps, createInput("kappa"));
		await markProvisioning(deps, created.operationId, "test");
		await completeOperation(deps, created.operationId, "test");
		const retired = await requestAgentRetire(deps, {
			agentId: "kappa",
			actor: "test",
			source: "cli",
		});
		await markProvisioning(deps, retired.operationId, "test");
		await completeOperation(deps, retired.operationId, "test");

		const restored = await requestAgentRestore(deps, {
			agentId: "kappa",
			actor: "test",
			source: "cli",
		});
		const [lifecycle] = (
			await pool.query(
				"select status, generation::int, retired_at from agent_lifecycle where agent_id = 'kappa'",
			)
		).rows;
		expect(lifecycle).toMatchObject({ status: "pending", generation: 3, retired_at: null });

		const [row] = (await pool.query("select enabled from agents where id = 'kappa'")).rows;
		expect(row.enabled).toBe(true);
		expect(await activeConfigRevisionId(deps)).toBe(restored.revisionId);
	});

	it("restore carries the agent's last hub-managed attachments forward, including an explicitly empty list (ADR-027)", async () => {
		await ensureToolCatalogSeeded(deps, "test");
		const created = await requestAgentCreate(deps, createInput("mu"));
		await markProvisioning(deps, created.operationId, "test");
		await completeOperation(deps, created.operationId, "test");
		await attachTool(deps, {
			agentId: "mu",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});
		const retired = await requestAgentRetire(deps, { agentId: "mu", actor: "test", source: "cli" });
		await markProvisioning(deps, retired.operationId, "test");
		await completeOperation(deps, retired.operationId, "test");

		const restored = await requestAgentRestore(deps, {
			agentId: "mu",
			actor: "test",
			source: "cli",
		});
		expect(restored.droppedAttachments).toEqual([]);
		const { bundle } = await inTransaction(deps, ({ tx }) =>
			loadActiveBundle(tx.db, restored.revisionId),
		);
		expect(bundle.toolAttachments.mu).toEqual([
			{ entryId: "gateway-mattermost-post", pinnedVersion: null, mode: "allow", settings: {} },
		]);

		// A second agent, explicitly cleared (hub-managed but empty) before it retires, is restored
		// the same way: still hub-managed (a key of its own), just with nothing in it — never
		// reverted to legacy (converted from `permissions`) on restore.
		const createdNu = await requestAgentCreate(deps, createInput("nu"));
		await markProvisioning(deps, createdNu.operationId, "test");
		await completeOperation(deps, createdNu.operationId, "test");
		const attach = await attachTool(deps, {
			agentId: "nu",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});
		await commitChange(deps, {
			changeSet: [{ type: "detach_tool", agentId: "nu", entryId: "gateway-mattermost-post" }],
			baseRevisionId: attach.revisionId,
			actor: "test",
			source: "cli_apply",
		});
		const retiredNu = await requestAgentRetire(deps, {
			agentId: "nu",
			actor: "test",
			source: "cli",
		});
		await markProvisioning(deps, retiredNu.operationId, "test");
		await completeOperation(deps, retiredNu.operationId, "test");
		const restoredNu = await requestAgentRestore(deps, {
			agentId: "nu",
			actor: "test",
			source: "cli",
		});
		const { bundle: bundleNu } = await inTransaction(deps, ({ tx }) =>
			loadActiveBundle(tx.db, restoredNu.revisionId),
		);
		expect(bundleNu.toolAttachments.nu).toEqual([]);
	});

	it("restore drops an attachment to a catalog entry deleted since retirement, reporting it rather than failing or resurrecting it (ADR-027)", async () => {
		await ensureToolCatalogSeeded(deps, "test");
		const created = await requestAgentCreate(deps, createInput("xi"));
		await markProvisioning(deps, created.operationId, "test");
		await completeOperation(deps, created.operationId, "test");
		await attachTool(deps, {
			agentId: "xi",
			entryId: "gateway-memory-write",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});
		const retired = await requestAgentRetire(deps, { agentId: "xi", actor: "test", source: "cli" });
		await markProvisioning(deps, retired.operationId, "test");
		await completeOperation(deps, retired.operationId, "test");
		await deleteCatalogEntry(deps, "gateway-memory-write", "test");

		const restored = await requestAgentRestore(deps, {
			agentId: "xi",
			actor: "test",
			source: "cli",
		});
		expect(restored.droppedAttachments).toEqual([{ entryId: "gateway-memory-write" }]);
		const { bundle } = await inTransaction(deps, ({ tx }) =>
			loadActiveBundle(tx.db, restored.revisionId),
		);
		expect(bundle.toolAttachments.xi).toEqual([]);
	});

	it("restore migrates an adopted (bootstrap-managed) agent's token reference to the lifecycle provisioner's own path", async () => {
		// `finance` (from `reset()`) is bootstrap-managed: `agent("finance")` gives it the operator's
		// own `/run/secrets/mm_finance_token`, never touched by `requestAgentCreate`. Adopted, then
		// retired (which revokes that token server-side, ADR-026) and restored.
		await reset([agent("accountant")]);
		await ensureAgentLifecycleAdoption(deps, "test");
		const retired = await requestAgentRetire(deps, {
			agentId: "finance",
			actor: "test",
			source: "cli",
			reassignFinanceTo: "accountant",
		});
		await markProvisioning(deps, retired.operationId, "test");
		await completeOperation(deps, retired.operationId, "test");

		const restored = await requestAgentRestore(deps, {
			agentId: "finance",
			actor: "test",
			source: "cli",
		});

		// Never the historical `/run/secrets/mm_finance_token`: restoring it unchanged would leave
		// the provisioner unable to write a fresh token to a path the controller only mounts
		// read-only (the old file is simply stale from here on, documented in ADR-026). Migrated as
		// part of the very same change set the restore commits, so config and lifecycle agree from
		// the start.
		const [{ config }] = (await pool.query("select config from agents where id = 'finance'")).rows;
		expect(config.mattermost.token_secret_file).toBe("/run/bot-secrets/mm_finance_token");
		const [identity] = (
			await pool.query(
				"select token_secret_ref from mattermost_identities where agent_id = 'finance'",
			)
		).rows;
		expect(identity.token_secret_ref).toBe("/run/bot-secrets/mm_finance_token");
		expect(await activeConfigRevisionId(deps)).toBe(restored.revisionId);
	});

	it("restore normalizes a former finance agent's permissions, unless makeFinanceAgent reassigns the role back to it atomically", async () => {
		await reset([agent("accountant")]);
		await ensureAgentLifecycleAdoption(deps, "test");

		// Grants "finance" the shape `financeIssues` allows only while an agent actually is the
		// organization's finance agent: a non-read finance action in `tools_require_human_approval`
		// (never required in `tools_allow`), and no `finance.*` in `tools_deny` (never required of
		// it either while it holds the role).
		const [{ config: financeConfig }] = (
			await pool.query("select config from agents where id = 'finance'")
		).rows;
		const financeShaped: AgentConfig = {
			...financeConfig,
			permissions: {
				tools_allow: ["finance.read"],
				tools_require_human_approval: ["finance.payment.create"],
				tools_deny: [],
				// An unrelated permission field, same as the operator example agent's own
				// (`config/examples/agents/operator.yaml`): normalizing the finance-related fields
				// must never drop a field it does not itself adjust.
				observe_system: true,
			},
		};
		await commitChange(deps, {
			changeSet: [{ type: "update_agent", agent: financeShaped }],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "test",
			source: "cli_apply",
		});

		const retired = await requestAgentRetire(deps, {
			agentId: "finance",
			actor: "test",
			source: "cli",
			reassignFinanceTo: "accountant",
		});
		await markProvisioning(deps, retired.operationId, "test");
		await completeOperation(deps, retired.operationId, "test");

		// Restoring it unchanged would fail `validateConfigBundle`'s own finance rule the moment it
		// restores to anyone but today's finance agent ("accountant", now): this must not throw.
		const restored = await requestAgentRestore(deps, {
			agentId: "finance",
			actor: "test",
			source: "cli",
		});
		expect(await activeConfigRevisionId(deps)).toBe(restored.revisionId);
		const [{ config: normalized }] = (
			await pool.query("select config from agents where id = 'finance'")
		).rows;
		expect(normalized.permissions.tools_allow).not.toContain("finance.read");
		expect(normalized.permissions.tools_require_human_approval).not.toContain(
			"finance.payment.create",
		);
		expect(normalized.permissions.tools_deny).toContain("finance.*");
		expect(normalized.permissions.observe_system).toBe(true);
	});

	it("restore with makeFinanceAgent reassigns the finance role atomically and keeps the restored agent's finance-shaped permissions", async () => {
		await reset([agent("accountant")]);
		await ensureAgentLifecycleAdoption(deps, "test");

		const [{ config: financeConfig }] = (
			await pool.query("select config from agents where id = 'finance'")
		).rows;
		const financeShaped: AgentConfig = {
			...financeConfig,
			permissions: {
				tools_allow: ["finance.read"],
				tools_require_human_approval: ["finance.payment.create"],
				tools_deny: [],
			},
		};
		await commitChange(deps, {
			changeSet: [{ type: "update_agent", agent: financeShaped }],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "test",
			source: "cli_apply",
		});

		const retired = await requestAgentRetire(deps, {
			agentId: "finance",
			actor: "test",
			source: "cli",
			reassignFinanceTo: "accountant",
		});
		await markProvisioning(deps, retired.operationId, "test");
		await completeOperation(deps, retired.operationId, "test");

		const restored = await requestAgentRestore(deps, {
			agentId: "finance",
			actor: "test",
			source: "cli",
			makeFinanceAgent: true,
		});
		expect(await activeConfigRevisionId(deps)).toBe(restored.revisionId);
		const [{ config: keptShaped }] = (
			await pool.query("select config from agents where id = 'finance'")
		).rows;
		expect(keptShaped.permissions).toEqual(financeShaped.permissions);
		const [org] = (
			await pool.query(
				"select bundle -> 'organization' -> 'organization' ->> 'finance_agent_id' as finance_agent_id from config_snapshots s join config_revisions r on r.snapshot_hash = s.hash where r.id = $1",
				[restored.revisionId],
			)
		).rows;
		expect(org.finance_agent_id).toBe("finance");
	});

	it("restore with makeFinanceAgent also normalizes the outgoing finance agent's permissions, when it actually holds finance tools rather than merely the role", async () => {
		await reset([agent("accountant")]);
		await ensureAgentLifecycleAdoption(deps, "test");

		const retired = await requestAgentRetire(deps, {
			agentId: "finance",
			actor: "test",
			source: "cli",
			reassignFinanceTo: "accountant",
		});
		await markProvisioning(deps, retired.operationId, "test");
		await completeOperation(deps, retired.operationId, "test");

		// "accountant" is now the active finance agent, and genuinely holds finance tools (the same
		// working shape `config/examples/agents/finance.yaml` itself uses) — not merely named the
		// role with none of its own, the way the tests above leave it.
		const [{ config: accountantConfig }] = (
			await pool.query("select config from agents where id = 'accountant'")
		).rows;
		const financeShaped: AgentConfig = {
			...accountantConfig,
			permissions: {
				tools_allow: ["finance.read"],
				tools_require_human_approval: ["finance.payment.create"],
				tools_deny: [],
			},
		};
		await commitChange(deps, {
			changeSet: [{ type: "update_agent", agent: financeShaped }],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "test",
			source: "cli_apply",
		});

		// Restoring "finance" with `makeFinanceAgent` reassigns the role back to it atomically.
		// Without normalizing "accountant" in the same change set, it would be left holding finance
		// tools while no longer the finance agent — refused outright by whole-bundle validation.
		const restored = await requestAgentRestore(deps, {
			agentId: "finance",
			actor: "test",
			source: "cli",
			makeFinanceAgent: true,
		});
		expect(await activeConfigRevisionId(deps)).toBe(restored.revisionId);

		const [{ config: normalizedAccountant }] = (
			await pool.query("select config from agents where id = 'accountant'")
		).rows;
		expect(normalizedAccountant.permissions.tools_allow).not.toContain("finance.read");
		expect(normalizedAccountant.permissions.tools_require_human_approval).not.toContain(
			"finance.payment.create",
		);
		expect(normalizedAccountant.permissions.tools_deny).toContain("finance.*");

		const [org] = (
			await pool.query(
				"select bundle -> 'organization' -> 'organization' ->> 'finance_agent_id' as finance_agent_id from config_snapshots s join config_revisions r on r.snapshot_hash = s.hash where r.id = $1",
				[restored.revisionId],
			)
		).rows;
		expect(org.finance_agent_id).toBe("finance");
	});

	it("refuses to complete an operation a later request already superseded", async () => {
		const created = await requestAgentCreate(deps, createInput("lambda"));
		// Supersedes the create operation: a new `retire` operation and generation.
		await requestAgentRetire(deps, { agentId: "lambda", actor: "test", source: "cli" });

		await expect(completeOperation(deps, created.operationId, "test")).rejects.toThrow(
			StaleLifecycleOperationError,
		);
		await expect(markProvisioning(deps, created.operationId, "test")).rejects.toThrow(
			StaleLifecycleOperationError,
		);
		await expect(failOperation(deps, created.operationId, "test", "too late")).rejects.toThrow(
			StaleLifecycleOperationError,
		);
	});

	it("lists operations left running, for the provisioner to resume after a restart", async () => {
		const created = await requestAgentCreate(deps, createInput("mu"));
		await markProvisioning(deps, created.operationId, "test");

		const running = await listRunningLifecycleOperations(deps);
		expect(running.map((row) => row.id)).toContain(created.operationId);
		expect(running.find((row) => row.id === created.operationId)?.state).toBe("running");
	});

	it("lists operations newest first, scoped to an agent when asked (gateway agents operations)", async () => {
		const first = await requestAgentCreate(deps, createInput("muopsa"));
		const second = await requestAgentCreate(deps, createInput("muopsb"));

		const scoped = await listLifecycleOperations(deps, "muopsa");
		expect(scoped.map((op) => op.id)).toEqual([first.operationId]);
		expect(scoped[0]).toMatchObject({
			agentId: "muopsa",
			kind: "create",
			state: "pending",
			checkpoints: {},
			error: null,
		});

		const everything = await listLifecycleOperations(deps);
		const ids = everything.map((op) => op.id);
		expect(ids.indexOf(second.operationId)).toBeLessThan(ids.indexOf(first.operationId));
	});

	it("failOperation marks the agent failed with a recorded error", async () => {
		const created = await requestAgentCreate(deps, createInput("nu"));
		await markProvisioning(deps, created.operationId, "test");
		await failOperation(deps, created.operationId, "test", "the bot account could not be created");

		const [lifecycle] = (
			await pool.query("select status, last_error from agent_lifecycle where agent_id = 'nu'")
		).rows;
		expect(lifecycle.status).toBe("failed");
		expect(lifecycle.last_error).toBe("the bot account could not be created");
	});

	it("failOperation redacts secrets out of the error before it is stored", async () => {
		const created = await requestAgentCreate(deps, createInput("xi"));
		await markProvisioning(deps, created.operationId, "test");
		await failOperation(
			deps,
			created.operationId,
			"test",
			"bot creation failed: Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
		);

		const [lifecycle] = (
			await pool.query("select last_error from agent_lifecycle where agent_id = 'xi'")
		).rows;
		expect(lifecycle.last_error).not.toContain("abcdefghijklmnopqrstuvwxyz");

		const [operation] = (
			await pool.query("select error from agent_lifecycle_operations where id = $1", [
				created.operationId,
			])
		).rows;
		expect(operation.error).not.toContain("abcdefghijklmnopqrstuvwxyz");
	});

	it("retire cancels a still-running create operation, so it does not strand there forever", async () => {
		const created = await requestAgentCreate(deps, createInput("pi"));
		await markProvisioning(deps, created.operationId, "test");

		await requestAgentRetire(deps, { agentId: "pi", actor: "test", source: "cli" });

		const [createOp] = (
			await pool.query("select state, finished_at from agent_lifecycle_operations where id = $1", [
				created.operationId,
			])
		).rows;
		expect(createOp.state).toBe("cancelled");
		expect(createOp.finished_at).not.toBeNull();

		const running = await listRunningLifecycleOperations(deps);
		expect(running.map((row) => row.id)).not.toContain(created.operationId);
	});

	it("adopts existing agents exactly once, all ready, with or without a resolved identity", async () => {
		await reset([agent("adopted-ready"), agent("adopted-pending")]);
		await pool.query(
			"update mattermost_identities set mattermost_user_id = $1 where agent_id = 'adopted-ready'",
			["abcdefghijklmnopqrstuvwxyz".slice(0, 26)],
		);

		await ensureAgentLifecycleAdoption(deps, "test");
		const rows = (
			await pool.query(
				"select agent_id, status from agent_lifecycle where agent_id in ('adopted-ready', 'adopted-pending') order by agent_id",
			)
		).rows;
		expect(rows).toEqual([
			{ agent_id: "adopted-pending", status: "ready" },
			{ agent_id: "adopted-ready", status: "ready" },
		]);
		// Plus the baseline `finance` agent every `reset()` configures, adopted in the same call.
		const operationCountFirst = (
			await pool.query(
				"select count(*)::int as n from agent_lifecycle_operations where kind = 'adopt'",
			)
		).rows[0].n;
		expect(operationCountFirst).toBe(3);

		// Idempotent: running it again adopts nothing new.
		await ensureAgentLifecycleAdoption(deps, "test");
		const operationCountSecond = (
			await pool.query(
				"select count(*)::int as n from agent_lifecycle_operations where kind = 'adopt'",
			)
		).rows[0].n;
		expect(operationCountSecond).toBe(operationCountFirst);
	});

	it("retire adopts an agent added by config apply/import while the controller kept running, rather than refusing 'has no lifecycle record'", async () => {
		// `reset` itself never calls `ensureAgentLifecycleAdoption`, so "added-live" starts with no
		// `agent_lifecycle` row at all — exactly the gap a config apply/import while the controller
		// runs leaves (adoption happens only at startup or a fresh CLI session, ADR-026).
		await reset([agent("added-live")]);
		const [missing] = (
			await pool.query("select status from agent_lifecycle where agent_id = 'added-live'")
		).rows;
		expect(missing).toBeUndefined();

		const retired = await requestAgentRetire(deps, {
			agentId: "added-live",
			actor: "test",
			source: "cli",
		});
		expect(await activeConfigRevisionId(deps)).toBe(retired.revisionId);
		const [lifecycle] = (
			await pool.query("select status from agent_lifecycle where agent_id = 'added-live'")
		).rows;
		expect(lifecycle.status).toBe("retiring");
	});

	it("lets several concurrent adoptions race without error, exactly one adopt operation per agent", async () => {
		await reset([agent("racer-a"), agent("racer-b")]);

		const results = await Promise.allSettled([
			ensureAgentLifecycleAdoption(deps, "test"),
			ensureAgentLifecycleAdoption(deps, "test"),
			ensureAgentLifecycleAdoption(deps, "test"),
		]);
		for (const result of results) {
			expect(result.status).toBe("fulfilled");
		}

		// `finance` (every `reset()`'s own baseline agent) plus the two just configured here.
		const rows = (
			await pool.query(
				`select agent_id, count(*)::int as n from agent_lifecycle_operations
				  where kind = 'adopt' and agent_id in ('finance', 'racer-a', 'racer-b')
				  group by agent_id`,
			)
		).rows;
		expect(rows).toHaveLength(3);
		for (const row of rows) {
			expect(row.n).toBe(1);
		}
		const lifecycleCount = (
			await pool.query(
				"select count(*)::int as n from agent_lifecycle where agent_id in ('finance', 'racer-a', 'racer-b')",
			)
		).rows[0].n;
		expect(lifecycleCount).toBe(3);
	});

	/** Whether `error`, or anything in its `cause` chain, is Postgres's own "deadlock detected":
	 * drizzle wraps the driver's error as `cause` of its own `Failed query: ...`, so the deadlock
	 * text is never in the top-level message. */
	function isDeadlock(error: unknown): boolean {
		for (let current: unknown = error; current instanceof Error; current = current.cause) {
			if (/deadlock detected/i.test(current.message)) {
				return true;
			}
		}
		return false;
	}

	it("retire racing a concurrent operation transition never deadlocks (lock order: lifecycle row, then operation rows)", async () => {
		// `requestAgentRetire` locks the agent's lifecycle row, then — still under that lock, after
		// the heavier `commitChangeIn` work — its operation rows (`cancelNonterminalOperations`);
		// `lockCurrentOperation` (`markProvisioning`/`completeOperation`/`failOperation`) must lock
		// the same two rows in the same order, or the two can deadlock (Postgres 40P01): one holds
		// the lifecycle row waiting for the operation row the other already holds, which is in turn
		// waiting for the lifecycle row. `completeOperation` alone reaches its first lock in one
		// round trip against retire's three (`gateway_controls`, then the lifecycle row), so a
		// plain, simultaneous race never lands inside that window — retire needs a small head start
		// to still be holding the lifecycle row when `completeOperation` reaches for it, exactly the
		// interleaving a provisioner's own transition can hit against a concurrent retirement.
		for (let i = 0; i < 20; i += 1) {
			const agentId = `deadlock-${i}`;
			const created = await requestAgentCreate(deps, createInput(agentId));
			await markProvisioning(deps, created.operationId, "test");
			const retiring = requestAgentRetire(deps, { agentId, actor: "test", source: "cli" });
			await new Promise((resolve) => setTimeout(resolve, 5));
			const results = await Promise.allSettled([
				retiring,
				completeOperation(deps, created.operationId, "test"),
			]);
			for (const result of results) {
				if (result.status === "rejected") {
					// Either side of the race may lose (the operation was superseded) — anything but a
					// deadlock.
					expect(isDeadlock(result.reason)).toBe(false);
				}
			}
		}
	});

	it("a channel-config commit racing completeOperation of a reprovision never deadlocks (lock order: lifecycle row, then agent row)", async () => {
		// A config writer that queues a `reprovision` locks the affected agents' lifecycle rows
		// before it locks the `agents` table itself (`lockLifecycleRows`); `completeOperation` locks
		// the lifecycle row, then (through `scheduleAgent`) the agent row. Getting the writer's own
		// order backwards — as the very first version of this queuing did — risks exactly the
		// deadlock the test above already covers for `retire`'s own two rows, one level further out.
		for (let i = 0; i < 20; i += 1) {
			const agentId = `reprovision-deadlock-${i}`;
			const created = await requestAgentCreate(
				deps,
				createInput(agentId, { mattermost: { username: agentId, allowed_channels: ["hq"] } }),
			);
			await markProvisioning(deps, created.operationId, "test");
			await completeOperation(deps, created.operationId, "test");

			const [{ config }] = (await pool.query("select config from agents where id = $1", [agentId]))
				.rows;
			const emptied = { ...config, mattermost: { ...config.mattermost, allowed_channels: [] } };
			await commitChange(deps, {
				changeSet: [{ type: "update_agent", agent: emptied }],
				baseRevisionId: await activeConfigRevisionId(deps),
				actor: "owner",
				source: "console",
			});
			const [reprovisionOp] = (
				await pool.query(
					"select id from agent_lifecycle_operations where agent_id = $1 and kind = 'reprovision' order by created_at desc limit 1",
					[agentId],
				)
			).rows;
			// Simulates the provisioner having already claimed this operation.
			await markProvisioning(deps, reprovisionOp.id, "test");

			const [{ config: config2 }] = (
				await pool.query("select config from agents where id = $1", [agentId])
			).rows;
			const restored = {
				...config2,
				mattermost: { ...config2.mattermost, allowed_channels: ["hq"] },
			};
			const committing = commitChange(deps, {
				changeSet: [{ type: "update_agent", agent: restored }],
				baseRevisionId: await activeConfigRevisionId(deps),
				actor: "owner",
				source: "console",
			});
			await new Promise((resolve) => setTimeout(resolve, 5));
			const results = await Promise.allSettled([
				committing,
				completeOperation(deps, reprovisionOp.id, "test"),
			]);
			for (const result of results) {
				if (result.status === "rejected") {
					expect(isDeadlock(result.reason)).toBe(false);
				}
			}
		}
	});

	describe("retry (ADR-026)", () => {
		it("retry after a failed create completes", async () => {
			const created = await requestAgentCreate(deps, createInput("retry-create"));
			await markProvisioning(deps, created.operationId, "test");
			await failOperation(
				deps,
				created.operationId,
				"test",
				"the bot account could not be created",
			);

			const retried = await requestOperationRetry(deps, {
				agentId: "retry-create",
				actor: "test",
				source: "cli",
			});
			expect(retried.kind).toBe("create");
			expect(retried.operationId).not.toBe(created.operationId);

			const [lifecycle] = (
				await pool.query(
					"select status, generation::int, operation_id, last_error from agent_lifecycle where agent_id = 'retry-create'",
				)
			).rows;
			expect(lifecycle).toMatchObject({
				status: "pending",
				generation: 2,
				operation_id: retried.operationId,
				last_error: null,
			});
			// The superseded operation stays exactly as `failOperation` left it: the journal is
			// append-only, so retry never resurrects it, only queues a fresh one.
			const [oldOperation] = (
				await pool.query("select state from agent_lifecycle_operations where id = $1", [
					created.operationId,
				])
			).rows;
			expect(oldOperation.state).toBe("failed");

			await markProvisioning(deps, retried.operationId, "test");
			await completeOperation(deps, retried.operationId, "test");
			const [settled] = (
				await pool.query("select status from agent_lifecycle where agent_id = 'retry-create'")
			).rows;
			expect(settled.status).toBe("ready");
		});

		it("carries the failed operation's own checkpoints forward, so a completed step is not repeated", async () => {
			const created = await requestAgentCreate(deps, createInput("retry-checkpoints"));
			await markProvisioning(deps, created.operationId, "test");
			await checkpointOperation(deps, created.operationId, {
				bot_user_id: "abcdefghijklmnopqrstuvwxyz",
				token_ref: "/run/bot-secrets/mm_retry_checkpoints_token",
			});
			await failOperation(deps, created.operationId, "test", "team join failed");

			const retried = await requestOperationRetry(deps, {
				agentId: "retry-checkpoints",
				actor: "test",
				source: "cli",
			});
			const [operation] = (
				await pool.query("select checkpoints from agent_lifecycle_operations where id = $1", [
					retried.operationId,
				])
			).rows;
			expect(operation.checkpoints).toMatchObject({
				bot_user_id: "abcdefghijklmnopqrstuvwxyz",
				token_ref: "/run/bot-secrets/mm_retry_checkpoints_token",
			});
		});

		it("retry of a failed retire completes, leaving the agent retiring throughout", async () => {
			const created = await requestAgentCreate(deps, createInput("retry-retire"));
			await markProvisioning(deps, created.operationId, "test");
			await completeOperation(deps, created.operationId, "test");

			const retired = await requestAgentRetire(deps, {
				agentId: "retry-retire",
				actor: "test",
				source: "cli",
			});
			await markProvisioning(deps, retired.operationId, "test");
			await failOperation(deps, retired.operationId, "test", "the admin token was rejected");

			const [beforeRetry] = (
				await pool.query("select status from agent_lifecycle where agent_id = 'retry-retire'")
			).rows;
			expect(beforeRetry.status).toBe("retiring");

			const retriedAgain = await requestOperationRetry(deps, {
				agentId: "retry-retire",
				actor: "test",
				source: "cli",
			});
			expect(retriedAgain.kind).toBe("retire");

			const [lifecycle] = (
				await pool.query(
					"select status, last_error from agent_lifecycle where agent_id = 'retry-retire'",
				)
			).rows;
			expect(lifecycle).toMatchObject({ status: "retiring", last_error: null });

			await markProvisioning(deps, retriedAgain.operationId, "test");
			await completeOperation(deps, retriedAgain.operationId, "test");
			const [settled] = (
				await pool.query("select status from agent_lifecycle where agent_id = 'retry-retire'")
			).rows;
			expect(settled.status).toBe("retired");
		});

		it("a reprovision that fails permanently leaves the agent ready, and retrying it keeps the agent ready throughout", async () => {
			const agentId = "retry-reprovision";
			const created = await requestAgentCreate(
				deps,
				createInput(agentId, { mattermost: { username: agentId, allowed_channels: ["hq"] } }),
			);
			await markProvisioning(deps, created.operationId, "test");
			await completeOperation(deps, created.operationId, "test");

			const [{ config }] = (await pool.query("select config from agents where id = $1", [agentId]))
				.rows;
			const changed = {
				...config,
				mattermost: { ...config.mattermost, allowed_channels: [] },
			};
			await commitChange(deps, {
				changeSet: [{ type: "update_agent", agent: changed }],
				baseRevisionId: await activeConfigRevisionId(deps),
				actor: "owner",
				source: "console",
			});
			const [reprovisionOp] = (
				await pool.query(
					"select id from agent_lifecycle_operations where agent_id = $1 and kind = 'reprovision' order by created_at desc limit 1",
					[agentId],
				)
			).rows;

			// Queuing it never moved the agent out of `ready` (ADR-026); nor does claiming it.
			await markProvisioning(deps, reprovisionOp.id, "test");
			const [reconciling] = (
				await pool.query("select status from agent_lifecycle where agent_id = $1", [agentId])
			).rows;
			expect(reconciling.status).toBe("ready");

			await failOperation(deps, reprovisionOp.id, "test", "the bot's username is taken");
			const [failed] = (
				await pool.query("select status, last_error from agent_lifecycle where agent_id = $1", [
					agentId,
				])
			).rows;
			// A permanent failure does not stop the scheduler either: still `ready`, with the error
			// recorded for `gateway doctor` and the console to surface, and the failed operation
			// itself still visible (and retryable) rather than silently dropped.
			expect(failed).toMatchObject({ status: "ready", last_error: "the bot's username is taken" });
			const [failedOp] = (
				await pool.query("select state from agent_lifecycle_operations where id = $1", [
					reprovisionOp.id,
				])
			).rows;
			expect(failedOp.state).toBe("failed");

			const retried = await requestOperationRetry(deps, { agentId, actor: "test", source: "cli" });
			expect(retried.kind).toBe("reprovision");
			const [afterRetry] = (
				await pool.query("select status, last_error from agent_lifecycle where agent_id = $1", [
					agentId,
				])
			).rows;
			expect(afterRetry).toMatchObject({ status: "ready", last_error: null });

			await markProvisioning(deps, retried.operationId, "test");
			const [stillReady] = (
				await pool.query("select status from agent_lifecycle where agent_id = $1", [agentId])
			).rows;
			expect(stillReady.status).toBe("ready");

			await completeOperation(deps, retried.operationId, "test");
			const [settled] = (
				await pool.query("select status from agent_lifecycle where agent_id = $1", [agentId])
			).rows;
			expect(settled.status).toBe("ready");
		});

		it("refuses to retry an agent whose current operation is not actually failed", async () => {
			const created = await requestAgentCreate(deps, createInput("retry-not-failed"));
			// Still `pending`: nothing has failed yet.
			await expect(
				requestOperationRetry(deps, { agentId: "retry-not-failed", actor: "test", source: "cli" }),
			).rejects.toThrow(/not failed; nothing to retry/);

			await markProvisioning(deps, created.operationId, "test");
			await completeOperation(deps, created.operationId, "test");
			// Now `ready`, its operation `succeeded`.
			await expect(
				requestOperationRetry(deps, { agentId: "retry-not-failed", actor: "test", source: "cli" }),
			).rejects.toThrow(AdminError);
		});

		it("refuses to retry an agent with no lifecycle record at all", async () => {
			await expect(
				requestOperationRetry(deps, { agentId: "finance", actor: "test", source: "cli" }),
			).rejects.toThrow(/has no lifecycle record/);
		});

		it("replays a duplicate retry carrying the same idempotency key", async () => {
			const created = await requestAgentCreate(deps, createInput("retry-idempotent"));
			await markProvisioning(deps, created.operationId, "test");
			await failOperation(
				deps,
				created.operationId,
				"test",
				"the bot account could not be created",
			);

			const idempotencyKey = randomUUID();
			const first = await requestOperationRetry(deps, {
				agentId: "retry-idempotent",
				actor: "test",
				source: "cli",
				idempotencyKey,
			});
			const second = await requestOperationRetry(deps, {
				agentId: "retry-idempotent",
				actor: "test",
				source: "cli",
				idempotencyKey,
			});
			expect(second).toEqual(first);

			const [{ n }] = (
				await pool.query(
					"select count(*)::int as n from agent_lifecycle_operations where agent_id = 'retry-idempotent'",
				)
			).rows;
			// The original `create` plus the one retry — the replayed call inserted nothing further.
			expect(n).toBe(2);
		});

		it("refuses an idempotency key already used for a retry of a different kind of operation on the same agent", async () => {
			const agentId = "retry-kind-mismatch";
			const created = await requestAgentCreate(
				deps,
				createInput(agentId, { mattermost: { username: agentId, allowed_channels: ["hq"] } }),
			);
			await markProvisioning(deps, created.operationId, "test");
			await failOperation(
				deps,
				created.operationId,
				"test",
				"the bot account could not be created",
			);

			const idempotencyKey = randomUUID();
			const createRetry = await requestOperationRetry(deps, {
				agentId,
				actor: "test",
				source: "cli",
				idempotencyKey,
			});
			expect(createRetry.kind).toBe("create");
			await markProvisioning(deps, createRetry.operationId, "test");
			await completeOperation(deps, createRetry.operationId, "test");

			// The agent's current operation is now a failed `reprovision`, not the `create` the key was
			// first used for: reusing it must be refused, never silently handed back as if it had just
			// retried this entirely different operation.
			const [{ config }] = (await pool.query("select config from agents where id = $1", [agentId]))
				.rows;
			const changed = {
				...config,
				mattermost: { ...config.mattermost, allowed_channels: [] },
			};
			await commitChange(deps, {
				changeSet: [{ type: "update_agent", agent: changed }],
				baseRevisionId: await activeConfigRevisionId(deps),
				actor: "owner",
				source: "console",
			});
			const [reprovisionOp] = (
				await pool.query(
					"select id from agent_lifecycle_operations where agent_id = $1 and kind = 'reprovision' order by created_at desc limit 1",
					[agentId],
				)
			).rows;
			await markProvisioning(deps, reprovisionOp.id, "test");
			await failOperation(deps, reprovisionOp.id, "test", "the bot's username is taken");

			await expect(
				requestOperationRetry(deps, { agentId, actor: "test", source: "cli", idempotencyKey }),
			).rejects.toThrow(/already used for a different request/);
		});

		it("refuses an idempotency key a create request already used, even though the agent's own current operation happens to share that retry's kind", async () => {
			const agentId = "retry-replays-create-key";
			const idempotencyKey = randomUUID();
			// `create`'s own operation carries kind `create` — exactly the kind a retry of it would
			// also carry, so `kind` alone could not tell the two apart; only `retry_of` (set solely by
			// `requestOperationRetry`'s own insert) can.
			const created = await requestAgentCreate(deps, {
				...createInput(agentId),
				idempotencyKey,
			});
			await markProvisioning(deps, created.operationId, "test");
			await failOperation(
				deps,
				created.operationId,
				"test",
				"the bot account could not be created",
			);

			await expect(
				requestOperationRetry(deps, { agentId, actor: "test", source: "cli", idempotencyKey }),
			).rejects.toThrow(/already used for a different request/);

			// Never silently "replayed" as a retry: no second operation was queued.
			const [{ n }] = (
				await pool.query(
					"select count(*)::int as n from agent_lifecycle_operations where agent_id = $1",
					[agentId],
				)
			).rows;
			expect(n).toBe(1);
		});

		it("two concurrent retries racing on the same idempotency key both get the first's result, never a spurious 422", async () => {
			const created = await requestAgentCreate(deps, createInput("retry-concurrent"));
			await markProvisioning(deps, created.operationId, "test");
			await failOperation(
				deps,
				created.operationId,
				"test",
				"the bot account could not be created",
			);

			const idempotencyKey = randomUUID();
			const retry = () =>
				requestOperationRetry(deps, {
					agentId: "retry-concurrent",
					actor: "test",
					source: "cli",
					idempotencyKey,
				});
			const results = await Promise.allSettled([retry(), retry()]);
			// Without the fix, the loser's own recheck (run before either side locks the lifecycle
			// row) misses the winner's not-yet-committed row, then reads `failed`'s now-superseded
			// state once it does get the lock and refuses with 422 ("nothing to retry") instead of
			// replaying the winner's result.
			const fulfilled = results.filter(
				(result): result is PromiseFulfilledResult<RequestOperationRetryResult> =>
					result.status === "fulfilled",
			);
			expect(fulfilled).toHaveLength(2);
			expect(fulfilled[0]?.value).toEqual(fulfilled[1]?.value);

			const [{ n }] = (
				await pool.query(
					"select count(*)::int as n from agent_lifecycle_operations where agent_id = 'retry-concurrent'",
				)
			).rows;
			// The original `create` plus exactly one retry — the race never inserted a second.
			expect(n).toBe(2);
		});
	});

	describe("retirement cleanup", () => {
		/** A minimal `events` row, enough to satisfy `agent_runs.trigger_event_id`'s own foreign key;
		 * its content is never read by anything under test here. */
		async function insertEvent(): Promise<string> {
			const externalId = randomUUID();
			const [row] = (
				await pool.query(
					`insert into events (specversion, external_id, source, type, time, correlation_id, trust_level, hop, payload, payload_hash)
					 values ('1.0', $1, 'test', 'mattermost.agent.mentioned', now(), $1, 'trusted', 0, '{}'::jsonb, 'hash')
					 returning id`,
					[externalId],
				)
			).rows;
			return row.id;
		}

		/** A run of `status` for `agentId`, wired to a fresh trigger event. */
		async function insertRun(
			agentId: string,
			status: "queued" | "running" | "succeeded",
		): Promise<string> {
			const eventId = await insertEvent();
			const idempotencyKey = randomUUID();
			const [row] = (
				await pool.query(
					`insert into agent_runs (agent_id, trigger_event_id, idempotency_key, status, max_attempts, runtime_adapter, correlation_id, hop, timeout_at, timeout_seconds)
					 values ($1, $2, $3, $4, 1, 'mock', $3, 0, now() + interval '1 hour', 3600)
					 returning id`,
					[agentId, eventId, idempotencyKey, status],
				)
			).rows;
			return row.id;
		}

		async function setAgentState(agentId: string, state: string): Promise<void> {
			await pool.query("update agents set state = $2 where id = $1", [agentId, state]);
		}

		it("cancels a queued run, so the worker never starts the stale turn", async () => {
			const created = await requestAgentCreate(deps, createInput("queued-run"));
			await markProvisioning(deps, created.operationId, "test");
			await completeOperation(deps, created.operationId, "test");
			const runId = await insertRun("queued-run", "queued");
			await setAgentState("queued-run", "queued");

			await requestAgentRetire(deps, { agentId: "queued-run", actor: "test", source: "cli" });

			const [run] = (await pool.query("select status from agent_runs where id = $1", [runId])).rows;
			expect(run.status).toBe("cancelled");
			const [enabled] = (
				await pool.query("select enabled, state from agents where id = 'queued-run'")
			).rows;
			expect(enabled).toMatchObject({ enabled: false, state: "disabled" });
		});

		it("cancels a running run the same way pausing does, so the worker stops the turn", async () => {
			const created = await requestAgentCreate(deps, createInput("running-run"));
			await markProvisioning(deps, created.operationId, "test");
			await completeOperation(deps, created.operationId, "test");
			const runId = await insertRun("running-run", "running");
			await setAgentState("running-run", "running");

			const retired = await requestAgentRetire(deps, {
				agentId: "running-run",
				actor: "test",
				source: "cli",
			});

			const [run] = (await pool.query("select status from agent_runs where id = $1", [runId])).rows;
			expect(run.status).toBe("cancelled");
			const [lifecycle] = (
				await pool.query("select status from agent_lifecycle where agent_id = 'running-run'")
			).rows;
			expect(lifecycle.status).toBe("retiring");
			expect(retired.cancelledJobs).toEqual([]);
		});

		it("cancels a pending wait and a pending approval (its card is withdrawn like any other), and blocks a pending outbox item", async () => {
			const created = await requestAgentCreate(deps, createInput("busy-agent"));
			await markProvisioning(deps, created.operationId, "test");
			await completeOperation(deps, created.operationId, "test");
			const sourceRun = await insertRun("busy-agent", "succeeded");
			const [wait] = (
				await pool.query(
					`insert into wait_subscriptions (agent_id, created_by_run_id, status, event_type, correlation_id, condition, timeout_at)
					 values ('busy-agent', $1, 'active', 'mattermost.thread.reply', 'corr-1', '{}'::jsonb, now() + interval '1 hour')
					 returning id`,
					[sourceRun],
				)
			).rows;
			const approvalRun = await insertRun("busy-agent", "succeeded");
			const [approval] = (
				await pool.query(
					`insert into approval_requests (requested_by_agent_id, run_id, action_type, action_params, immutable_action_hash, action_summary, risk_level, status, allowed_approver_user_ids, nonce, expires_at)
					 values ('busy-agent', $1, 'finance.pay', '{}'::jsonb, 'hash', 'summary', 'high', 'pending', '["owner0000000000000000000a"]'::jsonb, 'nonce', now() + interval '1 day')
					 returning id`,
					[approvalRun],
				)
			).rows;
			const outboxRun = await insertRun("busy-agent", "succeeded");
			const [outboxItem] = (
				await pool.query(
					`insert into outbox (kind, destination, payload, idempotency_key, status, max_attempts, run_id)
					 values ('mattermost.post', 'channel/hq', '{}'::jsonb, $1, 'pending', 8, $2)
					 returning id`,
					[randomUUID(), outboxRun],
				)
			).rows;

			await requestAgentRetire(deps, { agentId: "busy-agent", actor: "test", source: "cli" });

			const [waitAfter] = (
				await pool.query("select status from wait_subscriptions where id = $1", [wait.id])
			).rows;
			expect(waitAfter.status).toBe("cancelled");
			const [approvalAfter] = (
				await pool.query("select status from approval_requests where id = $1", [approval.id])
			).rows;
			expect(approvalAfter.status).toBe("cancelled");
			const [outboxAfter] = (
				await pool.query("select status, last_error_redacted from outbox where id = $1", [
					outboxItem.id,
				])
			).rows;
			expect(outboxAfter).toMatchObject({
				status: "cancelled",
				last_error_redacted: "agent_retired",
			});
		});

		it("ends the agent's stored runtime session even when it never had a channel grant to revoke, so a later restore cannot resume it", async () => {
			const created = await requestAgentCreate(deps, createInput("session-agent"));
			await markProvisioning(deps, created.operationId, "test");
			await completeOperation(deps, created.operationId, "test");
			await pool.query(
				`insert into runtime_sessions (agent_id, adapter, provider_session_ref, runtime_version, status)
				 values ('session-agent', 'mock', 'transcript-1', 'mock/1', 'active')`,
			);

			// No channel grant ever existed for this agent: `revokeAllActiveGrantsIn` alone (gated on
			// `revoked.length > 0`) would never reach the session, which is exactly the gap this test
			// guards against.
			await requestAgentRetire(deps, { agentId: "session-agent", actor: "test", source: "cli" });

			const [session] = (
				await pool.query(
					"select status from runtime_sessions where agent_id = 'session-agent' and adapter = 'mock'",
				)
			).rows;
			expect(session.status).toBe("revoked");
		});

		it("refuses to retire the organization's finance agent without reassigning the role, and succeeds with it", async () => {
			await reset([agent("accountant")]);
			await ensureAgentLifecycleAdoption(deps, "test");
			await expect(
				requestAgentRetire(deps, { agentId: "finance", actor: "test", source: "cli" }),
			).rejects.toThrow(/finance agent/);

			const retired = await requestAgentRetire(deps, {
				agentId: "finance",
				actor: "test",
				source: "cli",
				reassignFinanceTo: "accountant",
			});
			expect(await activeConfigRevisionId(deps)).toBe(retired.revisionId);
			const [org] = (
				await pool.query(
					"select bundle -> 'organization' -> 'organization' ->> 'finance_agent_id' as finance_agent_id from config_snapshots s join config_revisions r on r.snapshot_hash = s.hash where r.id = $1",
					[retired.revisionId],
				)
			).rows;
			expect(org.finance_agent_id).toBe("accountant");
		});

		it("refuses reassignFinanceTo for an agent that is not the finance agent", async () => {
			const created = await requestAgentCreate(deps, createInput("not-finance"));
			await markProvisioning(deps, created.operationId, "test");
			await completeOperation(deps, created.operationId, "test");

			await expect(
				requestAgentRetire(deps, {
					agentId: "not-finance",
					actor: "test",
					source: "cli",
					reassignFinanceTo: "finance",
				}),
			).rejects.toThrow(/reassignFinanceTo must not be given/);
		});

		it("a late run report for a retiring agent publishes no effect, dropped with an audit entry", async () => {
			const created = await requestAgentCreate(deps, createInput("late-report"));
			await markProvisioning(deps, created.operationId, "test");
			await completeOperation(deps, created.operationId, "test");
			const runId = await insertRun("late-report", "running");
			await setAgentState("late-report", "running");
			await requestAgentRetire(deps, { agentId: "late-report", actor: "test", source: "cli" });
			// Simulates a report that was already in flight when retirement cancelled the run: back
			// to `running`, as it would have still been had the worker's report beaten the
			// cancellation by a hair, so only the lifecycle gate (not the run's own status) stands
			// between this report and publishing an effect.
			await pool.query("update agent_runs set status = 'running' where id = $1", [runId]);

			const outcome = await handleRunReport(
				deps,
				{
					kind: "failed",
					runId,
					attempt: 1,
					agentId: "late-report",
					runtimeVersion: "test",
					error: { code: "runtime_permanent", retryable: false, detail: "late" },
					usage: null,
					session: null,
				},
				"mock",
			);

			expect(outcome).toBe("ignored_retired");
			const [run] = (await pool.query("select status from agent_runs where id = $1", [runId])).rows;
			// Never moved to `failed`/retried: the gate returned before any effect of the report.
			expect(run.status).toBe("running");
			const [audited] = (
				await pool.query(
					"select detail from audit_log where action = 'run.report.dropped_retired' and subject_id = $1",
					[runId],
				)
			).rows;
			expect(audited).toMatchObject({ detail: { kind: "failed", lifecycle_status: "retiring" } });
		});

		it("excludes a retired agent's private memory from listings, but keeps shared memory it wrote", async () => {
			const created = await requestAgentCreate(deps, createInput("memory-agent"));
			await markProvisioning(deps, created.operationId, "test");
			await completeOperation(deps, created.operationId, "test");
			const sourceRun = await insertRun("memory-agent", "succeeded");
			await pool.query(
				`insert into memory_items (namespace, key, content, source_run_id, status, visibility)
				 values ('agents/memory-agent', 'secret', 'private content', $1, 'accepted', 'private')`,
				[sourceRun],
			);
			await pool.query(
				`insert into memory_items (namespace, key, content, source_run_id, status, visibility)
				 values ('organization/shared', 'note', 'shared content', $1, 'accepted', 'shared')`,
				[sourceRun],
			);

			await requestAgentRetire(deps, { agentId: "memory-agent", actor: "test", source: "cli" });

			const all = await listMemory(deps, {
				status: null,
				namespace: null,
				oldestFirst: false,
				limit: 100,
				offset: 0,
			});
			expect(all.some((item) => item.namespace === "agents/memory-agent")).toBe(false);
			expect(all.some((item) => item.namespace === "organization/shared")).toBe(true);
		});
	});

	describe("a lifecycle-owned agent cannot be dropped from configuration outside its own retire (ADR-026)", () => {
		it("refuses a managed commit that removes a lifecycle-owned, ready agent", async () => {
			const created = await requestAgentCreate(deps, createInput("drop-managed"));
			await markProvisioning(deps, created.operationId, "test");
			await completeOperation(deps, created.operationId, "test");

			await expect(
				commitChange(deps, {
					changeSet: [{ type: "remove_agent", agentId: "drop-managed" }],
					baseRevisionId: await activeConfigRevisionId(deps),
					actor: "owner",
					source: "console",
				}),
			).rejects.toThrow(/gateway agents retire drop-managed/);

			const [lifecycle] = (
				await pool.query("select status from agent_lifecycle where agent_id = 'drop-managed'")
			).rows;
			expect(lifecycle.status).toBe("ready");
			const [row] = (await pool.query("select enabled from agents where id = 'drop-managed'")).rows;
			expect(row.enabled).toBe(true);
		});

		it("refuses a whole-bundle config apply that drops a lifecycle-owned, ready agent", async () => {
			const created = await requestAgentCreate(deps, createInput("drop-apply"));
			await markProvisioning(deps, created.operationId, "test");
			await completeOperation(deps, created.operationId, "test");

			const [{ config: financeConfig }] = (
				await pool.query("select config from agents where id = 'finance'")
			).rows;
			await expect(
				applyConfig(
					deps,
					{
						organization: organization(),
						agents: [financeConfig],
						constitution: "Be helpful.",
						rolePrompts: { finance: "Role prompt for finance." },
					},
					"test",
				),
			).rejects.toThrow(/gateway agents retire drop-apply/);

			const [row] = (await pool.query("select enabled from agents where id = 'drop-apply'")).rows;
			expect(row.enabled).toBe(true);
		});

		// `setAgentEnabled`'s own `remove_agent` fallback (`management.ts`) commits through the very
		// same public `commitChange` the test above calls directly, so it is refused by the identical
		// mechanism; reproducing its own specific precondition (disabling alone insufficient, only
		// reachable by simulating a retained configuration a cross-release rule change invalidated)
		// would only re-exercise the same check already covered there.

		it("retire tolerates an agent already missing from the active configuration (a stuck legacy state), still running its own cleanup", async () => {
			const agentId = "already-gone";
			const created = await requestAgentCreate(deps, createInput(agentId));
			await markProvisioning(deps, created.operationId, "test");
			await completeOperation(deps, created.operationId, "test");
			await pool.query(
				`insert into runtime_sessions (agent_id, adapter, provider_session_ref, runtime_version, status)
				 values ($1, 'mock', 'transcript-1', 'mock/1', 'active')`,
				[agentId],
			);

			// Simulates a stuck state only an older release's own bug could leave behind — a config
			// write removing a lifecycle-owned agent any way but its own retire — never something this
			// release's own writers can still produce, now that `rejectLifecycleOwnedRemovals` refuses
			// it: the agent's configuration is gone from the active bundle, but its lifecycle row was
			// never moved to `retiring`, still `ready` exactly as it was. Reproduced here the same way
			// the bug itself would have: a direct `commitChangeIn` call trusted to remove it, bypassing
			// the lifecycle row update `requestAgentRetire` itself always does in the same transaction.
			const baseRevisionId = await activeConfigRevisionId(deps);
			const changeSet: ChangeSet = [{ type: "remove_agent", agentId }];
			await inTransaction(deps, (uow) =>
				commitChangeIn(
					uow,
					{ changeSet, baseRevisionId, actor: "test", source: "cli_apply" },
					changeSet,
					undefined,
					new Set([agentId]),
				),
			);
			const [stuck] = (
				await pool.query("select status from agent_lifecycle where agent_id = $1", [agentId])
			).rows;
			expect(stuck.status).toBe("ready");
			// Out of the active bundle `loadActiveBundle` reads, even though its projection row (never
			// deleted, only ever disabled, like any agent leaving the configuration) still exists.
			const [disabled] = (await pool.query("select enabled from agents where id = $1", [agentId]))
				.rows;
			expect(disabled.enabled).toBe(false);

			const retired = await requestAgentRetire(deps, { agentId, actor: "test", source: "cli" });

			const [lifecycle] = (
				await pool.query("select status from agent_lifecycle where agent_id = $1", [agentId])
			).rows;
			expect(lifecycle.status).toBe("retiring");
			const [operation] = (
				await pool.query("select kind, state from agent_lifecycle_operations where id = $1", [
					retired.operationId,
				])
			).rows;
			expect(operation).toMatchObject({ kind: "retire", state: "pending" });

			// Every other retirement cleanup step still ran, even with nothing left to remove from the
			// configuration: its stored runtime session is ended unconditionally, the same as any other
			// retire.
			const [session] = (
				await pool.query(
					"select status from runtime_sessions where agent_id = $1 and adapter = 'mock'",
					[agentId],
				)
			).rows;
			expect(session.status).toBe("revoked");
		});
	});

	describe("a retired agent cannot be re-added to configuration outside its own restore (ADR-026)", () => {
		it("refuses a managed commit (add_agent) that re-adds a retired agent id", async () => {
			const created = await requestAgentCreate(deps, createInput("readd-managed"));
			await markProvisioning(deps, created.operationId, "test");
			await completeOperation(deps, created.operationId, "test");
			const retired = await requestAgentRetire(deps, {
				agentId: "readd-managed",
				actor: "test",
				source: "cli",
			});
			await markProvisioning(deps, retired.operationId, "test");
			await completeOperation(deps, retired.operationId, "test");
			const [lifecycle] = (
				await pool.query("select status from agent_lifecycle where agent_id = 'readd-managed'")
			).rows;
			expect(lifecycle.status).toBe("retired");

			await expect(
				commitChange(deps, {
					changeSet: [
						{
							type: "add_agent",
							agent: agent("readd-managed"),
							rolePrompt: "Role prompt for readd-managed.",
						},
					],
					baseRevisionId: await activeConfigRevisionId(deps),
					actor: "owner",
					source: "console",
				}),
			).rejects.toThrow(/gateway agents restore readd-managed/);

			// Still disabled: the rejected commit never re-enabled it (`agents` retains a retired
			// agent's own last configuration rather than deleting its row, ADR-024 — present, but
			// never active).
			const [row] = (await pool.query("select enabled from agents where id = 'readd-managed'"))
				.rows;
			expect(row.enabled).toBe(false);
		});

		it("refuses a whole-bundle config apply that reintroduces a retired agent id", async () => {
			const created = await requestAgentCreate(deps, createInput("readd-apply"));
			await markProvisioning(deps, created.operationId, "test");
			await completeOperation(deps, created.operationId, "test");
			const retired = await requestAgentRetire(deps, {
				agentId: "readd-apply",
				actor: "test",
				source: "cli",
			});
			await markProvisioning(deps, retired.operationId, "test");
			await completeOperation(deps, retired.operationId, "test");

			const [{ config: financeConfig }] = (
				await pool.query("select config from agents where id = 'finance'")
			).rows;
			await expect(
				applyConfig(
					deps,
					{
						organization: organization(),
						agents: [financeConfig, agent("readd-apply")],
						constitution: "Be helpful.",
						rolePrompts: { finance: "Role prompt for finance.", "readd-apply": "Role prompt." },
					},
					"test",
				),
			).rejects.toThrow(/gateway agents restore readd-apply/);
		});

		it("refuses a rollback to a revision whose snapshot still names a since-retired agent, naming the restore command instead", async () => {
			const created = await requestAgentCreate(deps, createInput("readd-rollback"));
			await markProvisioning(deps, created.operationId, "test");
			await completeOperation(deps, created.operationId, "test");
			// The revision to "roll back" to: still names the agent, while it was ready.
			const liveRevisionId = await activeConfigRevisionId(deps);
			const { bundle: liveBundle } = await inTransaction(deps, ({ tx }) =>
				loadActiveBundle(tx.db, liveRevisionId),
			);

			const retired = await requestAgentRetire(deps, {
				agentId: "readd-rollback",
				actor: "test",
				source: "cli",
			});
			await markProvisioning(deps, retired.operationId, "test");
			await completeOperation(deps, retired.operationId, "test");

			if (liveBundle.organization === null) {
				throw new Error("unreachable: a committed revision always has an organization");
			}
			await expect(
				commitChange(deps, {
					changeSet: [
						{
							type: "replace_bundle",
							bundle: {
								organization: liveBundle.organization,
								agents: [...liveBundle.agents],
								constitution: liveBundle.constitution,
								rolePrompts: liveBundle.rolePrompts,
							},
						},
					],
					baseRevisionId: await activeConfigRevisionId(deps),
					actor: "owner",
					source: "rollback",
				}),
			).rejects.toThrow(/gateway agents restore readd-rollback/);

			const [lifecycle] = (
				await pool.query("select status from agent_lifecycle where agent_id = 'readd-rollback'")
			).rows;
			expect(lifecycle.status).toBe("retired");
		});

		it("requestAgentRestore's own add_agent is unaffected (it is the sanctioned way to do this)", async () => {
			const created = await requestAgentCreate(deps, createInput("readd-restore"));
			await markProvisioning(deps, created.operationId, "test");
			await completeOperation(deps, created.operationId, "test");
			const retired = await requestAgentRetire(deps, {
				agentId: "readd-restore",
				actor: "test",
				source: "cli",
			});
			await markProvisioning(deps, retired.operationId, "test");
			await completeOperation(deps, retired.operationId, "test");

			const restored = await requestAgentRestore(deps, {
				agentId: "readd-restore",
				actor: "test",
				source: "cli",
			});
			const [lifecycle] = (
				await pool.query("select status from agent_lifecycle where agent_id = 'readd-restore'")
			).rows;
			expect(lifecycle.status).toBe("pending");
			const [row] = (await pool.query("select enabled from agents where id = 'readd-restore'"))
				.rows;
			expect(row.enabled).toBe(true);
			expect(restored.agentId).toBe("readd-restore");
		});
	});
});
