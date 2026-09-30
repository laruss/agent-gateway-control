import {
	type AgentTurnInput,
	type JsonValue,
	RunJobSchema,
	type RuntimeUsage,
	runQueue,
} from "@agent-gateway/contracts";
import {
	applyConfig,
	handleRunReport,
	handleWaitTimeout,
	ingestEvent,
	redriveRun,
} from "@agent-gateway/core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	eventually,
	exampleConfig,
	humanPost,
	startTestGateway,
	type TestGateway,
} from "./test-gateway.ts";

/**
 * Wraps a pool so every SQL statement its transactions issue is recorded, without disturbing the
 * identity `pg` and pg-boss rely on for connection bookkeeping: only the one `connect()` call
 * `withTransaction` makes is intercepted, the real client it returns keeps every other method
 * (`release` included) untouched, and only its own `query` is wrapped to record statement text.
 * Two casts adapt to `pg`'s overloaded `query` method, which a two-argument forwarding wrapper
 * cannot literally satisfy; nothing about the real pool or client changes.
 */
function querySpy(pool: pg.Pool): Readonly<{ pool: pg.Pool; queries: string[] }> {
	const queries: string[] = [];
	const spiedPool = new Proxy(pool, {
		get(target, prop, receiver) {
			if (prop !== "connect") {
				return Reflect.get(target, prop, receiver);
			}
			return async () => {
				const client = await target.connect();
				const original = client.query as (...args: unknown[]) => Promise<unknown>;
				client.query = ((...args: unknown[]) => {
					// `query` also accepts a single `{ text, values, ... }` config object (drizzle and
					// pg-boss both use that form); only a recognizable SQL text is recorded, everything
					// is still forwarded to the real client exactly as received.
					const [first] = args;
					const text =
						typeof first === "string"
							? first
							: typeof (first as { text?: unknown } | null)?.text === "string"
								? (first as { text: string }).text
								: null;
					if (text !== null) {
						queries.push(text);
					}
					return original.apply(client, args);
				}) as typeof client.query;
				return client;
			};
		},
	});
	return { pool: spiedPool, queries };
}

