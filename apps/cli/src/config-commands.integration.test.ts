import {
	cpSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AdminError,
	activeConfigRevisionId,
	adoptAgentToolAttachments,
	applyConfig,
	attachTool,
	type ControlPlaneDeps,
	commitChange,
	configBundleProblems,
	configSnapshotBundle,
	deleteCatalogEntry,
	ensureToolCatalogSeeded,
	inTransaction,
	loadActiveBundle,
	ManagementConflictError,
	prepareChange,
} from "@agent-gateway/core";
import { createPool, migrateSchema } from "@agent-gateway/db";
import { canonicalHash } from "@agent-gateway/events";
import { DEVELOPMENT_VERSION, silentLogger } from "@agent-gateway/logging";
import { createBoss, migrateQueues, transactionalJobSink } from "@agent-gateway/queue";
import { startTestPostgres, type TestPostgres } from "@agent-gateway/testkit";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	configDiffCommand,
	configExport,
	configHistory,
	configImport,
	configRollback,
} from "./config-commands.ts";
import { ConfigFileError, loadConfigDirectory } from "./config-files.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const EXAMPLES_DIR = join(repoRoot, "config/examples");

function exampleInput() {
	return loadConfigDirectory(EXAMPLES_DIR, repoRoot);
}

function exportDir(): string {
	return mkdtempSync(join(tmpdir(), "gateway-export-"));
}

/** Every file under `dir`, keyed by its path relative to `dir`, read as UTF-8 text. */
function readTree(dir: string, prefix = ""): Readonly<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const name of readdirSync(dir).sort()) {
		const full = join(dir, name);
		const rel = prefix === "" ? name : `${prefix}/${name}`;
		if (statSync(full).isDirectory()) {
			Object.assign(result, readTree(full, rel));
		} else {
			result[rel] = readFileSync(full, "utf8");
		}
	}
	return result;
}

const noopPrint = (_line: string) => undefined;

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

async function revisionCount(pool: pg.Pool): Promise<number> {
	const result = await pool.query<{ n: number }>("select count(*)::int as n from config_revisions");
	return result.rows[0]?.n ?? 0;
}

