import {
	DEFAULT_MEMORY_BUDGET,
	DEFAULT_THREAD_BUDGET,
	MAX_SUMMARY_CHARS,
} from "@agent-gateway/context";
import {
	type DailyBudget,
	type GatewayEventType,
	GatewayEventTypeSchema,
	type RuntimeAdapterId,
	SYSTEM_STATUS_LIMITS,
	type SystemStatus,
	type SystemStatusAgent,
	type SystemStatusLastRun,
	type SystemStatusRun,
	SystemStatusSchema,
} from "@agent-gateway/contracts";
import type { Transaction } from "@agent-gateway/db";
import { utcDay } from "@agent-gateway/policy";
import { MAX_TURN_INPUT_BYTES } from "../turn-context.ts";
import { parseThreadRef } from "./context-store.ts";

// ---------------------------------------------------------------------------
// Read models of the Gateway's own operation (ADR-023): `loadSystemStatus` is the operational
// metadata an observing agent gets in its turn; `loadConsoleStatus` adds what the owner's
// console shows on top (tasks, context measurements, recent runs). Both only read, and both
// bound every query to the agents they actually display: never more than
// `SYSTEM_STATUS_LIMITS.agents` rows deep, whatever the Gateway's real size.
//
// Content boundary (ADR-023): neither model ever carries message bodies, run summaries
// reproduced verbatim, wait conditions or credentials. `loadSystemStatus` re-validates its
// result against `SystemStatusSchema` before returning it, so a field that slipped past review
// fails loudly instead of silently reaching a turn.
// ---------------------------------------------------------------------------

type Client = Transaction["client"];

const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value === null ? null : value.toISOString());
/** A Gateway-made array literal for `= any($1::text[])` / `= any($1::uuid[])`; ids and uuids
 * never contain ',' or '{}' (see `AgentIdSchema`, `UuidSchema`), so no escaping is needed. */
const idList = (ids: Readonly<string[]>) => `{${ids.join(",")}}`;
const triggerType = (value: string): GatewayEventType => GatewayEventTypeSchema.parse(value);

/** Per agent, active runs shown, in the system status and the console alike: matches
 * `SystemStatusAgentSchema.activeRuns`'s own cap. */
const ACTIVE_RUNS_SHOWN = 8;

type AgentRow = Readonly<{
	id: string;
	display_name: string;
	state: string;
	enabled: boolean;
	runtime_adapter: RuntimeAdapterId;
	model: string | null;
	state_changed_at: Date;
}>;

type ActiveRunRow = Readonly<{
	id: string;
	agent_id: string;
	status: string;
	attempt: number;
	max_attempts: number;
	trigger_type: string;
	queued_at: Date;
	started_at: Date | null;
	timeout_at: Date;
}>;

type LastRunRow = Readonly<{
	id: string;
	agent_id: string;
	status: string;
	outcome: string | null;
	error_code: string | null;
	finished_at: Date | null;
	input_tokens: number | null;
	output_tokens: number | null;
}>;

type CountRow = Readonly<{ agent_id: string; n: number; next: Date | null }>;
type UsageRow = Readonly<{ agent_id: string; tokens: number; cost: number }>;

async function rows<T extends object>(
	client: Client,
	text: string,
	params: Readonly<(string | number)[]> = [],
): Promise<Readonly<T[]>> {
	return (await client.query<T>(text, [...params])).rows;
}

function byAgent<T extends Readonly<{ agent_id: string }>>(list: Readonly<T[]>) {
	const map = new Map<string, T[]>();
	for (const row of list) {
		map.set(row.agent_id, [...(map.get(row.agent_id) ?? []), row]);
	}
	return map;
}

function activeRun(row: ActiveRunRow): SystemStatusRun {
	return {
		runId: row.id,
		status: row.status,
		attempt: row.attempt,
		maxAttempts: row.max_attempts,
		triggerType: triggerType(row.trigger_type),
		queuedAt: iso(row.queued_at),
		startedAt: isoOrNull(row.started_at),
	};
}

