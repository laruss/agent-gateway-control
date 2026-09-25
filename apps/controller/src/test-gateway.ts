import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AgentConfigSchema,
	type GatewayEvent,
	OrganizationConfigSchema,
	reportQueue,
	runDeadLetterQueue,
	runQueue,
} from "@agent-gateway/contracts";
import { applyConfig, type ControlPlaneDeps, setDirectoryEntry } from "@agent-gateway/core";
import { createPool, grantWorkerRole, migrateDatabase } from "@agent-gateway/db";
import { silentLogger } from "@agent-gateway/logging";
import type { Deliverer } from "@agent-gateway/outbox";
import { dryRunDeliverers } from "@agent-gateway/outbox";
import { startTestPostgres, type TestPostgres } from "@agent-gateway/testkit";
import { type RunningWorker, startWorker } from "@agent-gateway/worker";
import type pg from "pg";
import { type RunningController, startController } from "./controller.ts";
import { loopbackPostDeliverer } from "./loopback-deliverer.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/** Mattermost ids the directory resolves configured names to. */
export const IDS = {
	channel: (name: string) => `${name.replace(/[^a-z0-9]/g, "")}${"0".repeat(26)}`.slice(0, 26),
	owner: "owner0000000000000000000aa",
	human: "human0000000000000000000aa",
} as const;

/** The example configuration with every agent on the mock runtime and short timeouts. */
function exampleConfig() {
	const organization = OrganizationConfigSchema.parse(
		Bun.YAML.parse(readFileSync(join(repoRoot, "config/examples/organization.yaml"), "utf8")),
	);
	const agentsDir = join(repoRoot, "config/examples/agents");
	const agents = readdirSync(agentsDir)
		.filter((file) => file.endsWith(".yaml"))
		.map((file) => {
			const agent = AgentConfigSchema.parse(
				Bun.YAML.parse(readFileSync(join(agentsDir, file), "utf8")),
			);
			return {
				...agent,
				runtime: { ...agent.runtime, adapter: "mock" as const, timeout_seconds: 20 },
			};
		});
	const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
	return {
		organization,
		agents,
		constitution: read(organization.organization.constitution_file),
		rolePrompts: Object.fromEntries(agents.map((a) => [a.id, read(a.prompts.role_file)])),
	};
}

const WORKER_ROLE = "gateway_worker";
/** Throwaway credential of a throwaway test database. */
const WORKER_PASSWORD = "worker-test";

export type TestGateway = Readonly<{
	postgres: TestPostgres;
	workerConnectionString: string;
	pool: pg.Pool;
	controller: () => RunningController;
	deps: () => ControlPlaneDeps;
	startController: () => Promise<void>;
	stopController: () => Promise<void>;
	startWorker: () => Promise<void>;
	stopWorker: () => Promise<void>;
	stop: () => Promise<void>;
}>;

/**
 * A full control plane on a throwaway database: migrations, the example organization on the
 * mock runtime, resolved directory entries, a controller with loopback delivery and one worker.
 */
export async function startTestGateway(): Promise<TestGateway> {
	const postgres = await startTestPostgres();
	const pool = createPool(postgres.connectionString, 4);
	await migrateDatabase(pool);

	const workerUrl = new URL(postgres.connectionString);
	workerUrl.username = WORKER_ROLE;
	workerUrl.password = WORKER_PASSWORD;
	const workerConnectionString = workerUrl.toString();
	let controller: RunningController | null = null;
	let worker: RunningWorker | null = null;
	const gateway: TestGateway = {
		postgres,
		workerConnectionString,
		pool,
		controller: () => {
			if (controller === null) {
				throw new Error("controller is not running");
			}
			return controller;
		},
		deps: () => gateway.controller().deps,
		startController: async () => {
			controller = await startController({
				connectionString: postgres.connectionString,
				log: silentLogger,
				deliverers: (deps) => ({
					...dryRunDeliverers(silentLogger),
					"mattermost.post": loopbackPostDeliverer(deps),
				}),
				random: () => 0,
				pollingIntervalSeconds: 0.5,
				reconcileIntervalMs: 1000,
			});
		},
		stopController: async () => {
			await controller?.stop();
			controller = null;
		},
		startWorker: async () => {
			worker = await startWorker({
				connectionString: workerConnectionString,
				adapter: "mock",
				concurrency: 4,
				log: silentLogger,
				pollingIntervalSeconds: 0.5,
			});
		},
		stopWorker: async () => {
			await worker?.stop();
			worker = null;
		},
		stop: async () => {
			try {
				await gateway.stopWorker();
				await gateway.stopController();
				await pool.end();
			} finally {
				await postgres.stop();
			}
		},
	};

	await gateway.startController();
	// The worker runs as a role limited to the pg-boss schema, as in a deployment.
	await pool.query(`create role ${WORKER_ROLE} login password '${WORKER_PASSWORD}'`);
	await grantWorkerRole(pool, WORKER_ROLE, {
		run: runQueue("mock"),
		report: reportQueue("mock"),
		deadLetter: runDeadLetterQueue("mock"),
	});
	const deps = gateway.deps();
	const config = exampleConfig();
	await applyConfig(deps, config, "test");
	for (const channel of config.organization.mattermost.channels) {
		await setDirectoryEntry(deps, "channel", channel, IDS.channel(channel), "test");
	}
	await setDirectoryEntry(deps, "user", "owner", IDS.owner, "test");
	await gateway.startWorker();
	return gateway;
}

let postCounter = 0;

/** A human post in `#hq` addressed to `targets`, as the Mattermost listener would normalize it. */
export function humanPost(message: string, targets: Readonly<string[]>): GatewayEvent {
	postCounter += 1;
	const postId = `humanp0st${String(postCounter).padStart(17, "0")}`;
	return {
		specversion: "1.0",
		id: `mattermost:post:${postId}`,
		source: "mattermost://test",
		type: "mattermost.agent.mentioned",
		time: new Date().toISOString(),
		datacontenttype: "application/json",
		correlationid: `thread:${postId}`,
		causationid: null,
		trustlevel: "human-trusted",
		hop: 0,
		data: {
			post_id: postId,
			root_id: null,
			channel_id: IDS.channel("hq"),
			user_id: IDS.human,
			sender_agent_id: null,
			target_agent_ids: [...targets],
			message,
		},
	};
}

/** Polls until `check` returns a value, or fails after `timeoutMs`. */
export async function eventually<T>(
	check: () => Promise<T | null | undefined | false>,
	timeoutMs = 30_000,
	what = "condition",
): Promise<T> {
	const until = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value !== null && value !== undefined && value !== false) {
			return value;
		}
		if (Date.now() > until) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await Bun.sleep(100);
	}
}

/** A deliverer that fails its first `failures` calls; `calls` records every idempotency key. */
export function flakyDeliverer(failures: number): Deliverer & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		deliver: async (item) => {
			calls.push(item.idempotencyKey);
			if (calls.length <= failures) {
				throw new Error(`transient failure ${calls.length}`);
			}
			return { delivered: item.idempotencyKey };
		},
	};
}
