import { utcDay } from "@agent-gateway/policy";
import { gauge, type MetricFamily, type MetricsRegistry } from "@agent-gateway/service";
import type pg from "pg";

/** Scrapes within this window share one collection. */
const CACHE_MS = 15_000;
/** One statement may take this long; a slow database reports a failed collection. */
const STATEMENT_TIMEOUT_MS = 2_000;
/** The whole collection, waiting for a connection included. */
const COLLECTION_DEADLINE_MS = 3_000;

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`metrics collection took over ${ms} ms`)), ms);
	});
	return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

type Cell = string | number | boolean | Date | null | undefined;
type Row = Readonly<Record<string, Cell>>;

const QUERIES = {
	agents: "select state, count(*)::int as n from agents group by state",
	runs: `select status, runtime_adapter as adapter, count(*)::int as n from agent_runs
	        where status in ('queued', 'running') group by status, runtime_adapter`,
	// The age of the oldest job that is due: jobs scheduled for later (timeouts, backoffs) do
	// not count as a backlog.
	queues: `select name as queue, state, count(*)::int as n,
	                extract(epoch from (now() - min(start_after) filter (where start_after <= now())))::float8 as oldest
	           from pgboss.job where state in ('created', 'retry', 'active')
	          group by name, state`,
	outbox: `select status, count(*)::int as n from outbox
	          where status <> 'sent' group by status`,
	approvals: "select count(*)::int as n from approval_requests where status = 'pending'",
	tools: `select status, count(*)::int as n from tool_actions
	         where status in ('queued', 'running', 'unknown') group by status`,
	usage: `select coalesce(sum(cost_usd), 0)::float8 as cost, coalesce(sum(tokens), 0)::float8 as tokens
	          from run_usage where day = $1`,
	runtimes: "select adapter, available from runtime_availability",
	alerts: "select key from alert_states where state = 'firing'",
	maintenance: `select task, extract(epoch from last_success_at)::float8 as success
	                from maintenance_status`,
	killSwitch: "select kill_switch from gateway_controls where id = 1",
} as const;

type Collected = Readonly<Record<keyof typeof QUERIES, Readonly<Row[]>>>;

