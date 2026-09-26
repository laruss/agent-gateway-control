import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyConfig,
	ingestEvent,
	listAgents,
	recordWorkerStatus,
	runtimeHealth,
} from "@agent-gateway/core";
import { silentLogger } from "@agent-gateway/logging";
import { createMockRuntime } from "@agent-gateway/runtime-mock";
import type { RuntimeAdapter, RuntimeProbeResult } from "@agent-gateway/runtime-sdk";
import { type RunningWorker, startWorker } from "@agent-gateway/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	eventually,
	exampleConfig,
	humanPost,
	startTestGateway,
	type TestGateway,
} from "./test-gateway.ts";

let gateway: TestGateway;
let probe: RuntimeProbeResult = {
	ok: false,
	runtimeVersion: "grok/1.2.3",
	detail: "not logged in",
	risks: [],
};
const workers: RunningWorker[] = [];

let probeThrows = false;

/** A runtime reporting itself as grok, whose probe the test controls. */
const grokRuntime: RuntimeAdapter = {
	...createMockRuntime(),
	id: "grok",
	probe: async () => {
		if (probeThrows) {
			throw new Error("spawn grok ENOENT");
		}
		return probe;
	},
};

async function startGrokWorker(pinnedVersion: string | null = null): Promise<RunningWorker> {
	const worker = await startWorker({
		// Another adapter's worker would have its own role; the admin role keeps the test short.
		connectionString: gateway.postgres.connectionString,
		adapter: "grok",
		runtime: grokRuntime,
		concurrency: 1,
		workspaceRoot: join(tmpdir(), "agent-gateway-test-workspaces"),
		log: silentLogger,
		pinnedVersion,
		pollingIntervalSeconds: 0.5,
		heartbeatMs: 200,
		reprobeMs: 200,
	});
	workers.push(worker);
	return worker;
}

const health = async (adapter: string) =>
	(await runtimeHealth(gateway.deps())).find((h) => h.adapter === adapter);
const statusOf = async (agentId: string) =>
	(await listAgents(gateway.deps())).find((a) => a.id === agentId)?.runtime_status;
const alerts = async () =>
	(
		await gateway.pool.query<{ message: string }>(
			"select payload->>'message' as message from outbox where kind = 'mattermost.alert' order by created_at",
		)
	).rows.map((row) => row.message);

beforeAll(async () => {
	gateway = await startTestGateway();
	// @research runs on grok; every other agent stays on the mock runtime.
	const config = exampleConfig();
	await applyConfig(
		gateway.deps(),
		{
			...config,
			agents: config.agents.map((agent) =>
				agent.id === "research"
					? { ...agent, runtime: { ...agent.runtime, adapter: "grok" as const } }
					: agent,
			),
		},
		"test",
	);
});

afterAll(async () => {
	for (const worker of workers) {
		await worker.stop();
	}
	await gateway?.stop();
});

describe("runtime health", () => {
	it("marks only the agents of a runtime without a worker degraded", async () => {
		await eventually(async () => (await health("mock"))?.available, 10_000, "mock worker ready");
		expect(await statusOf("research")).toBe("degraded");
		expect(await statusOf("developer")).toBe("ok");
		expect(await health("grok")).toMatchObject({ available: false, readyWorkers: 0 });
	});

	it("reports a runtime whose probe fails, and its recovery, without touching the others", async () => {
		const worker = await startGrokWorker();
		expect(worker.ready()).toBe(false);
		await eventually(async () => (await health("grok"))?.detail === "not logged in", 10_000);
		expect(await statusOf("research")).toBe("degraded");
		expect(await statusOf("developer")).toBe("ok");
		expect(await health("mock")).toMatchObject({ available: true });
		const down = await eventually(
			async () => (await alerts()).find((m) => m.includes("'grok' has no ready worker")),
			10_000,
			"unavailable alert",
		);
		expect(down).toContain("@research");
		expect(down).toContain("not logged in");

		// Work for @research waits in its queue while its runtime is unavailable.
		const post = humanPost("@research please look into this", ["research"]);
		await ingestEvent(gateway.deps(), post);
		const runOf = async () =>
			(
				await gateway.pool.query<{ status: string }>(
					"select r.status from agent_runs r join events e on e.id = r.trigger_event_id where e.external_id = $1",
					[post.id],
				)
			).rows[0]?.status;
		await eventually(async () => (await runOf()) === "queued", 10_000, "research run queued");
		await Bun.sleep(1_500);
		expect(await runOf()).toBe("queued");

		probe = { ...probe, ok: true, detail: "grok/1.2.3, login" };
		await eventually(async () => (await statusOf("research")) === "ok", 10_000, "recovery");
		expect(worker.ready()).toBe(true);
		expect(await health("grok")).toMatchObject({
			available: true,
			runtimeVersions: ["grok/1.2.3"],
			readyWorkers: 1,
		});
		await eventually(
			async () => (await alerts()).some((m) => m.includes("'grok' is available again")),
			10_000,
			"recovery alert",
		);
		await eventually(async () => (await runOf()) === "succeeded", 20_000, "research run done");

		// An upgrade in place: the worker takes jobs anew under the new version.
		probe = { ...probe, runtimeVersion: "grok/1.2.5" };
		await eventually(
			async () => (await health("grok"))?.runtimeVersions.join() === "grok/1.2.5",
			10_000,
			"new version reported",
		);
		expect(worker.ready()).toBe(true);
		expect(worker.runtimeVersion()).toBe("grok/1.2.5");

		// A probe that throws counts as a failed one.
		probeThrows = true;
		await eventually(async () => !worker.ready(), 10_000, "worker stops taking jobs");
		await eventually(
			async () => (await health("grok"))?.detail?.includes("spawn grok ENOENT"),
			10_000,
			"throwing probe reported",
		);
		probeThrows = false;
		await worker.stop();
	});

	it("treats a runtime of another version than the pinned one as unavailable", async () => {
		probe = { ok: true, runtimeVersion: "grok/1.2.4", detail: "grok/1.2.4, login", risks: [] };
		const worker = await startGrokWorker("grok/1.2.3");
		expect(worker.ready()).toBe(false);
		await eventually(
			async () =>
				(await health("grok"))?.detail ===
				"runtime version grok/1.2.4 is not the pinned grok/1.2.3",
			10_000,
			"pin mismatch",
		);
		expect(await statusOf("research")).toBe("degraded");
		await worker.stop();
	});

	it("ignores stale heartbeats, earlier reports and a worker id reused by another adapter", async () => {
		const deps = gateway.deps();
		const workerId = randomUUID();
		const report = (sequence: number, status: "ready" | "stopped" = "ready") => ({
			kind: "worker_status" as const,
			workerId,
			sequence,
			status,
			runtimeVersion: "hermes/1.0.0",
			detail: "ok",
		});
		await recordWorkerStatus(deps, "hermes", report(0), new Date(Date.now() - 600_000));
		expect(await health("hermes")).toBeUndefined();
		await recordWorkerStatus(deps, "hermes", report(1), new Date());
		expect(await health("hermes")).toMatchObject({ available: true });
		// An earlier report applied later does not undo a later one, even at the same moment.
		const now = new Date();
		await recordWorkerStatus(deps, "hermes", report(3, "stopped"), now);
		await recordWorkerStatus(deps, "hermes", report(2), now);
		expect(await health("hermes")).toMatchObject({ available: false });
		await recordWorkerStatus(deps, "kiro", { ...report(4), runtimeVersion: "kiro/1" }, new Date());
		expect(await health("kiro")).toBeUndefined();
	});
});
