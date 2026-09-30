import { randomUUID } from "node:crypto";
import { SYSTEM_STATUS_LIMITS } from "@agent-gateway/contracts";
import { loadConsoleStatus, loadSystemStatus } from "@agent-gateway/core";
import { type Transaction, withTransaction } from "@agent-gateway/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, startTestGateway, type TestGateway } from "./test-gateway.ts";

/** Seeded only into content a turn or the console must never carry. */
const PRIVATE_MARKER = "PRIVATE-9f3ac2-DO-NOT-LEAK";
/** Seeded only into an alert's own message: already sent to the owner's alerts channel, so the
 * console may show it (ADR-023) even though `SystemStatus` never carries any alert text. */
const ALERT_MARKER = "ALERT-7e1bd4-PUBLIC-OK";
/**
 * One space, one astral codepoint (U+1F600, 2 UTF-16 code units), one space, five letters: 9
 * UTF-16 code units but only 8 Unicode code points. PostgreSQL's `length()` would count 8; the
 * context budgets (and `String.prototype.length`) count 9. Appending this to a marker and
 * asserting the exact expected count (not a count recomputed the same way) is what would catch a
 * regression back to code-point counting.
 */
const EMOJI_SNIPPET = " \u{1f600} hello";

const REAL_AGENT_IDS = ["developer", "director", "finance", "mail-follower", "research"] as const;