describe("config export, diff, import, rollback and history", () => {
	let harness: Awaited<ReturnType<typeof startHarness>>;
	let firstRevisionId: number;
	let dirA: string;

	beforeAll(async () => {
		harness = await startHarness();
	});

	afterAll(async () => {
		await harness.stop();
	});

	it("imports into a fresh database without --expected-revision", async () => {
		const result = await configImport(
			harness.deps,
			{ dir: EXAMPLES_DIR, root: repoRoot, expectedRevision: null, reason: null, actor: "test" },
			noopPrint,
		);
		expect(result.noop).toBe(false);
		firstRevisionId = result.revisionId;
		expect(await revisionCount(harness.pool)).toBe(1);
	});

	it("exports the active revision as a directory that round-trips to the same hash as a no-op import", async () => {
		dirA = exportDir();
		await configExport(harness.deps, { dir: dirA, revisionId: null }, noopPrint);

		const reloaded = loadConfigDirectory(dirA, dirA);
		expect(reloaded.agents.map((a) => a.id).sort()).toEqual(
			exampleInput()
				.agents.map((a) => a.id)
				.sort(),
		);

		const before = await revisionCount(harness.pool);
		const result = await configImport(
			harness.deps,
			{ dir: dirA, root: dirA, expectedRevision: firstRevisionId, reason: null, actor: "test" },
			noopPrint,
		);
		expect(result.noop).toBe(true);
		expect(result.revisionId).toBe(firstRevisionId);
		expect(await revisionCount(harness.pool)).toBe(before);
	});

	it("is deterministic: exporting the same revision twice is byte-for-byte identical", async () => {
		const dirB = exportDir();
		await configExport(harness.deps, { dir: dirB, revisionId: firstRevisionId }, noopPrint);
		expect(readTree(dirB)).toEqual(readTree(dirA));
	});

	it("refuses to export into a non-empty directory, leaving it untouched", async () => {
		const before = readTree(dirA);
		await expect(
			configExport(harness.deps, { dir: dirA, revisionId: null }, noopPrint),
		).rejects.toThrow(ConfigFileError);
		expect(readTree(dirA)).toEqual(before);
	});

	it("diff reports no problems and a noop for the directory it just exported", async () => {
		const printed: string[] = [];
		const ok = await configDiffCommand(
			harness.deps,
			{ dir: dirA, root: dirA, json: false },
			(line) => printed.push(line),
		);
		expect(ok).toBe(true);
		expect(printed[0]).toContain("no changes");
	});

	it("import without --expected-revision replays an already-committed identical import instead of refusing", async () => {
		// dirA's content is byte-for-byte the same as the fresh-DB import that created
		// firstRevisionId: its own earlier response may have been lost before the caller saw it,
		// so this is a legitimate retry, not a missing-flag mistake.
		const before = await revisionCount(harness.pool);
		const result = await configImport(
			harness.deps,
			{ dir: dirA, root: dirA, expectedRevision: null, reason: null, actor: "test" },
			noopPrint,
		);
		expect(result.revisionId).toBe(firstRevisionId);
		expect(await revisionCount(harness.pool)).toBe(before);
	});

	it("import without --expected-revision refuses when there is no matching commit to replay", async () => {
		const modified = exportDir();
		cpSync(dirA, modified, { recursive: true });
		// A manifest copied alongside modified content would fail its own hash check first; this
		// directory's import is refused for the missing flag, not a tampered manifest.
		rmSync(join(modified, "manifest.json"));
		writeFileSync(
			join(modified, "prompts/examples/organization-constitution.md"),
			"A constitution this directory never committed with 'import:none'.",
		);
		await expect(
			configImport(
				harness.deps,
				{ dir: modified, root: modified, expectedRevision: null, reason: null, actor: "test" },
				noopPrint,
			),
		).rejects.toThrow(AdminError);
		await expect(
			configImport(
				harness.deps,
				{ dir: modified, root: modified, expectedRevision: null, reason: null, actor: "test" },
				noopPrint,
			),
		).rejects.toThrow(/--expected-revision is required/);
	});

	let revisionAfterChange: number;

	it("a later change moves the active revision; diff against the stale export now shows it, and a stale import conflicts", async () => {
		const changeSet = [
			{ type: "set_constitution" as const, constitution: "Changed directly, after the export." },
		];
		const preview = await prepareChange(harness.deps, changeSet);
		const committed = await commitChange(harness.deps, {
			changeSet,
			baseRevisionId: preview.baseRevisionId,
			actor: "test",
			source: "cli_apply",
		});
		revisionAfterChange = committed.revisionId;
		expect(revisionAfterChange).not.toBe(firstRevisionId);

		const printed: string[] = [];
		const ok = await configDiffCommand(
			harness.deps,
			{ dir: dirA, root: dirA, json: false },
			(line) => printed.push(line),
		);
		expect(ok).toBe(true);
		expect(printed[0]).toContain("constitution:");

		await expect(
			configImport(
				harness.deps,
				{ dir: dirA, root: dirA, expectedRevision: firstRevisionId, reason: null, actor: "test" },
				noopPrint,
			),
		).rejects.toThrow(ManagementConflictError);
	});

	it("rolls back to the first revision's content as a new revision, source 'rollback'", async () => {
		const active = await activeConfigRevisionId(harness.deps);
		expect(active).toBe(revisionAfterChange);

		const result = await configRollback(
			harness.deps,
			{
				revisionId: firstRevisionId,
				expectedRevision: revisionAfterChange,
				reason: "rollback test",
				actor: "test",
			},
			noopPrint,
		);
		expect(result.noop).toBe(false);

		const rows = await harness.pool.query<{
			snapshot_hash: string;
			parent_revision_id: number;
			source: string;
			reason: string | null;
		}>(
			"select snapshot_hash, parent_revision_id::int as parent_revision_id, source, reason from config_revisions where id = $1",
			[result.revisionId],
		);
		const target = await harness.pool.query<{ snapshot_hash: string }>(
			"select snapshot_hash from config_revisions where id = $1",
			[firstRevisionId],
		);
		expect(rows.rows[0]?.snapshot_hash).toBe(target.rows[0]?.snapshot_hash);
		expect(rows.rows[0]?.parent_revision_id).toBe(revisionAfterChange);
		expect(rows.rows[0]?.source).toBe("rollback");
		expect(rows.rows[0]?.reason).toBe("rollback test");
	});

	it("refuses a rollback target whose revision does not exist", async () => {
		const active = await activeConfigRevisionId(harness.deps);
		await expect(
			configRollback(
				harness.deps,
				{ revisionId: 999_999, expectedRevision: active ?? 0, reason: null, actor: "test" },
				noopPrint,
			),
		).rejects.toThrow(AdminError);
	});

	it("lists revision history newest first, with the fields an operator needs", async () => {
		const printed: string[] = [];
		await configHistory(harness.deps, 10, (line) => printed.push(line));
		const rows = JSON.parse(printed[0] ?? "[]") as Readonly<
			{
				id: number;
				createdAt: string;
				actor: string;
				source: string;
				reason: string | null;
				snapshotHash: string;
				parentRevisionId: number | null;
			}[]
		>;
		expect(rows.length).toBeGreaterThanOrEqual(3);
		for (let i = 1; i < rows.length; i += 1) {
			expect(rows[i - 1]?.id).toBeGreaterThan(rows[i]?.id ?? 0);
		}
		expect(rows[0]?.source).toBe("rollback");
		expect(rows[0]?.snapshotHash).toHaveLength(12);
	});
});

