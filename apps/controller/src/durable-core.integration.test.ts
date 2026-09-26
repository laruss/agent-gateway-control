import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	type AgentTurnInput,
	type GatewayEvent,
	type JsonValue,
	MattermostPostDataSchema,
	QUEUES,
	type RunQueueName,
	reportQueue,
	runDeadLetterQueue,
	runQueue,
} from "@agent-gateway/contracts";
import {
	afterChannelStart,
	applyConfig,
	decideMemory,
	deleteDirectoryEntry,
	deleteUnmanagedChannelCursors,
	enqueueOutbox,
	handleRunReport,
	handleWaitTimeout,
	ingestEvent,
	ingestEventIf,
	killAll,
	loadConfigGeneration,
	loadMattermostSnapshot,
	mattermostBootstrapStore,
	pauseAgent,
	ReservedEventError,
	reconcileRunsAndWaits,
	redriveRun,
	releaseKillSwitch,
	resumeAgent,
	setAgentEnabled,
	setDirectoryEntry,
	startManagedChannel,
	type UnitOfWork,
	whileAgentMayPost,
} from "@agent-gateway/core";
import { createPool, grantWorkerRole, withTransaction } from "@agent-gateway/db";
import { newPostEventType } from "@agent-gateway/events";
import { silentLogger } from "@agent-gateway/logging";
import {
	type Deliverer,
	DeliveryError,
	deliverOutboxItem,
	type OutboxDeps,
	reconcileOutbox,
} from "@agent-gateway/outbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { bossJobProbe } from "./controller.ts";
import { loopbackPostDeliverer } from "./loopback-deliverer.ts";
import {
	eventually,
	exampleConfig,
	flakyDeliverer,
	humanPost,
	IDS,
	startTestGateway,
	type TestGateway,
} from "./test-gateway.ts";

type Row = Record<string, JsonValue>;

const MalformedSchema = z.object({ malformed: z.literal(true) });

