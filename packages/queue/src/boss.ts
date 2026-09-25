import type { JobSink, QueueName, SendOptions } from "@agent-gateway/contracts";
import type pg from "pg";
import { PgBoss } from "pg-boss";

export type BossRole = "service" | "client";

/**
 * A service instance supervises queues (maintenance, expiration); a client instance, such as
 * the CLI, only sends and inspects jobs.
 */
export function createBoss(connectionString: string, role: BossRole = "service"): PgBoss {
	const client = role === "client";
	return new PgBoss({
		connectionString,
		schema: "pgboss",
		max: client ? 2 : 10,
		supervise: !client,
		schedule: !client,
		migrate: !client,
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
