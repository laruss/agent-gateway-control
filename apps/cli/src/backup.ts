import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ConfigSnapshotBundle } from "@agent-gateway/contracts";
import { createPool } from "@agent-gateway/db";
import { canonicalHash } from "@agent-gateway/events";
import { redactText } from "@agent-gateway/logging";
import pg from "pg";
import { z } from "zod";

/** A check in the shape `gateway doctor` prints. */
export type BackupCheck = Readonly<{ name: string; ok: boolean; detail: string }>;

export const BACKUP_FORMAT = "agent-gateway-backup/1";
export const MANIFEST_SUFFIX = ".manifest.json";

/**
 * Written by the backup producer after its dump is complete (`scripts/backup-gateway-db.sh`),
 * next to `<name>.dump`. A dump without a manifest is incomplete and never picked.
 */
export const BackupManifestSchema = z
	.object({
		format: z.literal(BACKUP_FORMAT),
		database: z.string().min(1),
		/** `pg_control_system()`; null when the producing role may not read it. */
		system_identifier: z.string().regex(/^\d+$/u).nullable(),
		completed_at: z.iso.datetime({ offset: true }),
		schema_version: z
			.object({
				migrations: z.number().int().nonnegative(),
				latest_hash: z.string().nullable(),
			})
			.strict(),
		pg_dump_version: z.string().min(1),
		dump_file: z.string().regex(/^[^/\\]+\.dump$/u),
		size_bytes: z.number().int().positive(),
		sha256: z.string().regex(/^[0-9a-f]{64}$/u),
	})
	.strict();

export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export type FoundManifest = Readonly<{ file: string; manifest: BackupManifest }>;

export type ManifestScan = Readonly<{
	newest: FoundManifest | null;
	/** Manifests that did not parse; named in the check's detail. */
	invalid: Readonly<string[]>;
}>;

/** The manifest with the latest completion time; unreadable manifests are counted, not used. */
export function scanManifests(dir: string): ManifestScan {
	const invalid: string[] = [];
	let newest: FoundManifest | null = null;
	for (const name of readdirSync(dir)
		.filter((file) => file.endsWith(MANIFEST_SUFFIX))
		.sort()) {
		const file = join(dir, name);
		const parsed = safeJson(file);
		const result = BackupManifestSchema.safeParse(parsed);
		if (!result.success) {
			invalid.push(name);
			continue;
		}
		if (
			newest === null ||
			Date.parse(result.data.completed_at) > Date.parse(newest.manifest.completed_at)
		) {
			newest = { file, manifest: result.data };
		}
	}
	return { newest, invalid };
}

function safeJson(file: string): object | null {
	try {
		const value: object | null = JSON.parse(readFileSync(file, "utf8"));
		return value;
	} catch {
		return null;
	}
}

export async function sha256File(file: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file)) {
		hash.update(chunk);
	}
	return hash.digest("hex");
}

/** Allowed clock skew for a completion time in the future. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export function ageCheck(manifest: BackupManifest, maxAgeHours: number, now: Date): BackupCheck {
	const completed = Date.parse(manifest.completed_at);
	const ageMs = now.getTime() - completed;
	if (ageMs < -FUTURE_SKEW_MS) {
		return { name: "age", ok: false, detail: `completed in the future: ${manifest.completed_at}` };
	}
	const hours = Math.max(0, ageMs) / 3_600_000;
	return {
		name: "age",
		ok: hours <= maxAgeHours,
		detail: `completed ${manifest.completed_at}, ${hours.toFixed(1)} h ago (limit ${maxAgeHours} h)`,
	};
}

/** The dump's size and SHA-256 against its manifest. */
export async function dumpChecks(dir: string, manifest: BackupManifest): Promise<BackupCheck[]> {
	const dump = join(dir, manifest.dump_file);
	if (!existsSync(dump)) {
		return [{ name: "dump", ok: false, detail: `${manifest.dump_file} is missing` }];
	}
	const size = statSync(dump).size;
	if (size !== manifest.size_bytes) {
		return [
			{
				name: "dump",
				ok: false,
				detail: `${manifest.dump_file} has ${size} bytes, the manifest says ${manifest.size_bytes}`,
			},
		];
	}
	const actual = await sha256File(dump);
	return [
		{ name: "dump", ok: true, detail: `${manifest.dump_file}, ${size} bytes` },
		{
			name: "checksum",
			ok: actual === manifest.sha256,
			detail: actual === manifest.sha256 ? "sha256 matches" : "sha256 does not match the manifest",
		},
	];
}

