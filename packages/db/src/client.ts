import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { z } from "zod";
import * as schema from "./schema.ts";

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;

/** One database transaction: Drizzle and raw SQL (pg-boss) share the same client. */
export type Transaction = Readonly<{
	db: Database;
	client: pg.PoolClient;
}>;

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

export function createPool(connectionString: string, max = 10): pg.Pool {
	return new pg.Pool({ connectionString, max });
}

export function createDatabase(pool: pg.Pool): Database {
	return drizzle(pool, { schema });
}

/**
 * Runs `work` in one transaction and commits it, or rolls back when `work` throws.
 * Everything that must be atomic with a domain write, such as enqueueing a job, uses
 * `transaction.client`.
 */
export async function withTransaction<T>(
	pool: pg.Pool,
	work: (transaction: Transaction) => Promise<T>,
): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const result = await work({ db: drizzle(client, { schema }), client });
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

/** Applies all pending migrations. Run by `gateway db migrate`, never implicitly at startup. */
export async function migrateDatabase(pool: pg.Pool): Promise<void> {
	await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
}

type AppliedMigration = { hash: string };

const JournalSchema = z.object({ entries: z.array(z.object({ tag: z.string() })) });

/** Number of migration files the database has not applied yet. */
export async function pendingMigrationCount(pool: pg.Pool): Promise<number> {
	const journal = JournalSchema.parse(
		await Bun.file(join(MIGRATIONS_FOLDER, "meta", "_journal.json")).json(),
	);
	const total = journal.entries.length;
	const exists = await pool.query<{ exists: boolean }>(
		"select to_regclass('drizzle.__drizzle_migrations') is not null as exists",
	);
	if (exists.rows[0]?.exists !== true) {
		return total;
	}
	const applied = await pool.query<AppliedMigration>(
		"select hash from drizzle.__drizzle_migrations",
	);
	return Math.max(0, total - applied.rows.length);
}

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * A role that owns (or belongs to the owner of) the gateway tables, is a superuser, bypasses
 * row-level security or may stream replication (all data) cannot be restricted, and revoking an owner's privileges would lock the
 * controller out. Such a role is refused.
 */
async function refuseUnrestrictableRole(client: pg.PoolClient, role: string): Promise<void> {
	const result = await client.query<{
		rolsuper: boolean;
		rolbypassrls: boolean;
		rolreplication: boolean;
		is_current: boolean;
		owns: boolean;
		member_of: boolean;
	}>(
		`select r.rolsuper, r.rolbypassrls, r.rolreplication, r.rolname = current_user as is_current,
		   exists (select 1 from pg_tables t
		            where t.schemaname in ('public', 'pgboss')
		              and pg_has_role(r.rolname, t.tableowner, 'MEMBER')) as owns,
		   exists (select 1 from pg_auth_members m where m.member = r.oid) as member_of
		   from pg_roles r where r.rolname = $1`,
		[role],
	);
	const row = result.rows[0];
	if (row === undefined) {
		throw new Error(`role '${role}' does not exist; create it first`);
	}
	if (row.is_current || row.owns || row.rolsuper || row.rolbypassrls || row.rolreplication) {
		throw new Error(
			`role '${role}' owns the gateway tables, is a superuser, bypasses row-level security or may replicate; ` +
				"create a separate role for workers",
		);
	}
	// Privileges inherited from any group role (e.g. pg_read_all_data or another worker role)
	// would survive the revokes below.
	if (row.member_of) {
		throw new Error(`role '${role}' is a member of other roles; a worker role must have none`);
	}
}

const TABLE_PRIVILEGES = [
	"SELECT",
	"INSERT",
	"UPDATE",
	"DELETE",
	"TRUNCATE",
	"REFERENCES",
	"TRIGGER",
	"MAINTAIN",
] as const;
type TablePrivilege = (typeof TABLE_PRIVILEGES)[number];
/** Privileges that can also be granted on single columns. */
const COLUMN_PRIVILEGES: Readonly<TablePrivilege[]> = ["SELECT", "INSERT", "UPDATE", "REFERENCES"];

/**
 * The role's effective privileges, including those granted to PUBLIC, must be exactly the
 * intended ones: per table and per privilege, and no CREATE on the gateway schemas.
 */
