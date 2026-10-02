import type { JsonObject, OrganizationRetention } from "@agent-gateway/contracts";
import { OrganizationRetentionSchema } from "@agent-gateway/contracts";
import { withTransaction } from "@agent-gateway/db";
import { redactForStorage } from "@agent-gateway/logging";
import type pg from "pg";
import { cleanupExpiredConsoleSessions } from "./console-sessions.ts";
import type { ControlPlaneDeps } from "./deps.ts";
import { loadActiveConfig } from "./store.ts";

/** How often retention runs. */
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** Rows changed per statement: short transactions, no long locks. */
export const RETENTION_BATCH = 500;
/** Batches per step and run; what is left waits for the next run. */
const MAX_BATCHES = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One retention step: a statement that changes at most `$2` rows older than the cutoff `$1`
 * and returns how many it changed. Every step re-checks, in its own statement, that the row is
 * no longer needed: pending work, active runs and undelivered items are never touched.
 */
type RetentionStep = Readonly<{
	name: string;
	days: (retention: OrganizationRetention) => number;
	sql: string;
}>;

/** Waits with work still pending or claimed in an inbox; completed by the caller's join column. */
const WAITED_ON = `select 1 from wait_subscriptions w
	  join agent_inbox i on i.wait_id = w.id and i.status in ('pending', 'claimed')
	 where w`;

const STEPS: Readonly<RetentionStep[]> = [
	{
		// Only the ids thread lookups join on remain; hashes and routing columns stay for dedupe
		// and the loop guards. Events of pending or claimed work keep their content, and so do
		// the events of a FAILED agent's latest run, which an operator may still redrive.
		name: "event_content",
		days: (r) => r.event_content_days,
		// The edits and deletions of a protected post stay too: a turn shows the post as it is now.
		sql: `with protected as (
			select p.id, p.source, p.subject from events p
			  join agent_inbox i on i.event_id = p.id join agents a on a.id = i.agent_id
			 where i.status in ('pending', 'claimed')
			    or (a.state = 'failed' and i.run_id = (
			          select r.id from agent_runs r where r.agent_id = a.id
			           order by r.queued_at desc limit 1))),
			batch as (
			select e.id from events e
			 where e.content_expired_at is null and e.received_at < $1
			   and not exists (select 1 from protected p
			                    where p.id = e.id
			                       or (e.subject is not null and p.source = e.source
			                           and p.subject = e.subject))
			 order by e.received_at limit $2 for no key update skip locked)
			update events e set content_expired_at = now(),
			       payload = jsonb_strip_nulls(jsonb_build_object(
			         'channel_id', e.payload->'channel_id',
			         'root_id', e.payload->'root_id',
			         'post_id', e.payload->'post_id'))
			  from batch where e.id = batch.id`,
	},
	{
		// The exact turn input goes with the run's content: a run's summary is shown to the next
		// run only together with its snapshot. A run whose wait still has work waiting (a timeout
		// of a paused agent) keeps both: that work finds its thread through them.
		name: "context_snapshots",
		days: (r) => r.run_content_days,
		sql: `with batch as (
			select s.id from context_snapshots s join agent_runs r on r.id = s.run_id
			 where s.created_at < $1 and r.status in ('succeeded', 'failed', 'cancelled')
			   and r.finished_at < $1
			   and not exists (${WAITED_ON}.created_by_run_id = s.run_id)
			 order by s.created_at limit $2 for update of s skip locked)
			delete from context_snapshots s using batch where s.id = batch.id`,
	},
	{
		name: "run_content",
		days: (r) => r.run_content_days,
		sql: `with batch as (
			select id from agent_runs r
			 where content_expired_at is null and finished_at < $1
			   and status in ('succeeded', 'failed', 'cancelled')
			   and not exists (${WAITED_ON}.created_by_run_id = r.id)
			 order by finished_at limit $2 for no key update skip locked)
			update agent_runs r set content_expired_at = now(), result = null, public_summary = null,
			       error_detail_redacted = null
			  from batch where r.id = batch.id`,
	},
	{
		// The receipt stays: approval notices find their card's post by it.
		name: "outbox_sent",
		days: (r) => r.outbox_sent_days,
		sql: `with batch as (
			select id from outbox
			 where content_expired_at is null and status = 'sent' and created_at < $1
			 order by created_at limit $2 for no key update skip locked)
			update outbox o set content_expired_at = now(), payload = '{}'::jsonb,
			       last_error_redacted = null
			  from batch where o.id = batch.id`,
	},
	{
		// Counted from the last attempt, not the creation: an item that died after a long outage
		// keeps its payload for the whole period, so it can still be redriven. `cancelled` (an
		// agent retired with it still undelivered, ADR-026) is never redriven, but it carries the
		// same payload a `dead` item does and is otherwise forgotten by every other step, so it
		// ages out on the same rule rather than staying forever.
		name: "outbox_dead",
		days: (r) => r.outbox_dead_days,
		sql: `with batch as (
			select id from outbox
			 where content_expired_at is null and status in ('dead', 'cancelled')
			   and greatest(created_at, next_attempt_at, coalesce(locked_until, created_at)) < $1
			 order by created_at limit $2 for no key update skip locked)
			update outbox o set content_expired_at = now(), payload = '{}'::jsonb
			  from batch where o.id = batch.id`,
	},
	{
		name: "policy_inputs",
		days: (r) => r.policy_input_days,
		sql: `with batch as (
			select id from policy_decisions
			 where content_expired_at is null and created_at < $1
			 order by created_at limit $2 for no key update skip locked)
			update policy_decisions p set content_expired_at = now(), input_redacted = '{}'::jsonb
			  from batch where p.id = batch.id`,
	},
	{
		name: "thread_summaries",
		days: (r) => r.thread_summary_days,
		sql: `with batch as (
			select channel_id, root_post_id from thread_summaries
			 where updated_at < $1 order by updated_at limit $2 for no key update skip locked)
			delete from thread_summaries t using batch
			 where t.channel_id = batch.channel_id and t.root_post_id = batch.root_post_id`,
	},
	{
		name: "inactive_memory",
		days: (r) => r.inactive_memory_days,
		sql: `with batch as (
			select id from memory_items
			 where status in ('rejected', 'superseded')
			   and coalesce(superseded_at, created_at) < $1
			 order by created_at limit $2 for no key update skip locked)
			delete from memory_items m using batch where m.id = batch.id`,
	},
	{
		name: "usage",
		days: (r) => r.usage_days,
		sql: `with batch as (
			select run_id, attempt from run_usage
			 where recorded_at < $1 order by recorded_at limit $2 for no key update skip locked)
			delete from run_usage u using batch
			 where u.run_id = batch.run_id and u.attempt = batch.attempt`,
	},
];