describe("config apply", () => {
	it("remains a working, source-'cli_apply' alias of a whole-bundle replace (existing callers are unaffected)", async () => {
		const harness = await startHarness();
		try {
			const result = await applyConfig(harness.deps, exampleInput(), "test");
			expect(result.created.length).toBeGreaterThan(0);
			expect(await revisionCount(harness.pool)).toBe(1);
		} finally {
			await harness.stop();
		}
	});
});

describe("config import: idempotency key reuse survives a renamed agent file", () => {
	/** A writable copy of `EXAMPLES_DIR`, so a file inside it can be renamed or edited. */
	function copyExamplesDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "gateway-config-copy-"));
		cpSync(EXAMPLES_DIR, dir, { recursive: true });
		return dir;
	}

	it("the same content under a renamed YAML file replays instead of refusing as key reuse", async () => {
		const harness = await startHarness();
		try {
			const base = await configImport(
				harness.deps,
				{ dir: EXAMPLES_DIR, root: repoRoot, expectedRevision: null, reason: null, actor: "test" },
				noopPrint,
			);

			// A real change against the base revision: `director`'s display name, edited in a copy of
			// the example directory (never the repository's own files).
			const dirC = copyExamplesDir();
			const directorPathC = join(dirC, "agents/director.yaml");
			writeFileSync(
				directorPathC,
				readFileSync(directorPathC, "utf8").replace(
					"display_name: Director",
					"display_name: Director (renamed test)",
				),
			);
			const changed = await configImport(
				harness.deps,
				{
					dir: dirC,
					root: repoRoot,
					expectedRevision: base.revisionId,
					reason: null,
					actor: "test",
				},
				noopPrint,
			);
			expect(changed.noop).toBe(false);
			expect(changed.revisionId).not.toBe(base.revisionId);
			const afterChange = await revisionCount(harness.pool);

			// The same content, but `director.yaml` is now the last file `readdirSync` returns
			// instead of the second: a retry (the same directory content, same --expected-revision)
			// that only looks different because of file order, not configuration meaning.
			const dirD = copyExamplesDir();
			cpSync(join(dirC, "agents/director.yaml"), join(dirD, "agents/director.yaml"), {
				force: true,
			});
			cpSync(join(dirD, "agents/director.yaml"), join(dirD, "agents/zzz-director.yaml"));
			rmSync(join(dirD, "agents/director.yaml"));

			const replayed = await configImport(
				harness.deps,
				{
					dir: dirD,
					root: repoRoot,
					expectedRevision: base.revisionId,
					reason: null,
					actor: "test",
				},
				noopPrint,
			);
			expect(replayed.revisionId).toBe(changed.revisionId);
			expect(await revisionCount(harness.pool)).toBe(afterChange);
		} finally {
			await harness.stop();
		}
	});
});

