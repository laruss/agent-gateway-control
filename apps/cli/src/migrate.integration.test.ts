import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CompatibilityManifestSchema,
	checkCompatibility,
	createLoginRole,
	createPool,
	DeploymentLockError,
	holdDeploymentLock,
	type LocalSchema,
	loadLocalSchema,
	MIGRATIONS_FOLDER,
	type MigrationKind,
	migrateSchema,
	readSchemaState,
} from "@agent-gateway/db";
import { migrateQueues } from "@agent-gateway/queue";
import { startTestPostgres, type TestPostgres } from "@agent-gateway/testkit";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

const JournalSchema = z.looseObject({
	entries: z.array(z.looseObject({ idx: z.number(), when: z.number(), tag: z.string() })),
});

/**
 * A copy of the shipped migrations plus one more, as the next release would ship it: the
 * rollback rules are checked against real SQL, not a fixture schema.
 */
async function nextRelease(
	kind: MigrationKind,
	releases: LocalSchema["releases"],
): Promise<string> {
	const folder = await mkdtemp(join(tmpdir(), "agw-migrations-"));
	await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
	const tag = "0099_next_release";
	await writeFile(
		join(folder, `${tag}.sql`),
		kind === "expand"
			? "ALTER TABLE agents ADD COLUMN next_release_note text;"
			: "ALTER TABLE agents DROP COLUMN display_name;",
	);
	const journalPath = join(folder, "meta", "_journal.json");
	const journal = JournalSchema.parse(JSON.parse(await readFile(journalPath, "utf8")));
	const last = journal.entries.at(-1);
	if (last === undefined) {
		throw new Error("no migrations shipped");
	}
	journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag });
	await writeFile(journalPath, JSON.stringify(journal));
	const manifestPath = join(folder, "compatibility.json");
	const manifest = CompatibilityManifestSchema.parse(
		JSON.parse(await readFile(manifestPath, "utf8")),
	);
	await writeFile(
		manifestPath,
		JSON.stringify({ ...manifest, migrations: { ...manifest.migrations, [tag]: kind }, releases }),
	);
	return folder;
}