describe("scheduling, retry and redrive carry the system status (ADR-023)", () => {
	let gateway: TestGateway;
	/** The run id of director's [mock:permanent] redrive, carried from one test into the next. */
	let directorPermanentFailureRunId: string;

	beforeAll(async () => {
		gateway = await startTestGateway();
	});

	afterAll(async () => {
		await gateway?.stop();
	});

	const query = async <T extends Record<string, JsonValue | Date | null>>(
		text: string,
		values: Readonly<unknown[]> = [],
	): Promise<Readonly<T[]>> => (await gateway.pool.query<T>(text, [...values])).rows;

	const agentState = async (id: string) =>
		(await query<{ state: string }>("select state from agents where id = $1", [id]))[0]?.state;

	const idle = (agentId: string) =>
		eventually(async () => (await agentState(agentId)) === "idle", 30_000, `${agentId} idle`);

	const failed = (agentId: string) =>
		eventually(async () => (await agentState(agentId)) === "failed", 30_000, `${agentId} failed`);

	const runsFor = (eventExternalId: string) =>
		query<{ id: string; status: string; attempt: number }>(
			`select r.id, r.status, r.attempt from agent_runs r join events e on e.id = r.trigger_event_id
			  where e.external_id = $1 order by r.queued_at`,
			[eventExternalId],
		);

	const finishedRun = (eventExternalId: string, what: string) =>
		eventually(
			async () => {
				const runs = await runsFor(eventExternalId);
				const last = runs.at(-1);
				return last !== undefined && last.status !== "queued" && last.status !== "running"
					? last
					: null;
			},
			30_000,
			what,
		);

	const latestRun = async (agentId: string) => {
		const [row] = await query<{ id: string }>(
			"select id from agent_runs where agent_id = $1 order by queued_at desc, id desc limit 1",
			[agentId],
		);
		if (row === undefined) {
			throw new Error(`no run of '${agentId}' exists`);
		}
		return row;
	};

	const snapshotOf = async (runId: string) => {
		const [row] = await query<{ input: AgentTurnInput; size_bytes: number }>(
			"select input, size_bytes from context_snapshots where run_id = $1",
			[runId],
		);
		if (row === undefined) {
			throw new Error(`no context snapshot for run '${runId}'`);
		}
		return row;
	};

	/** Applies the example configuration with exactly one agent's `observe_system` set. */
	const setObserveSystem = async (agentId: string, on: boolean) => {
		const config = exampleConfig();
		await applyConfig(
			gateway.deps(),
			{
				...config,
				agents: config.agents.map((agent) =>
					agent.id === agentId
						? { ...agent, permissions: { ...agent.permissions, observe_system: on } }
						: agent,
				),
			},
			"test",
		);
	};

	it("schedules an ordinary agent's turn as version 1, with no systemStatus and no status query", async () => {
		const spy = querySpy(gateway.pool);
		const event = humanPost("@finance status please", ["finance"]);
		await ingestEvent({ ...gateway.deps(), pool: spy.pool }, event);
		// `runtime_availability` is read only inside the system status loader (ADR-023); nothing
		// else scheduling touches reads it, so its absence here proves no status was collected.
		expect(spy.queries.some((text) => text.includes("runtime_availability"))).toBe(false);

		await finishedRun(event.id, "finance turn finished");
		await idle("finance");
		const run = await latestRun("finance");
		const snapshot = await snapshotOf(run.id);
		expect(snapshot.input.schemaVersion).toBe(1);
		expect(snapshot.input.systemStatus).toBeUndefined();
	});

	it("schedules an observing agent's turn as version 2, carrying a fresh systemStatus", async () => {
		await setObserveSystem("director", true);
		const spy = querySpy(gateway.pool);
		const event = humanPost("@director status please", ["director"]);
		await ingestEvent({ ...gateway.deps(), pool: spy.pool }, event);
		// The status really was queried (proves the spy itself works, not only that it found nothing).
		expect(spy.queries.some((text) => text.includes("runtime_availability"))).toBe(true);

		await finishedRun(event.id, "director turn finished");
		await idle("director");
		const run = await latestRun("director");
		const snapshot = await snapshotOf(run.id);
		expect(snapshot.input.schemaVersion).toBe(2);
		expect(snapshot.input.systemStatus).toMatchObject({ killSwitch: false });
		expect(snapshot.input.systemStatus?.agents.some((a) => a.agentId === "director")).toBe(true);
	});

	it("stores exactly the job's input as the run's context snapshot", async () => {
		await gateway.stopWorker();
		try {
			const event = humanPost("@director status again", ["director"]);
			await ingestEvent(gateway.deps(), event);
			const [run] = await runsFor(event.id);
			if (run === undefined) {
				throw new Error("no run was scheduled");
			}
			const [job] = await gateway.controller().boss.findJobs(runQueue("mock"), {
				data: { runId: run.id },
			});
			const jobInput = RunJobSchema.parse(job?.data).input;
			const snapshot = await snapshotOf(run.id);
			expect(jobInput).toEqual(snapshot.input);
			expect(jobInput.schemaVersion).toBe(2);
		} finally {
			await gateway.startWorker();
			await idle("director");
		}
	});

	it("a retryable failure preserves the original status and its asOf, and saves the reported usage", async () => {
		await gateway.stopWorker();
		try {
			const event = humanPost("@director status once more", ["director"]);
			await ingestEvent(gateway.deps(), event);
			const [run] = await runsFor(event.id);
			if (run === undefined) {
				throw new Error("no run was scheduled");
			}
			const before = await snapshotOf(run.id);
			expect(before.input.schemaVersion).toBe(2);

			const usage: RuntimeUsage = {
				inputTokens: 321,
				outputTokens: 45,
				cachedInputTokens: 12,
				costUsd: 0.05,
				durationMs: 987,
				model: "mock-test-model",
			};
			const outcome = await handleRunReport(
				gateway.deps(),
				{
					kind: "failed",
					runId: run.id,
					attempt: 1,
					agentId: "director",
					runtimeVersion: "test-runtime",
					error: { code: "runtime_retryable", retryable: true, detail: "forced for the test" },
					usage,
					session: null,
				},
				"mock",
			);
			expect(outcome).toBe("retry_scheduled");

			const after = await snapshotOf(run.id);
			expect(after.input.systemStatus).toEqual(before.input.systemStatus);
			expect(after.input.deadline).not.toBe(before.input.deadline);
			expect(after.size_bytes).toBe(Buffer.byteLength(JSON.stringify(after.input), "utf8"));

			const [row] = await query<{ usage: RuntimeUsage | null }>(
				"select usage from agent_runs where id = $1",
				[run.id],
			);
			expect(row?.usage).toEqual(usage);

			// Settles the run so the agent is idle again before the next test.
			const idleResult = {
				schemaVersion: 1,
				runId: run.id,
				publicMessages: [],
				nextState: { kind: "idle" },
				publicSummary: {
					assigned: "x",
					facts: [],
					decisions: [],
					done: [],
					remaining: [],
					waitingFor: [],
					risks: [],
				},
				memoryProposals: [],
				artifacts: [],
				usage: null,
				session: null,
			};
			expect(
				await handleRunReport(
					gateway.deps(),
					{
						kind: "completed",
						runId: run.id,
						attempt: 2,
						agentId: "director",
						runtimeVersion: "test-runtime",
						result: idleResult,
					},
					"mock",
				),
			).toBe("completed");
		} finally {
			await gateway.startWorker();
			await idle("director");
		}
	});

	it("rejects scheduling over the input cap without partial scheduling", async () => {
		const [{ v: configVersion } = { v: "" }] = await query<{ v: string }>(
			"select active_config_version as v from gateway_controls where id = 1",
		);
		// No configured agent's display name can grow this large; a directly inserted row is the
		// realistic seam (`organization.directory` has no length cap of its own, by design: every
		// other field a turn carries is already budget-bounded). Comfortably over the 2 MiB cap.
		const hugeName = "x".repeat(3_000_000);
		await gateway.pool.query(
			`insert into agents (id, display_name, enabled, state, runtime_adapter, runtime_profile,
			   config_version, max_active_runs, config, role_prompt, state_changed_at)
			 values ('zzcapbust', $1, true, 'idle', 'mock', 'default', $2, 1,
			         '{"mattermost": {"allowed_channels": []}}'::jsonb, 'x', now())`,
			[hugeName, configVersion],
		);
		// A different agent than the wait-timeout test's target: that one is deliberately left
		// FAILED, which would skip scheduling for an unrelated reason before the cap is even checked.
		const event = humanPost("@mail-follower status", ["mail-follower"]);
		try {
			const result = await ingestEvent(gateway.deps(), event);
			expect(result.status).toBe("accepted");
			// No run for the event, and its inbox entry is left pending, not claimed.
			expect(await runsFor(event.id)).toEqual([]);
			const [inbox] = await query<{ status: string }>(
				`select i.status from agent_inbox i join events e on e.id = i.event_id
				  where e.external_id = $1`,
				[event.id],
			);
			expect(inbox?.status).toBe("pending");
			// `raiseAlert` posts to the outbox (delivered to the alerts channel); it never writes
			// `alert_states` itself, which a separate alert-rule evaluation maintains.
			const [alert] = await query<{ payload: { message: string } }>(
				"select payload from outbox where idempotency_key = $1",
				[`alert:context:mail-follower:${result.eventId}`],
			);
			expect(alert?.payload.message).toMatch(/over the limit/);
		} finally {
			await gateway.pool.query("delete from agents where id = 'zzcapbust'");
			await gateway.pool.query(
				`delete from agent_inbox where event_id in (select id from events where external_id = $1)`,
				[event.id],
			);
			await gateway.pool.query(
				`delete from event_routes where event_id in (select id from events where external_id = $1)`,
				[event.id],
			);
			await gateway.pool.query("delete from events where external_id = $1", [event.id]);
			await gateway.pool.query(
				"delete from outbox where idempotency_key like 'alert:context:mail-follower:%'",
			);
		}
	});

	it("redrive computes a fresh status rather than reusing the one originally stored", async () => {
		const event = humanPost("@director [mock:permanent]", ["director"]);
		await ingestEvent(gateway.deps(), event);
		await failed("director");
		const [originalRun] = await runsFor(event.id);
		if (originalRun === undefined) {
			throw new Error("no run was scheduled");
		}
		const original = await snapshotOf(originalRun.id);
		expect(original.input.schemaVersion).toBe(2);

		const redriven = await redriveRun(gateway.deps(), originalRun.id, "test");
		if (!("runId" in redriven)) {
			throw new Error(`redrive did not start a run: ${redriven.skipped}`);
		}
		const fresh = await snapshotOf(redriven.runId);
		expect(fresh.input.schemaVersion).toBe(2);
		expect(fresh.input.systemStatus?.asOf).not.toBe(original.input.systemStatus?.asOf);
		expect(Date.parse(fresh.input.systemStatus?.asOf ?? "")).toBeGreaterThan(
			Date.parse(original.input.systemStatus?.asOf ?? ""),
		);

		// The redriven run replays the same permanently-failing trigger and fails again, which the
		// next test's redrive (of this very run) relies on.
		await failed("director");
		directorPermanentFailureRunId = redriven.runId;
	});

	it("a permission turned off before redrive is respected: the redriven turn is version 1", async () => {
		await setObserveSystem("director", false);
		const redriven = await redriveRun(gateway.deps(), directorPermanentFailureRunId, "test");
		if (!("runId" in redriven)) {
			throw new Error(`redrive did not start a run: ${redriven.skipped}`);
		}
		const fresh = await snapshotOf(redriven.runId);
		expect(fresh.input.schemaVersion).toBe(1);
		expect(fresh.input.systemStatus).toBeUndefined();
	});

	it("a permission turned on before redrive is respected: the redriven turn is version 2", async () => {
		const event = humanPost("@finance [mock:permanent]", ["finance"]);
		await ingestEvent(gateway.deps(), event);
		await failed("finance");
		const [originalRun] = await runsFor(event.id);
		if (originalRun === undefined) {
			throw new Error("no run was scheduled");
		}
		const original = await snapshotOf(originalRun.id);
		expect(original.input.schemaVersion).toBe(1);

		await setObserveSystem("finance", true);
		const redriven = await redriveRun(gateway.deps(), originalRun.id, "test");
		if (!("runId" in redriven)) {
			throw new Error(`redrive did not start a run: ${redriven.skipped}`);
		}
		const fresh = await snapshotOf(redriven.runId);
		expect(fresh.input.schemaVersion).toBe(2);
		expect(fresh.input.systemStatus).toBeDefined();
		await setObserveSystem("finance", false);
	});

	// Last: forcing the timeout needs a clock far enough ahead of the wait's own (real-time)
	// deadline that its resumed run's `queued_at` lands in the future relative to true wall-clock
	// time for the rest of this run, which would otherwise poison every later "latest run of this
	// agent" query (redrive's own latest-failed-run check included). Using a fresh agent here,
	// never touched again afterward, keeps that side effect harmless.
	it("a wait timeout resumes the turn with a fresh status", async () => {
		await setObserveSystem("mail-follower", true);
		// The wait's target must never itself reply: a reply would resolve the wait as "matched"
		// (a race with the forced timeout below), not as the timeout this test means to drive. A
		// FAILED agent's inbox just sits pending, exactly like `durable-core.integration.test.ts`'s
		// own wait-timeout scenario relies on.
		await ingestEvent(gateway.deps(), humanPost("@research [mock:permanent]", ["research"]));
		await failed("research");

		const event = humanPost("@mail-follower ask research [mock:wait research]", ["mail-follower"]);
		await ingestEvent(gateway.deps(), event);
		await eventually(
			async () => (await agentState("mail-follower")) === "waiting",
			30_000,
			"waiting",
		);
		const [wait] = await query<{ id: string }>(
			"select id from wait_subscriptions where agent_id = 'mail-follower' and status = 'active'",
		);
		if (wait === undefined) {
			throw new Error("no active wait");
		}
		const [originalRun] = await runsFor(event.id);
		if (originalRun === undefined) {
			throw new Error("no run was scheduled");
		}
		const original = await snapshotOf(originalRun.id);
		expect(original.input.schemaVersion).toBe(2);

		const later = { ...gateway.deps(), clock: () => new Date(Date.now() + 2 * 3600_000) };
		expect(await handleWaitTimeout(later, { waitId: wait.id })).toBe("timed_out");
		await idle("mail-follower");

		const resumedRun = await latestRun("mail-follower");
		expect(resumedRun.id).not.toBe(originalRun.id);
		const resumed = await snapshotOf(resumedRun.id);
		expect(resumed.input.schemaVersion).toBe(2);
		expect(resumed.input.systemStatus?.asOf).not.toBe(original.input.systemStatus?.asOf);
		expect(Date.parse(resumed.input.systemStatus?.asOf ?? "")).toBeGreaterThan(
			Date.parse(original.input.systemStatus?.asOf ?? ""),
		);
	});
});
