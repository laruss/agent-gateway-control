import { createHash } from "node:crypto";
import { join } from "node:path";
import { DEVELOPMENT_VERSION } from "@agent-gateway/logging";
import type pg from "pg";
import { z } from "zod";
import { createPool, MIGRATIONS_FOLDER, migrateDatabase } from "./client.ts";
import { withExclusiveDeploymentLock } from "./deployment-lock.ts";

/**
 * How a migration treats the release before it:
 * - `expand` keeps the previous release working (new tables, nullable columns, new functions);
 * - `contract` breaks it (drops, renames, stricter constraints or values it cannot read);
 * - `pre-release` came before the first release; no release runs on the history before it.
 */
export const MIGRATION_KINDS = ["pre-release", "expand", "contract"] as const;
export type MigrationKind = (typeof MIGRATION_KINDS)[number];

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const CompatibilityManifestSchema = z.strictObject({
	format: z.literal(1),
	/** Every migration by its journal tag. */
	migrations: z.record(z.string(), z.enum(MIGRATION_KINDS)),
	/** Published releases and the last migration each shipped. */
	releases: z.array(z.strictObject({ version: z.string().regex(SEMVER), head: z.string() })),
});
export type CompatibilityManifest = z.infer<typeof CompatibilityManifestSchema>;

export type LocalMigration = Readonly<{ tag: string; hash: string; kind: MigrationKind }>;

/** The migrations this build ships, in order, with their kinds and published releases. */
export type LocalSchema = Readonly<{
	folder: string;
	migrations: Readonly<LocalMigration[]>;
	releases: CompatibilityManifest["releases"];
}>;

const JournalSchema = z.object({
	entries: z.array(z.object({ idx: z.number(), tag: z.string() })),
});

/**
 * Reads the shipped migrations. A hash is the SHA-256 of the SQL file, as the migrator stores
 * it. Every migration must have a kind, and every release a known head, in release order.
 */
export async function loadLocalSchema(folder = MIGRATIONS_FOLDER): Promise<LocalSchema> {
	const journal = JournalSchema.parse(await Bun.file(join(folder, "meta", "_journal.json")).json());
	const manifest = CompatibilityManifestSchema.parse(
		await Bun.file(join(folder, "compatibility.json")).json(),
	);
	const migrations: LocalMigration[] = [];
	for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
		const kind = manifest.migrations[entry.tag];
		if (kind === undefined) {
			throw new Error(`migration ${entry.tag} has no kind in compatibility.json`);
		}
		const sql = await Bun.file(join(folder, `${entry.tag}.sql`)).text();
		migrations.push({ tag: entry.tag, hash: createHash("sha256").update(sql).digest("hex"), kind });
	}
	const extra = Object.keys(manifest.migrations).filter(
		(tag) => !migrations.some((m) => m.tag === tag),
	);
	if (extra.length > 0) {
		throw new Error(`compatibility.json names unknown migrations: ${extra.join(", ")}`);
	}
	let previous = -1;
	for (const release of manifest.releases) {
		const head = migrations.findIndex((m) => m.tag === release.head);
		if (head < previous || head === -1) {
			throw new Error(`release ${release.version} has an unknown or out-of-order head`);
		}
		previous = head;
	}
	return { folder, migrations, releases: manifest.releases };
}

/** Identifies a whole migration history; the same as `gateway_schema_state()` computes. */
export function historyFingerprint(hashes: Readonly<string[]>): string {
	return createHash("sha256").update(hashes.join("\n")).digest("hex");
}

/** A database's migrations and the releases certified for them. */
export type SchemaState = Readonly<{
	hashes: Readonly<string[]>;
	certified: Readonly<string[]>;
}>;

const SchemaStateSchema = z.object({
	hashes: z.array(z.string()),
	certified: z.array(z.string()),
});

/**
 * Reads the database's schema state through `gateway_schema_state()`, which the restricted
 * worker and tool runner roles may call. `undefined`: the database predates it (or is empty),
 * so it needs `gateway db migrate`.
 */
export async function readSchemaState(pool: pg.Pool): Promise<SchemaState | undefined> {
	const exists = await pool.query<{ exists: boolean }>(
		"select to_regprocedure('public.gateway_schema_state()') is not null as exists",
	);
	if (exists.rows[0]?.exists !== true) {
		return undefined;
	}
	const result = await pool.query<{ state: unknown }>(
		"select public.gateway_schema_state() as state",
	);
	return SchemaStateSchema.parse(result.rows[0]?.state);
}

export type Compatibility =
	| Readonly<{ ok: true; detail: string }>
	| Readonly<{
			ok: false;
			reason: "not-migrated" | "pending" | "diverged" | "uncertified";
			detail: string;
	  }>;

/**
 * Whether `release` may run against the database:
 * - the database must hold this build's migrations, unchanged and in order;
 * - a development build runs only on exactly its own history;
 * - a release runs only where `gateway db migrate` certified it for the database's whole
 *   history: its own migrate, or a later release's whose migrations it stays compatible with.
 */