function lastRun(row: LastRunRow): SystemStatusLastRun {
	return {
		runId: row.id,
		status: row.status,
		outcome: row.outcome,
		errorCode: row.error_code,
		finishedAt: isoOrNull(row.finished_at),
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
	};
}

/** `(usage->>'x')` as a non-negative integer, or null when absent or not a count. */
const usageCount = (field: string) =>
	`case when jsonb_typeof(r.usage->'${field}') = 'number'
	      then greatest((r.usage->>'${field}')::numeric, 0)::float8 end`;

type Loaded = Readonly<{
	agentIds: Readonly<string[]>;
	agents: Readonly<AgentRow[]>;
	active: Map<string, ActiveRunRow[]>;
	last: Map<string, LastRunRow[]>;
	status: SystemStatus;
}>;

async function load(client: Client, now: Date): Promise<Loaded> {
	const agents = await rows<AgentRow>(
		client,
		`select id, display_name, state, enabled, runtime_adapter,
		        config->'runtime'->>'model' as model, state_changed_at
		   from agents order by id limit $1`,
		[SYSTEM_STATUS_LIMITS.agents],
	);
	const [{ n: totalAgents } = { n: 0 }] = await rows<Readonly<{ n: number }>>(
		client,
		"select count(*)::int as n from agents",
	);
	const omittedAgents = Math.max(totalAgents - agents.length, 0);
	const agentIds = agents.map((a) => a.id);
	const ids = idList(agentIds);

	// Bounded to the selected agents, and to `ACTIVE_RUNS_SHOWN` per agent in SQL (a window
	// function, not a slice after fetching every row): an agent's active runs never grow past
	// `max_active_runs`, but the query stays correct if that ever changes.
	const active = byAgent(
		await rows<ActiveRunRow>(
			client,
			`select id, agent_id, status, attempt, max_attempts, trigger_type, queued_at, started_at, timeout_at
			   from (
			     select r.id, r.agent_id, r.status, r.attempt, r.max_attempts, e.type as trigger_type,
			            r.queued_at, r.started_at, r.timeout_at,
			            row_number() over (partition by r.agent_id order by r.queued_at, r.id) as rn
			       from agent_runs r join events e on e.id = r.trigger_event_id
			      where r.status in ('queued', 'running') and r.agent_id = any($1::text[])
			   ) ranked
			  where rn <= $2
			  order by agent_id, queued_at, id`,
			[ids, ACTIVE_RUNS_SHOWN],
		),
	);
	// One row per selected agent: its most recent run that is no longer active (a run's own
	// trigger type is never needed here, only in `active`, so no join to `events`).
	const last = byAgent(
		await rows<LastRunRow>(
			client,
			`select sel.agent_id, r.id, r.status, r.outcome, r.error_code, r.finished_at,
			        ${usageCount("inputTokens")} as input_tokens,
			        ${usageCount("outputTokens")} as output_tokens
			   from unnest($1::text[]) as sel(agent_id)
			   cross join lateral (
			        select * from agent_runs
			         where agent_id = sel.agent_id and status not in ('queued', 'running')
			         order by queued_at desc, id desc limit 1) r
			  order by sel.agent_id`,
			[ids],
		),
	);
	const waits = byAgent(
		await rows<CountRow>(
			client,
			`select agent_id, count(*)::int as n, min(timeout_at) as next from wait_subscriptions
			  where status = 'active' and agent_id = any($1::text[])
			  group by agent_id order by agent_id`,
			[ids],
		),
	);
	const inbox = byAgent(
		await rows<CountRow>(
			client,
			`select agent_id, count(*)::int as n, null::timestamptz as next from agent_inbox
			  where status = 'pending' and agent_id = any($1::text[])
			  group by agent_id order by agent_id`,
			[ids],
		),
	);
	const usage = byAgent(
		await rows<UsageRow>(
			client,
			`select agent_id, coalesce(sum(tokens), 0)::float8 as tokens,
			        coalesce(sum(cost_usd), 0)::float8 as cost
			   from run_usage where day = $1 and agent_id = any($2::text[])
			  group by agent_id order by agent_id`,
			[utcDay(now), ids],
		),
	);

	const statusAgents: SystemStatusAgent[] = agents.map((agent) => {
		const wait = waits.get(agent.id)?.[0];
		const booked = usage.get(agent.id)?.[0];
		const latest = last.get(agent.id)?.[0];
		return {
			agentId: agent.id,
			state: agent.state,
			enabled: agent.enabled,
			stateSince: iso(agent.state_changed_at),
			runtimeAdapter: agent.runtime_adapter,
			model: agent.model,
			activeRuns: (active.get(agent.id) ?? []).map(activeRun),
			lastRun: latest === undefined ? null : lastRun(latest),
			activeWaits: wait?.n ?? 0,
			nextWaitTimeoutAt: isoOrNull(wait?.next ?? null),
			pendingInbox: inbox.get(agent.id)?.[0]?.n ?? 0,
			tokensToday: Math.round(booked?.tokens ?? 0),
			costTodayUsd: booked?.cost ?? 0,
		};
	});

	const runtimes = await rows<
		Readonly<{ adapter: RuntimeAdapterId; available: boolean; versions: string[]; changed: Date }>
	>(
		client,
		`select adapter, available, runtime_versions as versions, changed_at as changed
		   from runtime_availability order by adapter limit $1`,
		[SYSTEM_STATUS_LIMITS.runtimes],
	);
	// Due jobs only: jobs scheduled for later (timeouts, backoffs) are no backlog. `now` is the
	// injected clock, never the database's own: a caller measuring against a fixed moment (a
	// test, a replay) gets that moment's answer, not the wall clock's.
	const queues = await rows<
		Readonly<{ queue: string; waiting: number; active: number; oldest: number | null }>
	>(
		client,
		`select name as queue,
		        count(*) filter (where state in ('created', 'retry') and start_after <= $1::timestamptz)::int as waiting,
		        count(*) filter (where state = 'active')::int as active,
		        extract(epoch from ($1::timestamptz - min(start_after)
		          filter (where state in ('created', 'retry') and start_after <= $1::timestamptz)))::float8 as oldest
		   from pgboss.job where state in ('created', 'retry', 'active')
		  group by name
		 having count(*) filter (where state = 'active' or start_after <= $1::timestamptz) > 0
		  order by name limit $2`,
		[now.toISOString(), SYSTEM_STATUS_LIMITS.queues],
	);
	const [outbox = { pending: 0, dead: 0 }] = await rows<
		Readonly<{ pending: number; dead: number }>
	>(
		client,
		`select count(*) filter (where status in ('pending', 'sending'))::int as pending,
		        count(*) filter (where status = 'dead' and content_expired_at is null)::int as dead
		   from outbox where status <> 'sent'`,
	);
	const [counts = { approvals: 0, unknown: 0, kill: false }] = await rows<
		Readonly<{ approvals: number; unknown: number; kill: boolean }>
	>(
		client,
		`select (select count(*) from approval_requests where status = 'pending')::int as approvals,
		        (select count(*) from tool_actions where status = 'unknown')::int as unknown,
		        coalesce((select kill_switch from gateway_controls where id = 1), false) as kill`,
	);
	const alerts = await rows<Readonly<{ key: string; fired_at: Date }>>(
		client,
		`select key, fired_at from alert_states where state = 'firing'
		  order by fired_at, key limit $1`,
		[SYSTEM_STATUS_LIMITS.alerts],
	);
	const maintenance = await rows<Readonly<{ task: string; last_success_at: Date | null }>>(
		client,
		"select task, last_success_at from maintenance_status order by task limit $1",
		[SYSTEM_STATUS_LIMITS.maintenance],
	);

	return {
		agentIds,
		agents,
		active,
		last,
		status: {
			asOf: iso(now),
			killSwitch: counts.kill,
			agents: statusAgents,
			omittedAgents,
			runtimes: runtimes.map((row) => ({
				adapter: row.adapter,
				available: row.available,
				versions: row.versions.slice(0, 8),
				changedAt: iso(row.changed),
			})),
			queues: queues.map((row) => ({
				queue: row.queue,
				waiting: row.waiting,
				active: row.active,
				oldestWaitingSeconds: row.oldest === null ? null : Math.max(0, Math.round(row.oldest)),
			})),
			outbox,
			approvalsPending: counts.approvals,
			toolActionsUnknown: counts.unknown,
			alerts: alerts.map((row) => ({ key: row.key, firedAt: iso(row.fired_at) })),
			maintenance: maintenance.map((row) => ({
				task: row.task,
				lastSuccessAt: isoOrNull(row.last_success_at),
			})),
		},
	};
}

