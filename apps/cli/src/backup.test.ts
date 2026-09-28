import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ageCheck,
	type BackupCheckOptions,
	type BackupManifest,
	checkBackup,
	dumpChecks,
	majorVersion,
	type PgTools,
	sameDatabaseUrl,
	scanManifests,
	schemaCheck,
	scratchUrlIssue,
	withoutPassword,
} from "./backup.ts";

const NOW = new Date("2026-09-28T12:00:00Z");
const DUMP = Buffer.from("PGDMP fake archive");

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "backup-test-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function manifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
	return {
		format: "agent-gateway-backup/1",
		database: "gateway",
		system_identifier: "7400000000000000001",
		completed_at: "2026-09-28T02:00:00Z",
		schema_version: { migrations: 12, latest_hash: "abc" },
		pg_dump_version: "pg_dump (PostgreSQL) 17.6",
		dump_file: "gateway-1.dump",
		size_bytes: DUMP.length,
		sha256: createHash("sha256").update(DUMP).digest("hex"),
		...overrides,
	};
}

function writeBackup(m: BackupManifest, name = "gateway-1", dump: Buffer | null = DUMP): void {
	if (dump !== null) {
		writeFileSync(join(dir, m.dump_file), dump);
	}
	writeFileSync(join(dir, `${name}.manifest.json`), JSON.stringify(m));
}

function tools(
	list = {
		code: 0,
		stdout: "1; 2615 2200 SCHEMA - public\n2; 1259 16390 TABLE public events\n",
		stderr: "",
	},
	version = "pg_restore (PostgreSQL) 17.6",
): PgTools & { calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		pgRestore: async (args) => {
			calls.push([...args]);
			if (args[0] === "--version") {
				return { code: 0, stdout: version, stderr: "" };
			}
			return list;
		},
	};
}

function options(overrides: Partial<BackupCheckOptions> = {}): BackupCheckOptions {
	return {
		dir,
		maxAgeHours: 26,
		restoreTest: false,
		liveUrl: null,
		scratchUrl: null,
		tools: tools(),
		now: NOW,
		...overrides,
	};
}

describe("scanManifests", () => {
	it("picks the latest completed manifest and names the invalid ones", () => {
		writeBackup(manifest({ completed_at: "2026-09-27T02:00:00Z", dump_file: "a.dump" }), "a");
		writeBackup(manifest({ completed_at: "2026-09-28T02:00:00Z", dump_file: "b.dump" }), "b");
		writeFileSync(join(dir, "c.manifest.json"), "{ not json");
		writeFileSync(join(dir, "d.manifest.json"), JSON.stringify({ ...manifest(), extra: 1 }));
		const scan = scanManifests(dir);
		expect(scan.newest?.manifest.dump_file).toBe("b.dump");
		expect(scan.invalid).toEqual(["c.manifest.json", "d.manifest.json"]);
	});

	it("refuses a dump path that leaves the directory", () => {
		writeFileSync(
			join(dir, "x.manifest.json"),
			JSON.stringify({ ...manifest(), dump_file: "../elsewhere.dump" }),
		);
		expect(scanManifests(dir)).toEqual({ newest: null, invalid: ["x.manifest.json"] });
	});
});

describe("ageCheck", () => {
	it("accepts a fresh backup and fails a stale or future one", () => {
		expect(ageCheck(manifest(), 26, NOW).ok).toBe(true);
		expect(ageCheck(manifest({ completed_at: "2026-09-27T09:00:00Z" }), 26, NOW)).toMatchObject({
			ok: false,
			detail: expect.stringContaining("27.0 h ago"),
		});
		expect(ageCheck(manifest({ completed_at: "2026-09-28T13:00:00Z" }), 26, NOW).ok).toBe(false);
	});
});

describe("dumpChecks", () => {
	it("checks presence, size and checksum", async () => {
		const m = manifest();
		expect(await dumpChecks(dir, m)).toEqual([
			{ name: "dump", ok: false, detail: "gateway-1.dump is missing" },
		]);
		writeFileSync(join(dir, m.dump_file), Buffer.from("PGDMP"));
		expect((await dumpChecks(dir, m))[0]).toMatchObject({
			ok: false,
			detail: expect.stringContaining("5 bytes"),
		});
		writeFileSync(join(dir, m.dump_file), Buffer.from("PGDMP fake archivX"));
		expect((await dumpChecks(dir, m)).map((check) => check.ok)).toEqual([true, false]);
		writeFileSync(join(dir, m.dump_file), DUMP);
		expect((await dumpChecks(dir, m)).map((check) => check.ok)).toEqual([true, true]);
	});
});

