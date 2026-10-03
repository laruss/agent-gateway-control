import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.ts";

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;

/** One database transaction: Drizzle and raw SQL (pg-boss) share the same client. */
export type Transaction = Readonly<{
	db: Database;
	client: pg.PoolClient;
}>;

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

/** Optional, narrower limits for a short-lived caller that must not hang or hold a connection
 * open on a stuck query (a CLI command, say) — unlike {@link SERVICE_DATABASE_LIMITS}, which a
 * long-running service always applies, these are opt-in per {@link createPool} call. */
export type PoolTimeouts = Readonly<{
	/** Bounds `pool.connect()`/`pool.query()`'s own connection attempt; an unreachable or
	 * black-holed server fails within this instead of hanging indefinitely. */
	connectionTimeoutMs?: number;
	/** Bounds each statement server-side (`SET statement_timeout`). */
	statementTimeoutMs?: number;
	/** Bounds each query client-side: a server that stops answering mid-query fails within this,
	 * which a server-side timeout cannot guarantee. */
	queryTimeoutMs?: number;
}>;

export function createPool(connectionString: string, max = 10, timeouts?: PoolTimeouts): pg.Pool {
	return new pg.Pool({
		connectionString,
		max,
		...(timeouts?.connectionTimeoutMs === undefined
			? {}
			: { connectionTimeoutMillis: timeouts.connectionTimeoutMs }),
		...(timeouts?.statementTimeoutMs === undefined
			? {}
			: { statement_timeout: timeouts.statementTimeoutMs }),
		...(timeouts?.queryTimeoutMs === undefined ? {} : { query_timeout: timeouts.queryTimeoutMs }),
	});
}

/**
 * Limits a long-running service's connections put on its own statements: a statement, a lock
 * wait or an idle transaction that runs long is a defect, and cut off before it holds locks and
 * connections for good. Migrations and restores use {@link createPool}, without limits.
 */
export const SERVICE_DATABASE_LIMITS = {
	statementTimeoutMs: 60_000,
	lockTimeoutMs: 30_000,
	idleInTransactionTimeoutMs: 60_000,
	connectionTimeoutMs: 10_000,
} as const;

/** A pool for a long-running service, with {@link SERVICE_DATABASE_LIMITS}. */
export function createServicePool(connectionString: string, max = 10): pg.Pool {
	return new pg.Pool({
		connectionString,
		max,
		statement_timeout: SERVICE_DATABASE_LIMITS.statementTimeoutMs,
		lock_timeout: SERVICE_DATABASE_LIMITS.lockTimeoutMs,
		idle_in_transaction_session_timeout: SERVICE_DATABASE_LIMITS.idleInTransactionTimeoutMs,
		connectionTimeoutMillis: SERVICE_DATABASE_LIMITS.connectionTimeoutMs,
		// A silent network partition fails a statement shortly after the server would have
		// cancelled it, not when the OS gives up on the connection.
		query_timeout: SERVICE_DATABASE_LIMITS.statementTimeoutMs + 5_000,
		keepAlive: true,
	});
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
	let broken: Error | undefined;
	try {
		await client.query("BEGIN");
		const result = await work({ db: drizzle(client, { schema }), client });
		await client.query("COMMIT");
		return result;
	} catch (error) {
		try {
			await client.query("ROLLBACK");
		} catch (rollback) {
			// A client that cannot even roll back (a lost connection) is closed, not pooled.
			broken = rollback instanceof Error ? rollback : new Error(String(rollback));
		}
		throw error;
	} finally {
		client.release(broken);
	}
}

/**
 * Applies all pending migrations of `folder`. Only `migrateSchema` (`gateway db migrate`) and
 * tests call it, never a service at startup.
 */
export async function migrateDatabase(pool: pg.Pool, folder = MIGRATIONS_FOLDER): Promise<void> {
	await migrate(drizzle(pool), { migrationsFolder: folder });
}

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

const SCRAM_ITERATIONS = 4096;

/**
 * The SCRAM-SHA-256 verifier PostgreSQL stores for a password (RFC 5802, RFC 7677):
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
	const salted = pbkdf2Sync(password.normalize("NFKC"), salt, SCRAM_ITERATIONS, 32, "sha256");
	const clientKey = createHmac("sha256", salted).update("Client Key").digest();
	const storedKey = createHash("sha256").update(clientKey).digest();
	const serverKey = createHmac("sha256", salted).update("Server Key").digest();
	return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/**
 * Creates a login role with `password`, or sets the password of an existing one that nothing
 * is connected as. The role gets
 * no privileges here: `grantWorkerRole` or `grantToolRunnerRole` limits it afterwards. The
 * owning role, superusers and roles that bypass row-level security are refused.
 */