describe("config import: a replayed commit reports when it is no longer the active revision", () => {
	it("prints that the import already committed, and warns which revision is now active", async () => {
		const harness = await startHarness();
		try {
			const base = await configImport(
				harness.deps,
				{ dir: EXAMPLES_DIR, root: repoRoot, expectedRevision: null, reason: null, actor: "test" },
				noopPrint,
			);

			// A real change against `base`: `director`'s display name, in a writable copy of the
			// example directory (never the repository's own files).
			const dirC = mkdtempSync(join(tmpdir(), "gateway-config-copy-"));
			cpSync(EXAMPLES_DIR, dirC, { recursive: true });
			const directorPath = join(dirC, "agents/director.yaml");
			writeFileSync(
				directorPath,
				readFileSync(directorPath, "utf8").replace(
					"display_name: Director",
					"display_name: Director (replay test)",
				),
			);
			const changed = await configImport(
				harness.deps,
				{
					dir: dirC,
					root: repoRoot,
					expectedRevision: base.revisionId,
					reason: null,
					actor: "test",
				},
				noopPrint,
			);
			expect(changed.noop).toBe(false);

			// A later, unrelated change moves the active revision past `changed` (a different
			// operator, or the same one in another terminal).
			const superseding = await commitChange(harness.deps, {
				changeSet: [{ type: "set_constitution", constitution: "A later, unrelated change." }],
				baseRevisionId: changed.revisionId,
				actor: "test",
				source: "cli_apply",
			});

			// A retry of the `changed` import (the same directory, the same --expected-revision, as
			// if its own response was lost before the caller saw it) replays that commit rather than
			// conflicting — but the active configuration has since moved on, so the operator is told.
			const printed: string[] = [];
			const replay = await configImport(
				harness.deps,
				{
					dir: dirC,
					root: repoRoot,
					expectedRevision: base.revisionId,
					reason: null,
					actor: "test",
				},
				(line) => printed.push(line),
			);
			expect(replay.replayed).toBe(true);
			expect(replay.revisionId).toBe(changed.revisionId);
			expect(replay.activeRevisionId).toBe(superseding.revisionId);
			expect(printed[0]).toContain(`already committed as revision ${changed.revisionId}`);
			expect(printed[1]).toContain(`revision ${superseding.revisionId} is now active`);
			expect(printed[1]).toContain("config diff");
		} finally {
			await harness.stop();
		}
	});
});

describe("config export: target directory rules", () => {
	let harness: Awaited<ReturnType<typeof startHarness>>;

	beforeAll(async () => {
		harness = await startHarness();
		await applyConfig(harness.deps, exampleInput(), "test");
	});

	afterAll(async () => {
		await harness.stop();
	});

	it("refuses a non-empty target directory, leaving it completely untouched", async () => {
		const dir = exportDir();
		writeFileSync(join(dir, "stray.txt"), "not an export");
		const before = readTree(dir);

		await expect(configExport(harness.deps, { dir, revisionId: null }, noopPrint)).rejects.toThrow(
			ConfigFileError,
		);

		expect(readTree(dir)).toEqual(before);
	});

	it("publishes a freshly created target directory with mode 0755", async () => {
		const parent = mkdtempSync(join(tmpdir(), "gateway-export-parent-"));
		const dir = join(parent, "export");
		await configExport(harness.deps, { dir, revisionId: null }, noopPrint);

		// `mkdtemp` itself creates the build directory mode 0700; the published one must be the
		// ordinary 0755 a directory `mkdir` would get, not leak the temp directory's own mode.
		expect(statSync(dir).mode & 0o777).toBe(0o755);
		expect(configBundleProblems(loadConfigDirectory(dir, dir))).toEqual([]);
		// Nothing but the export itself sits beside it: no leftover temp directory.
		expect(readdirSync(parent).sort()).toEqual(["export"]);
	});

	it("writes directly into an existing, empty target directory", async () => {
		const dir = exportDir();
		await configExport(harness.deps, { dir, revisionId: null }, noopPrint);
		expect(configBundleProblems(loadConfigDirectory(dir, dir))).toEqual([]);
	});
});

