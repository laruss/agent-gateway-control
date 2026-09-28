import { type JsonValue, MattermostPostDataSchema } from "@agent-gateway/contracts";
import {
	applyRetention,
	type ControlPlaneDeps,
	enqueueOutbox,
	ingestEvent,
	pauseAgent,
	redriveOutbox,
	redriveRun,
	resumeAgent,
	runRetentionIfDue,
	showEvent,
	sweepAlertConditions,
	type UnitOfWork,
} from "@agent-gateway/core";
import { createPool, withTransaction } from "@agent-gateway/db";
import { parseTraceparent, silentLogger } from "@agent-gateway/logging";
import { MetricsRegistry } from "@agent-gateway/service";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerControllerMetrics } from "./metrics.ts";
import { eventually, humanPost, startTestGateway, type TestGateway } from "./test-gateway.ts";

type Row = Record<string, JsonValue>;

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const DAY_MS = 24 * 60 * 60 * 1000;

describe("operations: traces, alerts, retention and metrics", () => {
	let gateway: TestGateway;

	beforeAll(async () => {
		gateway = await startTestGateway();
	});

	afterAll(async () => {
		await gateway?.stop();
	});

	const query = async <T extends Row>(text: string, values: Readonly<string[]> = []) =>
		(await gateway.pool.query<T>(text, [...values])).rows;

	const traceOf = (value: JsonValue | undefined) =>
		parseTraceparent(typeof value === "string" ? value : null)?.traceId ?? null;

	/** Control plane deps on the test pool with another clock; jobs go nowhere. */
	const at = (now: Date): ControlPlaneDeps => ({
		pool: gateway.pool,
		clock: () => now,
		random: () => 0,
		log: silentLogger,
		jobs: () => ({ send: async () => "job" }),
	});

	const settledRuns = (externalId: string, count: number) =>
		eventually(
			async () => {
				const runs = await query<{ id: string; status: string }>(
					`select r.id, r.status from agent_runs r join events e on e.id = r.trigger_event_id
					  where e.correlation_id = (select correlation_id from events where external_id = $1)`,
					[externalId],
				);
				return runs.length >= count &&
					runs.every((run) => run.status !== "queued" && run.status !== "running")
					? runs
					: null;
			},
			30_000,
			`${count} settled runs`,
		);

	it("carries one trace from a post through runs, jobs, deliveries and the agent's post", async () => {
		const event = {
			...humanPost("@director hand this to research [mock:mention research]", ["director"]),
			traceparent: `00-${TRACE}-00f067aa0ba902b7-01`,
		};
		await ingestEvent(gateway.deps(), event);
		const runs = await settledRuns(event.id, 2);
		expect(runs).toHaveLength(2);

		const events = await query<{ type: string; traceparent: string }>(
			"select type, traceparent from events where correlation_id = $1 order by seq",
			[event.correlationid],
		);
		expect(events.length).toBeGreaterThanOrEqual(2);
		expect(events.map((row) => traceOf(row.traceparent))).toEqual(events.map(() => TRACE));

		const runRows = await query<{ traceparent: string; job_id: string }>(
			"select traceparent, job_id from agent_runs where correlation_id = $1",
			[event.correlationid],
		);
		expect(runRows.map((row) => traceOf(row.traceparent))).toEqual([TRACE, TRACE]);
		// Every span is its own: the event's, each run's, each attempt's.
		const spans = new Set([
			...events.map((row) => row.traceparent),
			...runRows.map((row) => row.traceparent),
		]);
		expect(spans.size).toBe(events.length + runRows.length);

		const jobs = await query<{ traceparent: string | null }>(
			"select data->>'traceparent' as traceparent from pgboss.job where id::text = any($1::text[])",
			[`{${runRows.map((row) => row.job_id).join(",")}}`],
		);
		expect(jobs.map((row) => traceOf(row.traceparent))).toEqual([TRACE, TRACE]);

		const deliveries = await query<{ traceparent: string }>(
			`select o.traceparent from outbox o join agent_runs r on r.id = o.run_id
			  where r.correlation_id = $1`,
			[event.correlationid],
		);
		expect(deliveries.length).toBeGreaterThan(0);
		expect(deliveries.map((row) => traceOf(row.traceparent))).toEqual(deliveries.map(() => TRACE));
	});

	it("starts a new trace for an event without a valid one", async () => {
		const event = {
			...humanPost("@director hello", ["director"]),
			traceparent: `00-${"0".repeat(32)}-00f067aa0ba902b7-01`,
		};
		await ingestEvent(gateway.deps(), event);
		// A causation that only looks like a run id does not break the ingest.
		const odd = {
			...humanPost("@director hi", ["director"]),
			causationid: `run:${"a".repeat(36)}`,
		};
		expect((await ingestEvent(gateway.deps(), odd)).status).toBe("accepted");
		const [row] = await query<{ traceparent: string }>(
			"select traceparent from events where external_id = $1",
			[event.id],
		);
		expect(parseTraceparent(row?.traceparent ?? null)).not.toBeNull();
		expect(traceOf(row?.traceparent)).not.toBe("0".repeat(32));
		await settledRuns(event.id, 1);
	});

	describe("with the controller stopped", () => {
		beforeAll(async () => {
			// Its own sweeps would race the clock this suite sets.
			await gateway.stopController();
		});

		afterAll(async () => {
			await gateway.startController();
		});

		const alertKeys = async () =>
			(
				await query<{ key: string }>(
					"select idempotency_key as key from outbox where kind = 'mattermost.alert' and idempotency_key like 'condition:%' order by created_at, idempotency_key",
				)
			).map((row) => row.key);

		it("fires an alert when a condition starts, reminds while it lasts and resolves it", async () => {
			const t0 = new Date("2030-01-01T00:00:00Z");
			const deadId = await withTransaction(gateway.pool, (tx) => {
				const uow: UnitOfWork = { deps: at(t0), tx, jobs: { send: async () => "job" }, now: t0 };
				return enqueueOutbox(uow, {
					kind: "mattermost.alert",
					destination: "channel/x",
					payload: { channelName: null, channelId: null, message: "x", detail: {} },
					idempotencyKey: "test:dead-item",
				});
			});
			await gateway.pool.query("update outbox set status = 'dead' where id = $1", [deadId ?? ""]);

			// Other conditions hold at these dates too (retention has not run by then): only the dead
			// item is followed.
			const dead = async (now: Date) =>
				(await sweepAlertConditions(at(now), { mattermost: null }))["outbox:dead"];
			expect(await dead(t0)).toBe("fired");
			expect(await dead(new Date(t0.getTime() + 60_000))).toBeUndefined();
			const later = new Date(t0.getTime() + 6 * 60 * 60 * 1000);
			expect(await dead(later)).toBe("reminded");

			await gateway.pool.query("update outbox set status = 'sent' where id = $1", [deadId ?? ""]);
			expect(await dead(later)).toBe("resolved");
			await gateway.pool.query("update outbox set status = 'dead' where id = $1", [deadId ?? ""]);
			expect(await dead(later)).toBe("fired");
			const keys = (await alertKeys()).filter((key) => key.startsWith("condition:outbox:dead:"));
			expect(keys).toEqual([
				"condition:outbox:dead:1:fired",
				`condition:outbox:dead:1:reminder:${later.getTime()}`,
				"condition:outbox:dead:1:resolved",
				"condition:outbox:dead:2:fired",
			]);
			await gateway.pool.query("update outbox set status = 'sent' where id = $1", [deadId ?? ""]);
			await sweepAlertConditions(at(later), { mattermost: null });
		});

		it("alerts on a Mattermost outage after two minutes, and ends it once stable", async () => {
			const now = new Date("2030-01-02T00:00:00Z");
			const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
			const outage = async (disconnectedSince: Date | null, connectedSince: Date | null) =>
				(
					await sweepAlertConditions(at(now), {
						mattermost: { disconnectedSince, connectedSince },
					})
				)["mattermost:disconnected"];
			// A short blip, and a start-up that connects at once, alert nobody.
			expect(await outage(ago(1), null)).toBeUndefined();
			expect(await outage(null, ago(0))).toBeUndefined();
			expect(await outage(ago(3), null)).toBe("fired");
			// A restarted controller starts disconnected "now": the outage stays firing.
			expect(await outage(now, null)).toBeUndefined();
			// Reconnected, but not for long: still the same outage.
			expect(await outage(null, ago(1))).toBeUndefined();
			expect(await outage(null, ago(3))).toBe("resolved");
		});

		it("alerts before a budget holds and on a failed backup check", async () => {
			const now = new Date();
			const day = now.toISOString().slice(0, 10);
			const [run] = await query<{ id: string; agent_id: string }>(
				"select id, agent_id from agent_runs order by queued_at limit 1",
			);
			await gateway.pool.query(
				`update config_versions set organization = jsonb_set(organization, '{organization,budgets}',
				   '{"global_daily": {"tokens": 1000}, "unmetered": "allow"}'::jsonb)
				  where version = (select active_config_version from gateway_controls where id = 1)`,
			);
			await gateway.pool.query(
				`insert into run_usage (run_id, attempt, agent_id, day, cost_usd, tokens, recorded_at)
				 values ($1, 99, $2, $3, null, 850, now())`,
				[run?.id ?? "", run?.agent_id ?? "", day],
			);
			await gateway.pool.query(
				`insert into maintenance_status (task, last_run_at, last_success_at, last_error_redacted, detail)
				 values ('backup', now(), now() - interval '2 days', 'checksum mismatch', '{"max_age_hours": 26}')`,
			);
			// A task that never succeeded is stale only once its first run is old: a first
			// retention run may still be in progress.
			await gateway.pool.query(
				`insert into maintenance_status (task, last_run_at) values ('probe', now())`,
			);
			const transitions = await sweepAlertConditions(at(now), { mattermost: null });
			expect(transitions["maintenance:probe"]).toBeUndefined();
			expect(transitions).toMatchObject({
				"budget:global": "fired",
				"maintenance:backup": "fired",
			});
			const [message] = await query<{ message: string }>(
				"select message from alert_states where key = 'budget:global'",
			);
			expect(message?.message).toContain("85% used");
			await gateway.pool.query("delete from run_usage where attempt = 99");
			await gateway.pool.query("delete from maintenance_status where task = 'backup'");
			expect(await sweepAlertConditions(at(now), { mattermost: null })).toMatchObject({
				"budget:global": "resolved",
				"maintenance:backup": "resolved",
			});
			// Last: four hours later may be another UTC day, which would reset the budget.
			expect(
				(
					await sweepAlertConditions(at(new Date(now.getTime() + 4 * 3_600_000)), {
						mattermost: null,
					})
				)["maintenance:probe"],
			).toBe("fired");
			await gateway.pool.query("delete from maintenance_status where task = 'probe'");
		});

		it("removes old content but keeps dedupe, pending work and a failed agent's work", async () => {
			const deps = at(new Date());
			// Pending work: an event for a paused agent waits in its inbox.
			await pauseAgent(deps, "director", "test");
			const base = humanPost("@director later", ["director"]);
			const post = MattermostPostDataSchema.parse(base.data);
			const pending = { ...base, subject: `channel/${post.channel_id}/post/${post.post_id}` };
			await ingestEvent(deps, pending);
			// An edit of the pending post: kept with it, so the turn shows the post as it is now.
			const edit = {
				...pending,
				id: `${pending.id}:edited`,
				type: "mattermost.post.edited" as const,
				data: { ...post, target_agent_ids: [], message: "@director later, edited" },
			};
			await ingestEvent(deps, edit);

			// A finished run whose wait timed out while its agent is paused: the timeout waits in
			// the inbox and finds its thread through the run's snapshot.
			const [waiter] = await query<{ id: string; agent_id: string; correlation_id: string }>(
				`select r.id, r.agent_id, r.correlation_id from agent_runs r
				   join context_snapshots s on s.run_id = r.id
				  where r.status = 'succeeded' order by r.finished_at limit 1`,
			);
			const [waitRow] = await query<{ id: string }>(
				`insert into wait_subscriptions (agent_id, created_by_run_id, status, event_type,
				   correlation_id, condition, timeout_at)
				 values ($1, $2, 'timed_out', 'mattermost.thread.reply', $3, '{}'::jsonb, now())
				 returning id`,
				[waiter?.agent_id ?? "", waiter?.id ?? "", waiter?.correlation_id ?? ""],
			);
			await gateway.pool.query(
				`insert into agent_inbox (agent_id, event_id, status, wait_id)
				 values ($1, (select e.id from events e
				               where not exists (select 1 from agent_inbox i
				                                  where i.event_id = e.id and i.agent_id = $1)
				               order by e.seq desc limit 1), 'pending', $2)`,
				[waiter?.agent_id ?? "", waitRow?.id ?? ""],
			);

			const now = new Date(Date.now() + 40 * DAY_MS);
			const result = await applyRetention(at(now));
			expect(result.event_content).toBeGreaterThan(0);
			expect(result.run_content).toBeGreaterThan(0);
			expect(result.context_snapshots).toBeGreaterThan(0);
			expect(result.outbox_sent).toBeGreaterThan(0);

			const [expiredId] = await query<{ external_id: string }>(
				"select external_id from events where content_expired_at is not null limit 1",
			);
			const expired = await query<{ payload: Row; content_hash: string | null }>(
				`select payload, content_hash from events
				  where content_expired_at is not null and type = 'mattermost.agent.mentioned' limit 1`,
			);
			expect(Object.keys(expired[0]?.payload ?? {}).sort()).toEqual(["channel_id", "post_id"]);

			const [kept] = await query<{ content_expired_at: string | null; message: string }>(
				"select content_expired_at, payload->>'message' as message from events where external_id = $1",
				[pending.id],
			);
			expect(kept).toEqual({ content_expired_at: null, message: "@director later" });
			const [keptEdit] = await query<{ content_expired_at: string | null }>(
				"select content_expired_at from events where external_id = $1",
				[edit.id],
			);
			expect(keptEdit?.content_expired_at).toBeNull();

			const runs = await query<{ id: string }>(
				`select id from agent_runs
				  where status in ('succeeded', 'failed', 'cancelled') and (result is not null or public_summary is not null)`,
			);
			expect(runs.map((row) => row.id)).toEqual([waiter?.id]);
			const snapshots = await query<{ run_id: string }>("select run_id from context_snapshots");
			expect(snapshots.map((row) => row.run_id)).toEqual([waiter?.id]);
			await gateway.pool.query("delete from agent_inbox where wait_id = $1", [waitRow?.id ?? ""]);

			// An expired event is shown by its columns, not as an envelope that no longer parses.
			const [shown] = await showEvent(deps, expiredId?.external_id ?? "");
			expect(shown).toMatchObject({ event: null });
			expect(shown && "contentExpiredAt" in shown).toBe(true);

			// A redelivered expired event is still a duplicate.
			const [first] = await query<{ external_id: string }>(
				`select external_id from events where content_expired_at is not null
				  and source = 'mattermost://test' limit 1`,
			);
			const original = humanPost("@director again", ["director"]);
			const replay = await ingestEvent(deps, { ...original, id: first?.external_id ?? "" });
			expect(replay.status).not.toBe("accepted");

			// A dead item whose payload expired cannot be redriven.
			const [dead] = await query<{ id: string }>(
				`update outbox set status = 'dead', content_expired_at = now()
				  where id = (select id from outbox where status = 'sent' limit 1) returning id`,
			);
			await expect(redriveOutbox(deps, dead?.id ?? "", "test")).rejects.toThrow(
				"expired under retention",
			);
			await gateway.pool.query("update outbox set status = 'sent' where id = $1", [dead?.id ?? ""]);
			await resumeAgent(deps, "director", "test");
		});

		it("keeps the events of a failed agent redrivable and runs once per interval", async () => {
			await gateway.startController();
			const deps = gateway.deps();
			const event = humanPost("@research [mock:permanent]", ["research"]);
			await ingestEvent(deps, event);
			const [run] = await settledRuns(event.id, 1);
			await gateway.stopController();

			const now = new Date(Date.now() + 40 * DAY_MS);
			await applyRetention(at(now));
			const [row] = await query<{ content_expired_at: string | null }>(
				"select content_expired_at from events where external_id = $1",
				[event.id],
			);
			expect(row?.content_expired_at).toBeNull();

			// Two passes at once (two controllers, or a slow pass and the next tick): one runs.
			const passes = await Promise.all([runRetentionIfDue(at(now)), runRetentionIfDue(at(now))]);
			expect(passes.filter((pass) => pass !== null)).toHaveLength(1);
			expect(await runRetentionIfDue(at(new Date(now.getTime() + 60_000)))).toBeNull();
			const [status] = await query<{ ok: boolean }>(
				"select last_success_at is not null as ok from maintenance_status where task = 'retention'",
			);
			expect(status?.ok).toBe(true);

			// A pass interrupted by a stopping controller is no success, and is due again at once.
			const successAt = async () =>
				(
					await query<{ at: string }>(
						"select last_success_at::text as at from maintenance_status where task = 'retention'",
					)
				)[0]?.at;
			const before = await successAt();
			const later = new Date(now.getTime() + 2 * 3_600_000);
			expect(await runRetentionIfDue(at(later), undefined, () => true)).not.toBeNull();
			expect(await successAt()).toBe(before);
			expect(await runRetentionIfDue(at(later))).not.toBeNull();
			expect(await successAt()).not.toBe(before);

			await gateway.startController();
			await redriveRun(gateway.deps(), run?.id ?? "", "test");
			await gateway.stopController();
		});
	});

	it("reports database gauges, and a failed collection as a failure, not as zeros", async () => {
		const registry = new MetricsRegistry();
		registerControllerMetrics(registry, gateway.pool);
		const text = await registry.render();
		expect(text).toContain("gateway_metrics_collection_success 1");
		expect(text).toMatch(/gateway_agents\{state="[a-z]+"\} \d+/u);
		expect(text).toContain("gateway_kill_switch 0");

		const unreachable = createPool("postgres://nobody:nothing@127.0.0.1:1/none", 1);
		const broken = new MetricsRegistry();
		registerControllerMetrics(broken, unreachable);
		const failed = await broken.render();
		await unreachable.end();
		expect(failed).toContain("gateway_metrics_collection_success 0");
		expect(failed).not.toContain("gateway_agents{");
	});
});
