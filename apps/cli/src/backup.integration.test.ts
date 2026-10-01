import { createHash } from "node:crypto";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_SNAPSHOT_FORMAT } from "@agent-gateway/contracts";
import { createPool, migrateDatabase } from "@agent-gateway/db";
import { canonicalHash } from "@agent-gateway/events";
import { POSTGRES_IMAGE } from "@agent-gateway/testkit";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type BackupCheckOptions,
	BackupManifestSchema,
	checkBackup,
	MANIFEST_SUFFIX,
	type PgTools,
	provesDistinct,
	scanManifests,
} from "./backup.ts";

/** Minimal, schema-shape-only bundle: the backup checks only hash it, never validate it. */
function fixtureBundle(tag: string) {
	return { organization: { id: tag }, agents: [], constitution: "Be helpful.", rolePrompts: {} };
}

const SCRIPT = join(import.meta.dirname, "../../../scripts/backup-gateway-db.sh");
const PASSWORD = "gateway-backup-test";
const DB_MIGRATIONS_DIR = join(import.meta.dirname, "../../../packages/db/migrations");
/** `0018_config_history` is the first migration `backup.ts`'s config-history checks require. */
const CONFIG_HISTORY_MIGRATION_TAG = "0018_config_history";

type JournalEntry = Readonly<{ tag: string }>;

/**
 * A migrations folder holding only the migrations strictly before `0018_config_history`: the
 * schema a 0.3.0-era database (and its backup) actually has, built from the real migration files
 * so it can never drift from them. Deleted by the caller once the test is done with it.
 */
