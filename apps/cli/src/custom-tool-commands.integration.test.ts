import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	applyConfig,
	type ControlPlaneDeps,
	ensureToolCatalogSeeded,
	getCatalogEntry,
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

const DEFINITION = {
	host: "api.example.com",
	pathTemplate: "/tickets/{id}",
	method: "POST",
	parameters: [
		{ name: "id", slot: "path", slotName: "id", type: "string", minLength: 1, maxLength: 50 },
		{
			name: "summary",
			slot: "body",
			slotName: "summary",
			type: "string",
			minLength: 1,
			maxLength: 200,
		},
	],
	secretSlots: [{ alias: "api_key", slot: "header", slotName: "x-api-key" }],
	idempotency: { headerName: "idempotency-key" },
	responseLimits: {
		maxResponseBytes: 65_536,
		allowedContentTypes: ["application/json"],
		timeoutMs: 5000,
	},
};

/**
 * `gateway tools custom create|edit`'s own CLI dispatch: argument parsing, reading and validating
 * the definition file, and the service call it makes — mirroring
 * `tools-commands.integration.test.ts`'s own harness for `gateway tools adopt`.
 */
describe("gateway tools custom create|edit (CLI dispatch)", () => {
	let postgres: TestPostgres;
	let pool: pg.Pool;
	let boss: PgBoss;
	let session: Session;
	let dir: string;

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
		dir = mkdtempSync(join(tmpdir(), "agw-custom-tool-cli-"));
	});

	afterAll(async () => {
		await boss?.stop({ graceful: false });
		await pool?.end();
		await postgres?.stop();
	});

	function writeDefinition(name: string, content: unknown): string {
		const path = join(dir, name);
		writeFileSync(path, JSON.stringify(content));
		return path;
	}

	async function run(args: Readonly<string[]>): Promise<{ code: number; printed: string[] }> {
		const printed: string[] = [];
		const code = await dispatchSessionCommand(session, "tools custom", args, {
			print: (line) => printed.push(line),
		});
		return { code, printed };
	}

	it("requires --name, --description and --definition on create", async () => {
		await expect(run(["tools", "custom", "create", "zendesk-ticket"])).rejects.toThrow(
			/missing --name/,
		);
	});

	it("creates a custom HTTPS tool from a valid definition file", async () => {
		const file = writeDefinition("valid.json", DEFINITION);
		const { code, printed } = await run([
			"tools",
			"custom",
			"create",
			"zendesk-ticket",
			"--name",
			"Create Zendesk ticket",
			"--description",
			"Files a support ticket.",
			"--definition",
			file,
		]);
		expect(code).toBe(0);
		expect(printed[0]).toContain("created");
		const entry = await getCatalogEntry(session.deps, "zendesk-ticket", {
			installedAdapters: new Set(),
			registeredExecutorActionTypes: new Set(),
			registeredNamespaces: new Set(),
		});
		expect(entry?.kind).toBe("custom_https");
		expect(entry?.currentVersion.httpsDefinition).toMatchObject({ host: "api.example.com" });
	});

	it("refuses a definition file that is not valid JSON", async () => {
		const path = join(dir, "invalid.json");
		writeFileSync(path, "{ not json");
		await expect(
			run([
				"tools",
				"custom",
				"create",
				"broken-tool",
				"--name",
				"x",
				"--description",
				"y",
				"--definition",
				path,
			]),
		).rejects.toThrow(/not valid JSON/);
	});

	it("refuses a definition that fails CustomHttpsDefinitionSchema or its own cross-field rules", async () => {
		const file = writeDefinition("no-idempotency.json", { ...DEFINITION, idempotency: null });
		await expect(
			run([
				"tools",
				"custom",
				"create",
				"no-idempotency-tool",
				"--name",
				"x",
				"--description",
				"y",
				"--definition",
				file,
			]),
		).rejects.toThrow(/idempotency/);
	});

	it("edits an existing tool, publishing a new version", async () => {
		const file = writeDefinition("valid.json", DEFINITION);
		await run([
			"tools",
			"custom",
			"create",
			"edit-me",
			"--name",
			"Edit me",
			"--description",
			"Before.",
			"--definition",
			file,
		]);
		const updated = writeDefinition("updated.json", {
			...DEFINITION,
			pathTemplate: "/tickets/v2/{id}",
		});
		const { code } = await run([
			"tools",
			"custom",
			"edit",
			"edit-me",
			"--description",
			"After.",
			"--definition",
			updated,
		]);
		expect(code).toBe(0);
		const entry = await getCatalogEntry(session.deps, "edit-me", {
			installedAdapters: new Set(),
			registeredExecutorActionTypes: new Set(),
			registeredNamespaces: new Set(),
		});
		expect(entry?.currentVersion.version).toBe(2);
		expect(entry?.currentVersion.description).toBe("After.");
		expect(entry?.currentVersion.httpsDefinition).toMatchObject({
			pathTemplate: "/tickets/v2/{id}",
		});
	});

	it("requires at least one of --name, --description or --definition on edit", async () => {
		await expect(run(["tools", "custom", "edit", "zendesk-ticket"])).rejects.toThrow(
			/nothing to edit/,
		);
	});
});