describe("durable core with the mock runtime", () => {
	let gateway: TestGateway;

	beforeAll(async () => {
		gateway = await startTestGateway();
	});

	afterAll(async () => {
		await gateway?.stop();
	});

	const query = async <T extends Row>(text: string, values: Readonly<(string | number)[]> = []) =>
		(await gateway.pool.query<T>(text, [...values])).rows;

	const agentState = async (id: string) =>
		(await query<{ state: string }>("select state from agents where id = $1", [id]))[0]?.state;

	const runsFor = (eventExternalId: string) =>
		query<{
			id: string;
			agent_id: string;
			status: string;
			outcome: string | null;
			error_code: string | null;
			attempt: number;
		}>(
			`select r.id, r.agent_id, r.status, r.outcome, r.error_code, r.attempt
			   from agent_runs r join events e on e.id = r.trigger_event_id
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

	/** An outbox item whose delivery job goes nowhere: the test drives delivery by hand. */
	const insertAlert = async (key: string, now: Date) => {
		const id = await withTransaction(gateway.pool, (tx) => {
			const uow: UnitOfWork = { deps: gateway.deps(), tx, jobs: { send: async () => "job" }, now };
			return enqueueOutbox(uow, {
				kind: "mattermost.alert",
				destination: "channel/test",
				payload: { message: "test" },
				idempotencyKey: key,
				maxAttempts: 3,
			});
		});
		if (id === null) {
			throw new Error("duplicate outbox key");
		}
		return id;
	};

	const idle = (agentId: string) =>
		eventually(async () => (await agentState(agentId)) === "idle", 30_000, `${agentId} idle`);

	/** The turn input of an agent's latest run in a correlation. */
	const latestInput = async (correlationId: string, agentId: string) => {
		const [row] = await query<{ input: AgentTurnInput; thread_ref: string | null }>(
			`select s.input, s.thread_ref from context_snapshots s join agent_runs r on r.id = s.run_id
			  where r.correlation_id = $1 and r.agent_id = $2 order by r.queued_at desc limit 1`,
			[correlationId, agentId],
		);
		if (row === undefined) {
			throw new Error(`no run of ${agentId} in ${correlationId}`);
		}
		return row;
	};

	let postCounter = 0;
	/** A post of a thread in #hq, as the listener would normalize it. */
	const threadEvent = (
		init: Readonly<{
			rootId: string | null;
			message: string;
			targets?: Readonly<string[]>;
			userId?: string;
		}>,
	): GatewayEvent => {
		postCounter += 1;
		const postId = `thrp0st${String(postCounter).padStart(19, "0")}`;
		const targets = init.targets ?? [];
		return {
			specversion: "1.0",
			id: `mattermost:post:${postId}`,
			source: "mattermost://test",
			type: newPostEventType(init.rootId, targets),
			time: new Date().toISOString(),
			subject: `channel/${IDS.channel("hq")}/post/${postId}`,
			datacontenttype: "application/json",
			correlationid: `thread:${init.rootId ?? postId}`,
			causationid: null,
			trustlevel: "human-trusted",
			hop: 0,
			data: {
				post_id: postId,
				root_id: init.rootId,
				channel_id: IDS.channel("hq"),
				user_id: init.userId ?? IDS.human,
				sender_agent_id: null,
				target_agent_ids: [...targets],
				message: init.message,
			},
		};
	};

	/** A later change (edit or deletion) of a stored post event. */
	const changeOf = (
		event: GatewayEvent,
		change: "edited" | "deleted",
		message: string,
	): GatewayEvent => {
		const post = MattermostPostDataSchema.parse(event.data);
		return {
			...event,
			id: change === "edited" ? `${event.id}:edited:${Date.now()}` : `${event.id}:deleted`,
			type: change === "edited" ? "mattermost.post.edited" : "mattermost.post.deleted",
			time: new Date().toISOString(),
			data: { ...post, target_agent_ids: [], message: change === "deleted" ? "" : message },
		};
	};

	it("creates exactly one run for a duplicated event, also under concurrency", async () => {
		const event = humanPost("@developer status please", ["developer"]);
		const results = await Promise.all([
			ingestEvent(gateway.deps(), event),
			ingestEvent(gateway.deps(), event),
			ingestEvent(gateway.deps(), event),
		]);
		expect(results.map((r) => r.status).sort()).toEqual(["accepted", "duplicate", "duplicate"]);
		expect((await ingestEvent(gateway.deps(), event)).status).toBe("duplicate");

		const run = await finishedRun(event.id, "developer run");
		expect(run).toMatchObject({ agent_id: "developer", status: "succeeded", outcome: "idle" });
		expect(await runsFor(event.id)).toHaveLength(1);
		await idle("developer");

		const posts = await eventually(async () => {
			const rows = await query<{ status: string; idempotency_key: string }>(
				"select status, idempotency_key from outbox where run_id = $1",
				[run.id],
			);
			return rows.every((row) => row.status === "sent") && rows.length > 0 ? rows : null;
		});
		expect(posts).toEqual([{ status: "sent", idempotency_key: `mattermost-post:${run.id}:0` }]);
	});

	it("reports a conflicting redelivery instead of accepting it", async () => {
		const event = humanPost("@developer original", ["developer"]);
		await ingestEvent(gateway.deps(), event);
		const forged = { ...event, data: { ...event.data, message: "@developer changed" } };
		expect((await ingestEvent(gateway.deps(), forged)).status).toBe("conflict");
		await finishedRun(event.id, "original run");
		await idle("developer");
	});

	it("waits for another agent and resumes on its reply (loopback cascade)", async () => {
		const event = humanPost("@developer ask finance about the budget [mock:wait finance]", [
			"developer",
		]);
		await ingestEvent(gateway.deps(), event);

		// developer asks finance and waits; finance replies in the thread; developer resumes.
		const runs = await eventually(
			async () => {
				const rows = await query<{ agent_id: string; status: string; outcome: string | null }>(
					"select agent_id, status, outcome from agent_runs where correlation_id = $1 order by queued_at",
					[event.correlationid],
				);
				return rows.length === 3 && rows.every((r) => r.status === "succeeded") ? rows : null;
			},
			45_000,
			"three runs in the cascade",
		);
		expect(runs).toEqual([
			{ agent_id: "developer", status: "succeeded", outcome: "waiting" },
			{ agent_id: "finance", status: "succeeded", outcome: "idle" },
			{ agent_id: "developer", status: "succeeded", outcome: "idle" },
		]);
		const waits = await query<{ status: string; agent_id: string }>(
			"select status, agent_id from wait_subscriptions where correlation_id = $1",
			[event.correlationid],
		);
		expect(waits).toEqual([{ status: "matched", agent_id: "developer" }]);
		await idle("developer");
		await idle("finance");

		const [resumed] = await query<{
			input: { durableState: { resolvedWaits: { outcome: string }[] } };
		}>(
			`select s.input from context_snapshots s join agent_runs r on r.id = s.run_id
			  where r.correlation_id = $1 and r.agent_id = 'developer' order by r.queued_at desc limit 1`,
			[event.correlationid],
		);
		expect(resumed?.input.durableState.resolvedWaits.map((w) => w.outcome)).toEqual(["matched"]);

		// The resumed turn sees its thread: the human root, its own question, and the summaries of
		// the runs before it. Finance's answer is the trigger and is not repeated.
		const { input, thread_ref: threadRef } = await latestInput(event.correlationid, "developer");
		const rootId = MattermostPostDataSchema.parse(event.data).post_id;
		expect(threadRef).toBe(`channel/${IDS.channel("hq")}/thread/${rootId}`);
		const thread = input.threadContext;
		expect(thread?.rootPost).toMatchObject({ postId: rootId, trustLevel: "human-trusted" });
		expect(thread?.recentPosts.map((p) => [p.authorAgentId, p.message])).toEqual([
			["developer", "@finance could you answer in this thread?"],
		]);
		expect(thread?.participantAgentIds).toEqual(["developer", "finance"]);
		expect(thread?.summary).toContain("@developer at");
		expect(thread?.summary).toContain("@finance at");
		expect(input.durableState.previousSummary?.done).toEqual(["Asked a question"]);
		const [summary] = await query<{ summary: { entries: { agentId: string }[] } }>(
			"select summary from thread_summaries where channel_id = $1 and root_post_id = $2",
			[IDS.channel("hq"), rootId],
		);
		expect(summary?.summary.entries.map((e) => e.agentId)).toEqual([
			"developer",
			"finance",
			"developer",
		]);
	});

	it("assembles the thread with edits applied and deleted posts left out", async () => {
		const root = threadEvent({ rootId: null, message: "Release plan for Friday" });
		const rootId = MattermostPostDataSchema.parse(root.data).post_id;
		const kept = threadEvent({ rootId, message: "first draft", userId: IDS.owner });
		const dropped = threadEvent({ rootId, message: "wrong channel, sorry" });
		for (const event of [
			root,
			kept,
			dropped,
			changeOf(kept, "edited", "final draft"),
			changeOf(dropped, "deleted", ""),
		]) {
			await ingestEvent(gateway.deps(), event);
		}
		const ask = threadEvent({
			rootId,
			message: "@developer please review",
			targets: ["developer"],
		});
		await ingestEvent(gateway.deps(), ask);
		await finishedRun(ask.id, "developer run in the thread");

		const { input } = await latestInput(root.correlationid, "developer");
		expect(input.threadContext?.rootPost?.message).toBe("Release plan for Friday");
		expect(input.threadContext?.recentPosts.map((p) => [p.authorUserId, p.message])).toEqual([
			[IDS.owner, "final draft"],
		]);
		expect(input.threadContext?.omittedPostCount).toBe(0);
		expect(input.memoryNamespaces).toEqual({
			private: "agents/developer",
			shared: ["organization/decisions", "organization/engineering"],
		});
	});

	it("waits for the human who asked and resumes on their answer in the thread", async () => {
		const ask = threadEvent({
			rootId: null,
			message: "@developer check with me first [mock:wait-asker]",
			targets: ["developer"],
		});
		await ingestEvent(gateway.deps(), ask);
		await eventually(
			async () => (await agentState("developer")) === "waiting",
			30_000,
			"developer waiting",
		);
		const [wait] = await query<{ condition: { expectedSenderUserIds: string[] } }>(
			"select condition from wait_subscriptions where correlation_id = $1 and status = 'active'",
			[ask.correlationid],
		);
		expect(wait?.condition.expectedSenderUserIds).toEqual([IDS.human]);

		// Someone else's answer does not resolve it; the asker's does, without a mention.
		const rootId = MattermostPostDataSchema.parse(ask.data).post_id;
		const other = threadEvent({ rootId, message: "not me", userId: IDS.owner });
		await ingestEvent(gateway.deps(), other);
		await Bun.sleep(500);
		expect(await agentState("developer")).toBe("waiting");
		const answer = threadEvent({ rootId, message: "go ahead" });
		await ingestEvent(gateway.deps(), answer);
		const run = await finishedRun(answer.id, "resumed developer run");
		expect(run).toMatchObject({ agent_id: "developer", status: "succeeded" });
		const { input } = await latestInput(ask.correlationid, "developer");
		expect(input.durableState.resolvedWaits.map((w) => w.outcome)).toEqual(["matched"]);
		await idle("developer");
	});

	it("resumes only on a reply in the thread the question was asked in", async () => {
		const deps = gateway.deps();
		await pauseAgent(deps, "finance", "test");
		const ask = threadEvent({
			rootId: null,
			message: "@developer ask finance [mock:wait finance]",
			targets: ["developer"],
		});
		await ingestEvent(deps, ask);
		await eventually(
			async () => (await agentState("developer")) === "waiting",
			30_000,
			"developer waiting",
		);
		const rootId = MattermostPostDataSchema.parse(ask.data).post_id;
		// A finance post addressed to developer in another thread of the same conversation (a thread
		// some other run of the cascade started): the same correlation, but not where it was asked.
		const elsewhere = {
			...threadEvent({ rootId: "e1sewherer00t0000000000000", message: "@developer done" }),
			correlationid: ask.correlationid,
			causationid: `run:${randomUUID()}`,
			trustlevel: "internal-untrusted" as const,
			hop: 2,
		};
		const elsewherePost = MattermostPostDataSchema.parse(elsewhere.data);
		await ingestEvent(deps, {
			...elsewhere,
			data: {
				...elsewherePost,
				sender_agent_id: "finance",
				user_id: "f1nancebot0000000000000000",
				target_agent_ids: ["developer"],
			},
		});
		await Bun.sleep(500);
		expect(await agentState("developer")).toBe("waiting");

		// Finance answers the question in its thread: that resumes developer.
		await resumeAgent(deps, "finance", "test");
		await eventually(
			async () => {
				const rows = await query<{ status: string }>(
					"select status from wait_subscriptions where correlation_id = $1",
					[ask.correlationid],
				);
				return rows.length === 1 && rows[0]?.status === "matched";
			},
			30_000,
			"wait matched in its thread",
		);
		await idle("developer");
		const { input } = await latestInput(ask.correlationid, "developer");
		expect(input.threadContext?.rootPostId).toBe(rootId);
		expect(input.durableState.resolvedWaits.map((w) => w.outcome)).toEqual(["matched"]);
		const trigger = MattermostPostDataSchema.parse(input.trigger.data);
		expect([trigger.root_id, trigger.sender_agent_id]).toEqual([rootId, "finance"]);
	});

	it("binds reply waits created before thread binding to their run's threads", async () => {
		const [run] = await query<{ id: string; agent_id: string; correlation: string; root: string }>(
			`select r.id, r.agent_id, s.input->'trigger'->>'correlationid' as correlation,
			        coalesce(s.input->'trigger'->'data'->>'root_id', s.input->'trigger'->'data'->>'post_id') as root
			   from agent_runs r join context_snapshots s on s.run_id = r.id
			  where s.input->'trigger'->'data' ? 'post_id' order by r.queued_at limit 1`,
		);
		if (run === undefined) {
			throw new Error("no run with a post trigger");
		}
		const condition = {
			eventType: "mattermost.thread.reply",
			correlationId: run.correlation,
			expectedSenderAgentIds: ["finance"],
			expectedSenderUserIds: [],
			requireTargetAgentId: null,
			timeoutAt: new Date(Date.now() + 3600_000).toISOString(),
		};
		const insert = (correlation: string) =>
			query<{ id: string }>(
				`insert into wait_subscriptions
				   (agent_id, created_by_run_id, status, event_type, correlation_id, condition, timeout_at)
				 values ($1, $2, 'active', 'mattermost.thread.reply', $3, $4::jsonb, now() + interval '1 hour')
				 returning id`,
				[
					run.agent_id,
					run.id,
					correlation,
					JSON.stringify({ ...condition, correlationId: correlation }),
				],
			);
		const [bound] = await insert(run.correlation);
		const [orphan] = await insert("thread:nothingknown000000000000");
		const migration = readFileSync(
			new URL("../../../packages/db/migrations/0006_bind_reply_waits.sql", import.meta.url),
			"utf8",
		);
		await gateway.pool.query(migration);
		const roots = await query<{ id: string; thread_root_ids: string[] }>(
			"select id, thread_root_ids from wait_subscriptions where id = any($1::uuid[]) order by id",
			[`{${bound?.id},${orphan?.id}}`],
		);
		expect(Object.fromEntries(roots.map((r) => [r.id, r.thread_root_ids]))).toEqual({
			[bound?.id ?? ""]: [run.root],
			[orphan?.id ?? ""]: [],
		});
		await query("update wait_subscriptions set status = 'cancelled' where id = any($1::uuid[])", [
			`{${bound?.id},${orphan?.id}}`,
		]);
	});

	it("drops deleted posts from the inbox and shows edited ones as they are now", async () => {
		const deps = gateway.deps();
		await pauseAgent(deps, "developer", "test");
		const withdrawn = threadEvent({
			rootId: null,
			message: "@developer the password is hunter2",
			targets: ["developer"],
		});
		const edited = threadEvent({
			rootId: null,
			message: "@developer deploy X",
			targets: ["developer"],
		});
		for (const event of [
			withdrawn,
			changeOf(withdrawn, "deleted", ""),
			edited,
			changeOf(edited, "edited", "@developer do NOT deploy X"),
		]) {
			await ingestEvent(deps, event);
		}
		await resumeAgent(deps, "developer", "test");
		const run = await finishedRun(edited.id, "developer run on the edited post");
		expect(run.status).toBe("succeeded");
		await idle("developer");
		const { input } = await latestInput(edited.correlationid, "developer");
		expect(MattermostPostDataSchema.parse(input.trigger.data).message).toBe(
			"@developer do NOT deploy X",
		);
		expect(input.pendingInbox).toEqual([]);
		expect(await runsFor(withdrawn.id)).toEqual([]);
		const [entry] = await query<{ status: string }>(
			`select i.status from agent_inbox i join events e on e.id = i.event_id
			  where e.external_id = $1 and i.agent_id = 'developer'`,
			[withdrawn.id],
		);
		expect(entry?.status).toBe("dead");
	});

	it("does not resume on an answer deleted before the wait existed", async () => {
		await idle("developer");
		await gateway.stopWorker();
		const ask = threadEvent({
			rootId: null,
			message: "@developer check with me [mock:wait-asker]",
			targets: ["developer"],
		});
		await ingestEvent(gateway.deps(), ask);
		const rootId = MattermostPostDataSchema.parse(ask.data).post_id;
		const early = threadEvent({ rootId, message: "yes" });
		await ingestEvent(gateway.deps(), early);
		await ingestEvent(gateway.deps(), changeOf(early, "deleted", ""));
		await gateway.startWorker();
		await eventually(
			async () => (await agentState("developer")) === "waiting",
			30_000,
			"developer waiting",
		);
		await Bun.sleep(500);
		expect(await agentState("developer")).toBe("waiting");
		const answer = threadEvent({ rootId, message: "yes, really" });
		await ingestEvent(gateway.deps(), answer);
		await finishedRun(answer.id, "developer resumed by the live answer");
		await idle("developer");
	});

	it("lets an agent wait for a human in a thread whose root was never recorded", async () => {
		const ask = threadEvent({
			rootId: "unrec0rdedr00t000000000000",
			message: "@developer confirm with me [mock:wait-asker]",
			targets: ["developer"],
		});
		await ingestEvent(gateway.deps(), ask);
		await eventually(
			async () => (await agentState("developer")) === "waiting",
			30_000,
			"developer waiting",
		);
		const { input } = await latestInput(ask.correlationid, "developer");
		expect(input.threadContext).toMatchObject({ rootPost: null, recentPosts: [] });
		const answer = threadEvent({ rootId: "unrec0rdedr00t000000000000", message: "confirmed" });
		await ingestEvent(gateway.deps(), answer);
		await finishedRun(answer.id, "developer resumed");
		await idle("developer");
	});

	it("keeps memory within namespaces and shares a proposal only once an operator accepts it", async () => {
		const remember = async (agentId: string) => {
			const event = humanPost(`@${agentId} note this [mock:remember]`, [agentId]);
			await ingestEvent(gateway.deps(), event);
			await finishedRun(event.id, `${agentId} remember run`);
			await idle(agentId);
			return (await latestInput(event.correlationid, agentId)).input;
		};
		const memory = () =>
			query<{ id: string; namespace: string; status: string }>(
				`select id, namespace, status from memory_items where key = 'mock-note' order by namespace, created_at`,
			);

		const first = await remember("developer");
		expect(first.memories).toEqual([]);
		expect(await memory()).toMatchObject([
			{ namespace: "agents/developer", status: "accepted" },
			{ namespace: "organization/decisions", status: "proposed" },
		]);

		// The private note is the agent's own at once; the shared proposal is invisible so far.
		const second = await remember("developer");
		expect(second.memories.map((m) => m.namespace)).toEqual(["agents/developer"]);
		const afterSecond = await memory();
		expect(afterSecond.filter((m) => m.status === "accepted")).toHaveLength(1);
		expect(afterSecond.filter((m) => m.status === "superseded")).toHaveLength(1);

		const shared = afterSecond.find((m) => m.namespace === "organization/decisions");
		if (shared === undefined) {
			throw new Error("no shared proposal");
		}
		await decideMemory(gateway.deps(), shared.id, "accept", "test");
		await expect(decideMemory(gateway.deps(), shared.id, "accept", "test")).rejects.toThrow(
			"is not proposed",
		);

		// finance reads organization/decisions too, but never developer's private namespace.
		const finance = await remember("finance");
		expect(finance.memories.map((m) => [m.namespace, m.key])).toEqual([
			["organization/decisions", "mock-note"],
		]);
	});

	it("fails a permanent runtime error and redrives it on request", async () => {
		const event = humanPost("@research [mock:permanent]", ["research"]);
		await ingestEvent(gateway.deps(), event);
		const run = await finishedRun(event.id, "failing research run");
		expect(run).toMatchObject({ status: "failed", error_code: "runtime_permanent", attempt: 1 });
		expect(await agentState("research")).toBe("failed");
		const alerts = await query("select 1 from outbox where idempotency_key = $1", [
			`alert:run-failed:${run.id}`,
		]);
		expect(alerts).toHaveLength(1);

		// New events for a failed agent wait in its inbox.
		const later = humanPost("@research anything new?", ["research"]);
		await ingestEvent(gateway.deps(), later);
		expect(await runsFor(later.id)).toEqual([]);

		const redriven = await redriveRun(gateway.deps(), run.id, "test");
		expect("runId" in redriven).toBe(true);
		await eventually(
			async () =>
				(await runsFor(event.id)).length === 2 && (await agentState("research")) === "failed",
		);
		const [parent] = await query<{ parent_run_id: string }>(
			"select parent_run_id from agent_runs where id = $1",
			["runId" in redriven ? redriven.runId : ""],
		);
		expect(parent?.parent_run_id).toBe(run.id);

		// Neither disable/enable nor kill-all clears a failure; only a redrive does.
		expect(await setAgentEnabled(gateway.deps(), "research", false, "test")).toBe("disabled");
		expect(await setAgentEnabled(gateway.deps(), "research", true, "test")).toBe("failed");
		expect(await pauseAgent(gateway.deps(), "research", "test")).toEqual([]);
		expect(await agentState("research")).toBe("failed");
	});

	it("resumes a waiting agent with a timeout when nobody answers", async () => {
		// research is FAILED and will not answer.
		const event = humanPost("@director ask research [mock:wait research]", ["director"]);
		await ingestEvent(gateway.deps(), event);
		await eventually(
			async () => (await agentState("director")) === "waiting",
			30_000,
			"director waiting",
		);
		const [wait] = await query<{ id: string }>(
			"select id from wait_subscriptions where correlation_id = $1 and status = 'active'",
			[event.correlationid],
		);
		if (wait === undefined) {
			throw new Error("no active wait");
		}
		// Let the question reach the thread before the wait times out.
		await eventually(
			async () =>
				(
					await query(
						"select 1 from events where correlation_id = $1 and sender_agent_id = 'director'",
						[event.correlationid],
					)
				).length > 0,
			30_000,
			"director's question posted",
		);
		// Unrelated work of another thread waits in the inbox and joins the resumed turn.
		const unrelated = humanPost("@director unrelated question", ["director"]);
		await ingestEvent(gateway.deps(), unrelated);
		expect(await handleWaitTimeout(gateway.deps(), { waitId: wait.id })).toBe("not_due");
		const later = { ...gateway.deps(), clock: () => new Date(Date.now() + 2 * 3600_000) };
		expect(await handleWaitTimeout(later, { waitId: wait.id })).toBe("timed_out");
		expect(await handleWaitTimeout(later, { waitId: wait.id })).toBe("ignored");

		await idle("director");
		const [resumed] = await query<{
			input: { durableState: { resolvedWaits: { outcome: string }[] } };
		}>(
			`select s.input from context_snapshots s join agent_runs r on r.id = s.run_id
			  where r.correlation_id = $1 and r.agent_id = 'director' order by r.queued_at desc limit 1`,
			[event.correlationid],
		);
		expect(resumed?.input.durableState.resolvedWaits.map((w) => w.outcome)).toEqual(["timeout"]);

		// Resumed without a post, the turn still gets the thread it waited in (not the thread of the
		// inbox post it also carries) and may answer there.
		const rootId = MattermostPostDataSchema.parse(event.data).post_id;
		const { input } = await latestInput(event.correlationid, "director");
		expect(input.pendingInbox.map((e) => e.id)).toEqual([unrelated.id]);
		expect(input.threadContext?.rootPostId).toBe(rootId);
		expect(input.threadContext?.recentPosts.map((p) => p.authorAgentId)).toEqual(["director"]);
		const posts = await query<{ payload: { rootPostId: string | null; message: string } }>(
			`select o.payload from outbox o join agent_runs r on r.id = o.run_id
			  where r.correlation_id = $1 and r.agent_id = 'director' order by o.created_at`,
			[event.correlationid],
		);
		expect(posts.map((p) => [p.payload.rootPostId, p.payload.message])).toEqual([
			[rootId, "@research could you answer in this thread?"],
			[rootId, "Thanks, continuing."],
		]);
	});

	it("does not let a reply blocked by a loop guard resume a waiting agent", async () => {
		const event = humanPost("@director ask research [mock:wait research]", ["director"]);
		await ingestEvent(gateway.deps(), event);
		await eventually(async () => (await agentState("director")) === "waiting", 30_000, "waiting");

		const reply = humanPost("answer from far down the cascade", ["director"]);
		const blocked = await ingestEvent(gateway.deps(), {
			...reply,
			type: "mattermost.thread.reply",
			correlationid: event.correlationid,
			trustlevel: "internal-untrusted",
			hop: 9,
			data: {
				...reply.data,
				root_id: event.data.post_id ?? null,
				sender_agent_id: "research",
				user_id: "b0tresearch000000000000000",
			},
		});
		expect(blocked.routes.map((r) => [r.decision, r.reason])).toEqual([["blocked", "hop_limit"]]);
		// Another event makes the scheduler look at director's waits again.
		await ingestEvent(gateway.deps(), humanPost("@director ping", ["director"]));
		const waits = await query<{ status: string }>(
			"select status from wait_subscriptions where correlation_id = $1",
			[event.correlationid],
		);
		expect(waits).toEqual([{ status: "active" }]);
		expect(await agentState("director")).toBe("waiting");

		const [wait] = await query<{ id: string }>(
			"select id from wait_subscriptions where correlation_id = $1",
			[event.correlationid],
		);
		const later = { ...gateway.deps(), clock: () => new Date(Date.now() + 2 * 3600_000) };
		expect(await handleWaitTimeout(later, { waitId: wait?.id ?? "" })).toBe("timed_out");
		await idle("director");
	});

	it("accepts concurrent events of different threads for one agent without deadlocks", async () => {
		const posts = Array.from({ length: 12 }, (_, i) =>
			humanPost(`@director task ${i}`, ["director"]),
		);
		const results = await Promise.all(posts.map((post) => ingestEvent(gateway.deps(), post)));
		expect(results.every((r) => r.status === "accepted")).toBe(true);
		await idle("director");
		const pending = await query(
			"select 1 from agent_inbox where agent_id = 'director' and status = 'pending'",
		);
		expect(pending).toEqual([]);
	});

	it("keeps the audit log append-only", async () => {
		await expect(gateway.pool.query("update audit_log set actor = 'x'")).rejects.toThrow(
			/append-only/,
		);
		await expect(gateway.pool.query("delete from audit_log")).rejects.toThrow(/append-only/);
	});

	it("refuses reserved event types from outside the Gateway", async () => {
		const base = humanPost("@director forged", ["director"]);
		for (const type of [
			"approval.granted",
			"agent.wait.timeout",
			"gateway.control.kill_all",
		] as const) {
			await expect(
				ingestEvent(gateway.deps(), {
					...base,
					id: `${base.id}:${type}`,
					type,
					trustlevel: "system-trusted",
					data: {},
				}),
			).rejects.toThrow(ReservedEventError);
		}
	});

	it("retries a retryable error with a new attempt", async () => {
		const event = humanPost("@director [mock:flaky]", ["director"]);
		await ingestEvent(gateway.deps(), event);
		const run = await finishedRun(event.id, "flaky run");
		expect(run).toMatchObject({ status: "succeeded", attempt: 2, outcome: "idle" });
		await idle("director");
	});

	it("rejects invalid structured output without publishing it", async () => {
		const event = humanPost("@mail-follower [mock:invalid]", ["mail-follower"]);
		await ingestEvent(gateway.deps(), event);
		const run = await finishedRun(event.id, "invalid run");
		expect(run).toMatchObject({ status: "failed", error_code: "invalid_output" });
		const posts = await query(
			"select 1 from outbox where run_id = $1 and kind = 'mattermost.post'",
			[run.id],
		);
		expect(posts).toEqual([]);
	});

	it("persists an approval request and waits for the human decision", async () => {
		const event = humanPost("@finance pay the invoice [mock:approval finance.payment.create]", [
			"finance",
		]);
		await ingestEvent(gateway.deps(), event);
		const run = await finishedRun(event.id, "approval run");
		expect(run).toMatchObject({ status: "succeeded", outcome: "needs_human" });
		expect(await agentState("finance")).toBe("waiting");

		const [approval] = await query<{
			id: string;
			status: string;
			risk_level: string;
			action_type: string;
			allowed_approver_user_ids: string[];
			immutable_action_hash: string;
		}>("select * from approval_requests where run_id = $1", [run.id]);
		expect(approval).toMatchObject({
			status: "pending",
			risk_level: "critical",
			action_type: "finance.payment.create",
			allowed_approver_user_ids: [IDS.owner],
		});
		expect(approval?.immutable_action_hash).toMatch(/^[a-f0-9]{64}$/);
		const waits = await query<{ event_type: string }>(
			"select event_type from wait_subscriptions where correlation_id = $1 and status = 'active' order by event_type",
			[`approval:${approval?.id}`],
		);
		expect(waits.map((w) => w.event_type)).toEqual(["approval.denied", "approval.granted"]);
		const cards = await query("select 1 from outbox where idempotency_key = $1", [
			`approval-card:${approval?.id}`,
		]);
		expect(cards).toHaveLength(1);
	});

	it("rejects a forged result that exceeds the run's authority", async () => {
		await gateway.stopWorker();
		const event = humanPost("@developer forged", ["developer"]);
		await ingestEvent(gateway.deps(), event);
		const [run] = await runsFor(event.id);
		if (run === undefined) {
			throw new Error("no run was scheduled");
		}
		const outcome = await handleRunReport(
			gateway.deps(),
			{
				kind: "completed",
				runId: run.id,
				attempt: 1,
				agentId: "developer",
				runtimeVersion: "forged",
				result: {
					schemaVersion: 1,
					runId: run.id,
					publicMessages: [
						{
							channelId: IDS.channel("finance"),
							rootPostId: null,
							markdown: "moving money",
							targetAgentIds: [],
							attachments: [],
						},
					],
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
				},
			},
			"mock",
		);
		expect(outcome).toBe("failed");
		const decisions = await query(
			"select action, decision from policy_decisions where run_id = $1",
			[run.id],
		);
		expect(decisions).toEqual([
			{ action: "turn_result.publicMessages.0.channelId", decision: "deny" },
		]);
		expect(
			await query("select 1 from outbox where run_id = $1 and kind = 'mattermost.post'", [run.id]),
		).toEqual([]);
		// A late report of the same attempt is stale now.
		expect(
			await handleRunReport(
				gateway.deps(),
				{
					kind: "started",
					runId: run.id,
					attempt: 1,
					agentId: "developer",
					runtimeVersion: "late",
				},
				"mock",
			),
		).toBe("ignored_stale");
		// A report that claims another agent's run is ignored outright.
		expect(
			await handleRunReport(
				gateway.deps(),
				{
					kind: "started",
					runId: run.id,
					attempt: 1,
					agentId: "finance",
					runtimeVersion: "forged",
				},
				"mock",
			),
		).toBe("ignored_unknown");

		expect(await agentState("developer")).toBe("failed");
		await gateway.startWorker();
		await redriveRun(gateway.deps(), run.id, "test");
		await idle("developer");
	});

	it("runs the worker as a role limited to its adapter's queues", async () => {
		const workerPool = createPool(gateway.workerConnectionString, 1);
		try {
			await expect(workerPool.query("select id from agents")).rejects.toThrow(/permission denied/);
			await expect(workerPool.query("delete from outbox")).rejects.toThrow(/permission denied/);
			// Only its own adapter's tables: not the shared job table, not controller queues.
			await expect(workerPool.query("select id from pgboss.job")).rejects.toThrow(
				/permission denied/,
			);
			const [timeouts] = await query<{ table_name: string }>(
				"select table_name from pgboss.queue where name = 'wait.timeout'",
			);
			await expect(
				workerPool.query(`delete from pgboss."${timeouts?.table_name ?? ""}"`),
			).rejects.toThrow(/permission denied/);
			// The owning role itself can never be turned into a worker role.
			await expect(
				grantWorkerRole(gateway.pool, "gateway", {
					run: runQueue("mock"),
					report: reportQueue("mock"),
					deadLetter: runDeadLetterQueue("mock"),
				}),
			).rejects.toThrow(/owns the gateway tables/);
			// Nor a role that would keep a privilege granted to PUBLIC.
			await gateway.pool.query("create role public_worker login password 'x'");
			await gateway.pool.query("grant update on pgboss.queue to public");
			try {
				await expect(
					grantWorkerRole(gateway.pool, "public_worker", {
						run: runQueue("mock"),
						report: reportQueue("mock"),
						deadLetter: runDeadLetterQueue("mock"),
					}),
				).rejects.toThrow(/UPDATE on pgboss.queue/);
			} finally {
				await gateway.pool.query("revoke update on pgboss.queue from public");
			}
			// Nor one that could read a column of domain data through PUBLIC.
			await gateway.pool.query("grant select (input) on context_snapshots to public");
			try {
				await expect(
					grantWorkerRole(gateway.pool, "public_worker", {
						run: runQueue("mock"),
						report: reportQueue("mock"),
						deadLetter: runDeadLetterQueue("mock"),
					}),
				).rejects.toThrow(/SELECT on public.context_snapshots/);
			} finally {
				await gateway.pool.query("revoke select (input) on context_snapshots from public");
			}
			// Nor one holding PostgreSQL 17's MAINTAIN on a domain table, nor a replication role.
			await gateway.pool.query("grant maintain on agents to public");
			try {
				await expect(
					grantWorkerRole(gateway.pool, "public_worker", {
						run: runQueue("mock"),
						report: reportQueue("mock"),
						deadLetter: runDeadLetterQueue("mock"),
					}),
				).rejects.toThrow(/MAINTAIN on public.agents/);
			} finally {
				await gateway.pool.query("revoke maintain on agents from public");
			}
			await gateway.pool.query("create role replicating_worker login replication password 'x'");
			await expect(
				grantWorkerRole(gateway.pool, "replicating_worker", {
					run: runQueue("mock"),
					report: reportQueue("mock"),
					deadLetter: runDeadLetterQueue("mock"),
				}),
			).rejects.toThrow(/may replicate/);
			// Nor a role that inherits read access from a group role.
			await gateway.pool.query("create role reader_worker login password 'x'");
			await gateway.pool.query("grant pg_read_all_data to reader_worker");
			await expect(
				grantWorkerRole(gateway.pool, "reader_worker", {
					run: runQueue("mock"),
					report: reportQueue("mock"),
					deadLetter: runDeadLetterQueue("mock"),
				}),
			).rejects.toThrow(/member of other roles/);
			// Nor can it inject jobs into another queue through the parent job table.
			await expect(
				workerPool.query(
					"insert into pgboss.job (name, data) values ('agent.run.report.codex', '{}')",
				),
			).rejects.toThrow(/row-level security/);
		} finally {
			await workerPool.end();
		}
	});

	it("dead-letters a run job the restricted worker cannot process", async () => {
		const boss = gateway.controller().boss;
		const jobId = await boss.send(runQueue("mock"), { malformed: true });
		await eventually(
			async () => {
				const jobs = await boss.findJobs(runDeadLetterQueue("mock"), {});
				return jobs.some((job) => MalformedSchema.safeParse(job.data).success);
			},
			30_000,
			"dead-lettered job",
		);
		expect(jobId).not.toBeNull();
	});

	/** A reply by `sender` in the thread of `root`, addressed to nobody (stored only). */
	const untargetedReply = (
		root: ReturnType<typeof humanPost>,
		sender: string,
		userId: string,
		hop: number,
	) => {
		const base = humanPost("an answer for the thread", []);
		return {
			...base,
			type: "mattermost.thread.reply" as const,
			correlationid: root.correlationid,
			trustlevel: "internal-untrusted" as const,
			hop,
			data: {
				...base.data,
				root_id: root.data.post_id ?? null,
				sender_agent_id: sender,
				user_id: userId,
			},
		};
	};

	it("keeps the cascade when a human only edits a post", async () => {
		await gateway.stopWorker();
		const mention = humanPost("@research look at X", ["research"]);
		const first = await ingestEvent(gateway.deps(), mention);
		const edit = humanPost("@research look at Y", []);
		await ingestEvent(gateway.deps(), {
			...edit,
			id: `${mention.id}:edited:1`,
			type: "mattermost.post.edited",
			correlationid: mention.correlationid,
			data: { ...edit.data, post_id: mention.data.post_id ?? null, target_agent_ids: [] },
		});
		const reply = untargetedReply(mention, "finance", "b0tf1nance0000000000000000", 1);
		const routed = await ingestEvent(gateway.deps(), {
			...reply,
			data: { ...reply.data, target_agent_ids: ["research"] },
		});
		const [row] = await query<{ same: string }>(
			`select (r.cascade_anchor = e.seq)::text as same from event_routes r, events e
			  where r.event_id = $1 and r.agent_id = 'research' and e.id = $2`,
			[routed.eventId, first.eventId],
		);
		expect(row).toEqual({ same: "true" });
		// research is FAILED by an earlier test: its new inbox entry never runs.
		await gateway.startWorker();
	});

	it("resumes on an untargeted answer stored before the wait existed", async () => {
		await idle("developer");
		await gateway.stopWorker();
		const event = humanPost("@developer ask mail-follower [mock:wait-open mail-follower]", [
			"developer",
		]);
		await ingestEvent(gateway.deps(), event);
		const early = await ingestEvent(
			gateway.deps(),
			untargetedReply(event, "mail-follower", "b0tmai1f0110wer00000000000", 1),
		);
		expect(early.routes).toEqual([]);
		// A new human post in the thread starts a new cascade before the wait exists.
		const human = humanPost("keep going", []);
		const restart = await ingestEvent(gateway.deps(), {
			...human,
			type: "mattermost.thread.reply",
			correlationid: event.correlationid,
			data: { ...human.data, root_id: event.data.post_id ?? null },
		});
		await gateway.startWorker();
		await eventually(
			async () => {
				const rows = await query<{ outcome: string | null }>(
					"select outcome from agent_runs where correlation_id = $1 and agent_id = 'developer' and status = 'succeeded' order by queued_at",
					[event.correlationid],
				);
				return rows.length >= 2 ? rows : null;
			},
			45_000,
			"developer resumed by the stored answer",
		);
		const [late] = await query<{ decision: string; reason_code: string; anchor: string }>(
			`select r.decision, r.reason_code, (r.cascade_anchor = e.seq)::text as anchor
			   from event_routes r, events e
			  where r.event_id = $1 and r.agent_id = 'developer' and e.id = $2`,
			[early.eventId, restart.eventId],
		);
		// The late match spends the budget of the current cascade, not of the answer's.
		expect(late).toEqual({
			decision: "wait-match",
			reason_code: "wait_matched_late",
			anchor: "true",
		});
		await idle("developer");
	});

	it("keeps a stored answer beyond the hop limit from resuming a waiting agent", async () => {
		await gateway.stopWorker();
		const event = humanPost("@developer ask mail-follower [mock:wait-open mail-follower]", [
			"developer",
		]);
		await ingestEvent(gateway.deps(), event);
		const far = await ingestEvent(
			gateway.deps(),
			untargetedReply(event, "mail-follower", "b0tmai1f0110wer00000000000", 9),
		);
		await gateway.startWorker();
		await eventually(async () => (await agentState("developer")) === "waiting", 30_000, "waiting");
		const [blocked] = await query<{ decision: string; reason_code: string }>(
			"select decision, reason_code from event_routes where event_id = $1 and agent_id = 'developer'",
			[far.eventId],
		);
		expect(blocked).toEqual({ decision: "blocked", reason_code: "hop_limit" });
		const [wait] = await query<{ id: string; status: string }>(
			"select id, status from wait_subscriptions where correlation_id = $1",
			[event.correlationid],
		);
		expect(wait?.status).toBe("active");
		const later = { ...gateway.deps(), clock: () => new Date(Date.now() + 2 * 3600_000) };
		await handleWaitTimeout(later, { waitId: wait?.id ?? "" });
		await idle("developer");
	});

	it("recovers a run whose job was lost from the queue", async () => {
		await idle("director");
		await gateway.stopWorker();
		const event = humanPost("@director lost job", ["director"]);
		await ingestEvent(gateway.deps(), event);
		const [run] = await query<{ id: string; job_id: string }>(
			"select r.id, r.job_id from agent_runs r join events e on e.id = r.trigger_event_id where e.external_id = $1",
			[event.id],
		);
		if (run === undefined) {
			throw new Error("no run");
		}
		await gateway.controller().boss.deleteJob(runQueue("mock"), run.job_id);
		// A second stale run whose job is intact: with one run per page, both pages are scanned.
		await idle("developer");
		const healthy = humanPost("@developer still queued", ["developer"]);
		await ingestEvent(gateway.deps(), healthy);
		await gateway.pool.query(
			`update agent_runs set queued_at = now() - interval '10 minutes'
			  where trigger_event_id = (select id from events where external_id = $1)`,
			[healthy.id],
		);
		const probe = {
			isAlive: async (queue: RunQueueName, id: string) =>
				(await gateway.controller().boss.findJobs(queue, { id })).length > 0,
			hasPendingReport: async () => false,
		};
		await gateway.pool.query(
			"update agent_runs set queued_at = now() - interval '10 minutes' where id = $1",
			[run.id],
		);
		// A report still waiting in its queue wins: the run is not treated as lost. The real
		// controller probe must find it (a report due later sits queued).
		const boss = gateway.controller().boss;
		const pending = await boss.send(
			reportQueue("mock"),
			{ kind: "started", runId: run.id, attempt: 1, agentId: "director", runtimeVersion: "late" },
			{ startAfter: new Date(Date.now() + 3600_000) },
		);
		expect(
			await reconcileRunsAndWaits(gateway.deps(), {
				...probe,
				hasPendingReport: bossJobProbe(boss).hasPendingReport,
			}),
		).toMatchObject({ lostAttempts: 0 });
		if (pending !== null) {
			await boss.deleteJob(reportQueue("mock"), pending);
		}
		expect(await reconcileRunsAndWaits(gateway.deps(), probe, 1)).toMatchObject({
			lostAttempts: 1,
		});
		expect((await runsFor(healthy.id)).map((r) => [r.status, r.attempt])).toEqual([["queued", 1]]);
		const [requeued] = await query<{ attempt: number; job_id: string; status: string }>(
			"select attempt, job_id, status from agent_runs where id = $1",
			[run.id],
		);
		expect(requeued).toMatchObject({ attempt: 2, status: "queued" });

		expect(requeued?.job_id).not.toBe(run.job_id);
		// Nothing more to recover.
		expect(await reconcileRunsAndWaits(gateway.deps(), probe)).toMatchObject({ lostAttempts: 0 });
		await gateway.startWorker();
		await eventually(
			async () => {
				const [done] = await query<{ status: string }>(
					"select status from agent_runs where id = $1",
					[run.id],
				);
				return done?.status === "succeeded";
			},
			45_000,
			"recovered run",
		);
	});

	it("re-enqueues the timeout of a wait whose timeout job was lost", async () => {
		const event = humanPost("@director ask research again [mock:wait research]", ["director"]);
		await ingestEvent(gateway.deps(), event);
		await eventually(async () => (await agentState("director")) === "waiting", 30_000, "waiting");
		// The wait's own timeout job fires in an hour; pretend it was lost and the wait is overdue.
		await gateway.pool.query(
			"update wait_subscriptions set timeout_at = now() - interval '10 minutes' where correlation_id = $1",
			[event.correlationid],
		);
		const [overdue] = await query<{ id: string }>(
			"select id from wait_subscriptions where correlation_id = $1",
			[event.correlationid],
		);
		const boss = gateway.controller().boss;
		for (const job of await boss.findJobs(QUEUES.waitTimeout, { data: { waitId: overdue?.id } })) {
			await boss.deleteJob(QUEUES.waitTimeout, job.id);
		}
		const probe = { isAlive: async () => true, hasPendingReport: async () => false };
		expect(await reconcileRunsAndWaits(gateway.deps(), probe)).toMatchObject({
			requeuedWaitTimeouts: 1,
		});
		await idle("director");
		const [wait] = await query<{ status: string }>(
			"select status from wait_subscriptions where correlation_id = $1",
			[event.correlationid],
		);
		expect(wait?.status).toBe("timed_out");
	});

	it("resumes on a reply that arrived before the wait existed", async () => {
		await idle("developer");
		await gateway.stopWorker();
		const event = humanPost("@developer ask director [mock:wait director]", ["developer"]);
		await ingestEvent(gateway.deps(), event);
		// director answers in the thread before developer's run has even started.
		const early = {
			...humanPost("early answer", ["developer"]),
			type: "mattermost.thread.reply" as const,
			correlationid: event.correlationid,
			trustlevel: "internal-untrusted" as const,
			hop: 1,
		};
		await ingestEvent(gateway.deps(), {
			...early,
			data: {
				...early.data,
				root_id: event.data.post_id ?? null,
				sender_agent_id: "director",
				user_id: "b0tdirect0r00000000000000a",
			},
		});
		await gateway.startWorker();
		const runs = await eventually(
			async () => {
				const rows = await query<{ agent_id: string; status: string; outcome: string | null }>(
					"select agent_id, status, outcome from agent_runs where correlation_id = $1 and agent_id = 'developer' order by queued_at",
					[event.correlationid],
				);
				return rows.length >= 2 && rows.every((r) => r.status === "succeeded") ? rows : null;
			},
			45_000,
			"developer resumed",
		);
		expect(runs.slice(0, 2).map((r) => r.outcome)).toEqual(["waiting", "idle"]);
	});

	it("preserves queued work across a restart of controller and worker", async () => {
		await idle("developer");
		await gateway.stopWorker();
		const event = humanPost("@developer after restart", ["developer"]);
		await ingestEvent(gateway.deps(), event);
		await gateway.stopController();

		const queued = await runsFor(event.id);
		expect(queued.map((r) => r.status)).toEqual(["queued"]);

		await gateway.startController();
		await gateway.startWorker();
		const run = await finishedRun(event.id, "run after restart");
		expect(run).toMatchObject({ status: "succeeded", outcome: "idle" });
	});

	it("kill-all stops new runs until released and resumed", async () => {
		await killAll(gateway.deps(), "test");
		expect(await agentState("director")).toBe("paused");
		const event = humanPost("@director are you there?", ["director"]);
		await ingestEvent(gateway.deps(), event);
		await Bun.sleep(1500);
		expect(await runsFor(event.id)).toEqual([]);

		await releaseKillSwitch(gateway.deps(), "test");
		await resumeAgent(gateway.deps(), "director", "test");
		const run = await finishedRun(event.id, "run after kill-all");
		expect(run.status).toBe("succeeded");
		for (const id of ["developer", "finance"]) {
			await resumeAgent(gateway.deps(), id, "test").catch(() => undefined);
		}
	});

	it("blocks an agent cascade beyond the hop limit and raises an alert", async () => {
		const base = humanPost("@finance loop", ["finance"]);
		const looping = {
			...base,
			trustlevel: "internal-untrusted" as const,
			hop: 9,
			data: { ...base.data, sender_agent_id: "developer", user_id: "b0tdeve1oper00000000000000" },
		};
		const result = await ingestEvent(gateway.deps(), looping);
		expect(result.routes).toEqual([
			expect.objectContaining({ agentId: "finance", decision: "blocked", reason: "hop_limit" }),
		]);
		expect(await runsFor(looping.id)).toEqual([]);
		const alerts = await query("select 1 from outbox where idempotency_key = $1", [
			`alert:loop:${result.eventId}:finance`,
		]);
		expect(alerts).toHaveLength(1);
	});

	it("delivers an outbox item once across failures, duplicate jobs and expired leases", async () => {
		const deliverer = flakyDeliverer(1);
		let now = new Date();
		const deps: OutboxDeps = {
			pool: gateway.pool,
			deliverers: { "mattermost.alert": deliverer },
			clock: () => now,
			log: silentLogger,
			leaseSeconds: 30,
		};
		const key = `test:${randomUUID()}`;
		const outboxId = await insertAlert(key, now);

		await expect(deliverOutboxItem(deps, outboxId)).rejects.toThrow("transient failure 1");
		// A duplicate job inside the backoff does not retry early.
		expect(await deliverOutboxItem(deps, outboxId)).toBe("not_due");
		now = new Date(now.getTime() + 10_000);
		expect(await deliverOutboxItem(deps, outboxId)).toBe("sent");
		expect(await deliverOutboxItem(deps, outboxId)).toBe("skipped");
		// Two attempts with the same idempotency key, none after the item was sent.
		expect(deliverer.calls).toEqual([key, key]);
		const [row] = await query<{ status: string; attempts: number }>(
			"select status, attempts from outbox where id = $1",
			[outboxId],
		);
		expect(row).toEqual({ status: "sent", attempts: 2 });

		// A delivery that died holding its lease becomes deliverable again after the lease.
		const stuckKey = `test:${randomUUID()}`;
		const stuckId = await insertAlert(stuckKey, now);
		await gateway.pool.query(
			"update outbox set status = 'sending', locked_until = $2 where id = $1",
			[stuckId, new Date(now.getTime() + 30_000)],
		);
		expect(await deliverOutboxItem(deps, stuckId)).toBe("skipped");
		now = new Date(now.getTime() + 60_000);
		const sent: string[] = [];
		expect(
			await reconcileOutbox(deps, () => ({
				send: async (_queue, data) => {
					sent.push(String(data.outboxId));
					return "job";
				},
			})),
		).toBeGreaterThanOrEqual(1);
		expect(sent).toContain(stuckId);
		expect(await deliverOutboxItem(deps, stuckId)).toBe("sent");
	});

	it("fences a late delivery after its lease was taken over", async () => {
		let now = new Date();
		let releaseA = () => {};
		const blockedA = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		let claimedA = () => {};
		const aStarted = new Promise<void>((resolve) => {
			claimedA = resolve;
		});
		const slow: Deliverer = {
			deliver: async () => {
				claimedA();
				await blockedA;
				throw new DeliveryError("A failed late", false);
			},
		};
		const fast: Deliverer = { deliver: async (item) => ({ by: "B", key: item.idempotencyKey }) };
		const base = { pool: gateway.pool, clock: () => now, log: silentLogger, leaseSeconds: 30 };
		const id = await insertAlert(`test:${randomUUID()}`, now);

		const a = deliverOutboxItem({ ...base, deliverers: { "mattermost.alert": slow } }, id);
		await aStarted;
		now = new Date(now.getTime() + 60_000);
		expect(await deliverOutboxItem({ ...base, deliverers: { "mattermost.alert": fast } }, id)).toBe(
			"sent",
		);
		releaseA();
		// A's late permanent failure changes nothing and leaves no false audit record; a late
		// success of a taken-over claim is not recorded either (checked below).
		expect(await a).toBe("skipped");
		expect(
			await query("select 1 from audit_log where action = 'outbox.dead' and subject_id = $1", [id]),
		).toEqual([]);

		const [row] = await query<{ status: string; attempts: number; receipt: JsonValue }>(
			"select status, attempts, receipt from outbox where id = $1",
			[id],
		);
		expect(row).toMatchObject({ status: "sent", attempts: 2, receipt: { by: "B" } });
	});

	it("does not record a late success after its lease was taken over", async () => {
		let now = new Date();
		let release = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = () => {};
		const claimed = new Promise<void>((resolve) => {
			started = resolve;
		});
		const slow: Deliverer = {
			deliver: async () => {
				started();
				await blocked;
				return { by: "A" };
			},
		};
		const fast: Deliverer = { deliver: async () => ({ by: "B" }) };
		const base = { pool: gateway.pool, clock: () => now, log: silentLogger, leaseSeconds: 30 };
		const id = await insertAlert(`test:${randomUUID()}`, now);
		const a = deliverOutboxItem({ ...base, deliverers: { "mattermost.alert": slow } }, id);
		await claimed;
		now = new Date(now.getTime() + 60_000);
		expect(await deliverOutboxItem({ ...base, deliverers: { "mattermost.alert": fast } }, id)).toBe(
			"sent",
		);
		release();
		expect(await a).toBe("skipped");
		const [row] = await query<{ receipt: JsonValue }>("select receipt from outbox where id = $1", [
			id,
		]);
		expect(row?.receipt).toEqual({ by: "B" });
	});

	it("posts through loopback once, even when the delivery repeats", async () => {
		const deliverer = loopbackPostDeliverer(gateway.deps());
		const item = {
			id: randomUUID(),
			kind: "mattermost.post" as const,
			destination: `channel/${IDS.channel("hq")}`,
			idempotencyKey: `mattermost-post:${randomUUID()}:0`,
			attempt: 1,
			createdAt: new Date(),
			payload: {
				agentId: "finance",
				runId: randomUUID(),
				channelId: IDS.channel("hq"),
				rootPostId: null,
				message: "status update",
				targetAgentIds: [],
				attachmentArtifactIds: [],
				correlationId: `test:${randomUUID()}`,
				hop: 1,
			},
		};
		const first = await deliverer.deliver(item);
		const second = await deliverer.deliver({ ...item, attempt: 2 });
		expect(first).toMatchObject({ ingest: "accepted" });
		expect(second).toMatchObject({ ingest: "duplicate" });
		const events = await query("select 1 from events where correlation_id = $1", [
			item.payload.correlationId,
		]);
		expect(events).toHaveLength(1);
	});

	it("cancels a run in progress on pause and keeps its inbox", async () => {
		await idle("developer");
		const event = humanPost("@developer take forever [mock:slow]", ["developer"]);
		await ingestEvent(gateway.deps(), event);
		await eventually(async () => (await agentState("developer")) === "running", 30_000, "running");
		await pauseAgent(gateway.deps(), "developer", "test");
		const [run] = await runsFor(event.id);
		expect(run).toMatchObject({ status: "cancelled", error_code: "cancelled" });
		const inbox = await query<{ status: string; run_id: string | null }>(
			"select i.status, i.run_id from agent_inbox i join events e on e.id = i.event_id where e.external_id = $1",
			[event.id],
		);
		expect(inbox).toEqual([{ status: "pending", run_id: null }]);
		expect(await agentState("developer")).toBe("paused");
	});

	it("keeps a config apply from revoking a post that is already authorized", async () => {
		const deps = gateway.deps();
		await setDirectoryEntry(deps, "team", "autonomous-lab", IDS.channel("team"), "test");
		const config = exampleConfig();
		const revoked = {
			...config,
			agents: config.agents.map((agent) =>
				agent.id === "developer"
					? { ...agent, mattermost: { ...agent.mattermost, allowed_channels: ["engineering"] } }
					: agent,
			),
		};
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let posting = false;
		const post = whileAgentMayPost(deps, "developer", IDS.channel("hq"), async () => {
			posting = true;
			await gate;
			return "posted";
		});
		await eventually(async () => posting, 10_000, "post authorized");
		let applied = false;
		const apply = applyConfig(deps, revoked, "test").then(() => {
			applied = true;
		});
		await Bun.sleep(500);
		expect(applied).toBe(false);
		release();
		expect(await post).toEqual({ allowed: true, value: "posted" });
		await apply;
		expect(
			await whileAgentMayPost(deps, "developer", IDS.channel("hq"), async () => "posted"),
		).toEqual({ allowed: false });
		await applyConfig(deps, config, "test");
	});

	it("manages no Mattermost channel until the configured team is resolved", async () => {
		const deps = gateway.deps();
		await deleteDirectoryEntry(deps, "team", "autonomous-lab", IDS.channel("team"), "test");
		const before = await loadMattermostSnapshot(deps);
		expect(before?.channels.size).toBe(0);
		await setDirectoryEntry(deps, "team", "autonomous-lab", IDS.channel("team"), "test");
		const after = await loadMattermostSnapshot(deps);
		expect(after?.channels.get(IDS.channel("hq"))).toBe("hq");
	});

	it("restarts every channel's catch-up when the configuration moves to another team", async () => {
		const deps = gateway.deps();
		await gateway.pool.query(
			"insert into source_cursors (source_id, cursor_type, cursor_value) values ($1, 'update_at_ms', '1'), ($2, 'create_at_ms', '1')",
			[`mattermost:channel:${IDS.channel("hq")}`, `mattermost:channel-floor:${IDS.channel("hq")}`],
		);
		const config = exampleConfig();
		await applyConfig(
			deps,
			{
				...config,
				organization: {
					...config.organization,
					mattermost: { ...config.organization.mattermost, team: "another-team" },
				},
			},
			"test",
		);
		expect(
			await query(
				"select source_id from source_cursors where source_id like 'mattermost:channel%'",
			),
		).toEqual([]);
		await applyConfig(deps, config, "test");
	});

	it("forgets a channel's catch-up when the configuration drops the channel", async () => {
		const deps = gateway.deps();
		await gateway.pool.query(
			"insert into source_cursors (source_id, cursor_type, cursor_value) values ($1, 'update_at_ms', '1'), ($2, 'update_at_ms', '1')",
			[`mattermost:channel:${IDS.channel("mail")}`, `mattermost:channel:${IDS.channel("hq")}`],
		);
		const config = exampleConfig();
		await applyConfig(
			deps,
			{
				...config,
				organization: {
					...config.organization,
					mattermost: {
						...config.organization.mattermost,
						channels: config.organization.mattermost.channels.filter((name) => name !== "mail"),
					},
				},
				agents: config.agents.map((agent) => ({
					...agent,
					mattermost: {
						...agent.mattermost,
						allowed_channels: agent.mattermost.allowed_channels.filter((name) => name !== "mail"),
					},
				})),
			},
			"test",
		);
		expect(
			await query(
				"select source_id from source_cursors where source_id ~ '^mattermost:channel(-floor|-floor-posts)?:'",
			),
		).toEqual([{ source_id: `mattermost:channel:${IDS.channel("hq")}` }]);
		await applyConfig(deps, config, "test");
	});

	it("admits a new post only after its channel's current start", async () => {
		const deps = gateway.deps();
		const channelId = IDS.channel("hq");
		const post = humanPost("an ambient note", []);
		const postId = String(post.data.post_id);
		const admit = (createAt: number) => afterChannelStart(channelId, postId, createAt);
		await gateway.pool.query(
			"delete from source_cursors where source_id like 'mattermost:channel%'",
		);
		expect(await ingestEventIf(deps, post, admit(5000))).toBeNull();
		await gateway.pool.query(
			"insert into source_cursors (source_id, cursor_type, cursor_value) values ($1, 'create_at_ms', '1000'), ($2, 'post_ids', $3)",
			[
				`mattermost:channel-floor:${channelId}`,
				`mattermost:channel-floor-posts:${channelId}`,
				postId,
			],
		);
		expect(await ingestEventIf(deps, post, admit(999))).toBeNull();
		expect(await ingestEventIf(deps, post, admit(1000))).toBeNull();
		// A channel that is not managed now admits nothing, whatever start it still has.
		const stray = "strayc0000000000000000000a";
		await gateway.pool.query(
			"insert into source_cursors (source_id, cursor_type, cursor_value) values ($1, 'create_at_ms', '1')",
			[`mattermost:channel-floor:${stray}`],
		);
		expect(await ingestEventIf(deps, post, afterChannelStart(stray, postId, 5000))).toBeNull();
		expect((await ingestEventIf(deps, post, admit(1001)))?.status).toBe("accepted");
		await gateway.pool.query(
			"delete from source_cursors where source_id like 'mattermost:channel%'",
		);
	});

	it("keeps channel starts staged for a team that is not recorded yet", async () => {
		const deps = gateway.deps();
		await deleteDirectoryEntry(deps, "team", "autonomous-lab", IDS.channel("team"), "test");
		await gateway.pool.query(
			"insert into source_cursors (source_id, cursor_type, cursor_value) values ($1, 'update_at_ms', '1') on conflict do nothing",
			[`mattermost:channel:${IDS.channel("hq")}`],
		);
		await deleteUnmanagedChannelCursors(deps);
		expect(
			await query("select 1 from source_cursors where source_id = $1", [
				`mattermost:channel:${IDS.channel("hq")}`,
			]),
		).toHaveLength(1);
		await setDirectoryEntry(deps, "team", "autonomous-lab", IDS.channel("team"), "test");
		await gateway.pool.query(
			"delete from source_cursors where source_id like 'mattermost:channel%'",
		);
	});

	it("installs no channel start scanned before the channel left the configuration", async () => {
		const deps = gateway.deps();
		const store = mattermostBootstrapStore(deps, "test");
		const start = { cursor: 5, floor: 5, floorPostIds: [] };
		const mail = { name: "mail", id: IDS.channel("mail"), start };
		const team = { name: "autonomous-lab", id: IDS.channel("team") };
		const count = async () =>
			(
				await query(
					"select 1 from source_cursors where source_id ~ '^mattermost:channel(-floor|-floor-posts)?:'",
				)
			).length;
		await gateway.pool.query(
			"delete from source_cursors where source_id like 'mattermost:channel%'",
		);
		const config = exampleConfig();
		// Re-applying the same configuration leaves a scan valid.
		const scanned = await loadConfigGeneration(deps);
		await applyConfig(deps, config, "test");
		expect(await startManagedChannel(deps, mail.id, start, scanned)).toBe(true);
		await gateway.pool.query(
			"delete from source_cursors where source_id ~ '^mattermost:channel(-floor|-floor-posts)?:'",
		);
		// Dropping and re-adding the channel voids a scan made before.
		const before = await loadConfigGeneration(deps);
		const withoutMail = {
			...config,
			organization: {
				...config.organization,
				mattermost: {
					...config.organization.mattermost,
					channels: config.organization.mattermost.channels.filter((name) => name !== "mail"),
				},
			},
			agents: config.agents.map((agent) => ({
				...agent,
				mattermost: {
					...agent.mattermost,
					allowed_channels: agent.mattermost.allowed_channels.filter((name) => name !== "mail"),
				},
			})),
		};
		await applyConfig(deps, withoutMail, "test");
		await applyConfig(deps, config, "test");
		expect(await startManagedChannel(deps, mail.id, start, before)).toBe(false);
		expect(await store.publishTeam(team, [mail], before)).toBe(false);
		expect(await count()).toBe(0);
		expect(await store.publishTeam(team, [mail], await loadConfigGeneration(deps))).toBe(true);
		expect(await count()).toBe(3);
		await gateway.pool.query(
			"delete from source_cursors where source_id like 'mattermost:channel%'",
		);
	});

	it("serializes concurrent config applies, each one generation", async () => {
		const deps = gateway.deps();
		const before = await loadConfigGeneration(deps);
		await Promise.all([
			applyConfig(deps, exampleConfig(), "test"),
			applyConfig(deps, exampleConfig(), "test"),
		]);
		expect(await loadConfigGeneration(deps)).toBe(before + 2);
	});
});