function buildPreConfigHistoryMigrationsFolder(): string {
	const dir = mkdtempSync(join(tmpdir(), "pre-config-history-migrations-"));
	mkdirSync(join(dir, "meta"));
	const journal = JSON.parse(
		readFileSync(join(DB_MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
	) as {
		entries: JournalEntry[];
	};
	const kept = journal.entries.filter((entry) => entry.tag < CONFIG_HISTORY_MIGRATION_TAG);
	for (const entry of kept) {
		cpSync(join(DB_MIGRATIONS_DIR, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
	}
	writeFileSync(
		join(dir, "meta/_journal.json"),
		JSON.stringify({ ...journal, entries: kept }, null, 2),
	);
	return dir;
}

let container: StartedPostgreSqlContainer;
let liveUrl: string;
let scratchUrl: string;
let backupDir: string;
let tools: PgTools;
let configRevisionId: number;
let configSnapshotHash: string;

/** The client tools run inside the database container: the host's may be older than the server. */
function containerTools(target: StartedPostgreSqlContainer): PgTools {
	const hostAddress = `${target.getHost()}:${target.getPort()}`;
	return {
		pgRestore: async (args, stdinFile, env = {}) => {
			const child = Bun.spawn(
				[
					"docker",
					"exec",
					"-i",
					"-e",
					"PGPASSWORD",
					target.getId(),
					"pg_restore",
					...args.map((arg) => arg.replace(hostAddress, "localhost:5432")),
				],
				{
					stdin: stdinFile === null ? "ignore" : Bun.file(stdinFile),
					stdout: "pipe",
					stderr: "pipe",
					env: { ...process.env, PGPASSWORD: "", ...env },
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { code, stdout, stderr };
		},
	};
}

async function runScript(
	target: StartedPostgreSqlContainer,
	dir: string,
	database = "gateway_test",
): Promise<void> {
	const exec = `docker exec -i -e PGPASSWORD ${target.getId()}`;
	const child = Bun.spawn(["bash", SCRIPT, dir], {
		env: {
			PATH: process.env.PATH ?? "",
			DATABASE_URL: `postgres://gateway:${PASSWORD}@localhost:5432/${database}`,
			PG_DUMP: `${exec} pg_dump`,
			PSQL: `${exec} psql`,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	if (code !== 0) {
		throw new Error(`backup script failed: ${stderr}`);
	}
}

function options(dir: string, overrides: Partial<BackupCheckOptions> = {}): BackupCheckOptions {
	return {
		dir,
		maxAgeHours: 26,
		restoreTest: false,
		liveUrl,
		scratchUrl,
		tools,
		now: new Date(),
		...overrides,
	};
}

/** A copy of the backup directory to damage. */
function copyBackup(): string {
	const dir = mkdtempSync(join(tmpdir(), "backup-copy-"));
	cpSync(backupDir, dir, { recursive: true });
	return dir;
}

function failed(report: Awaited<ReturnType<typeof checkBackup>>): string[] {
	return report.checks.filter((check) => !check.ok).map((check) => check.name);
}

beforeAll(async () => {
	container = await new PostgreSqlContainer(POSTGRES_IMAGE)
		.withDatabase("gateway_test")
		.withUsername("gateway")
		.withPassword(PASSWORD)
		.start();
	liveUrl = container.getConnectionUri();
	scratchUrl = liveUrl.replace(/\/gateway_test$/u, "/gateway_scratch");
	const pool = createPool(liveUrl, 1);
	try {
		await migrateDatabase(pool);
		await pool.query("create database gateway_scratch");
		await pool.query(
			`insert into audit_log (actor, action, subject_type, subject_id, detail)
			 values ('test', 'backup.seed', 'test', 'seed', '{}')`,
		);
		// A configuration history fixture, written directly (the way `applyConfig` itself would,
		// minus the queue infrastructure this test has no need of): `gateway backup check
		// --restore-test` must prove the restored history is whole, not only that the older tables
		// came back.
		const bundle = fixtureBundle("backup-test");
		configSnapshotHash = canonicalHash(bundle);
		await pool.query(
			"insert into config_snapshots (hash, bundle, format, origin, created_at) values ($1, $2, $3, 'applied', now())",
			[configSnapshotHash, JSON.stringify(bundle), CONFIG_SNAPSHOT_FORMAT],
		);
		const revision = await pool.query<{ id: number }>(
			`insert into config_revisions (snapshot_hash, parent_revision_id, generation, actor, source, created_at)
			 values ($1, null, 1, 'test', 'cli_apply', now()) returning id::int as id`,
			[configSnapshotHash],
		);
		const revisionId = revision.rows[0]?.id;
		if (revisionId === undefined) {
			throw new Error("expected a config_revisions row to be inserted");
		}
		configRevisionId = revisionId;
		await pool.query(
			"update gateway_controls set active_config_version = $1, active_config_revision = $2, config_generation = 1 where id = 1",
			[configSnapshotHash, configRevisionId],
		);
	} finally {
		await pool.end();
	}
	tools = containerTools(container);
	backupDir = mkdtempSync(join(tmpdir(), "backup-it-"));
	await runScript(container, backupDir);
}, 180_000);

afterAll(async () => {
	rmSync(backupDir, { recursive: true, force: true });
	await container?.stop();
});

describe("gateway backup check against a real backup", () => {
	it("the script writes a dump and a manifest that describes it", () => {
		const { newest, invalid } = scanManifests(backupDir);
		expect(invalid).toEqual([]);
		const manifest = BackupManifestSchema.parse(newest?.manifest);
		expect(manifest).toMatchObject({ database: "gateway_test", format: "agent-gateway-backup/1" });
		expect(manifest.schema_version.migrations).toBeGreaterThan(0);
		expect(manifest.pg_dump_version).toContain("17.");
		const file = readFileSync(join(backupDir, manifest.dump_file));
		expect(createHash("sha256").update(file).digest("hex")).toBe(manifest.sha256);
		// The manifest carries no connection details.
		expect(readFileSync(newest?.file ?? "", "utf8")).not.toContain(PASSWORD);
	});

	it("passes a good backup, restored into a scratch database", async () => {
		const report = await checkBackup(options(backupDir, { restoreTest: true }));
		expect(failed(report)).toEqual([]);
		expect(report.checks.map((check) => check.name)).toEqual([
			"manifest",
			"age",
			"dump",
			"checksum",
			"identity",
			"schema",
			"pg_restore",
			"toc",
			"restore",
			"restored:migrations",
			"restored:controls",
			"restored:tables",
			"restored:active_revision",
			"restored:snapshot_hashes",
		]);
		const byName = (name: string) => report.checks.find((check) => check.name === name);
		expect(byName("restored:tables")?.detail).toContain("audit_log 1");
		expect(byName("restored:tables")?.detail).toContain("config_snapshots 1");
		expect(byName("restored:tables")?.detail).toContain("config_revisions 1");
		// The active revision, its snapshot, and the snapshot's own hash all survived the restore.
		expect(byName("restored:active_revision")).toMatchObject({
			ok: true,
			detail: `revision ${configRevisionId}, snapshot ${configSnapshotHash.slice(0, 12)}`,
		});
		expect(byName("restored:snapshot_hashes")).toMatchObject({
			ok: true,
			detail: "1 snapshot(s) verified",
		});
		expect(JSON.stringify(report)).not.toContain(PASSWORD);
		// Restoring again replaces the scratch database's contents.
		expect((await checkBackup(options(backupDir, { restoreTest: true }))).ok).toBe(true);
	});

	it("refuses to restore into the live database", async () => {
		const report = await checkBackup(
			options(backupDir, { restoreTest: true, scratchUrl: liveUrl }),
		);
		expect(report.checks.at(-1)).toEqual({
			name: "restore",
			ok: false,
			detail: "refused: the scratch database is the live one",
		});
	});

	it("proves the scratch database is another one by a probe, not by the URL", async () => {
		const probe = async (url: string) => {
			const pool = createPool(url, 1);
			const client = await pool.connect();
			try {
				return await provesDistinct(client, liveUrl);
			} finally {
				client.release();
				await pool.end();
			}
		};
		// However the live database is reached (an alias, a proxy), its probe shows up there.
		expect(await probe(liveUrl)).toContain("is the live one");
		expect(await probe(scratchUrl)).toBeNull();
		// Without the live database there is no proof, and nothing is emptied.
		const report = await checkBackup(options(backupDir, { restoreTest: true, liveUrl: null }));
		expect(report.checks.at(-1)).toMatchObject({ name: "restore", ok: false });
	});

	it("fails the live checks when a reachable live database cannot be queried", async () => {
		const pool = createPool(liveUrl, 1);
		try {
			await pool.query("create role backup_reader login password 'reader-test'");
		} finally {
			await pool.end();
		}
		const reader = new URL(liveUrl);
		reader.username = "backup_reader";
		reader.password = "reader-test";
		const report = await checkBackup(options(backupDir, { liveUrl: reader.toString() }));
		expect(report.checks.find((check) => check.name === "identity")).toMatchObject({ ok: false });
	});

	it("fails a stale backup", async () => {
		const later = new Date(Date.now() + 30 * 3_600_000);
		expect(failed(await checkBackup(options(backupDir, { now: later })))).toEqual(["age"]);
	});

	it("fails a corrupt, a missing and a truncated dump", async () => {
		const corrupt = copyBackup();
		const missing = copyBackup();
		const truncated = copyBackup();
		try {
			const manifest = scanManifests(backupDir).newest?.manifest;
			if (manifest === undefined) {
				throw new Error("no manifest");
			}
			const bytes = readFileSync(join(backupDir, manifest.dump_file));

			const flipped = Buffer.from(bytes);
			flipped[bytes.length - 10] = (flipped[bytes.length - 10] ?? 0) ^ 0xff;
			writeFileSync(join(corrupt, manifest.dump_file), flipped);
			expect(failed(await checkBackup(options(corrupt)))).toEqual(["checksum"]);

			unlinkSync(join(missing, manifest.dump_file));
			expect(failed(await checkBackup(options(missing)))).toEqual(["dump"]);

			// A truncated archive whose manifest was written for it: only reading it tells.
			const cut = bytes.subarray(0, 64);
			writeFileSync(join(truncated, manifest.dump_file), cut);
			const manifestFile = (scanManifests(truncated).newest?.file ?? "").replace(/.*\//u, "");
			expect(manifestFile.endsWith(MANIFEST_SUFFIX)).toBe(true);
			writeFileSync(
				join(truncated, manifestFile),
				JSON.stringify({
					...manifest,
					size_bytes: cut.length,
					sha256: createHash("sha256").update(cut).digest("hex"),
				}),
			);
			expect(failed(await checkBackup(options(truncated)))).toEqual(["toc"]);
		} finally {
			for (const dir of [corrupt, missing, truncated]) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	// Last: it writes directly into the live database a `config_snapshots` row the append-only
	// trigger (migration 0019) then forbids ever deleting, so every test above runs against the
	// single, honestly-hashed snapshot seeded in `beforeAll` first.
	it("reports a config snapshot whose stored hash does not match its own content", async () => {
		const pool = createPool(liveUrl, 1);
		try {
			await pool.query(
				"insert into config_snapshots (hash, bundle, format, origin, created_at) values ($1, $2, $3, 'applied', now())",
				["0".repeat(64), JSON.stringify(fixtureBundle("tampered")), CONFIG_SNAPSHOT_FORMAT],
			);
		} finally {
			await pool.end();
		}
		const dir = mkdtempSync(join(tmpdir(), "backup-tamper-"));
		try {
			await runScript(container, dir);
			const report = await checkBackup(options(dir, { restoreTest: true }));
			expect(report.ok).toBe(false);
			expect(
				report.checks.find((check) => check.name === "restored:snapshot_hashes"),
			).toMatchObject({ ok: false, detail: expect.stringContaining("0".repeat(12)) });
			// Every other restored check (the ones unrelated to the tampered row) still passes.
			expect(failed(report)).toEqual(["restored:snapshot_hashes"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("gateway backup check against a pre-config-history (0.3.0-era) backup", () => {
	let preContainer: StartedPostgreSqlContainer;
	let preLiveUrl: string;
	let preScratchUrl: string;
	let preBackupDir: string;
	let preTools: PgTools;
	let migrationsFolder: string;

	beforeAll(async () => {
		preContainer = await new PostgreSqlContainer(POSTGRES_IMAGE)
			.withDatabase("gateway_test_pre0018")
			.withUsername("gateway")
			.withPassword(PASSWORD)
			.start();
		preLiveUrl = preContainer.getConnectionUri();
		preScratchUrl = preLiveUrl.replace(/\/gateway_test_pre0018$/u, "/gateway_scratch_pre0018");
		migrationsFolder = buildPreConfigHistoryMigrationsFolder();
		const pool = createPool(preLiveUrl, 1);
		try {
			await migrateDatabase(pool, migrationsFolder);
			await pool.query("create database gateway_scratch_pre0018");
			await pool.query(
				`insert into audit_log (actor, action, subject_type, subject_id, detail)
				 values ('test', 'backup.seed', 'test', 'seed', '{}')`,
			);
		} finally {
			await pool.end();
		}
		preTools = containerTools(preContainer);
		preBackupDir = mkdtempSync(join(tmpdir(), "backup-it-pre0018-"));
		await runScript(preContainer, preBackupDir, "gateway_test_pre0018");
	}, 180_000);

	afterAll(async () => {
		rmSync(preBackupDir, { recursive: true, force: true });
		rmSync(migrationsFolder, { recursive: true, force: true });
		await preContainer?.stop();
	});

	it("a healthy backup taken before migration 0018 passes --restore-test", async () => {
		const report = await checkBackup({
			dir: preBackupDir,
			maxAgeHours: 26,
			restoreTest: true,
			liveUrl: preLiveUrl,
			scratchUrl: preScratchUrl,
			tools: preTools,
			now: new Date(),
		});
		expect(failed(report)).toEqual([]);
		expect(report.ok).toBe(true);
		const byName = (name: string) => report.checks.find((check) => check.name === name);
		// Neither table nor the active-revision column exist at this schema: nothing to check, and
		// `restored:tables` must not demand them.
		expect(byName("restored:tables")?.detail).not.toContain("config_snapshots");
		expect(byName("restored:tables")?.detail).not.toContain("config_revisions");
		expect(byName("restored:active_revision")).toBeUndefined();
		expect(byName("restored:snapshot_hashes")).toBeUndefined();
	});
});