describe("config export: a stored snapshot predating the shared-path validation", () => {
	it("refuses rather than silently dropping one agent's text when two agents share a role_file but disagree on it", async () => {
		const harness = await startHarness();
		try {
			const applied = await applyConfig(harness.deps, exampleInput(), "test");
			const base = exampleInput();
			// `commitChange`/`applyConfig` would now refuse this bundle outright
			// (`configBundleProblems`); this writes it directly, as a snapshot that predates that
			// rule, to check `config export`'s own defensive check against it.
			const sharedPath = "prompts/examples/agents/developer.md";
			const conflicting = {
				organization: base.organization,
				agents: base.agents.map((a) =>
					a.id === "director" ? { ...a, prompts: { role_file: sharedPath } } : a,
				),
				constitution: base.constitution,
				rolePrompts: base.rolePrompts,
			};
			const bundle = configSnapshotBundle(conflicting);
			const hash = canonicalHash(bundle);
			const [controls] = (
				await harness.pool.query<{ generation: number }>(
					"select config_generation::int as generation from gateway_controls where id = 1",
				)
			).rows;
			await harness.pool.query(
				"insert into config_snapshots (hash, bundle, format, origin, created_at) values ($1, $2::jsonb, 1, 'applied', now())",
				[hash, JSON.stringify(bundle)],
			);
			// Same generation as `gateway_controls.config_generation` already holds (left untouched
			// below): `ensureConfigHistoryIn` treats a revision whose generation disagrees with the
			// live column as stale and silently replaces it with a fresh backfill from the `agents`
			// table before `configExport` ever reads it — which has no conflict, since this insert
			// never touches `agents`, defeating the point of the test.
			const inserted = await harness.pool.query<{ id: number }>(
				`insert into config_revisions (snapshot_hash, parent_revision_id, generation, actor, source, created_at)
				 values ($1, $2, $3, 'test', 'backfill', now()) returning id::int as id`,
				[hash, applied.revisionId, controls?.generation ?? 0],
			);
			await harness.pool.query(
				"update gateway_controls set active_config_revision = $1 where id = 1",
				[inserted.rows[0]?.id],
			);

			// The conflict is caught building the export in memory, before the target directory is
			// ever looked at.
			await expect(
				configExport(harness.deps, { dir: exportDir(), revisionId: null }, noopPrint),
			).rejects.toThrow(ConfigFileError);
		} finally {
			await harness.stop();
		}
	});

	it("refuses to export a snapshot with a role prompt for an agent it does not configure", async () => {
		const harness = await startHarness();
		try {
			const applied = await applyConfig(harness.deps, exampleInput(), "test");
			const base = exampleInput();
			// `commitChange`/`applyConfig` would now refuse this bundle outright
			// (`configBundleProblems`); this writes it directly, as a snapshot that predates that
			// rule, to check `config export`'s own defensive check against it.
			const orphaned = {
				organization: base.organization,
				agents: base.agents,
				constitution: base.constitution,
				rolePrompts: { ...base.rolePrompts, ghost: "A role prompt for an agent that is gone." },
			};
			const bundle = configSnapshotBundle(orphaned);
			const hash = canonicalHash(bundle);
			const [controls] = (
				await harness.pool.query<{ generation: number }>(
					"select config_generation::int as generation from gateway_controls where id = 1",
				)
			).rows;
			await harness.pool.query(
				"insert into config_snapshots (hash, bundle, format, origin, created_at) values ($1, $2::jsonb, 1, 'applied', now())",
				[hash, JSON.stringify(bundle)],
			);
			const inserted = await harness.pool.query<{ id: number }>(
				`insert into config_revisions (snapshot_hash, parent_revision_id, generation, actor, source, created_at)
				 values ($1, $2, $3, 'test', 'backfill', now()) returning id::int as id`,
				[hash, applied.revisionId, controls?.generation ?? 0],
			);
			await harness.pool.query(
				"update gateway_controls set active_config_revision = $1 where id = 1",
				[inserted.rows[0]?.id],
			);

			await expect(
				configExport(harness.deps, { dir: exportDir(), revisionId: null }, noopPrint),
			).rejects.toThrow(ConfigFileError);
		} finally {
			await harness.stop();
		}
	});
});