async function collect(pool: pg.Pool, now: Date): Promise<Collected> {
	const client = await pool.connect();
	try {
		await client.query("begin read only");
		await client.query(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
		const rows = async (sql: string, params: Readonly<string[]> = []) =>
			(await client.query<Row>(sql, [...params])).rows;
		const collected: Collected = {
			agents: await rows(QUERIES.agents),
			runs: await rows(QUERIES.runs),
			queues: await rows(QUERIES.queues),
			outbox: await rows(QUERIES.outbox),
			approvals: await rows(QUERIES.approvals),
			tools: await rows(QUERIES.tools),
			usage: await rows(QUERIES.usage, [utcDay(now)]),
			runtimes: await rows(QUERIES.runtimes),
			alerts: await rows(QUERIES.alerts),
			maintenance: await rows(QUERIES.maintenance),
			killSwitch: await rows(QUERIES.killSwitch),
		};
		await client.query("commit");
		return collected;
	} catch (error) {
		await client.query("rollback").catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}

const text = (value: Cell): string => (value === null || value === undefined ? "" : String(value));
const num = (value: Cell): number => (typeof value === "number" ? value : Number(value ?? 0));

/** Per queue, the oldest due job that is waiting, new or retrying. */
function oldestDue(rows: Readonly<Row[]>) {
	const oldest = new Map<string, number>();
	for (const row of rows) {
		if ((row.state === "created" || row.state === "retry") && row.oldest !== null) {
			const queue = text(row.queue);
			oldest.set(queue, Math.max(oldest.get(queue) ?? 0, num(row.oldest)));
		}
	}
	return [...oldest].map(([queue, value]) => ({ labels: { queue }, value }));
}

function families(data: Collected): MetricFamily[] {
	return [
		gauge(
			"gateway_agents",
			"Agents by state.",
			data.agents.map((r) => ({ labels: { state: text(r.state) }, value: num(r.n) })),
		),
		gauge(
			"gateway_runs_active",
			"Queued and running runs.",
			data.runs.map((r) => ({
				labels: { status: text(r.status), adapter: text(r.adapter) },
				value: num(r.n),
			})),
		),
		gauge(
			"gateway_queue_jobs",
			"Jobs waiting, retrying or active, by queue.",
			data.queues.map((r) => ({
				labels: { queue: text(r.queue), state: text(r.state) },
				value: num(r.n),
			})),
		),
		gauge(
			"gateway_queue_oldest_job_seconds",
			"Age of the oldest job that is due and waiting, by queue.",
			oldestDue(data.queues),
		),
		gauge(
			"gateway_dead_letter_jobs",
			"Jobs in dead letter queues.",
			data.queues
				.filter((r) => text(r.queue).startsWith("dlq.") && r.state !== "active")
				.map((r) => ({ labels: { queue: text(r.queue) }, value: num(r.n) })),
		),
		gauge(
			"gateway_outbox_items",
			"Outbox items not yet delivered, by status (dead items included).",
			data.outbox.map((r) => ({ labels: { status: text(r.status) }, value: num(r.n) })),
		),
		gauge("gateway_approvals_pending", "Approval requests waiting for an owner.", [
			{ labels: {}, value: num(data.approvals[0]?.n ?? 0) },
		]),
		gauge(
			"gateway_tool_actions_open",
			"Tool actions queued, running or unknown.",
			data.tools.map((r) => ({ labels: { status: text(r.status) }, value: num(r.n) })),
		),
		gauge("gateway_usage_today_cost_usd", "Cost booked today (UTC), all agents.", [
			{ labels: {}, value: num(data.usage[0]?.cost ?? 0) },
		]),
		gauge("gateway_usage_today_tokens", "Tokens booked today (UTC), all agents.", [
			{ labels: {}, value: num(data.usage[0]?.tokens ?? 0) },
		]),
		gauge(
			"gateway_runtime_available",
			"Whether a ready worker serves the runtime.",
			data.runtimes.map((r) => ({
				labels: { adapter: text(r.adapter) },
				value: r.available === true ? 1 : 0,
			})),
		),
		gauge(
			"gateway_alert_firing",
			"Alert conditions that hold now.",
			data.alerts.map((r) => ({ labels: { key: text(r.key) }, value: 1 })),
		),
		gauge(
			"gateway_maintenance_last_success_timestamp_seconds",
			"When each maintenance task last succeeded.",
			data.maintenance
				.filter((r) => r.success !== null)
				.map((r) => ({ labels: { task: text(r.task) }, value: num(r.success) })),
		),
		gauge("gateway_kill_switch", "1 while kill-all is on.", [
			{
				labels: {},
				value: data.killSwitch[0]?.kill_switch === true ? 1 : 0,
			},
		]),
	];
}

/**
 * Registers the controller's database gauges. A failed collection renders
 * `gateway_metrics_collection_success 0` and none of these gauges: an unreachable database
 * never looks like an empty one.
 */
export function registerControllerMetrics(
	registry: MetricsRegistry,
	pool: pg.Pool,
	clock: () => Date = () => new Date(),
): void {
	// One collection at a time: a slow one stays shared until it settles, so scrapes during a
	// database slowdown never pile up connections.
	let cached: { at: number; value: Promise<Collected>; settled: boolean } | null = null;
	registry.collect(async () => {
		const now = clock();
		if (cached === null || (cached.settled && now.getTime() - cached.at > CACHE_MS)) {
			const entry = { at: now.getTime(), value: collect(pool, now), settled: false };
			entry.value.then(
				() => {
					entry.settled = true;
				},
				() => {
					entry.settled = true;
					if (cached === entry) {
						cached = null;
					}
				},
			);
			cached = entry;
		}
		const started = Date.now();
		// Bound by the whole collection, connection included, not per statement: a scrape must
		// get its failure signal before its own timeout.
		const entry = cached;
		try {
			const data = await withDeadline(entry.value, COLLECTION_DEADLINE_MS);
			return [
				...families(data),
				gauge("gateway_metrics_collection_success", "1 when the database gauges are current.", [
					{ labels: {}, value: 1 },
				]),
				gauge("gateway_metrics_collection_age_seconds", "Age of the database gauges.", [
					{ labels: {}, value: Math.max(0, now.getTime() - entry.at) / 1000 },
				]),
			];
		} catch {
			return [
				gauge("gateway_metrics_collection_success", "1 when the database gauges are current.", [
					{ labels: {}, value: 0 },
				]),
				gauge("gateway_metrics_collection_seconds", "Time the failed collection took.", [
					{ labels: {}, value: (Date.now() - started) / 1000 },
				]),
			];
		}
	});
}