describe("system status and console read models (ADR-023)", () => {
	let gateway: TestGateway;

	const query = async <T extends Record<string, unknown>>(
		text: string,
		values: Readonly<unknown[]> = [],
	): Promise<Readonly<T[]>> => (await gateway.pool.query<T>(text, [...values])).rows;

	/** Runs `work` in a read-only transaction: the read models never write, and this proves it. */
	async function readOnly<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
		return withTransaction(gateway.pool, async (tx) => {
			await tx.client.query("set transaction read only");
			return work(tx);
		});
	}

	beforeAll(async () => {
		gateway = await startTestGateway();
		// Every scenario below is seeded with raw SQL, on purpose bypassing the state machine and
		// the scheduler: the background controller and worker must not react to it mid-test (a
		// reconciliation sweep, an alert sweep, a real schedule) while assertions are pending.
		await gateway.stopController();
		await gateway.stopWorker();
		// The worker's own brief startup already left its heartbeat report queued; nothing will
		// consume or add to it now that both are stopped, so a clean slate stays clean.
		await gateway.pool.query("delete from pgboss.job");
	});

	afterAll(async () => {
		await gateway?.stop();
	});

	it("reports the configured agents and nothing else before anything has run", async () => {
		const now = new Date();
		const status = await readOnly((tx) => loadSystemStatus(tx, now));
		expect(status.agents.map((a) => a.agentId).sort()).toEqual([...REAL_AGENT_IDS].sort());
		expect(status.omittedAgents).toBe(0);
		for (const agent of status.agents) {
			expect(agent.activeRuns).toEqual([]);
			expect(agent.lastRun).toBeNull();
			expect(agent.activeWaits).toBe(0);
			expect(agent.pendingInbox).toBe(0);
			expect(agent.tokensToday).toBe(0);
			expect(agent.costTodayUsd).toBe(0);
		}
		expect(status.queues).toEqual([]);
		expect(status.alerts).toEqual([]);

		const console = await readOnly((tx) => loadConsoleStatus(tx, now, { perAgent: null }));
		expect(console.recentRuns).toEqual([]);
		expect(console.alerts).toEqual([]);
		for (const agent of console.agents) {
			expect(agent.current).toBeNull();
			expect(agent.context).toBeNull();
			expect(agent.waits).toEqual([]);
		}
	});

	it("bounds the agent list at the configured limit and reports the rest as omitted", async () => {
		const [{ v: configVersion } = { v: "" }] = await query<{ v: string }>(
			"select active_config_version as v from gateway_controls where id = 1",
		);
		// Sorts after every real example agent id (which start with letters before 'z'), so the
		// bounded top `SYSTEM_STATUS_LIMITS.agents` is deterministic: the 5 real agents, then the
		// lexicographically smallest synthetic ones.
		const extra = SYSTEM_STATUS_LIMITS.agents + 1;
		await gateway.pool.query(
			`insert into agents (id, display_name, enabled, state, runtime_adapter, runtime_profile,
			   config_version, max_active_runs, config, role_prompt, state_changed_at)
			 select 'zzagent' || lpad(g::text, 3, '0'), 'Synthetic ' || g, true, 'idle', 'mock', 'default',
			        $1, 1, '{"runtime": {}}'::jsonb, 'synthetic role prompt', now()
			   from generate_series(1, $2) g`,
			[configVersion, extra],
		);
		try {
			const status = await readOnly((tx) => loadSystemStatus(tx, new Date()));
			expect(status.agents).toHaveLength(SYSTEM_STATUS_LIMITS.agents);
			expect(status.omittedAgents).toBe(
				REAL_AGENT_IDS.length + extra - SYSTEM_STATUS_LIMITS.agents,
			);
			const ids = status.agents.map((a) => a.agentId);
			expect(ids.slice(0, REAL_AGENT_IDS.length).sort()).toEqual([...REAL_AGENT_IDS].sort());
			expect(ids.slice(REAL_AGENT_IDS.length)).toEqual(
				Array.from(
					{ length: SYSTEM_STATUS_LIMITS.agents - REAL_AGENT_IDS.length },
					(_, i) => `zzagent${String(i + 1).padStart(3, "0")}`,
				),
			);
			// The one left out is the lexicographically largest synthetic id, never one of the 5 real ones.
			expect(ids).not.toContain(`zzagent${String(extra).padStart(3, "0")}`);
		} finally {
			await gateway.pool.query("delete from agents where id like 'zzagent%'");
		}
	});

	describe("with a scenario of runs, waits, usage, queues and alerts seeded", () => {
		const NOW = new Date("2031-03-10T08:00:00.000Z");
		const GRANTED_CHANNEL_ID = IDS.channel("granted-only");
		const ROOT_POST_ID = IDS.channel("root-post");

		const insertedEventIds: string[] = [];

		async function insertEvent(type: string, payload: Readonly<Record<string, unknown>> = {}) {
			const id = randomUUID();
			await gateway.pool.query(
				// `id` is `uuid`; `external_id`/`correlation_id` are `text`. The same JS value is
				// passed twice, as $1 and $2, rather than reusing one placeholder for both column
				// types: PostgreSQL cannot deduce a single type for a parameter used both ways.
				`insert into events (id, specversion, external_id, source, type, time, correlation_id,
				   trust_level, hop, payload, payload_hash)
				 values ($1, '1.0', $2, 'test://seed', $3, $4, $2, 'human-trusted', 0, $5::jsonb, 'seed')`,
				[id, id, type, NOW.toISOString(), JSON.stringify(payload)],
			);
			insertedEventIds.push(id);
			return id;
		}

		type RunSeed = Readonly<{
			agentId: string;
			eventId: string;
			status: "queued" | "running" | "succeeded" | "failed";
			outcome?: string | null;
			errorCode?: string | null;
			usage?: Readonly<Record<string, unknown>> | null;
			startedAt?: Date | null;
			finishedAt?: Date | null;
			queuedAt?: Date;
			timeoutAt?: Date;
		}>;

		async function insertRun(seed: RunSeed): Promise<string> {
			const id = randomUUID();
			await gateway.pool.query(
				// `id` is `uuid`, `correlation_id` is `text`: passed as $1 and $6 separately, for the
				// same reason as `insertEvent` above.
				`insert into agent_runs (
				   id, agent_id, trigger_event_id, idempotency_key, status, attempt, max_attempts,
				   runtime_adapter, correlation_id, hop, queued_at, started_at, finished_at, timeout_at,
				   timeout_seconds, outcome, error_code, usage
				 ) values ($1, $2, $3, $4, $5, 1, 3, 'mock', $6, 0, $7, $8, $9, $10, 3600, $11, $12, $13::jsonb)`,
				[
					id,
					seed.agentId,
					seed.eventId,
					`seed:${id}`,
					seed.status,
					id,
					seed.queuedAt ?? NOW,
					seed.startedAt ?? null,
					seed.finishedAt ?? null,
					seed.timeoutAt ?? new Date(NOW.getTime() + 3600_000),
					seed.outcome ?? null,
					seed.errorCode ?? null,
					seed.usage == null ? null : JSON.stringify(seed.usage),
				],
			);
			return id;
		}

		function snapshotInput(opts: {
			rootMessage?: string | null;
			recentPosts?: Readonly<string[]>;
			summary?: string | null;
			omittedPostCount?: number;
			memories?: Readonly<string[]>;
			pendingInbox?: number;
		}) {
			return {
				threadContext: {
					rootPost: (opts.rootMessage ?? null) === null ? null : { message: opts.rootMessage },
					recentPosts: (opts.recentPosts ?? []).map((message) => ({ message })),
					summary: opts.summary ?? null,
					omittedPostCount: opts.omittedPostCount ?? 0,
				},
				memories: (opts.memories ?? []).map((content) => ({ content })),
				pendingInbox: new Array(opts.pendingInbox ?? 0).fill({}),
			};
		}

		async function insertSnapshot(opts: {
			agentId: string;
			runId: string;
			threadRef: string | null;
			input: unknown;
			sizeBytes?: number;
		}) {
			const [{ v: configVersion } = { v: "" }] = await query<{ v: string }>(
				"select active_config_version as v from gateway_controls where id = 1",
			);
			await gateway.pool.query(
				`insert into context_snapshots (agent_id, run_id, config_version, thread_ref, input, authority, size_bytes)
				 values ($1, $2, $3, $4, $5::jsonb, '{}'::jsonb, $6)`,
				[
					opts.agentId,
					opts.runId,
					configVersion,
					opts.threadRef,
					JSON.stringify(opts.input),
					opts.sizeBytes ?? 512,
				],
			);
		}

		let directorRunId: string;
		let developerRunId: string;
		let financeRunId: string;
		let researchRunId: string;
		let mailFollowerRunId: string;

		beforeAll(async () => {
			await gateway.pool.query(
				"update agents set state = $2, state_changed_at = $3 where id = $1",
				["director", "running", NOW],
			);
			await gateway.pool.query(
				"update agents set state = $2, state_changed_at = $3 where id = $1",
				["developer", "queued", NOW],
			);
			await gateway.pool.query(
				"update agents set state = $2, state_changed_at = $3 where id = $1",
				["finance", "waiting", NOW],
			);
			await gateway.pool.query(
				"update agents set state = $2, state_changed_at = $3 where id = $1",
				["research", "failed", NOW],
			);
			await gateway.pool.query(
				"update agents set state = $2, state_changed_at = $3 where id = $1",
				["mail-follower", "running", NOW],
			);

			// director: a running turn whose stored input carries private content (message bodies, a
			// thread summary, memory) that must never surface in either read model.
			const directorEvent = await insertEvent("mattermost.agent.mentioned", {
				message: PRIVATE_MARKER,
			});
			directorRunId = await insertRun({
				agentId: "director",
				eventId: directorEvent,
				status: "running",
				startedAt: NOW,
				usage: { inputTokens: 777, outputTokens: 111, model: "test-model" },
			});
			await insertSnapshot({
				agentId: "director",
				runId: directorRunId,
				threadRef: `channel/${IDS.channel("hq")}/thread/${ROOT_POST_ID}`,
				input: snapshotInput({
					rootMessage: `${PRIVATE_MARKER} root`,
					recentPosts: [`${PRIVATE_MARKER} reply one`, `${PRIVATE_MARKER} reply two`],
					summary: `${PRIVATE_MARKER} summary`,
					memories: [`${PRIVATE_MARKER} memory`],
					omittedPostCount: 2,
					pendingInbox: 3,
				}),
				sizeBytes: 4096,
			});

			// developer: a queued turn with an ordinary (non-private) inbox item and an inbox entry.
			const developerEvent = await insertEvent("mattermost.thread.reply", { message: "hello" });
			developerRunId = await insertRun({
				agentId: "developer",
				eventId: developerEvent,
				status: "queued",
			});
			await insertSnapshot({
				agentId: "developer",
				runId: developerRunId,
				threadRef: `channel/${IDS.channel("hq")}/thread/${ROOT_POST_ID}`,
				input: snapshotInput({ recentPosts: ["ordinary reply"] }),
			});
			await gateway.pool.query(
				`insert into agent_inbox (agent_id, event_id, status) values ('developer', $1, 'pending')`,
				[developerEvent],
			);

			// finance: a finished run whose wait is now active, its condition carrying private content.
			const financeEvent = await insertEvent("mattermost.agent.mentioned", {});
			financeRunId = await insertRun({
				agentId: "finance",
				eventId: financeEvent,
				status: "succeeded",
				outcome: "waiting",
				startedAt: NOW,
				finishedAt: NOW,
			});
			await gateway.pool.query(
				`insert into wait_subscriptions (agent_id, created_by_run_id, status, event_type,
				   correlation_id, condition, timeout_at)
				 values ('finance', $1, 'active', 'mattermost.thread.reply', $2,
				         $3::jsonb, $4)`,
				[
					financeRunId,
					financeEvent,
					JSON.stringify({ note: PRIVATE_MARKER }),
					new Date(NOW.getTime() + 2 * 3600_000),
				],
			);

			// research: a failed run reporting no usage, whose snapshot retention already deleted
			// (no context_snapshots row is inserted for it at all).
			const researchEvent = await insertEvent("mattermost.agent.mentioned", {});
			researchRunId = await insertRun({
				agentId: "research",
				eventId: researchEvent,
				status: "failed",
				outcome: "failed",
				errorCode: "agent_reported_failure",
				startedAt: NOW,
				finishedAt: NOW,
				usage: null,
			});

			// mail-follower: a turn resumed from a wait timeout. Its trigger event carries no post of
			// its own (a real `agent.wait.timeout` event never does), so the thread can only be found
			// through the run's own snapshot (`context_snapshots.thread_ref`); its channel is known
			// only through a grant, never through the resolved directory. Its thread also carries
			// an emoji, to prove characters are measured in UTF-16 units.
			const mailFollowerEvent = await insertEvent("agent.wait.timeout", {
				agent_id: "mail-follower",
				wait_id: randomUUID(),
			});
			mailFollowerRunId = await insertRun({
				agentId: "mail-follower",
				eventId: mailFollowerEvent,
				status: "running",
				startedAt: NOW,
			});
			await insertSnapshot({
				agentId: "mail-follower",
				runId: mailFollowerRunId,
				threadRef: `channel/${GRANTED_CHANNEL_ID}/thread/${ROOT_POST_ID}`,
				input: snapshotInput({ recentPosts: [`${PRIVATE_MARKER}${EMOJI_SNIPPET}`] }),
				sizeBytes: 2048,
			});
			await gateway.pool.query(
				`insert into mattermost_channel_grants (
				   agent_id, channel_id, team_id, channel_name, bot_user_id, state, grantor_user_id,
				   evidence_post_id, since_ms, checked_at_ms, granted_at
				 ) values ('mail-follower', $1, $2, 'granted-only-channel', $3, 'active', $4, $5, $6, $6, $7)`,
				[
					GRANTED_CHANNEL_ID,
					IDS.channel("team"),
					IDS.channel("bot"),
					IDS.owner,
					IDS.channel("evidence"),
					NOW.getTime(),
					NOW,
				],
			);

			// UTC-day usage: today's booking counts, yesterday's (on the very same run) does not.
			await gateway.pool.query(
				`insert into run_usage (run_id, attempt, agent_id, day, cost_usd, tokens, recorded_at)
				 values ($1, 1, 'director', $2, 1.5, 1000, $3)`,
				[directorRunId, "2031-03-10", NOW],
			);
			await gateway.pool.query(
				`insert into run_usage (run_id, attempt, agent_id, day, cost_usd, tokens, recorded_at)
				 values ($1, 2, 'director', $2, 999, 99999, $3)`,
				[directorRunId, "2031-03-09", new Date(NOW.getTime() - 86_400_000)],
			);
			await gateway.pool.query(
				`insert into run_usage (run_id, attempt, agent_id, day, cost_usd, tokens, recorded_at)
				 values ($1, 1, 'developer', $2, 0.25, 250, $3)`,
				[developerRunId, "2031-03-10", NOW],
			);

			// Queues: one due and one future job of the same run queue, a due dead-letter job, and an
			// active job whose own `start_after` is in the future (it counts as active regardless).
			const job = async (name: string, state: string, startAfter: Date) =>
				gateway.pool.query(
					`insert into pgboss.job (name, data, state, start_after)
					 values ($1, '{}'::jsonb, $2::pgboss.job_state, $3)`,
					[name, state, startAfter],
				);
			await job("agent.run.mock", "created", new Date(NOW.getTime() - 60_000));
			await job("dlq.agent.run.mock", "retry", new Date(NOW.getTime() - 120_000));
			await job("outbox.deliver", "created", new Date(NOW.getTime() + 3600_000));
			await job("wait.timeout", "active", new Date(NOW.getTime() + 3600_000));

			// An alert already sent to the owner's alerts channel: its message is fair game for the
			// console, but has no field at all in `SystemStatus`.
			await gateway.pool.query(
				`insert into alert_states (key, state, episode, message, fired_at, notified_at)
				 values ('test:alert-marker', 'firing', 1, $1, $2, $2)`,
				[ALERT_MARKER, NOW],
			);
		});

		afterAll(async () => {
			await gateway.pool.query("delete from alert_states where key = 'test:alert-marker'");
			await gateway.pool.query("delete from pgboss.job where name = any($1::text[])", [
				["agent.run.mock", "dlq.agent.run.mock", "outbox.deliver", "wait.timeout"],
			]);
			await gateway.pool.query("delete from run_usage where agent_id in ('director', 'developer')");
			await gateway.pool.query(
				"delete from mattermost_channel_grants where agent_id = 'mail-follower'",
			);
			await gateway.pool.query("delete from wait_subscriptions where agent_id = 'finance'");
			await gateway.pool.query("delete from agent_inbox where agent_id = 'developer'");
			await gateway.pool.query("delete from context_snapshots where agent_id = any($1::text[])", [
				["director", "developer", "mail-follower"],
			]);
			await gateway.pool.query("delete from agent_runs where agent_id = any($1::text[])", [
				["director", "developer", "finance", "research", "mail-follower"],
			]);
			await gateway.pool.query("delete from events where id = any($1::uuid[])", [insertedEventIds]);
		});

		it("never carries private content in the agent-facing system status", async () => {
			const status = await readOnly((tx) => loadSystemStatus(tx, NOW));
			expect(JSON.stringify(status)).not.toContain(PRIVATE_MARKER);
			expect(JSON.stringify(status)).not.toContain(ALERT_MARKER);
		});

		it("never carries private content on the owner's console either", async () => {
			const console = await readOnly((tx) => loadConsoleStatus(tx, NOW, { perAgent: null }));
			expect(JSON.stringify(console)).not.toContain(PRIVATE_MARKER);
			// The alert's own message is the one piece of already-public text the console does show.
			expect(JSON.stringify(console)).toContain(ALERT_MARKER);
		});

		it("shows queued, running, waiting and failed agents with their runs", async () => {
			const status = await readOnly((tx) => loadSystemStatus(tx, NOW));
			const byId = new Map(status.agents.map((a) => [a.agentId, a]));

			const director = byId.get("director");
			expect(director?.state).toBe("running");
			expect(director?.activeRuns).toEqual([
				expect.objectContaining({ runId: directorRunId, status: "running", attempt: 1 }),
			]);
			expect(director?.lastRun).toBeNull();

			const developer = byId.get("developer");
			expect(developer?.state).toBe("queued");
			expect(developer?.activeRuns).toEqual([
				expect.objectContaining({ runId: developerRunId, status: "queued" }),
			]);
			expect(developer?.pendingInbox).toBe(1);

			const finance = byId.get("finance");
			expect(finance?.state).toBe("waiting");
			expect(finance?.activeRuns).toEqual([]);
			expect(finance?.activeWaits).toBe(1);
			expect(finance?.nextWaitTimeoutAt).toBe(new Date(NOW.getTime() + 2 * 3600_000).toISOString());
			expect(finance?.lastRun).toMatchObject({ runId: financeRunId, status: "succeeded" });

			const research = byId.get("research");
			expect(research?.state).toBe("failed");
			expect(research?.activeRuns).toEqual([]);
			expect(research?.lastRun).toMatchObject({
				runId: researchRunId,
				status: "failed",
				outcome: "failed",
				errorCode: "agent_reported_failure",
				inputTokens: null,
				outputTokens: null,
			});
		});

		it("resolves a timeout turn's thread and channel from the run's own snapshot, including a channel known only through a grant", async () => {
			const console = await readOnly((tx) => loadConsoleStatus(tx, NOW, { perAgent: null }));
			const mailFollower = console.agents.find((a) => a.status.agentId === "mail-follower");
			expect(mailFollower?.current).toMatchObject({
				runId: mailFollowerRunId,
				triggerType: "agent.wait.timeout",
				channel: "granted-only-channel",
				threadRootId: ROOT_POST_ID,
			});
		});

		it("measures recent-reply characters in UTF-16 units, not PostgreSQL code points", async () => {
			const console = await readOnly((tx) => loadConsoleStatus(tx, NOW, { perAgent: null }));
			const mailFollower = console.agents.find((a) => a.status.agentId === "mail-follower");
			// " \u{1f600} hello": 1 + 2 + 1 + 5 = 9 UTF-16 units (not 8 Unicode code points).
			expect(mailFollower?.context?.recentRepliesChars).toBe(PRIVATE_MARKER.length + 9);
		});

		it("hides a run's context once its snapshot has expired under retention", async () => {
			const console = await readOnly((tx) => loadConsoleStatus(tx, NOW, { perAgent: null }));
			const research = console.agents.find((a) => a.status.agentId === "research");
			expect(research?.current).toBeNull();
			expect(research?.context).toBeNull();
		});

		it("labels the context budgets distinctly: recent replies, root, summary and memory", async () => {
			const console = await readOnly((tx) => loadConsoleStatus(tx, NOW, { perAgent: null }));
			const director = console.agents.find((a) => a.status.agentId === "director");
			expect(director?.context).toMatchObject({
				rootLimitChars: 4000,
				recentRepliesLimitChars: 24_000,
				summaryLimitChars: 8000,
				memoryLimitChars: 20_000,
				inputLimitBytes: 2 * 1024 * 1024,
			});
			expect(director?.context?.rootChars).toBe(`${PRIVATE_MARKER} root`.length);
			expect(director?.context?.omittedPosts).toBe(2);
			expect(director?.context?.pendingEvents).toBe(3);
			expect(director?.context?.inputTokens).toBe(777);
			expect(director?.context?.outputTokens).toBe(111);
			expect(director?.maxInputTokens7d).toBe(777);
		});

		it("books usage on its own UTC day and leaves an agent without any at zero", async () => {
			const status = await readOnly((tx) => loadSystemStatus(tx, NOW));
			const byId = new Map(status.agents.map((a) => [a.agentId, a]));
			expect(byId.get("director")).toMatchObject({ tokensToday: 1000, costTodayUsd: 1.5 });
			expect(byId.get("developer")).toMatchObject({ tokensToday: 250, costTodayUsd: 0.25 });
			// research and mail-follower booked nothing today: missing usage is zero, not an error.
			expect(byId.get("research")).toMatchObject({ tokensToday: 0, costTodayUsd: 0 });
			expect(byId.get("mail-follower")).toMatchObject({ tokensToday: 0, costTodayUsd: 0 });
		});

		it("shows only due jobs as waiting, and a dead letter queue by its own name", async () => {
			const status = await readOnly((tx) => loadSystemStatus(tx, NOW));
			const byQueue = new Map(status.queues.map((q) => [q.queue, q]));
			expect(byQueue.get("agent.run.mock")).toMatchObject({ waiting: 1, active: 0 });
			expect(byQueue.get("agent.run.mock")?.oldestWaitingSeconds).toBeCloseTo(60, 0);
			expect(byQueue.get("dlq.agent.run.mock")).toMatchObject({ waiting: 1, active: 0 });
			expect(byQueue.get("dlq.agent.run.mock")?.oldestWaitingSeconds).toBeCloseTo(120, 0);
			// A job scheduled for later, with nothing due or active in its queue, is no backlog.
			expect(byQueue.has("outbox.deliver")).toBe(false);
			// An active job counts regardless of its own future `start_after`.
			expect(byQueue.get("wait.timeout")).toMatchObject({ waiting: 0, active: 1 });
		});

		it("lists a firing alert's key and time in the system status, its message on the console only", async () => {
			const status = await readOnly((tx) => loadSystemStatus(tx, NOW));
			expect(status.alerts).toEqual([
				expect.objectContaining({ key: "test:alert-marker", firedAt: NOW.toISOString() }),
			]);
			const console = await readOnly((tx) => loadConsoleStatus(tx, NOW, { perAgent: null }));
			expect(console.alerts).toEqual([
				expect.objectContaining({ key: "test:alert-marker", message: ALERT_MARKER }),
			]);
		});

		it("lists recent runs across every agent, newest first", async () => {
			const console = await readOnly((tx) => loadConsoleStatus(tx, NOW, { perAgent: null }));
			const ids = console.recentRuns.map((r) => r.runId);
			expect(ids).toHaveLength(5);
			expect(ids).toEqual(
				expect.arrayContaining([
					directorRunId,
					developerRunId,
					financeRunId,
					researchRunId,
					mailFollowerRunId,
				]),
			);
		});
	});
});
