import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	applyConfig,
	type ControlPlaneDeps,
	recordWorkerStatus,
	requestAgentCreate,
} from "@agent-gateway/core";
import { createPool, migrateSchema } from "@agent-gateway/db";
import { DEVELOPMENT_VERSION, silentLogger } from "@agent-gateway/logging";
import { createBoss, migrateQueues, transactionalJobSink } from "@agent-gateway/queue";
import { startTestPostgres, type TestPostgres } from "@agent-gateway/testkit";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAgentCreateRequest } from "./commands.ts";
import { loadConfigDirectory } from "./config-files.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const EXAMPLES_DIR = join(repoRoot, "config/examples");

/** A `--root` with `prompts/<file>` already written, for `--role-prompt-file` to read. */
function rootWithPrompt(fileName: string, content: string): string {
	const root = mkdtempSync(join(tmpdir(), "gateway-agents-create-"));
	mkdirSync(join(root, "prompts"), { recursive: true });
	writeFileSync(join(root, "prompts", fileName), content);
	return root;
}

/** A control plane with a real database but no controller or worker: exactly what `openSession`
 * (the real CLI) builds, minus the deployment lock session commands hold around it. */
async function startHarness(): Promise<
	Readonly<{
		postgres: TestPostgres;
		pool: pg.Pool;
		boss: PgBoss;
		deps: ControlPlaneDeps;
		stop: () => Promise<void>;
	}>
> {
	const postgres = await startTestPostgres();
	const pool = createPool(postgres.connectionString, 4);
	await migrateSchema({
		pool,
		connectionString: postgres.connectionString,
		release: DEVELOPMENT_VERSION,
		migrateQueues: () => migrateQueues(postgres.connectionString),
	});
	const boss = createBoss(postgres.connectionString, "client");
	await boss.start();
	const deps: ControlPlaneDeps = {
		pool,
		jobs: (tx) => transactionalJobSink(boss, tx.client),
		clock: () => new Date(),
		random: Math.random,
		log: silentLogger,
	};
	return {
		postgres,
		pool,
		boss,
		deps,
		stop: async () => {
			await boss.stop({ graceful: false });
			await pool.end();
			await postgres.stop();
		},
	};
}

describe("gateway agents create: a minimal agent against the example config (finance agent included)", () => {
	let harness: Awaited<ReturnType<typeof startHarness>>;

	beforeAll(async () => {
		harness = await startHarness();
		// `config/examples` already defines the finance agent `validateConfigBundle` requires every
		// other agent's `tools_deny` to mention.
		await applyConfig(harness.deps, loadConfigDirectory(EXAMPLES_DIR, repoRoot), "test");
		await recordWorkerStatus(
			harness.deps,
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
	});

	afterAll(async () => {
		await harness.stop();
	});

	it("succeeds for a minimal create (no --permissions flags at all)", async () => {
		const root = rootWithPrompt("analyst.md", "You are the analyst.");
		const request = buildAgentCreateRequest(
			[
				"agents",
				"create",
				"analyst",
				"--display-name",
				"Analyst",
				"--role-prompt-file",
				"prompts/analyst.md",
				"--runtime",
				"mock",
			],
			root,
			"cli:owner",
		);

		const created = await requestAgentCreate(harness.deps, request);
		expect(created.agentId).toBe("analyst");

		const [row] = (
			await harness.pool.query<{ tools_allow: string[]; tools_deny: string[] }>(
				"select config #> '{permissions,tools_allow}' as tools_allow, config #> '{permissions,tools_deny}' as tools_deny from agents where id = $1",
				["analyst"],
			)
		).rows;
		// The bundle-wide rule `validateConfigBundle` enforces: every non-finance agent must deny
		// 'finance.*'. A minimal create that never mentions permissions must still produce a valid
		// bundle, not one `requestAgentCreate` itself would have rejected.
		expect(row?.tools_deny).toEqual(["finance.*"]);
		// The owner workflow is to create an agent and have it start working right away: a minimal
		// create defaults to the one permission every example agent already carries
		// (`defaultAgentPermissions`), not an agent that cannot reply until its permissions are
		// edited by hand.
		expect(row?.tools_allow).toEqual(["mattermost.post"]);
	});
});