/** The major version in `pg_restore (PostgreSQL) 17.6` or `17.6 (Debian ...)`. */
export function majorVersion(text: string): number | null {
	const match = /(\d+)(?:\.\d+)?/u.exec(text);
	return match?.[1] === undefined ? null : Number(match[1]);
}

// ---------------------------------------------------------------------------
// PostgreSQL client tools
// ---------------------------------------------------------------------------

export type ToolResult = Readonly<{ code: number; stdout: string; stderr: string }>;

/**
 * Runs `pg_restore`. The archive, when given, is fed on stdin, so the tool can run where the
 * file is not (inside a container, in tests).
 */
export type PgTools = Readonly<{
	pgRestore: (
		args: Readonly<string[]>,
		stdinFile: string | null,
		env?: Readonly<Record<string, string>>,
	) => Promise<ToolResult>;
}>;

const LIBPQ_TARGET_VARIABLES: Readonly<string[]> = [
	"PGHOST",
	"PGHOSTADDR",
	"PGPORT",
	"PGDATABASE",
	"PGUSER",
	"PGSERVICE",
	"PGSERVICEFILE",
	"PGOPTIONS",
	"PGPASSWORD",
];

function libpqNeutralEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined && !LIBPQ_TARGET_VARIABLES.includes(name)) {
			result[name] = value;
		}
	}
	return result;
}

