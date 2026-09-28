import type { JobSink, QueueName, SendOptions } from "@agent-gateway/contracts";
import type pg from "pg";
import { PgBoss } from "pg-boss";

export type BossRole = "migrator" | "supervisor" | "client";

/**
 * - `migrator` (`gateway db migrate` only) creates or upgrades the queue schema;
 * - `supervisor` (the controller) runs queue maintenance and expiration on the schema as it is;
 * - `client` (workers, the tool runner, the CLI) only sends, fetches and inspects jobs.
 *
 * Only the migrator changes the schema: a service started against a queue schema it does not
 * match fails instead of migrating it under other running services.
 */
export function createBoss(connectionString: string, role: BossRole): PgBoss {
	const supervisor = role === "supervisor";
	return new PgBoss({
		connectionString,
		schema: "pgboss",
		max: role === "client" ? 2 : 10,
		supervise: supervisor,
		schedule: supervisor,
		migrate: role === "migrator",
	});
}

function toBossOptions(options: SendOptions | undefined) {
	return {
		...(options?.startAfter === undefined ? {} : { startAfter: options.startAfter }),
		...(options?.expireInSeconds === undefined ? {} : { expireInSeconds: options.expireInSeconds }),
		...(options?.singletonKey === undefined ? {} : { singletonKey: options.singletonKey }),
	};
}

async function sendOrThrow(send: () => Promise<string | null>, queue: QueueName): Promise<string> {
	const id = await send();
	if (id === null) {
		throw new Error(`pg-boss did not create a job in '${queue}'`);
	}
	return id;
}

/** Sends through the given transaction client. */
export function transactionalJobSink(boss: PgBoss, client: pg.PoolClient): JobSink {
	return {
		send: (queue, data, options) =>
			sendOrThrow(
				() =>
					boss.send(queue, data, {
						...toBossOptions(options),
						db: { executeSql: (text, values) => client.query(text, values) },
					}),
				queue,
			),
	};
}

/** Sends outside of any domain transaction (worker reports). */
export function directJobSink(boss: PgBoss): JobSink {
	return {
		send: (queue, data, options) =>
			sendOrThrow(() => boss.send(queue, data, toBossOptions(options)), queue),
	};
}