export async function createLoginRole(
	pool: pg.Pool,
	role: string,
	password: string,
): Promise<void> {
	if (!ROLE_NAME.test(role)) {
		throw new Error(`invalid role name '${role}'`);
	}
	const client = await pool.connect();
	let broken: Error | undefined;
	try {
		await client.query("BEGIN");
		const exists = await client.query("select 1 from pg_roles where rolname = $1", [role]);
		if (exists.rowCount === 0) {
			await client.query(`CREATE ROLE ${client.escapeIdentifier(role)} LOGIN`);
		} else {
			await refuseUnrestrictableRole(client, role);
			// A running service keeps the URL it read at start: its next connection would fail.
			const sessions = await client.query(
				"select 1 from pg_stat_activity where usename = $1 limit 1",
				[role],
			);
			if ((sessions.rowCount ?? 0) > 0) {
				throw new Error(
					`role '${role}' is connected; stop the service that uses it before changing its password`,
				);
			}
		}
		// The server gets a SCRAM verifier, never the password: a logged statement reveals nothing.
		await client.query(
			`ALTER ROLE ${client.escapeIdentifier(role)} LOGIN PASSWORD ${client.escapeLiteral(scramVerifier(password))}`,
		);
		await client.query("COMMIT");
	} catch (error) {
		try {
			await client.query("ROLLBACK");
		} catch (rollback) {
			broken = rollback instanceof Error ? rollback : new Error(String(rollback));
		}
		throw error;
	} finally {
		client.release(broken);
	}
}

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
	await grantQueueRole(pool, role, [queues], []);
}

/**
 * The functions a tool runner may call: the `begin` gate, the stop check (ADR-018), and reading
 * one immutable `custom_https` definition by (entry id, version) — the one piece of catalog state
 * a runner serving the `custom` namespace needs, through the same narrow, read-only door every
 * other domain fact is kept behind (ADR-027).
 */
const TOOL_RUNNER_FUNCTIONS = [
	"gateway_begin_tool_action(uuid, integer, text)",
	"gateway_tool_action_stop_requested(uuid)",
	"gateway_custom_tool_definition(text, integer)",
] as const;

/**
 * Limits an existing PostgreSQL role to the tool actions of the given namespaces: fetch and
 * settle their execute jobs, send their reports, dead-letter their failed jobs, and call
 * `gateway_begin_tool_action`, the one check that lets an approved action run, and
 * `gateway_tool_action_stop_requested`. It reads no domain table. Run it again after `db migrate`.
 */
export async function grantToolRunnerRole(
	pool: pg.Pool,
	role: string,
	queues: Readonly<WorkerQueues[]>,
): Promise<void> {
	if (queues.length === 0) {
		throw new Error("a tool runner role needs at least one namespace");
	}
	await grantQueueRole(pool, role, queues, TOOL_RUNNER_FUNCTIONS);
}

async function grantQueueRole(
	pool: pg.Pool,
	role: string,
	queueSets: Readonly<WorkerQueues[]>,
	functions: Readonly<string[]>,
): Promise<void> {
	if (!ROLE_NAME.test(role)) {
		throw new Error(`invalid role name '${role}'`);
	}
	const client = await pool.connect();
	let broken: Error | undefined;
	try {
		const quoted = client.escapeIdentifier(role);
		await client.query("BEGIN");
		await refuseUnrestrictableRole(client, role);
		const names = queueSets.flatMap((q) => [q.run, q.report, q.deadLetter]);
		const tables = await client.query<{ name: string; table_name: string; partition: boolean }>(
			"select name, table_name, partition from pgboss.queue where name = any($1)",
			[names],
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
		for (const queues of queueSets) {
			await client.query(
				`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tableOf(queues.run, ["SELECT", "INSERT", "UPDATE", "DELETE"])} TO ${quoted}`,
			);
			await client.query(
				`GRANT SELECT, INSERT ON ${tableOf(queues.report, ["SELECT", "INSERT"])} TO ${quoted}`,
			);
			await client.query(
				`GRANT SELECT, INSERT ON ${tableOf(queues.deadLetter, ["SELECT", "INSERT"])} TO ${quoted}`,
			);
		}
		// pg-boss settles a failed job by moving it through the parent job table (delete, then
		// insert of the retry or dead letter copy). Row-level security keeps that insert to the
		// role's own queues; the controller owns the table and is not subject to it.
		await client.query(`GRANT INSERT ON pgboss.job TO ${quoted}`);
		await client.query("ALTER TABLE pgboss.job ENABLE ROW LEVEL SECURITY");
		// Hashed: role names up to 63 characters must not collide after identifier truncation.
		const policy = client.escapeIdentifier(
			`worker_insert_${createHash("sha256").update(role).digest("hex").slice(0, 32)}`,
		);
		const insertable = queueSets
			.flatMap((q) => [q.run, q.deadLetter])
			.map((name) => client.escapeLiteral(name))
			.join(", ");
		await client.query(`DROP POLICY IF EXISTS ${policy} ON pgboss.job`);
		await client.query(
			`CREATE POLICY ${policy} ON pgboss.job FOR INSERT TO ${quoted} WITH CHECK (name = ANY (ARRAY[${insertable}]))`,
		);
		for (const fn of TOOL_RUNNER_FUNCTIONS) {
			const call = functions.includes(fn) ? "GRANT" : "REVOKE";
			await client.query(
				`${call} EXECUTE ON FUNCTION ${fn} ${call === "GRANT" ? "TO" : "FROM"} ${quoted}`,
			);
		}
		await verifyWorkerPrivileges(client, role, allowedTables);
		await client.query("COMMIT");
	} catch (error) {
		try {
			await client.query("ROLLBACK");
		} catch (rollback) {
			// A client that cannot even roll back (a lost connection) is closed, not pooled.
			broken = rollback instanceof Error ? rollback : new Error(String(rollback));
		}
		throw error;
	} finally {
		client.release(broken);
	}
}