describe("config export/import: tool attachments round-trip (ADR-027)", () => {
	let harness: Awaited<ReturnType<typeof startHarness>>;

	beforeAll(async () => {
		harness = await startHarness();
		await applyConfig(harness.deps, exampleInput(), "test");
		await ensureToolCatalogSeeded(harness.deps, "test");
	});

	afterAll(async () => {
		await harness.stop();
	});

	it("pre-change export imports: a directory with no tool-attachments.json converts to empty, not refused", async () => {
		// `EXAMPLES_DIR` is exactly what a directory from before ADR-027 looks like: it has no
		// `tool-attachments.json` at all.
		const expectedRevision = await activeConfigRevisionId(harness.deps);
		const result = await configImport(
			harness.deps,
			{ dir: EXAMPLES_DIR, root: repoRoot, expectedRevision, reason: null, actor: "test" },
			noopPrint,
		);
		const { bundle } = await inTransaction(harness.deps, ({ tx }) =>
			loadActiveBundle(tx.db, result.revisionId),
		);
		expect(bundle.toolAttachments).toEqual({});
	});

	it("an attachment round-trips through export and import, losslessly, at the same hash", async () => {
		// `director` is still legacy the first time anything ever attaches to it: `attachTool`
		// converts its own `permissions` (`config/examples/agents/director.yaml`:
		// `tools_allow: [mattermost.post, memory.read, memory.write]`,
		// `tools_deny: [finance.*, deploy.*, mail.send]`) the same way `gateway tools adopt` would,
		// in this same revision, alongside the one attachment actually requested here — never just
		// that one attachment on its own, which would otherwise make `director` hub-managed while
		// silently dropping everything its legacy permissions covered (ADR-027). `memory.read`,
		// `deploy.*` and `mail.send` resolve to no known catalog entry and so convert to nothing.
		const attach = await attachTool(harness.deps, {
			agentId: "director",
			entryId: "gateway-memory-write",
			pinnedVersion: null,
			mode: "allow",
			settings: { note: "integration test" },
			actor: "test",
			source: "cli_apply",
		});
		expect(attach.noop).toBe(false);
		// Every pattern `director`'s own legacy `permissions` resolve to, except `memory.write`: the
		// entry being attached is left to the attachment's own revision.
		expect(attach.legacyConversion.map((a) => a.entryId).sort()).toEqual([
			"executor-finance-payment-create",
			"executor-finance-subscription-create",
			"gateway-mattermost-post",
		]);

		const dir = exportDir();
		await configExport(harness.deps, { dir, revisionId: attach.revisionId }, noopPrint);
		const written = JSON.parse(readFileSync(join(dir, "tool-attachments.json"), "utf8"));
		expect(written).toEqual({
			director: [
				{
					entryId: "executor-finance-payment-create",
					pinnedVersion: null,
					mode: "disabled",
					settings: {},
				},
				{
					entryId: "executor-finance-subscription-create",
					pinnedVersion: null,
					mode: "disabled",
					settings: {},
				},
				{
					entryId: "gateway-mattermost-post",
					pinnedVersion: null,
					mode: "allow",
					settings: {},
				},
				{
					entryId: "gateway-memory-write",
					pinnedVersion: null,
					mode: "allow",
					settings: { note: "integration test" },
				},
			],
		});

		const reloaded = loadConfigDirectory(dir, dir);
		expect(reloaded.toolAttachments).toEqual(written);

		const reimportDir = exportDir();
		rmSync(reimportDir, { recursive: true, force: true });
		cpSync(dir, reimportDir, { recursive: true });
		const imported = await configImport(
			harness.deps,
			{
				dir: reimportDir,
				root: reimportDir,
				expectedRevision: attach.revisionId,
				reason: null,
				actor: "test",
			},
			noopPrint,
		);
		expect(imported.noop).toBe(true);
		expect(imported.hash).toBe(attach.hash);
	});

	it("an untouched export/import round-trips to a no-op even when attachments were made in a different order than export's own sort (ADR-027)", async () => {
		// Attached in reverse alphabetical order of entryId: an export that sorts
		// `tool-attachments.json` (`toolAttachmentsText`) but a stored bundle that still hashes them
		// in attach order would make this untouched round-trip manufacture a new revision instead of
		// a no-op.
		await attachTool(harness.deps, {
			agentId: "director",
			entryId: "native-web-search",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});
		const attached = await attachTool(harness.deps, {
			agentId: "director",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});

		const dir = exportDir();
		await configExport(harness.deps, { dir, revisionId: attached.revisionId }, noopPrint);
		const imported = await configImport(
			harness.deps,
			{
				dir,
				root: dir,
				expectedRevision: attached.revisionId,
				reason: null,
				actor: "test",
			},
			noopPrint,
		);
		expect(imported.noop).toBe(true);
		expect(imported.hash).toBe(attached.hash);
	});

	it("rollback restores a prior revision's own attachments, not merely whatever is live now", async () => {
		const before = await activeConfigRevisionId(harness.deps);
		if (before === null) {
			throw new Error("expected an active revision");
		}
		const { bundle: beforeBundle } = await inTransaction(harness.deps, ({ tx }) =>
			loadActiveBundle(tx.db, before),
		);
		// `gateway-mattermost-post` is a `gateway`-kind entry: `allow`/`disabled` only
		// (`modeSupportedByKind`) — no enforcement point pauses a turn mid-flight for a human to
		// approve a direct Gateway action.
		await attachTool(harness.deps, {
			agentId: "director",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "disabled",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});
		const afterAttach = await activeConfigRevisionId(harness.deps);
		const result = await configRollback(
			harness.deps,
			{ revisionId: before, expectedRevision: afterAttach ?? before, reason: null, actor: "test" },
			noopPrint,
		);
		const { bundle: rolledBack } = await inTransaction(harness.deps, ({ tx }) =>
			loadActiveBundle(tx.db, result.revisionId),
		);
		expect(rolledBack.toolAttachments.director).toEqual(
			beforeBundle.toolAttachments.director ?? [],
		);
	});

	it("retrying an import whose attachments are merely reordered replays it instead of refusing key reuse", async () => {
		const base = await activeConfigRevisionId(harness.deps);
		if (base === null) {
			throw new Error("expected an active revision");
		}
		await attachTool(harness.deps, {
			agentId: "director",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});
		const attached = await attachTool(harness.deps, {
			agentId: "director",
			entryId: "native-web-search",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});
		const dir = exportDir();
		await configExport(harness.deps, { dir, revisionId: attached.revisionId }, noopPrint);
		const file = join(dir, "tool-attachments.json");
		// Edited by hand below: the export's own manifest would refuse the changed file first.
		rmSync(join(dir, "manifest.json"));
		const exported: Record<string, { settings: Record<string, string> }[]> = JSON.parse(
			readFileSync(file, "utf8"),
		);
		const director = exported.director ?? [];
		expect(director.length).toBeGreaterThanOrEqual(2);
		const edited = director.map((attachment) => ({ ...attachment, settings: { note: "edited" } }));
		writeFileSync(file, `${JSON.stringify({ ...exported, director: edited }, null, 2)}\n`);
		const options = {
			dir,
			root: dir,
			expectedRevision: attached.revisionId,
			reason: null,
			actor: "test",
		};
		const first = await configImport(harness.deps, options, noopPrint);
		expect(first.noop).toBe(false);

		writeFileSync(
			file,
			`${JSON.stringify({ ...exported, director: [...edited].reverse() }, null, 2)}\n`,
		);
		const retry = await configImport(harness.deps, options, noopPrint);
		expect(retry.revisionId).toBe(first.revisionId);
	});

	it("config apply refuses a directory that still attaches a since-deleted catalog entry", async () => {
		const attached = await attachTool(harness.deps, {
			agentId: "director",
			entryId: "native-web-fetch",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "cli_apply",
		});
		const dir = exportDir();
		await configExport(harness.deps, { dir, revisionId: attached.revisionId }, noopPrint);
		await deleteCatalogEntry(harness.deps, "native-web-fetch", "test");

		await expect(applyConfig(harness.deps, loadConfigDirectory(dir, dir), "test")).rejects.toThrow(
			/native-web-fetch' does not exist/,
		);
	});
});