/**
 * The Gateway's operational metadata as an observing agent sees it (ADR-023): states, ids,
 * counts, timestamps and codes, never message text. Reads only. Validated against
 * `SystemStatusSchema` before it returns, so the content boundary is enforced twice: by every
 * field's own type, and by this final parse.
 */
export async function loadSystemStatus(tx: Transaction, now: Date): Promise<SystemStatus> {
	return SystemStatusSchema.parse((await load(tx.client, now)).status);
}

// ---------------------------------------------------------------------------
// The owner's console
// ---------------------------------------------------------------------------

/** What a run was started by, as the owner reads it. Never the triggering post's own text: a
 * message body is exactly what ADR-023 keeps off the console, so only ids, refs and codes are
 * shown here, the same boundary `SystemStatus` itself keeps. */
export type ConsoleTask = Readonly<{
	runId: string;
	status: string;
	attempt: number;
	maxAttempts: number;
	queuedAt: string;
	startedAt: string | null;
	deadlineAt: string;
	triggerType: GatewayEventType;
	/** The channel's configured or granted name; null outside Mattermost or when unresolved. */
	channel: string | null;
	/** The thread's root post, from the run's own snapshot (`context_snapshots.thread_ref`): this
	 * covers a timeout or wait-resumption turn, whose triggering event carries no post of its
	 * own, as well as an ordinary one. Null for a run outside any thread. */
	threadRootId: string | null;
}>;