export function checkCompatibility(
	local: LocalSchema,
	state: SchemaState | undefined,
	release: string,
): Compatibility {
	if (state === undefined || state.hashes.length === 0) {
		return { ok: false, reason: "not-migrated", detail: "the database is not migrated" };
	}
	const known = Math.min(local.migrations.length, state.hashes.length);
	for (let i = 0; i < known; i++) {
		if (state.hashes[i] !== local.migrations[i]?.hash) {
			return {
				ok: false,
				reason: "diverged",
				detail: `migration ${local.migrations[i]?.tag} differs from the database's`,
			};
		}
	}
	const pending = local.migrations.length - state.hashes.length;
	if (pending > 0) {
		return { ok: false, reason: "pending", detail: `${pending} pending migration(s)` };
	}
	const newer = -pending;
	if (release === DEVELOPMENT_VERSION) {
		return newer === 0
			? { ok: true, detail: "0 pending" }
			: {
					ok: false,
					reason: "uncertified",
					detail: `the database has ${newer} newer migration(s); a development build runs only on its own`,
				};
	}
	if (!state.certified.includes(release)) {
		return {
			ok: false,
			reason: "uncertified",
			detail:
				newer === 0
					? `release ${release} is not certified for this database; run 'gateway db migrate'`
					: `the database has ${newer} newer migration(s) not certified for release ${release}`,
		};
	}
	return {
		ok: true,
		detail: newer === 0 ? "0 pending" : `certified for ${newer} newer migration(s)`,
	};
}

/**
 * The releases a migrate by `release` certifies for the full local history: itself, and every
 * published release whose later migrations are all `expand`.
 */
export function releasesToCertify(local: LocalSchema, release: string): string[] {
	const certified = new Set<string>([release]);
	for (const published of local.releases) {
		const head = local.migrations.findIndex((m) => m.tag === published.head);
		if (local.migrations.slice(head + 1).every((m) => m.kind === "expand")) {
			certified.add(published.version);
		}
	}
	return [...certified].sort();
}

/** Records the certificates for the database's current history (the local one). */
export async function certifyReleases(
	client: pg.PoolClient | pg.Pool,
	local: LocalSchema,
	releases: Readonly<string[]>,
): Promise<void> {
	const fingerprint = historyFingerprint(local.migrations.map((m) => m.hash));
	await client.query(
		`insert into schema_certifications (release, fingerprint)
		 select unnest($1::text[]), $2 on conflict do nothing`,
		[releases, fingerprint],
	);
}

/** The applied migration hashes in order, read by the owning role. */
async function appliedHashes(pool: pg.Pool): Promise<string[]> {
	const exists = await pool.query<{ exists: boolean }>(
		"select to_regclass('drizzle.__drizzle_migrations') is not null as exists",
	);
	if (exists.rows[0]?.exists !== true) {
		return [];
	}
	const rows = await pool.query<{ hash: string }>(
		"select hash from drizzle.__drizzle_migrations order by id",
	);
	return rows.rows.map((row) => row.hash);
}

export type MigrateSchemaOptions = Readonly<{
	pool: pg.Pool;
	connectionString: string;
	/** The release running the migration (`DEVELOPMENT_VERSION` for a checkout). */
	release: string;
	/** Creates or upgrades the queue schema and the queues, after the domain migrations. */
	migrateQueues: () => Promise<void>;
	local?: LocalSchema;
}>;

/**
 * `gateway db migrate`: under the exclusive deployment lock, applies this build's pending
 * migrations, then the queue schema, then certifies the releases that may run on the result.
 * A database with migrations this build does not ship (a newer release's) or with different
 * ones is refused: an older build never rewrites a newer schema. Certificates come last, so an
 * interrupted migration leaves a release uncertified and its services refuse to start.
 */
export async function migrateSchema(options: MigrateSchemaOptions): Promise<string[]> {
	const local = options.local ?? (await loadLocalSchema());
	return withExclusiveDeploymentLock(options.connectionString, async () => {
		const before = await appliedHashes(options.pool);
		const check = checkCompatibility(local, { hashes: before, certified: [] }, DEVELOPMENT_VERSION);
		if (!check.ok && (check.reason === "diverged" || check.reason === "uncertified")) {
			throw new Error(
				check.reason === "diverged"
					? `${check.detail}; this database was migrated by another build`
					: `the database has migrations this release does not ship; migrate it with the newer release`,
			);
		}
		await migrateDatabase(options.pool, local.folder);
		const after = await appliedHashes(options.pool);
		if (historyFingerprint(after) !== historyFingerprint(local.migrations.map((m) => m.hash))) {
			throw new Error("the applied migrations do not match this release's after migrating");
		}
		await options.migrateQueues();
		const releases = releasesToCertify(local, options.release);
		await certifyReleases(options.pool, local, releases);
		return releases;
	});
}

/** Whether `release` may run against the database behind `pool` (see `checkCompatibility`). */
export async function schemaCompatibility(pool: pg.Pool, release: string): Promise<Compatibility> {
	return checkCompatibility(await loadLocalSchema(), await readSchemaState(pool), release);
}

/** Refuses to run a service against a database its release may not run against. */
export async function requireCompatibleSchema(
	database: pg.Pool | string,
	release: string,
): Promise<void> {
	const pool = typeof database === "string" ? createPool(database, 1) : database;
	try {
		const schema = await schemaCompatibility(pool, release);
		if (!schema.ok) {
			throw new Error(`release ${release} cannot run against this database: ${schema.detail}`);
		}
	} finally {
		if (typeof database === "string") {
			await pool.end();
		}
	}
}