async function verifyWorkerPrivileges(
	client: pg.PoolClient,
	role: string,
	allowed: ReadonlyMap<string, Readonly<TablePrivilege[]>>,
): Promise<void> {
	// MAINTAIN exists from PostgreSQL 17; older servers reject the name.
	const version = await client.query<{ n: number }>(
		"select current_setting('server_version_num')::int as n",
	);
	const privileges = TABLE_PRIVILEGES.filter(
		(p) => p !== "MAINTAIN" || (version.rows[0]?.n ?? 0) >= 170_000,
	);
	// Column grants count too: `has_any_column_privilege` is true for a table-level grant or a
	// grant on any single column.
	const effective = await client.query<{ table: string; privilege: TablePrivilege }>(
		`select n.nspname || '.' || c.relname as table, p.privilege
		   from pg_class c
		   join pg_namespace n on n.oid = c.relnamespace
		   cross join unnest($2::text[]) as p(privilege)
		  where n.nspname in ('public', 'pgboss', 'drizzle')
		    and c.relkind in ('r', 'p', 'v', 'm', 'f')
		    and case when p.privilege = any($3::text[])
		             then has_any_column_privilege($1, c.oid, p.privilege)
		             else has_table_privilege($1, c.oid, p.privilege) end`,
		[role, privileges, COLUMN_PRIVILEGES],
	);
	const unexpected = effective.rows
		.filter((row) => !(allowed.get(row.table) ?? []).includes(row.privilege))
		.map((row) => `${row.privilege} on ${row.table}`);
	const schemas = await client.query<{ schema: string }>(
		`select s as schema from unnest(array['public', 'pgboss', 'drizzle']) as s
		  where exists (select 1 from pg_namespace where nspname = s)
		    and has_schema_privilege($1, s, 'CREATE')`,
		[role],
	);
	unexpected.push(...schemas.rows.map((row) => `CREATE on schema ${row.schema}`));
	if (unexpected.length > 0) {
		throw new Error(`role '${role}' would keep ${unexpected.join(", ")}; revoke it first`);
	}
}

/** The pg-boss queues a worker of one adapter uses; each has its own table. */
export type WorkerQueues = Readonly<{ run: string; report: string; deadLetter: string }>;

/**
 * Limits an existing PostgreSQL role to one runtime adapter's jobs: it may fetch and settle
 * that adapter's run jobs, send that adapter's reports and dead-letter its failed jobs, and
 * read nothing else. Run it again after `db migrate` created new queues. The operator creates the role and its password. Domain tables, other
 * adapters' jobs and the controller's timeout jobs stay out of reach, so a compromised worker
 * cannot write runs, outbox items or approvals, nor read another adapter's turns.
 */
export async function grantWorkerRole(
	pool: pg.Pool,
	role: string,
	queues: WorkerQueues,
): Promise<void> {
	if (!ROLE_NAME.test(role)) {
		throw new Error(`invalid role name '${role}'`);
	}
	const client = await pool.connect();
	try {
		const quoted = client.escapeIdentifier(role);
		await client.query("BEGIN");
		await refuseUnrestrictableRole(client, role);
		const tables = await client.query<{ name: string; table_name: string; partition: boolean }>(
			"select name, table_name, partition from pgboss.queue where name = any($1)",
			[[queues.run, queues.report, queues.deadLetter]],
		);
		const allowedTables = new Map<string, Readonly<TablePrivilege[]>>([
			["pgboss.queue", ["SELECT"]],
			["pgboss.version", ["SELECT"]],
			["pgboss.job", ["INSERT"]],
		]);
		const tableOf = (name: string, privileges: Readonly<TablePrivilege[]>) => {
			const row = tables.rows.find((r) => r.name === name);
			if (row === undefined || !row.partition) {
				throw new Error(
					`queue '${name}' is missing or not in its own table; run 'gateway db migrate'`,
				);
			}
			allowedTables.set(`pgboss.${row.table_name}`, privileges);
			return `pgboss.${client.escapeIdentifier(row.table_name)}`;
		};
		await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${quoted}`);
		await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA pgboss FROM ${quoted}`);
		await client.query(`GRANT USAGE ON SCHEMA pgboss TO ${quoted}`);
		await client.query(`GRANT SELECT ON pgboss.queue, pgboss.version TO ${quoted}`);
		await client.query(
			`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tableOf(queues.run, ["SELECT", "INSERT", "UPDATE", "DELETE"])} TO ${quoted}`,
		);
		await client.query(
			`GRANT SELECT, INSERT ON ${tableOf(queues.report, ["SELECT", "INSERT"])} TO ${quoted}`,
		);
		await client.query(
			`GRANT SELECT, INSERT ON ${tableOf(queues.deadLetter, ["SELECT", "INSERT"])} TO ${quoted}`,
		);
		// pg-boss settles a failed job by moving it through the parent job table (delete, then
		// insert of the retry or dead letter copy). Row-level security keeps that insert to the
		// adapter's own queues; the controller owns the table and is not subject to it.
		await client.query(`GRANT INSERT ON pgboss.job TO ${quoted}`);
		await client.query("ALTER TABLE pgboss.job ENABLE ROW LEVEL SECURITY");
		// Hashed: role names up to 63 characters must not collide after identifier truncation.
		const policy = client.escapeIdentifier(
			`worker_insert_${createHash("sha256").update(role).digest("hex").slice(0, 32)}`,
		);
		await client.query(`DROP POLICY IF EXISTS ${policy} ON pgboss.job`);
		await client.query(
			`CREATE POLICY ${policy} ON pgboss.job FOR INSERT TO ${quoted} WITH CHECK (name = ANY (ARRAY[${client.escapeLiteral(queues.run)}, ${client.escapeLiteral(queues.deadLetter)}]))`,
		);
		await verifyWorkerPrivileges(client, role, allowedTables);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}