/** `pg_restore` from `PG_RESTORE` (default: on the PATH). */
export function localPgTools(command = process.env.PG_RESTORE ?? "pg_restore"): PgTools {
	return {
		pgRestore: async (args, stdinFile, env = {}) => {
			if (Bun.which(command) === null) {
				return {
					code: 127,
					stdout: "",
					stderr: `${command} was not found; install the PostgreSQL client tools or set PG_RESTORE`,
				};
			}
			const child = Bun.spawn([command, ...args], {
				stdin: stdinFile === null ? "ignore" : Bun.file(stdinFile),
				// libpq reads these too; only the URL (and PGPASSWORD) may say where to restore.
				env: { ...libpqNeutralEnv(process.env), ...env },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { code, stdout, stderr };
		},
	};
}

function toolError(result: ToolResult): string {
	const lines = redactText(result.stderr.trim()).split("\n");
	return lines.slice(-3).join(" ").slice(0, 400) || `exit code ${result.code}`;
}

/** Tables every restored Gateway database must have, whatever release produced the backup. */
const KEY_TABLES: Readonly<string[]> = [
	"events",
	"agent_runs",
	"approval_requests",
	"tool_actions",
	"audit_log",
];

/**
 * Added by migration `0018_config_history` (`config_snapshots`/`config_revisions` tables,
 * `gateway_controls.active_config_revision`): a backup taken at an older schema (0.3.0 and
 * earlier) has none of the three, and checking for them would fail a healthy backup.
 */
const CONFIG_HISTORY_TABLES: Readonly<string[]> = ["config_snapshots", "config_revisions"];
/** The migration count (0000 through 0018 inclusive) at which `CONFIG_HISTORY_TABLES` exist. */
const CONFIG_HISTORY_MIGRATIONS = 19;

/** Whether the restored database's own migration history (as `schemaCheck` reads it) is at or past `0018_config_history`. */
function hasConfigHistorySchema(migrations: number): boolean {
	return migrations >= CONFIG_HISTORY_MIGRATIONS;
}

type SchemaVersion = BackupManifest["schema_version"];

async function schemaVersion(client: pg.ClientBase): Promise<SchemaVersion | null> {
	const exists = await client.query<{ exists: boolean }>(
		"select to_regclass('drizzle.__drizzle_migrations') is not null as exists",
	);
	if (exists.rows[0]?.exists !== true) {
		return null;
	}
	const result = await client.query<{ migrations: number; latest_hash: string | null }>(
		`select count(*)::int as migrations,
		        (select hash from drizzle.__drizzle_migrations order by created_at desc, id desc limit 1) as latest_hash
		   from drizzle.__drizzle_migrations`,
	);
	const row = result.rows[0];
	return row === undefined ? null : { migrations: row.migrations, latest_hash: row.latest_hash };
}

type DatabaseIdentity = Readonly<{ database: string; systemIdentifier: string | null }>;

async function identity(client: pg.ClientBase): Promise<DatabaseIdentity> {
	const database = await client.query<{ name: string }>("select current_database() as name");
	// `pg_control_system()` may be closed to the role; the identity is then the name alone.
	const system = await client
		.query<{ id: string }>("select system_identifier::text as id from pg_control_system()")
		.catch(() => null);
	return {
		database: database.rows[0]?.name ?? "",
		systemIdentifier: system?.rows[0]?.id ?? null,
	};
}

async function withClient<T>(url: string, work: (client: pg.ClientBase) => Promise<T>): Promise<T> {
	const pool = createPool(url, 1);
	try {
		const client = await pool.connect();
		try {
			return await work(client);
		} finally {
			client.release();
		}
	} finally {
		await pool.end();
	}
}

function describe(error: unknown): string {
	return redactText(error instanceof Error ? error.message : String(error));
}

/** Whether two connection strings name the same database on the same server, by the URL. */
export function sameDatabaseUrl(a: string, b: string): boolean {
	const key = (url: string) => {
		const parsed = new URL(url);
		const host =
			parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" ? "localhost" : parsed.hostname;
		return `${host}:${parsed.port || "5432"}/${decodeURIComponent(parsed.pathname.slice(1))}`;
	};
	return key(a) === key(b);
}

/**
 * A connection string without its password, and the password: from the user info or from a
 * `password` query parameter, which libpq accepts too.
 */
export function withoutPassword(url: string): Readonly<{ url: string; password: string | null }> {
	const parsed = new URL(url);
	const query = parsed.searchParams.get("password");
	const password =
		parsed.password !== "" ? decodeURIComponent(parsed.password) : query === "" ? null : query;
	parsed.password = "";
	// The other parameters stay exactly as written: re-serializing them would turn `%20` into
	// `+`, which libpq does not decode.
	const kept = parsed.search
		.slice(1)
		.split("&")
		.filter((pair) => pair !== "" && queryName(pair) !== "password");
	parsed.search = kept.length === 0 ? "" : `?${kept.join("&")}`;
	return { url: parsed.toString(), password };
}

function queryName(pair: string): string {
	const name = pair.split("=")[0] ?? "";
	try {
		return decodeURIComponent(name.replaceAll("+", " "));
	} catch {
		return name;
	}
}

/** Query parameters a scratch URL may carry: they mean the same to node-postgres and libpq. */
const SCRATCH_URL_PARAMETERS: ReadonlySet<string> = new Set(["sslmode", "password"]);

/**
 * Why a scratch URL is refused, or null. The probe connects with node-postgres and the restore
 * with libpq; a parameter only one of them reads (`dbname`, `host`, `service`, …) could point
 * the restore at a database the probe never saw.
 */
export function scratchUrlIssue(url: string): string | null {
	// Without a host, node-postgres connects over TCP to localhost and libpq to the socket.
	// Without a database or user, each client falls back to its own defaults (PGDATABASE for
	// node-postgres, the OS user for libpq).
	const parsed = new URL(url);
	if (parsed.hostname === "" || parsed.username === "" || parsed.pathname.length <= 1) {
		return "the scratch URL must name its host, user and database";
	}
	const unknown = [...new URL(url).searchParams.keys()].filter(
		(name) => !SCRATCH_URL_PARAMETERS.has(name),
	);
	return unknown.length === 0
		? null
		: `the scratch URL may carry only ${[...SCRATCH_URL_PARAMETERS].join(", ")} (has ${unknown.join(", ")})`;
}

/**
 * The backup's schema must not be newer than the live one, and at the same number of
 * migrations it must be the same history (the same latest migration).
 */
export function schemaCheck(
	backup: SchemaVersion,
	live: SchemaVersion | null,
	liveMigrations: number,
): BackupCheck {
	const detail = `backup at ${backup.migrations} migration(s), live database at ${liveMigrations}`;
	if (backup.migrations > liveMigrations) {
		return { name: "schema", ok: false, detail };
	}
	if (backup.migrations === liveMigrations && backup.latest_hash !== (live?.latest_hash ?? null)) {
		return {
			name: "schema",
			ok: false,
			detail: `${detail}, but their latest migrations differ: another migration history`,
		};
	}
	return { name: "schema", ok: true, detail };
}

async function liveChecks(liveUrl: string, manifest: BackupManifest): Promise<BackupCheck[]> {
	// Only a connection that cannot be made skips the checks; a query that fails on a reachable
	// database fails them.
	let connected = false;
	try {
		return await withClient(liveUrl, async (client) => {
			connected = true;
			const live = await identity(client);
			const liveSchema = await schemaVersion(client);
			const sameSystem =
				live.systemIdentifier === null || manifest.system_identifier === null
					? null
					: live.systemIdentifier === manifest.system_identifier;
			const identityOk = live.database === manifest.database && sameSystem !== false;
			const liveMigrations = liveSchema?.migrations ?? 0;
			return [
				{
					name: "identity",
					ok: identityOk,
					detail: identityOk
						? `database '${manifest.database}'${sameSystem === null ? " (server identity not readable)" : " on the same server"}`
						: `the backup is of '${manifest.database}'${sameSystem === false ? " on another server" : ""}, the live database is '${live.database}'`,
				},
				schemaCheck(manifest.schema_version, liveSchema, liveMigrations),
			];
		});
	} catch (error) {
		return [
			connected
				? {
						name: "identity",
						ok: false,
						detail: `the live database could not be checked: ${describe(error)}`,
					}
				: {
						name: "identity",
						ok: true,
						detail: `skipped: the live database is not reachable (${describe(error)})`,
					},
		];
	}
}

async function tocChecks(
	tools: PgTools,
	dump: string,
	manifest: BackupManifest,
): Promise<BackupCheck[]> {
	const version = await tools.pgRestore(["--version"], null);
	if (version.code !== 0) {
		return [{ name: "pg_restore", ok: false, detail: toolError(version) }];
	}
	const restoreMajor = majorVersion(version.stdout);
	const dumpMajor = majorVersion(manifest.pg_dump_version);
	const compatible = restoreMajor !== null && dumpMajor !== null && restoreMajor >= dumpMajor;
	const toolCheck: BackupCheck = {
		name: "pg_restore",
		ok: compatible,
		detail: `pg_restore ${restoreMajor ?? "?"}, dump made by pg_dump ${dumpMajor ?? "?"}`,
	};
	if (!compatible) {
		return [toolCheck];
	}
	const list = await tools.pgRestore(["--list"], dump);
	const entries = list.stdout.split("\n").filter((line) => /^\d+;/u.test(line)).length;
	return [
		toolCheck,
		{
			name: "toc",
			ok: list.code === 0 && entries > 0,
			detail:
				list.code === 0
					? `${entries} archive entries readable`
					: `the archive is not readable: ${toolError(list)}`,
		},
	];
}

/**
 * Proves the scratch database is not the live one before it is emptied: a probe table created
 * in the scratch database must not be visible from the live connection, asked of a primary (not
 * a standby that may lag). Aliased hosts, proxies and unreadable server identities cannot fool
 * it. Returns why not, or null when proven.
 */
export async function provesDistinct(
	scratch: pg.ClientBase,
	liveUrl: string,
): Promise<string | null> {
	const probe = `agent_gateway_restore_probe_${randomBytes(8).toString("hex")}`;
	await scratch.query(`create table public.${probe} ()`);
	try {
		// One statement, so one server answers both: a replica (or a read-splitting proxy's
		// replica) may not see the probe yet, and its "not found" proves nothing.
		const seen = await withClient(liveUrl, (live) =>
			live.query<{ found: boolean; replica: boolean }>(
				"select to_regclass($1) is not null as found, pg_is_in_recovery() as replica",
				[`public.${probe}`],
			),
		);
		const row = seen.rows[0];
		if (row?.replica !== false) {
			return "DATABASE_URL reaches a standby; the proof needs the primary";
		}
		return row.found === false
			? null
			: "the scratch database is the live one (a probe table showed up in both)";
	} catch (error) {
		return `the live database is needed to prove the scratch database is another one: ${describe(error)}`;
	} finally {
		await scratch.query(`drop table if exists public.${probe}`);
	}
}

/**
 * Empties the scratch database: drops every schema but the system ones, then recreates
 * `public`. Refuses a database that is the live one.
 */
async function resetScratch(client: pg.ClientBase): Promise<void> {
	const schemas = await client.query<{ name: string }>(
		`select nspname as name from pg_namespace
		  where nspname not like 'pg\\_%' and nspname <> 'information_schema'`,
	);
	for (const { name } of schemas.rows) {
		await client.query(`drop schema ${pg.escapeIdentifier(name)} cascade`);
	}
	await client.query("create schema public");
}

async function invariantChecks(
	client: pg.ClientBase,
	manifest: BackupManifest,
): Promise<BackupCheck[]> {
	const checks: BackupCheck[] = [];
	const restored = await schemaVersion(client);
	const schemaOk =
		restored !== null &&
		restored.migrations === manifest.schema_version.migrations &&
		restored.latest_hash === manifest.schema_version.latest_hash;
	checks.push({
		name: "restored:migrations",
		ok: schemaOk,
		detail:
			restored === null
				? "no migrations table"
				: `${restored.migrations} migration(s), manifest ${manifest.schema_version.migrations}${schemaOk ? "" : " (latest hash differs)"}`,
	});
	const controls = await client
		.query<{ n: number }>("select count(*)::int as n from gateway_controls where id = 1")
		.catch(() => null);
	checks.push({
		name: "restored:controls",
		ok: controls?.rows[0]?.n === 1,
		detail:
			controls === null
				? "gateway_controls is missing"
				: `${controls.rows[0]?.n ?? 0} controls row(s)`,
	});
	const hasConfigHistory = hasConfigHistorySchema(restored?.migrations ?? 0);
	const tables = hasConfigHistory ? [...KEY_TABLES, ...CONFIG_HISTORY_TABLES] : KEY_TABLES;
	const counts: string[] = [];
	const missing: string[] = [];
	for (const table of tables) {
		const result = await client
			.query<{ n: number }>(`select count(*)::int as n from ${pg.escapeIdentifier(table)}`)
			.catch(() => null);
		if (result === null) {
			missing.push(table);
		} else {
			counts.push(`${table} ${result.rows[0]?.n ?? 0}`);
		}
	}
	checks.push({
		name: "restored:tables",
		ok: missing.length === 0,
		detail:
			missing.length === 0 ? counts.join(", ") : `missing or unreadable: ${missing.join(", ")}`,
	});
	// A backup taken before migration 0018 has neither the tables nor the column these checks
	// read (`gateway_controls.active_config_revision`): nothing to verify, not a failure.
	if (hasConfigHistory) {
		checks.push(...(await configHistoryChecks(client)));
	}
	return checks;
}

/**
 * The restored configuration history is internally consistent: `gateway_controls`' active
 * revision (when one is set) names a `config_revisions` row, that row's snapshot exists in
 * `config_snapshots`, and every stored snapshot's content still hashes to its own `hash` — the
 * same canonical hash `applyConfig`/`ensureConfigHistory` compute when they write it (reused
 * here, not reimplemented), so a restore that silently dropped or corrupted a snapshot is caught
 * rather than only discovered the next time someone reads history. Callable only once
 * `hasConfigHistorySchema` confirms the restored database has the column and tables this reads.
 */
async function configHistoryChecks(client: pg.ClientBase): Promise<BackupCheck[]> {
	const checks: BackupCheck[] = [];
	const [controls] = (
		await client.query<{ active_config_revision: number | null }>(
			"select active_config_revision::int as active_config_revision from gateway_controls where id = 1",
		)
	).rows;
	const activeRevision = controls?.active_config_revision ?? null;
	if (activeRevision === null) {
		checks.push({
			name: "restored:active_revision",
			ok: true,
			detail: "no active configuration revision",
		});
	} else {
		const [revision] = (
			await client.query<{ snapshot_hash: string }>(
				"select snapshot_hash from config_revisions where id = $1",
				[activeRevision],
			)
		).rows;
		if (revision === undefined) {
			checks.push({
				name: "restored:active_revision",
				ok: false,
				detail: `active_config_revision ${activeRevision} has no config_revisions row`,
			});
		} else {
			const snapshot = await client.query<{ n: number }>(
				"select count(*)::int as n from config_snapshots where hash = $1",
				[revision.snapshot_hash],
			);
			const found = (snapshot.rows[0]?.n ?? 0) > 0;
			checks.push({
				name: "restored:active_revision",
				ok: found,
				detail: found
					? `revision ${activeRevision}, snapshot ${revision.snapshot_hash.slice(0, 12)}`
					: `revision ${activeRevision}'s snapshot '${revision.snapshot_hash}' is missing`,
			});
		}
	}

	const snapshots = await client.query<{ hash: string; bundle: ConfigSnapshotBundle }>(
		"select hash, bundle from config_snapshots",
	);
	const mismatched = snapshots.rows
		.filter((row) => canonicalHash(row.bundle) !== row.hash)
		.map((row) => row.hash);
	checks.push({
		name: "restored:snapshot_hashes",
		ok: mismatched.length === 0,
		detail:
			mismatched.length === 0
				? `${snapshots.rows.length} snapshot(s) verified`
				: `${mismatched.length} of ${snapshots.rows.length} snapshot(s) do not match their hash: ${mismatched.map((h) => h.slice(0, 12)).join(", ")}`,
	});
	return checks;
}

async function restoreChecks(
	tools: PgTools,
	dump: string,
	manifest: BackupManifest,
	scratchUrl: string | null,
	liveUrl: string | null,
): Promise<BackupCheck[]> {
	if (scratchUrl === null) {
		return [
			{ name: "restore", ok: false, detail: "BACKUP_RESTORE_DATABASE_URL (or _FILE) is required" },
		];
	}
	if (liveUrl !== null && sameDatabaseUrl(scratchUrl, liveUrl)) {
		return [
			{ name: "restore", ok: false, detail: "refused: the scratch database is the live one" },
		];
	}
	if (liveUrl === null) {
		return [
			{
				name: "restore",
				ok: false,
				detail:
					"refused: DATABASE_URL is required to prove the scratch database is not the live one",
			},
		];
	}
	const issue = scratchUrlIssue(scratchUrl);
	if (issue !== null) {
		return [{ name: "restore", ok: false, detail: `refused: ${issue}` }];
	}
	const live = liveUrl;
	try {
		return await withClient(scratchUrl, async (client) => {
			const scratch = await identity(client);
			const proof = await provesDistinct(client, live);
			if (proof !== null) {
				return [{ name: "restore", ok: false, detail: `refused: ${proof}` }];
			}
			await resetScratch(client);
			// The password goes by environment, never on the command line other users can read.
			const target = withoutPassword(scratchUrl);
			const result = await tools.pgRestore(
				["--no-owner", "--no-privileges", "--exit-on-error", "--dbname", target.url],
				dump,
				target.password === null ? {} : { PGPASSWORD: target.password },
			);
			if (result.code !== 0) {
				return [{ name: "restore", ok: false, detail: `restore failed: ${toolError(result)}` }];
			}
			return [
				{ name: "restore", ok: true, detail: `restored into '${scratch.database}'` },
				...(await invariantChecks(client, manifest)),
			];
		});
	} catch (error) {
		return [{ name: "restore", ok: false, detail: describe(error) }];
	}
}

export type BackupCheckOptions = Readonly<{
	dir: string;
	maxAgeHours: number;
	restoreTest: boolean;
	/** The live database, for identity and schema checks; null skips them. */
	liveUrl: string | null;
	/** An isolated database the restore test empties and restores into. */
	scratchUrl: string | null;
	tools: PgTools;
	now: Date;
}>;

export type BackupCheckReport = Readonly<{
	backup: string | null;
	checks: Readonly<BackupCheck[]>;
	ok: boolean;
}>;

/** Verifies the newest complete backup in a directory. */
export async function checkBackup(options: BackupCheckOptions): Promise<BackupCheckReport> {
	const checks: BackupCheck[] = [];
	const done = (backup: string | null): BackupCheckReport => ({
		backup,
		checks,
		ok: checks.every((check) => check.ok),
	});
	if (!existsSync(options.dir) || !statSync(options.dir).isDirectory()) {
		checks.push({ name: "directory", ok: false, detail: `${options.dir} is not a directory` });
		return done(null);
	}
	const scan = scanManifests(options.dir);
	const invalid = scan.invalid.length === 0 ? "" : `; ignored invalid: ${scan.invalid.join(", ")}`;
	if (scan.newest === null) {
		checks.push({
			name: "manifest",
			ok: false,
			detail: `no complete backup in ${options.dir}${invalid}`,
		});
		return done(null);
	}
	const { manifest } = scan.newest;
	checks.push({ name: "manifest", ok: true, detail: `${basename(scan.newest.file)}${invalid}` });
	checks.push(ageCheck(manifest, options.maxAgeHours, options.now));
	const files = await dumpChecks(options.dir, manifest);
	checks.push(...files);
	if (options.liveUrl !== null) {
		checks.push(...(await liveChecks(options.liveUrl, manifest)));
	}
	if (!files.every((check) => check.ok)) {
		return done(manifest.dump_file);
	}
	const dump = join(options.dir, manifest.dump_file);
	const toc = await tocChecks(options.tools, dump, manifest);
	checks.push(...toc);
	if (options.restoreTest && toc.every((check) => check.ok)) {
		checks.push(
			...(await restoreChecks(options.tools, dump, manifest, options.scratchUrl, options.liveUrl)),
		);
	}
	return done(manifest.dump_file);
}
