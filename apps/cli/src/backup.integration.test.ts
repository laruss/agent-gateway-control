import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, migrateDatabase } from "@agent-gateway/db";
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

const SCRIPT = join(import.meta.dirname, "../../../scripts/backup-gateway-db.sh");
const PASSWORD = "gateway-backup-test";

let container: StartedPostgreSqlContainer;
let liveUrl: string;
let scratchUrl: string;
let backupDir: string;
let tools: PgTools;

/** The client tools run inside the database container: the host's may be older than the server. */
function containerTools(): PgTools {
	const hostAddress = `${container.getHost()}:${container.getPort()}`;
	return {
		pgRestore: async (args, stdinFile, env = {}) => {
			const child = Bun.spawn(
				[
					"docker",
					"exec",
					"-i",
					"-e",
					"PGPASSWORD",
					container.getId(),
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

async function runScript(dir: string): Promise<void> {
	const exec = `docker exec -i -e PGPASSWORD ${container.getId()}`;
	const child = Bun.spawn(["bash", SCRIPT, dir], {
		env: {
			PATH: process.env.PATH ?? "",
			DATABASE_URL: `postgres://gateway:${PASSWORD}@localhost:5432/gateway_test`,
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
	} finally {
		await pool.end();
	}
	tools = containerTools();
	backupDir = mkdtempSync(join(tmpdir(), "backup-it-"));
	await runScript(backupDir);
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
		]);
		expect(report.checks.at(-1)?.detail).toContain("audit_log 1");
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
});