describe("helpers", () => {
	it("reads major versions", () => {
		expect(majorVersion("pg_restore (PostgreSQL) 17.6")).toBe(17);
		expect(majorVersion("pg_dump (PostgreSQL) 16.10 (Ubuntu 16.10-0ubuntu0.24.04.1)")).toBe(16);
		expect(majorVersion("none")).toBeNull();
	});

	it("compares databases by server and name", () => {
		expect(
			sameDatabaseUrl("postgres://a:b@127.0.0.1/gateway", "postgres://c@localhost:5432/gateway"),
		).toBe(true);
		expect(sameDatabaseUrl("postgres://a@db:5432/gateway", "postgres://a@db:5432/scratch")).toBe(
			false,
		);
		expect(sameDatabaseUrl("postgres://a@db:5432/gateway", "postgres://a@db:5433/gateway")).toBe(
			false,
		);
	});

	it("moves a password out of a connection string", () => {
		expect(withoutPassword("postgres://gw:p%40ss@db:5432/scratch")).toEqual({
			url: "postgres://gw@db:5432/scratch",
			password: "p@ss",
		});
		expect(withoutPassword("postgres://gw@db/scratch").password).toBeNull();
		expect(withoutPassword("postgres://gw@db/scratch?password=s3cret&sslmode=require")).toEqual({
			url: "postgres://gw@db/scratch?sslmode=require",
			password: "s3cret",
		});
		expect(withoutPassword("postgres://gw@db/scratch?options=-c%20x%3Dy&password=p").url).toBe(
			"postgres://gw@db/scratch?options=-c%20x%3Dy",
		);
	});

	it("refuses a backup of another migration history at the same count", () => {
		const backup = { migrations: 12, latest_hash: "a" };
		expect(schemaCheck(backup, { migrations: 12, latest_hash: "a" }, 12).ok).toBe(true);
		expect(schemaCheck(backup, { migrations: 12, latest_hash: "b" }, 12).detail).toContain(
			"another migration history",
		);
		expect(schemaCheck(backup, { migrations: 13, latest_hash: "c" }, 13).ok).toBe(true);
		expect(schemaCheck(backup, { migrations: 11, latest_hash: "a" }, 11).ok).toBe(false);
	});

	it("refuses scratch URL parameters only one client would read", () => {
		expect(scratchUrlIssue("postgres://gw@db/scratch?sslmode=require")).toBeNull();
		expect(scratchUrlIssue("postgres://gw@db/scratch?dbname=live")).toContain("dbname");
		expect(scratchUrlIssue("postgres:///scratch")).toContain("must name its host");
		expect(scratchUrlIssue("postgres://gw@db/")).toContain("database");
		expect(scratchUrlIssue("postgres://db/scratch")).toContain("user");
		expect(withoutPassword("postgres://gw@db/scratch?pass%77ord=x").url).toBe(
			"postgres://gw@db/scratch",
		);
	});
});

describe("checkBackup", () => {
	it("fails without a directory or a complete backup", async () => {
		const missing = await checkBackup(options({ dir: join(dir, "nope") }));
		expect(missing).toMatchObject({ ok: false, checks: [{ name: "directory", ok: false }] });
		writeFileSync(join(dir, "gateway-1.dump"), DUMP);
		const incomplete = await checkBackup(options());
		expect(incomplete).toMatchObject({ ok: false, checks: [{ name: "manifest", ok: false }] });
	});

	it("passes a complete, fresh, readable backup", async () => {
		writeBackup(manifest());
		const pg = tools();
		const report = await checkBackup(options({ tools: pg }));
		expect(report.checks.map((check) => [check.name, check.ok])).toEqual([
			["manifest", true],
			["age", true],
			["dump", true],
			["checksum", true],
			["pg_restore", true],
			["toc", true],
		]);
		expect(report.ok).toBe(true);
		expect(pg.calls).toEqual([["--version"], ["--list"]]);
	});

	it("does not read an archive whose checksum is wrong", async () => {
		writeBackup(manifest(), "gateway-1", Buffer.from("PGDMP fake archivX"));
		const pg = tools();
		const report = await checkBackup(options({ tools: pg }));
		expect(report.ok).toBe(false);
		expect(pg.calls).toEqual([]);
	});

	it("fails an unreadable archive and a pg_restore older than the dump", async () => {
		writeBackup(manifest());
		const broken = await checkBackup(
			options({
				tools: tools({
					code: 1,
					stdout: "",
					stderr: "pg_restore: error: could not read input file",
				}),
			}),
		);
		expect(broken.checks.at(-1)).toMatchObject({
			name: "toc",
			ok: false,
			detail: expect.stringContaining("could not read"),
		});
		const old = await checkBackup(
			options({ tools: tools(undefined, "pg_restore (PostgreSQL) 16.10") }),
		);
		expect(old.checks.at(-1)).toMatchObject({ name: "pg_restore", ok: false });
	});

	it("refuses a restore test into the live database and one without a scratch database", async () => {
		writeBackup(manifest());
		const live = "postgres://gw:secret@127.0.0.1:1/gateway";
		const same = await checkBackup(
			options({
				restoreTest: true,
				liveUrl: live,
				scratchUrl: "postgres://gw@localhost:1/gateway",
			}),
		);
		expect(same.checks.at(-1)).toEqual({
			name: "restore",
			ok: false,
			detail: "refused: the scratch database is the live one",
		});
		// The live database is not reachable here: identity is skipped, not failed.
		expect(same.checks.find((check) => check.name === "identity")).toMatchObject({
			ok: true,
			detail: expect.stringContaining("skipped"),
		});
		expect(JSON.stringify(same)).not.toContain("secret");
		const none = await checkBackup(options({ restoreTest: true }));
		expect(none.checks.at(-1)).toMatchObject({ name: "restore", ok: false });
	});
});