/**
 * What the Gateway handed the runtime in a run, measured separately (ADR-023): the Gateway's
 * own budgets in characters and bytes, and the tokens the runtime reported. The model's context
 * window is not known to the Gateway, so no fill percentage is derived from them.
 *
 * Character counts are computed in JavaScript (`String.prototype.length`, UTF-16 code units) on
 * the already-budget-bounded text a snapshot holds, then discarded: only the counts leave this
 * module, never the text. PostgreSQL's own `length()` counts Unicode code points, which
 * undercounts anything outside the Basic Multilingual Plane (most emoji) relative to the
 * budgets themselves (`@agent-gateway/context`), so it is never used for this measurement.
 */
export type ConsoleContext = Readonly<{
	runId: string;
	inputBytes: number;
	inputLimitBytes: number;
	/** The thread's root post (or the trigger, when it is the root), within its own per-post cap. */
	rootChars: number;
	rootLimitChars: number;
	threadPosts: number;
	omittedPosts: number;
	/** The newest replies within the thread's own recent-replies budget, distinct from the root's
	 * and the summary's own limits below. */
	recentRepliesChars: number;
	recentRepliesLimitChars: number;
	summaryChars: number;
	summaryLimitChars: number;
	memoryItems: number;
	memoryChars: number;
	memoryLimitChars: number;
	pendingEvents: number;
	/** Reported by the runtime for the run's last attempt; null when it reported none. */
	inputTokens: number | null;
	cachedInputTokens: number | null;
	outputTokens: number | null;
	model: string | null;
}>;

export type ConsoleWait = Readonly<{ eventType: string; timeoutAt: string }>;