describe("gateway db migrate and the schema rules", () => {
	let postgres: TestPostgres;
	let pool: pg.Pool;
	let current: LocalSchema;
	const folders: string[] = [];

	beforeAll(async () => {
		current = await loadLocalSchema();
	});

	beforeEach(async () => {
		postgres = await startTestPostgres();
		pool = createPool(postgres.connectionString, 2);
	});

	afterEach(async () => {
		await pool.end();
		await postgres.stop();
	});

	afterAll(async () => {
		for (const folder of folders) {
			await rm(folder, { recursive: true, force: true });
		}
	});

	const migrate = (release: string, local: LocalSchema = current) =>
		migrateSchema({
			pool,
			connectionString: postgres.connectionString,
			release,
			local,
			migrateQueues: () => migrateQueues(postgres.connectionString),
		});

	it("certifies the migrating release for the history it applied", async () => {
		expect(await readSchemaState(pool)).toBeUndefined();
		expect(await migrate("0.1.0")).toEqual(["0.1.0"]);
		const state = await readSchemaState(pool);
		// The database computes the same fingerprint: the certificate is found through it.
		expect(state).toEqual({
			hashes: current.migrations.map((m) => m.hash),
			// The manifest names the queue schema the installed pg-boss really creates.
			pgbossSchema: current.pgbossSchema,
			certified: ["0.1.0"],
		});
		expect(checkCompatibility(current, state, "0.1.0").ok).toBe(true);
		expect(checkCompatibility(current, state, "0.2.0")).toMatchObject({ reason: "uncertified" });
		const queues = await pool.query<{ n: number }>("select count(*)::int as n from pgboss.queue");
		expect(queues.rows[0]?.n).toBeGreaterThan(0);
		// A second migrate changes nothing and certifies again.
		expect(await migrate("0.1.0")).toEqual(["0.1.0"]);
	});

	it("lets the previous release run after an expand-only upgrade, and refuses its migrate", async () => {
		await migrate("0.1.0");
		const folder = await nextRelease("expand", [
			{
				version: "0.1.0",
				head: current.migrations.at(-1)?.tag ?? "",
				pgboss_schema: current.pgbossSchema,
			},
		]);
		folders.push(folder);
		const next = await loadLocalSchema(folder);
		expect(await migrate("0.2.0", next)).toEqual(["0.1.0", "0.2.0"]);

		const state = await readSchemaState(pool);
		expect(checkCompatibility(next, state, "0.2.0").ok).toBe(true);
		// Rollback: the previous release's own build accepts the newer database.
		expect(checkCompatibility(current, state, "0.1.0")).toEqual({
			ok: true,
			detail: "certified for 1 newer migration(s)",
		});
		// A development build of the previous code does not.
		expect(checkCompatibility(current, state, "0.0.0").ok).toBe(false);
		// The previous release never migrates (or downgrades) the newer schema.
		await expect(migrate("0.1.0")).rejects.toThrow("migrate it with the newer release");
	});

	it("does not certify the previous release after a contract migration", async () => {
		await migrate("0.1.0");
		const folder = await nextRelease("contract", [
			{
				version: "0.1.0",
				head: current.migrations.at(-1)?.tag ?? "",
				pgboss_schema: current.pgbossSchema,
			},
		]);
		folders.push(folder);
		expect(await migrate("0.2.0", await loadLocalSchema(folder))).toEqual(["0.2.0"]);
		expect(checkCompatibility(current, await readSchemaState(pool), "0.1.0")).toMatchObject({
			ok: false,
			reason: "uncertified",
		});
	});

	it("does not certify the previous release when it ran on another pg-boss schema", async () => {
		await migrate("0.1.0");
		const folder = await nextRelease("expand", [
			{
				version: "0.1.0",
				head: current.migrations.at(-1)?.tag ?? "",
				pgboss_schema: current.pgbossSchema - 1,
			},
		]);
		folders.push(folder);
		expect(await migrate("0.2.0", await loadLocalSchema(folder))).toEqual(["0.2.0"]);
	});

	it("refuses to migrate a queue schema newer than its pg-boss, and runs nothing on it", async () => {
		await migrate("0.1.0");
		await pool.query("update pgboss.version set version = version + 1");
		expect(checkCompatibility(current, await readSchemaState(pool), "0.1.0")).toMatchObject({
			ok: false,
			reason: "uncertified",
		});
		await expect(migrate("0.1.0")).rejects.toThrow("the queue schema is newer");
		expect(checkCompatibility(current, await readSchemaState(pool), "0.1.0").ok).toBe(false);
	});

	it("refuses a database whose history differs from the shipped one", async () => {
		await migrate("0.1.0");
		await pool.query(
			"update drizzle.__drizzle_migrations set hash = 'tampered' where id = (select min(id) from drizzle.__drizzle_migrations)",
		);
		expect(checkCompatibility(current, await readSchemaState(pool), "0.1.0")).toMatchObject({
			reason: "diverged",
		});
		await expect(migrate("0.1.0")).rejects.toThrow("migrated by another build");
	});

	it("leaves a release uncertified when the queue migration fails", async () => {
		await expect(
			migrateSchema({
				pool,
				connectionString: postgres.connectionString,
				release: "0.1.0",
				local: current,
				migrateQueues: async () => {
					throw new Error("queue schema failed");
				},
			}),
		).rejects.toThrow("queue schema failed");
		// Neither the release nor a development build runs on the half-migrated database.
		for (const release of ["0.1.0", "0.0.0"]) {
			expect(checkCompatibility(current, await readSchemaState(pool), release)).toMatchObject({
				ok: false,
				reason: "pending",
			});
		}
	});

	it("refuses to migrate while a service holds the deployment lock", async () => {
		const lost: Error[] = [];
		const lock = await holdDeploymentLock(postgres.connectionString, (error) => lost.push(error));
		await expect(migrate("0.1.0")).rejects.toThrow(DeploymentLockError);
		await lock.release();
		await migrate("0.1.0");
		expect(lost).toEqual([]);
	});

	it("creates a login role from a SCRAM verifier, which logs in with its password", async () => {
		await createLoginRole(pool, "gateway_login_check", "a-password-1");
		const url = new URL(postgres.connectionString);
		url.username = "gateway_login_check";
		url.password = "a-password-1";
		const role = createPool(url.toString(), 1);
		try {
			const who = await role.query<{ user: string }>("select current_user as user");
			expect(who.rows[0]?.user).toBe("gateway_login_check");
		} finally {
			await role.end();
		}
		const stored = await pool.query<{ rolpassword: string }>(
			"select rolpassword from pg_authid where rolname = 'gateway_login_check'",
		);
		expect(stored.rows[0]?.rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/);
		// A role in use keeps its password: the service using it would lose the database.
		const connected = createPool(url.toString(), 1);
		try {
			await connected.query("select 1");
			await expect(createLoginRole(pool, "gateway_login_check", "another")).rejects.toThrow(
				"is connected",
			);
		} finally {
			await connected.end();
		}
		// The owner is refused: its privileges must not be touched.
		await expect(createLoginRole(pool, "gateway", "x")).rejects.toThrow("owns the gateway tables");
	});

	it("tells a service when its deployment lock is gone", async () => {
		const lost: Error[] = [];
		await holdDeploymentLock(postgres.connectionString, (error) => lost.push(error));
		await pool.query(
			"select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and mode = 'ShareLock'",
		);
		await expect.poll(() => lost.length).toBe(1);
		await migrate("0.1.0");
	});
});
