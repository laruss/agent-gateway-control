import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	activeConfigRevisionId,
	applyConfig,
	type ControlPlaneDeps,
	checkpointOperation,
	commitChange,
	completeOperation,
	failOperation,
	markProvisioning,
	recordWorkerStatus,
	requestAgentCreate,
	requestAgentRetire,
} from "@agent-gateway/core";
import { createPool, migrateSchema } from "@agent-gateway/db";
import { DEVELOPMENT_VERSION, silentLogger } from "@agent-gateway/logging";
import { createBoss, migrateQueues, transactionalJobSink } from "@agent-gateway/queue";
import { startTestPostgres, type TestPostgres } from "@agent-gateway/testkit";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { doctor, type Session } from "./commands.ts";
import { loadConfigDirectory } from "./config-files.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const EXAMPLES_DIR = join(repoRoot, "config/examples");

type Check = Readonly<{ name: string; ok: boolean; detail: string }>;

async function runDoctor(session: Session): Promise<Readonly<Check[]>> {
	const printed: string[] = [];
	await doctor(session, { print: (line) => printed.push(line) });
	return (JSON.parse(printed[0] ?? "{}") as { checks: Check[] }).checks;
}

describe("gateway doctor: 'mattermost_provisioning' sees the admin token the same way gateway-cli's own container does (ADR-026)", () => {
	let postgres: TestPostgres;
	let pool: pg.Pool;
	let boss: PgBoss;
	let deps: ControlPlaneDeps;
	let session: Session;
	let tokenDir: string;
	const previousEnv = process.env.MATTERMOST_ADMIN_TOKEN_FILE;

	beforeAll(async () => {
		postgres = await startTestPostgres();
		pool = createPool(postgres.connectionString, 4);
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
		session = { deps, boss, close: async () => undefined };

		// The example configuration (it names the finance agent `validateConfigBundle` requires)
		// plus one lifecycle create request left `pending`: exactly what leaves
		// `mattermost_provisioning` an operation actually waiting on the admin token, rather than
		// trivially 'ok' with nothing to provision.
		await applyConfig(deps, loadConfigDirectory(EXAMPLES_DIR, repoRoot), "test");
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
		await requestAgentCreate(deps, {
			agent: {
				id: "waiting-agent",
				display_name: "Waiting Agent",
				mattermost: { username: "waiting-agent" },
				runtime: { adapter: "mock" },
				prompts: { role_file: "prompts/waiting-agent.md" },
				wake_rules: [],
				concurrency: { while_running: "enqueue" },
				memory: { private_namespace: "agents/waiting-agent", shared_namespaces: [] },
			},
			rolePrompt: "Role.",
			actor: "test",
			source: "cli",
		});

		tokenDir = mkdtempSync(join(tmpdir(), "gateway-doctor-"));
	});

	afterAll(async () => {
		await boss?.stop({ graceful: false });
		await pool?.end();
		await postgres?.stop();
		rmSync(tokenDir, { recursive: true, force: true });
	});

	afterEach(() => {
		if (previousEnv === undefined) {
			delete process.env.MATTERMOST_ADMIN_TOKEN_FILE;
		} else {
			process.env.MATTERMOST_ADMIN_TOKEN_FILE = previousEnv;
		}
	});

	it("reports not ok, naming the waiting operation, when the admin token file is absent", async () => {
		process.env.MATTERMOST_ADMIN_TOKEN_FILE = join(tokenDir, "mattermost_admin_token");
		const checks = await runDoctor(session);
		const check = checks.find((c) => c.name === "mattermost_provisioning");
		expect(check).toMatchObject({ ok: false });
		expect(check?.detail).toContain("no Mattermost admin token configured");
		expect(check?.detail).toContain("1 operation(s) waiting");
	});

	it("reports ok once the same file gateway-cli and the controller both read is present", async () => {
		const path = join(tokenDir, "mattermost_admin_token");
		writeFileSync(path, "a-token\n");
		process.env.MATTERMOST_ADMIN_TOKEN_FILE = path;
		const checks = await runDoctor(session);
		const check = checks.find((c) => c.name === "mattermost_provisioning");
		expect(check).toMatchObject({ ok: true });
		expect(check?.detail).toContain("admin token configured");
	});

	it("counts a pending retire as waiting too, not only create/restore/reprovision", async () => {
		const created = await requestAgentCreate(deps, {
			agent: {
				id: "retiring-agent",
				display_name: "Retiring Agent",
				mattermost: { username: "retiring-agent" },
				runtime: { adapter: "mock" },
				prompts: { role_file: "prompts/retiring-agent.md" },
				wake_rules: [],
				concurrency: { while_running: "enqueue" },
				memory: { private_namespace: "agents/retiring-agent", shared_namespaces: [] },
			},
			rolePrompt: "Role.",
			actor: "test",
			source: "cli",
		});
		await markProvisioning(deps, created.operationId, "test");
		await completeOperation(deps, created.operationId, "test");
		// A `retire` operation stays `pending` the same way a `create` does with no admin token
		// configured — driven by the very same tick, `processRetireOperation` gated on the same
		// token as `processOperation` (`agent-provisioner.ts`) — so `mattermost_provisioning` must
		// count it too, not only `create`/`restore`/`reprovision`.
		await requestAgentRetire(deps, { agentId: "retiring-agent", actor: "test", source: "cli" });

		// A fresh, still-absent path — not the one a prior test in this file already wrote a token
		// to (that file, once written, stays on disk for the rest of the suite).
		process.env.MATTERMOST_ADMIN_TOKEN_FILE = join(tokenDir, "mattermost_admin_token_retire_test");
		const checks = await runDoctor(session);
		const check = checks.find((c) => c.name === "mattermost_provisioning");
		expect(check).toMatchObject({ ok: false });
		// "waiting-agent"'s own still-pending create, plus this retire.
		expect(check?.detail).toContain("2 operation(s) waiting");
	});

	it("reports a failed lifecycle operation such as a failed reprovision, which leaves its agent 'ready' rather than 'failed'", async () => {
		await requestAgentCreate(deps, {
			agent: {
				id: "reprovision-agent",
				display_name: "Reprovision Agent",
				mattermost: { username: "reprovision-agent" },
				runtime: { adapter: "mock" },
				prompts: { role_file: "prompts/reprovision-agent.md" },
				wake_rules: [],
				concurrency: { while_running: "enqueue" },
				memory: { private_namespace: "agents/reprovision-agent", shared_namespaces: [] },
			},
			rolePrompt: "Role.",
			actor: "test",
			source: "cli",
		});
		const [{ operation_id: createOperationId }] = (
			await pool.query("select operation_id from agent_lifecycle where agent_id = $1", [
				"reprovision-agent",
			])
		).rows;
		await markProvisioning(deps, createOperationId, "test");
		await completeOperation(deps, createOperationId, "test");

		// A channel edit on a now-`ready` lifecycle-owned agent queues a `reprovision`
		// (`queueMembershipReprovisioning`); failing it permanently leaves its agent `ready`
		// throughout (ADR-026's own carve-out for this kind), never `failed` the way a stuck
		// `create`/`restore` would — invisible from the agent's own status alone.
		const [{ config }] = (
			await pool.query("select config from agents where id = $1", ["reprovision-agent"])
		).rows;
		await commitChange(deps, {
			changeSet: [
				{
					type: "update_agent",
					agent: {
						...config,
						mattermost: { ...config.mattermost, allowed_channels: ["research"] },
					},
				},
			],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "owner",
			source: "console",
		});
		const [{ operation_id: reprovisionOperationId }] = (
			await pool.query("select operation_id from agent_lifecycle where agent_id = $1", [
				"reprovision-agent",
			])
		).rows;
		await markProvisioning(deps, reprovisionOperationId, "test");
		await failOperation(
			deps,
			reprovisionOperationId,
			"test",
			"channel 'research' could not be resolved",
		);

		const [lifecycle] = (
			await pool.query("select status from agent_lifecycle where agent_id = $1", [
				"reprovision-agent",
			])
		).rows;
		expect(lifecycle.status).toBe("ready");

		process.env.MATTERMOST_ADMIN_TOKEN_FILE = join(tokenDir, "mattermost_admin_token");
		const checks = await runDoctor(session);
		const check = checks.find((c) => c.name === "lifecycle_failures");
		expect(check).toMatchObject({ ok: false });
		expect(check?.detail).toContain("1 agent(s)");
	});

	it("reports a retirement whose bot's ownership could not be confirmed either way (owner_unverified, ADR-026)", async () => {
		await requestAgentCreate(deps, {
			agent: {
				id: "unverified-agent",
				display_name: "Unverified Agent",
				mattermost: { username: "unverified-agent" },
				runtime: { adapter: "mock" },
				prompts: { role_file: "prompts/unverified-agent.md" },
				wake_rules: [],
				concurrency: { while_running: "enqueue" },
				memory: { private_namespace: "agents/unverified-agent", shared_namespaces: [] },
			},
			rolePrompt: "Role.",
			actor: "test",
			source: "cli",
		});
		const [{ operation_id: createOperationId }] = (
			await pool.query("select operation_id from agent_lifecycle where agent_id = $1", [
				"unverified-agent",
			])
		).rows;
		await markProvisioning(deps, createOperationId, "test");
		await completeOperation(deps, createOperationId, "test");

		// Simulates the provisioner's own retire recovery finding a plain bot at this agent's own
		// username that matches no provisioning admin account on record at all (`owner_unverified`):
		// cleanup is skipped (never adopted on a guess), but flagged here for an operator's own look.
		const retired = await requestAgentRetire(deps, {
			agentId: "unverified-agent",
			actor: "test",
			source: "cli",
		});
		await markProvisioning(deps, retired.operationId, "test");
		await checkpointOperation(deps, retired.operationId, { owner_unverified: true });
		await completeOperation(deps, retired.operationId, "test");

		process.env.MATTERMOST_ADMIN_TOKEN_FILE = join(tokenDir, "mattermost_admin_token");
		const checks = await runDoctor(session);
		const check = checks.find((c) => c.name === "lifecycle_retire_ownership");
		expect(check).toMatchObject({ ok: false });
		expect(check?.detail).toContain("1 retired agent(s)");
	});
});