export type ConsoleAgent = Readonly<{
	status: SystemStatusAgent;
	displayName: string;
	/** The queued or running run's task; null while the agent has none. */
	current: ConsoleTask | null;
	waits: Readonly<ConsoleWait[]>;
	/** Of the current run, else of the latest one; null once its snapshot has expired under
	 * retention (`context_snapshots` keeps a finished run's content for a bounded time only). */
	context: ConsoleContext | null;
	/**
	 * The largest input tokens a single run's *last stored attempt* reported in the last 7 days,
	 * read from `agent_runs.usage` (which keeps only the most recent attempt of each run, not a
	 * sum over `run_usage`'s full per-attempt ledger).
	 */
	maxInputTokens7d: number | null;
	session: Readonly<{ lastUsedAt: string; expiresAt: string | null }> | null;
	budget: DailyBudget | null;
}>;

export type ConsoleRun = Readonly<{
	runId: string;
	agentId: string;
	status: string;
	outcome: string | null;
	errorCode: string | null;
	triggerType: GatewayEventType;
	queuedAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
}>;

/** The alert's own message: already sent to the owner's alerts channel (ADR-023 shows alerts on
 * the console too), never a run's or a channel's content. */
export type ConsoleAlert = Readonly<{ key: string; message: string; firedAt: string }>;

export type ConsoleStatus = Readonly<{
	system: SystemStatus;
	agents: Readonly<ConsoleAgent[]>;
	recentRuns: Readonly<ConsoleRun[]>;
	alerts: Readonly<ConsoleAlert[]>;
}>;

const RECENT_RUNS = 25;
const WAITS_SHOWN = 5;

/** Only the parts of a stored `AgentTurnInput` this module measures; never read beyond them. */
type SnapshotThreadContext = Readonly<{
	rootPost: Readonly<{ message: string }> | null;
	recentPosts: Readonly<Readonly<{ message: string }>[]>;
	summary: string | null;
	omittedPostCount: number;
}>;
type SnapshotMemoryItem = Readonly<{ content: string }>;

type SnapshotRow = Readonly<{
	run_id: string;
	size_bytes: number;
	/** `channel/<id>/thread/<id>`, as `formatThreadRef` writes it; null outside a thread. */
	thread_ref: string | null;
	thread_context: SnapshotThreadContext | null;
	memories: Readonly<SnapshotMemoryItem[]>;
	pending_events: number;
}>;

/** Fetches the budget-bounded parts of a run's stored turn input that `measureContext` counts. */
async function snapshots(
	client: Client,
	runIds: Readonly<string[]>,
): Promise<Map<string, SnapshotRow>> {
	if (runIds.length === 0) {
		return new Map();
	}
	const found = await rows<SnapshotRow>(
		client,
		`select s.run_id, s.size_bytes, s.thread_ref,
		        s.input->'threadContext' as thread_context,
		        coalesce(s.input->'memories', '[]'::jsonb) as memories,
		        jsonb_array_length(coalesce(s.input->'pendingInbox', '[]'::jsonb))::int as pending_events
		   from context_snapshots s where s.run_id = any($1::uuid[])`,
		[idList(runIds)],
	);
	return new Map(found.map((row) => [row.run_id, row]));
}

type RunUsageRow = Readonly<{
	id: string;
	input_tokens: number | null;
	cached_tokens: number | null;
	output_tokens: number | null;
	model: string | null;
}>;

/** The console's own measurement of a run's context, or null while it has none (no run yet, or
 * its snapshot already expired under retention). Reads only the counts out of the snapshot's
 * JSON, in JavaScript UTF-16 units; see `ConsoleContext`. */
function measureContext(
	runId: string | undefined,
	snapshot: SnapshotRow | undefined,
	usage: RunUsageRow | undefined,
	agentModel: string | null,
): ConsoleContext | null {
	if (runId === undefined || snapshot === undefined) {
		return null;
	}
	const thread = snapshot.thread_context;
	const recentPosts = thread?.recentPosts ?? [];
	return {
		runId,
		inputBytes: snapshot.size_bytes,
		inputLimitBytes: MAX_TURN_INPUT_BYTES,
		rootChars: thread?.rootPost?.message.length ?? 0,
		rootLimitChars: DEFAULT_THREAD_BUDGET.maxPostChars,
		threadPosts: recentPosts.length,
		omittedPosts: thread?.omittedPostCount ?? 0,
		recentRepliesChars: recentPosts.reduce((sum, post) => sum + post.message.length, 0),
		recentRepliesLimitChars: DEFAULT_THREAD_BUDGET.maxChars,
		summaryChars: thread?.summary?.length ?? 0,
		summaryLimitChars: MAX_SUMMARY_CHARS,
		memoryItems: snapshot.memories.length,
		memoryChars: snapshot.memories.reduce((sum, item) => sum + item.content.length, 0),
		memoryLimitChars: DEFAULT_MEMORY_BUDGET.maxChars,
		pendingEvents: snapshot.pending_events,
		inputTokens: usage?.input_tokens ?? null,
		cachedInputTokens: usage?.cached_tokens ?? null,
		outputTokens: usage?.output_tokens ?? null,
		model: usage?.model ?? agentModel,
	};
}

