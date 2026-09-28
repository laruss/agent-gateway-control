import pg from "pg";

/**
 * The deployment lock keeps migrations and running services apart: every service holds it
 * shared for its lifetime, and `gateway db migrate` takes it exclusively. A migration therefore
 * never runs under live services, and a service never starts during one.
 */
const DEPLOYMENT_LOCK = "agent-gateway:deployment";
const HEARTBEAT_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

export type DeploymentLock = Readonly<{ release: () => Promise<void> }>;

export class DeploymentLockError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DeploymentLockError";
	}
}

/**
 * Takes the deployment lock shared, on a connection of its own that lives as long as the
 * service. `onLost` is called when that connection fails: the lock is gone with it, and the
 * service must stop.
 */
export async function holdDeploymentLock(
	connectionString: string,
	onLost: (error: Error) => void,
): Promise<DeploymentLock> {
	// A silently dropped connection is noticed within seconds, not after the OS's keepalive
	// default of hours: the heartbeat below fails and the service stops.
	const client = new pg.Client({
		connectionString,
		keepAlive: true,
		keepAliveInitialDelayMillis: 10_000,
		query_timeout: HEARTBEAT_TIMEOUT_MS,
	});
	let released = false;
	try {
		await client.connect();
		const result = await client.query<{ locked: boolean }>(
			"select pg_try_advisory_lock_shared(hashtextextended($1, 0)) as locked",
			[DEPLOYMENT_LOCK],
		);
		if (result.rows[0]?.locked !== true) {
			throw new DeploymentLockError("a database migration is running; start again after it");
		}
	} catch (error) {
		await client.end();
		throw error;
	}
	const lost = (error: Error) => {
		clearInterval(heartbeat);
		if (!released) {
			released = true;
			onLost(error);
		}
	};
	client.on("error", lost);
	client.on("end", () => lost(new Error("the deployment lock connection closed")));
	const heartbeat = setInterval(() => {
		client.query("select 1").catch((error: Error) => lost(error));
	}, HEARTBEAT_MS);
	heartbeat.unref();
	return {
		release: async () => {
			clearInterval(heartbeat);
			if (released) {
				return;
			}
			released = true;
			await client.end();
		},
	};
}

/**
 * Runs `work` holding the deployment lock exclusively; refuses at once while any service holds
 * it, instead of waiting for them.
 */
export async function withExclusiveDeploymentLock<T>(
	connectionString: string,
	work: () => Promise<T>,
): Promise<T> {
	const client = new pg.Client({ connectionString });
	await client.connect();
	try {
		const result = await client.query<{ locked: boolean }>(
			"select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
			[DEPLOYMENT_LOCK],
		);
		if (result.rows[0]?.locked !== true) {
			throw new DeploymentLockError(
				"Gateway services are connected to this database; stop them before migrating",
			);
		}
		return await work();
	} finally {
		await client.end();
	}
}