describe("attachTool: a retry of the attachment that converted a legacy agent replays it", () => {
	let harness: Awaited<ReturnType<typeof startHarness>>;

	beforeAll(async () => {
		harness = await startHarness();
		await applyConfig(harness.deps, exampleInput(), "test");
		await ensureToolCatalogSeeded(harness.deps, "test");
	});

	afterAll(async () => {
		await harness.stop();
	});

	it("returns the first commit, not a key-reuse refusal, once the agent is hub-managed", async () => {
		const input = {
			agentId: "research",
			entryId: "native-repository-read",
			pinnedVersion: null,
			mode: "allow" as const,
			actor: "test",
			source: "cli_apply" as const,
			idempotencyKey: "attach-research-repository-read",
		};
		const first = await attachTool(harness.deps, input);
		expect(first.replayed).toBe(false);
		expect(first.legacyConversion.length).toBeGreaterThan(0);

		const retry = await attachTool(harness.deps, input);
		expect(retry.replayed).toBe(true);
		expect(retry.revisionId).toBe(first.revisionId);
	});

	it("records the caller's key even when the legacy agent already had exactly this attachment", async () => {
		// `operator` already allows `mattermost.post`: were the conversion to install it, the
		// attachment itself would be a no-op that never stores the key.
		const input = {
			agentId: "operator",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "allow" as const,
			actor: "test",
			source: "cli_apply" as const,
			idempotencyKey: "attach-operator-post",
		};
		const first = await attachTool(harness.deps, input);
		expect(first.noop).toBe(false);
		const retry = await attachTool(harness.deps, input);
		expect(retry.replayed).toBe(true);
		expect(retry.revisionId).toBe(first.revisionId);
	});

	it("accepts a maximum-length key for an agent that is still legacy", async () => {
		const result = await attachTool(harness.deps, {
			agentId: "mail-follower",
			entryId: "native-web-search",
			pinnedVersion: null,
			mode: "allow",
			actor: "test",
			source: "cli_apply",
			idempotencyKey: "k".repeat(200),
		});
		expect(result.noop).toBe(false);
	});

	it("adopts several legacy agents under one key, each in its own revision", async () => {
		const results = await adoptAgentToolAttachments(harness.deps, {
			agentIds: ["director", "developer"],
			dryRun: false,
			actor: "test",
			idempotencyKey: "adopt-director-developer",
		});
		expect(results.map((result) => result.commit?.revisionId ?? null)).not.toContain(null);
		const retry = await adoptAgentToolAttachments(harness.deps, {
			agentIds: ["director", "developer"],
			dryRun: false,
			actor: "test",
			idempotencyKey: "adopt-director-developer",
		});
		expect(retry.every((result) => result.alreadyHubManaged)).toBe(true);
	});

	it("refuses the same key for a different attachment", async () => {
		await expect(
			attachTool(harness.deps, {
				agentId: "research",
				entryId: "native-repository-read",
				pinnedVersion: null,
				mode: "disabled",
				actor: "test",
				source: "cli_apply",
				idempotencyKey: "attach-research-repository-read",
			}),
		).rejects.toThrow(/different change set/);
	});

	it("replays a committed attachment even after its catalog entry was deleted", async () => {
		const input = {
			agentId: "finance",
			entryId: "native-web-fetch",
			pinnedVersion: null,
			mode: "allow" as const,
			actor: "test",
			source: "cli_apply" as const,
			idempotencyKey: "attach-finance-web-fetch",
		};
		const first = await attachTool(harness.deps, input);
		await deleteCatalogEntry(harness.deps, "native-web-fetch", "test");
		const retry = await attachTool(harness.deps, input);
		expect(retry.replayed).toBe(true);
		expect(retry.revisionId).toBe(first.revisionId);
	});
});