export type RetentionResult = Readonly<Record<string, number>>;

/** Checked between batches: a stopping controller does not wait for a whole run. */
export type RetentionStop = () => boolean;

async function runStep(
	pool: pg.Pool,
	step: RetentionStep,
	cutoff: Date,
	stop: RetentionStop,
): Promise<number> {
	let total = 0;
	for (let batch = 0; batch < MAX_BATCHES && !stop(); batch += 1) {
		// Each statement is its own transaction.
		const result = await pool.query(step.sql, [cutoff, RETENTION_BATCH]);
		const changed = result.rowCount ?? 0;
		total += changed;
		if (changed < RETENTION_BATCH) {
			break;
		}
	}
	return total;
}

/**
 * Removes content older than the organization's retention periods, step by step in short
 * batches. Safe to interrupt and to repeat: every step picks up what is still due.
 */
export async function applyRetention(
	deps: ControlPlaneDeps,
	stop: RetentionStop = () => false,
): Promise<RetentionResult> {
	const config = await withTransaction(deps.pool, (tx) => loadActiveConfig(tx.db));
	const retention =
		config?.organization.organization.retention ?? OrganizationRetentionSchema.parse({});
	const now = deps.clock().getTime();
	const result: Record<string, number> = {};
	for (const step of STEPS) {
		result[step.name] = await runStep(
			deps.pool,
			step,
			new Date(now - step.days(retention) * DAY_MS),
			stop,
		);
	}
	// Console session hygiene (ADR-025) is not part of the organization's configurable content
	// retention: expired and revoked rows carry no content to redact, so they are simply deleted,
	// piggybacking on this same periodic, lockable, recorded pass instead of a schedule of their
	// own.
	result.console_sessions = await cleanupExpiredConsoleSessions(deps.pool, new Date(now));
	return result;
}

