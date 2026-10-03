import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AdoptAgentResult,
	applyConfig,
	type ControlPlaneDeps,
	ensureToolCatalogSeeded,
	requestAgentRetire,
} from "@agent-gateway/core";
import { createPool, migrateSchema } from "@agent-gateway/db";
import { DEVELOPMENT_VERSION, silentLogger } from "@agent-gateway/logging";
import { createBoss, migrateQueues, transactionalJobSink } from "@agent-gateway/queue";
import { startTestPostgres, type TestPostgres } from "@agent-gateway/testkit";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchSessionCommand, type Session } from "./commands.ts";
import { loadConfigDirectory } from "./config-files.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const EXAMPLES_DIR = join(repoRoot, "config/examples");

/**
 * `gateway tools adopt`'s own CLI dispatch (`dispatchSessionCommand`'s `case "tools adopt"`):
 * argument parsing (`<agent-id>|--all`, `--dry-run`, `--reason`), the printed JSON and the exit
 * code — never `adoptAgentToolAttachments` itself, which `effective-permissions.integration.test.ts`
 * already covers in depth. Built against a manually-constructed `Session`, the same way
 * `doctor.integration.test.ts` tests `doctor` directly: no `DATABASE_URL`/deployment-lock
 * machinery, which belongs to the real CLI entrypoint (`runCommand`), not to one command's own
 * dispatch logic.
 */
describe("gateway tools adopt (CLI dispatch)", () => {
	let postgres: TestPostgres;
	let pool: pg.Pool;
	let boss: PgBoss;
	let session: Session;

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
		const deps: ControlPlaneDeps = {
			pool,
			jobs: (tx) => transactionalJobSink(boss, tx.client),
			clock: () => new Date(),
			random: Math.random,
			log: silentLogger,
		};
		session = { deps, boss, close: async () => undefined };
		await applyConfig(deps, loadConfigDirectory(EXAMPLES_DIR, repoRoot), "test");
		await ensureToolCatalogSeeded(deps, "test");
	});

	afterAll(async () => {
		await boss?.stop({ graceful: false });
		await pool?.end();
		await postgres?.stop();
	});

	async function runToolsAdopt(
		args: Readonly<string[]>,
	): Promise<{ code: number; results: Readonly<AdoptAgentResult[]> }> {
		const printed: string[] = [];
		const code = await dispatchSessionCommand(session, "tools adopt", args, {
			print: (line) => printed.push(line),
		});
		return { code, results: JSON.parse(printed[0] ?? "[]") as AdoptAgentResult[] };
	}

	it("requires an <agent-id> or --all", async () => {
		await expect(
			dispatchSessionCommand(session, "tools adopt", ["tools", "adopt"], {
				print: () => undefined,
			}),
		).rejects.toThrow(/missing <agent-id>\|--all/);
	});

	it("--dry-run previews a named agent's legacy conversion, including unresolved patterns, without committing", async () => {
		const { code, results } = await runToolsAdopt(["tools", "adopt", "mail-follower", "--dry-run"]);
		expect(code).toBe(0);
		expect(results).toHaveLength(1);
		const [result] = results;
		expect(result).toMatchObject({
			agentId: "mail-follower",
			alreadyHubManaged: false,
			commit: null,
		});
		// `mail.read`/`mail.send`/`mail.forward` name no catalog entry at all (not a tool-broker or
		// native/gateway capability this release ships); `mattermost.post` and `finance.*` do.
		expect(result?.unresolved.map((u) => u.pattern).sort()).toEqual(
			["deploy.*", "mail.forward", "mail.read", "mail.send"].sort(),
		);
		expect(result?.attachments.length).toBeGreaterThan(0);
	});

	it("commits the adoption for a named agent, with --reason recorded, then reports alreadyHubManaged on a repeat", async () => {
		const { code, results } = await runToolsAdopt([
			"tools",
			"adopt",
			"mail-follower",
			"--reason",
			"adopted through the CLI integration test",
		]);
		expect(code).toBe(0);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ agentId: "mail-follower", alreadyHubManaged: false });
		expect(results[0]?.commit).not.toBeNull();

		const again = await runToolsAdopt(["tools", "adopt", "mail-follower"]);
		expect(again.code).toBe(0);
		expect(again.results[0]).toMatchObject({ alreadyHubManaged: true, commit: null });
	});

	it("--all resolves every configured agent id and adopts (or skips) each one, exit code 0", async () => {
		const { code, results } = await runToolsAdopt(["tools", "adopt", "--all"]);
		expect(code).toBe(0);
		expect(results.length).toBeGreaterThan(0);
		expect(results.every((r) => r.commit !== null || r.alreadyHubManaged)).toBe(true);
		expect(results.some((r) => r.agentId === "mail-follower" && r.alreadyHubManaged)).toBe(true);
	});

	it(
		"--all excludes a retired agent kept in the `agents` projection for history, rather than " +
			"throwing mid-batch",
		async () => {
			// `remove_agent` (ADR-026's own retire) takes `director` out of the active configuration;
			// its `agents` row stays, disabled, for history — exactly the row `listAgents` would have
			// resolved `--all` from before this fix, and the one `adoptOneAgent` has no active-bundle
			// entry for at all.
			await requestAgentRetire(session.deps, {
				agentId: "director",
				actor: "test",
				source: "cli",
			});

			const { code, results } = await runToolsAdopt(["tools", "adopt", "--all"]);
			expect(code).toBe(0);
			expect(results.some((r) => r.agentId === "director")).toBe(false);
		},
	);
});
