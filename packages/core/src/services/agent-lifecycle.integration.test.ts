import { randomUUID } from "node:crypto";
import type { AgentConfig, OrganizationConfig } from "@agent-gateway/contracts";
import { AgentConfigSchema, OrganizationConfigSchema } from "@agent-gateway/contracts";
import { createPool, migrateSchema } from "@agent-gateway/db";
import { DEVELOPMENT_VERSION, silentLogger } from "@agent-gateway/logging";
import { createBoss, migrateQueues, transactionalJobSink } from "@agent-gateway/queue";
import { startTestPostgres, type TestPostgres } from "@agent-gateway/testkit";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdminError, applyConfig } from "./admin.ts";
import {
	completeOperation,
	ensureAgentLifecycleAdoption,
	failOperation,
	listLifecycleOperations,
	listRunningLifecycleOperations,
	markProvisioning,
	requestAgentCreate,
	requestAgentRestore,
	requestAgentRetire,
	StaleLifecycleOperationError,
} from "./agent-lifecycle.ts";
import type { ControlPlaneDeps } from "./deps.ts";
import { activeConfigRevisionId, commitChange } from "./management.ts";
import { recordWorkerStatus } from "./runtime-health.ts";

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
});