/**
 * Runs retention if it is due: one pass at a time (an advisory lock held for the pass), at most
 * once per interval (a row update claims it), and records the outcome in `maintenance_status`.
 * Returns null when not due or another pass is running.
 */
export async function runRetentionIfDue(
	deps: ControlPlaneDeps,
	intervalMs = RETENTION_INTERVAL_MS,
	stop: RetentionStop = () => false,
): Promise<RetentionResult | null> {
	// A session lock held for the whole pass: a pass that outlasts the interval is never joined
	// by a second one (another controller, or this one's next tick).
	const lock = await deps.pool.connect();
	// A client whose unlock failed may still hold the lock: it is closed, not pooled.
	let unlocked = true;
	try {
		const locked = await lock.query<{ locked: boolean }>(
			"select pg_try_advisory_lock(hashtext('agent-gateway:retention')) as locked",
		);
		if (locked.rows[0]?.locked !== true) {
			return null;
		}
		try {
			return await claimedRetention(deps, intervalMs, stop);
		} finally {
			unlocked = false;
			await lock.query("select pg_advisory_unlock(hashtext('agent-gateway:retention'))");
			unlocked = true;
		}
	} finally {
		lock.release(!unlocked);
	}
}

async function claimedRetention(
	deps: ControlPlaneDeps,
	intervalMs: number,
	stop: RetentionStop,
): Promise<RetentionResult | null> {
	const now = deps.clock();
	const claimed = await deps.pool.query(
		`insert into maintenance_status (task, last_run_at) values ('retention', $1)
		 on conflict (task) do update set last_run_at = excluded.last_run_at
		  where maintenance_status.last_run_at <= $2
		 returning task`,
		[now, new Date(now.getTime() - intervalMs)],
	);
	if (claimed.rowCount === 0) {
		return null;
	}
	try {
		const result = await applyRetention(deps, stop);
		if (stop()) {
			// Interrupted: not a success, and due again at once, so the next start resumes it.
			await deps.pool.query(
				`update maintenance_status set last_run_at = $2
				  where task = 'retention' and last_run_at = $1`,
				[now, new Date(now.getTime() - intervalMs)],
			);
			return result;
		}
		const detail: JsonObject = { ...result };
		await deps.pool.query(
			`update maintenance_status set last_success_at = $2, last_error_redacted = null, detail = $3
			  where task = 'retention' and last_run_at = $1`,
			[now, deps.clock(), detail],
		);
		return result;
	} catch (error) {
		await deps.pool.query(
			`update maintenance_status set last_error_redacted = $2
			  where task = 'retention' and last_run_at = $1`,
			[now, redactForStorage(error instanceof Error ? error.message : String(error), 500)],
		);
		throw error;
	}
}

/**
 * Records the outcome of a maintenance task run outside the controller, such as a backup
 * check. The controller's alert sweep reads it: a failure, or no success within `max_age_hours`
 * of `detail`, is an alert until a run succeeds.
 */
export async function recordMaintenanceResult(
	deps: ControlPlaneDeps,
	task: string,
	outcome: Readonly<{ ok: boolean; error: string | null; detail: JsonObject }>,
): Promise<void> {
	const now = deps.clock();
	await deps.pool.query(
		`insert into maintenance_status (task, last_run_at, last_success_at, last_error_redacted, detail)
		 values ($1, $2, $3, $4, $5)
		 on conflict (task) do update set last_run_at = excluded.last_run_at,
		   last_success_at = coalesce(excluded.last_success_at, maintenance_status.last_success_at),
		   last_error_redacted = excluded.last_error_redacted, detail = excluded.detail`,
		[
			task,
			now,
			outcome.ok ? now : null,
			outcome.error === null ? null : redactForStorage(outcome.error, 500),
			outcome.detail,
		],
	);
}