/**
 * Every channel name the console may need to show: channels bootstrap resolved from
 * configuration, and channels an owner or system admin granted directly
 * (`mattermost_channel_grants`), which never appear in the resolved directory. The directory's
 * own name wins when a channel is somehow in both (it is refreshed at resolution; a grant's name
 * is only as fresh as its last check).
 */
async function channelNames(client: Client): Promise<Map<string, string>> {
	const found = await rows<Readonly<{ id: string; name: string }>>(
		client,
		`select distinct on (id) id, name from (
		   select mattermost_id as id, name, 0 as pri from mattermost_directory where kind = 'channel'
		   union all
		   select channel_id as id, channel_name as name, 1 as pri from mattermost_channel_grants
		 ) c
		 order by id, pri, name`,
	);
	return new Map(found.map((row) => [row.id, row.name]));
}

/**
 * Everything the owner's console shows: the system status plus tasks, context measurements and
 * recent runs. For the owner only; never handed to an agent. Reads only.
 */
export async function loadConsoleStatus(
	tx: Transaction,
	now: Date,
	budgets: Readonly<{ perAgent: DailyBudget | null }>,
): Promise<ConsoleStatus> {
	const { client } = tx;
	const loaded = await load(client, now);
	const ids = idList(loaded.agentIds);
	const channels = await channelNames(client);
	const focus = new Map<string, string>();
	for (const agent of loaded.agents) {
		const run = loaded.active.get(agent.id)?.[0] ?? loaded.last.get(agent.id)?.[0];
		if (run !== undefined) {
			focus.set(agent.id, run.id);
		}
	}
	const focusRunIds = [...focus.values()];
	const measured = await snapshots(client, focusRunIds);
	const runDetails = new Map(
		(
			await rows<RunUsageRow>(
				client,
				`select r.id, ${usageCount("inputTokens")} as input_tokens,
				        ${usageCount("cachedInputTokens")} as cached_tokens,
				        ${usageCount("outputTokens")} as output_tokens,
				        coalesce(r.usage->>'model', r.model) as model
				   from agent_runs r where r.id = any($1::uuid[])`,
				[idList(focusRunIds)],
			)
		).map((row) => [row.id, row]),
	);
	const waits = byAgent(
		await rows<Readonly<{ agent_id: string; event_type: string; timeout_at: Date }>>(
			client,
			`select agent_id, event_type, timeout_at from (
			        select agent_id, event_type, timeout_at,
			               row_number() over (partition by agent_id order by timeout_at, id) as n
			          from wait_subscriptions where status = 'active' and agent_id = any($1::text[])) w
			  where n <= $2
			  order by agent_id, timeout_at`,
			[ids, WAITS_SHOWN],
		),
	);
	// The largest of `agent_runs.usage` over runs queued in the last 7 days; see `maxInputTokens7d`.
	const maxInput = byAgent(
		await rows<Readonly<{ agent_id: string; max: number | null }>>(
			client,
			`select r.agent_id, max(${usageCount("inputTokens")}) as max
			   from agent_runs r
			  where r.agent_id = any($1::text[]) and r.queued_at > $2::timestamptz
			  group by r.agent_id order by r.agent_id`,
			[ids, new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString()],
		),
	);
	const sessions = byAgent(
		await rows<
			Readonly<{ agent_id: string; last_used_at: Date; expires_at: Date | null; adapter: string }>
		>(
			client,
			`select s.agent_id, s.last_used_at, s.expires_at, s.adapter from runtime_sessions s
			   join agents a on a.id = s.agent_id and a.runtime_adapter = s.adapter
			  where a.id = any($1::text[]) and s.status = 'active'
			    and (s.expires_at is null or s.expires_at > $2::timestamptz)
			  order by s.agent_id`,
			[ids, now.toISOString()],
		),
	);

	const task = (run: ActiveRunRow): ConsoleTask => {
		const threadRef = parseThreadRef(measured.get(run.id)?.thread_ref ?? null);
		return {
			runId: run.id,
			status: run.status,
			attempt: run.attempt,
			maxAttempts: run.max_attempts,
			queuedAt: iso(run.queued_at),
			startedAt: isoOrNull(run.started_at),
			deadlineAt: iso(run.timeout_at),
			triggerType: triggerType(run.trigger_type),
			channel: threadRef === null ? null : (channels.get(threadRef.channelId) ?? null),
			threadRootId: threadRef?.rootPostId ?? null,
		};
	};

	const consoleAgents: ConsoleAgent[] = loaded.agents.map((agent, index) => {
		const status = loaded.status.agents[index];
		if (status === undefined || status.agentId !== agent.id) {
			throw new Error(`system status lost agent '${agent.id}'`);
		}
		const current = loaded.active.get(agent.id)?.[0];
		const runId = focus.get(agent.id);
		const session = sessions.get(agent.id)?.[0];
		return {
			status,
			displayName: agent.display_name,
			current: current === undefined ? null : task(current),
			waits: (waits.get(agent.id) ?? []).map((wait) => ({
				eventType: wait.event_type,
				timeoutAt: iso(wait.timeout_at),
			})),
			context: measureContext(
				runId,
				runId === undefined ? undefined : measured.get(runId),
				runId === undefined ? undefined : runDetails.get(runId),
				agent.model,
			),
			maxInputTokens7d: maxInput.get(agent.id)?.[0]?.max ?? null,
			session:
				session === undefined
					? null
					: { lastUsedAt: iso(session.last_used_at), expiresAt: isoOrNull(session.expires_at) },
			budget: budgets.perAgent,
		};
	});

	const recent = await rows<
		Readonly<{
			id: string;
			agent_id: string;
			status: string;
			outcome: string | null;
			error_code: string | null;
			trigger_type: string;
			queued_at: Date;
			started_at: Date | null;
			finished_at: Date | null;
			input_tokens: number | null;
			output_tokens: number | null;
		}>
	>(
		client,
		`select r.id, r.agent_id, r.status, r.outcome, r.error_code, e.type as trigger_type,
		        r.queued_at, r.started_at, r.finished_at,
		        ${usageCount("inputTokens")} as input_tokens,
		        ${usageCount("outputTokens")} as output_tokens
		   from agent_runs r join events e on e.id = r.trigger_event_id
		  order by r.queued_at desc, r.id desc limit ${RECENT_RUNS}`,
	);
	const alerts = await rows<Readonly<{ key: string; message: string; fired_at: Date }>>(
		client,
		`select key, message, fired_at from alert_states where state = 'firing'
		  order by fired_at, key limit $1`,
		[SYSTEM_STATUS_LIMITS.alerts],
	);

	return {
		system: loaded.status,
		agents: consoleAgents,
		recentRuns: recent.map((row) => ({
			runId: row.id,
			agentId: row.agent_id,
			status: row.status,
			outcome: row.outcome,
			errorCode: row.error_code,
			triggerType: triggerType(row.trigger_type),
			queuedAt: iso(row.queued_at),
			startedAt: isoOrNull(row.started_at),
			finishedAt: isoOrNull(row.finished_at),
			inputTokens: row.input_tokens,
			outputTokens: row.output_tokens,
		})),
		alerts: alerts.map((row) => ({
			key: row.key,
			message: row.message,
			firedAt: iso(row.fired_at),
		})),
	};
}
