import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestPostgres, type TestPostgres } from "./postgres.ts";

/**
 * Phase 0 smoke test for ADR-003 / ADR-008: pg-boss, Drizzle and Testcontainers
 * work under the Bun runtime, and a job can be enqueued in the same database
 * transaction as a domain write.
 */
describe("Bun runtime compatibility", () => {
	const QUEUE = "smoke.transactional";
	let postgres: TestPostgres;
	let pool: pg.Pool;
	let boss: PgBoss;
	const bossErrors: Error[] = [];

	beforeAll(async () => {
		postgres = await startTestPostgres();
		pool = new pg.Pool({ connectionString: postgres.connectionString });
		await pool.query("CREATE TABLE smoke_events (id text PRIMARY KEY)");
		boss = new PgBoss(postgres.connectionString);
		boss.on("error", (error) => {
			bossErrors.push(error);
		});
		await boss.start();
		await boss.createQueue(QUEUE);
	});

	afterAll(async () => {
		try {
			await boss?.stop({ graceful: false });
			await pool?.end();
		} finally {
			await postgres?.stop();
		}
		expect(bossErrors).toEqual([]);
	});

	it("executes under Bun, not Node", () => {
		expect(process.versions.bun).toBeDefined();
	});

	it("runs Drizzle queries", async () => {
		const db = drizzle(pool);
		const result = await db.execute<{ one: number }>(sql`select 1 as one`);
		expect(result.rows).toEqual([{ one: 1 }]);
	});

	async function ingestInTransaction(eventId: string, outcome: "commit" | "rollback") {
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			const db = drizzle(client);
			await db.execute(sql`insert into smoke_events (id) values (${eventId})`);
			await boss.send(
				QUEUE,
				{ eventId },
				{ db: { executeSql: (text, values) => client.query(text, values) } },
			);
			await client.query(outcome === "commit" ? "COMMIT" : "ROLLBACK");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	it("enqueues a job atomically with the domain write", async () => {
		await ingestInTransaction("rolled-back", "rollback");
		await ingestInTransaction("committed", "commit");

		const events = await pool.query<{ id: string }>("select id from smoke_events order by id");
		expect(events.rows.map((row) => row.id)).toEqual(["committed"]);

		const jobs = await boss.fetch<{ eventId: string }>(QUEUE, { batchSize: 10 });
		expect(jobs.map((job) => job.data.eventId)).toEqual(["committed"]);
	});
});
