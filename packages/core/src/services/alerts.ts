import {
	type JsonObject,
	type RuntimeAdapterId,
	RuntimeAdapterIdSchema,
} from "@agent-gateway/contracts";
import {
	type AlertState,
	alertStates,
	configRevisionAcks,
	configRevisions,
	withTransaction,
} from "@agent-gateway/db";
import { budgetPressure, type UsageTotals, utcDay } from "@agent-gateway/policy";
import { desc, eq } from "drizzle-orm";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import { loadActiveConfig, postAlert } from "./store.ts";

/**
 * A condition that holds for a while (Mattermost unreachable, a dead letter waiting, a budget
 * nearly spent), as opposed to a one-time notice: it fires when the condition starts, reminds
 * while it lasts and says when it ends; a later recurrence fires again.
 */
export type AlertCondition = Readonly<{ key: string; message: string }>;

/** How often a condition that still holds is posted again. */
export const ALERT_REMINDER_MS = 6 * 60 * 60 * 1000;
/** How long the listener may be disconnected before it is an alert. */
export const MATTERMOST_DISCONNECT_ALERT_MS = 2 * 60 * 1000;
/** Invalid structured outputs of one runtime within the window that make an alert. */
export const INVALID_OUTPUT_ALERT_COUNT = 3;
export const INVALID_OUTPUT_WINDOW_MS = 15 * 60 * 1000;
/** A Gmail watch this close to its expiry is an alert (it is renewed a day after it was set). */
export const GMAIL_WATCH_ALERT_MS = 24 * 60 * 60 * 1000;
/** A maintenance task without a success for this long is an alert. */
export const MAINTENANCE_STALE_MS = 3 * 60 * 60 * 1000;
/** A backup check's maximum age when it recorded none. */
const DEFAULT_BACKUP_MAX_AGE_HOURS = 26;

/** What the controller process knows that the database does not. */
export type AlertInputs = Readonly<{
	/**
	 * The Mattermost listener, when one runs: since when it has been disconnected (null while
	 * connected) and since when connected (null while disconnected).
	 */
	mattermost: Readonly<{ disconnectedSince: Date | null; connectedSince: Date | null }> | null;
}>;

type Transition = "fired" | "reminded" | "resolved" | null;

/**
 * Moves one condition's alert: a new or recurring condition fires (a new episode), a lasting
 * one is reminded every {@link ALERT_REMINDER_MS}, and one that no longer holds is resolved.
 * Each post has its own idempotency key, so a retried sweep posts nothing twice.
 */
export async function settleAlertCondition(
	uow: UnitOfWork,
	key: string,
	condition: AlertCondition | null,
): Promise<Transition> {
	const { db } = uow.tx;
	const [row] = await db.select().from(alertStates).where(eq(alertStates.key, key)).for("update");
	const firing = row?.state === "firing";
	if (condition === null) {
		if (row === undefined || !firing) {
			return null;
		}
		await db
			.update(alertStates)
			.set({ state: "resolved" satisfies AlertState, resolvedAt: uow.now })
			.where(eq(alertStates.key, key));
		await postAlert(uow, `condition:${key}:${row.episode}:resolved`, `Resolved: ${row.message}`, {
			condition: key,
			episode: row.episode,
			state: "resolved",
		});
		return "resolved";
	}
	if (row === undefined || !firing) {
		const episode = (row?.episode ?? 0) + 1;
		const state: AlertState = "firing";
		const values = {
			state,
			episode,
			message: condition.message,
			firedAt: uow.now,
			notifiedAt: uow.now,
			resolvedAt: null,
		};
		await db
			.insert(alertStates)
			.values({ key, ...values })
			.onConflictDoUpdate({ target: alertStates.key, set: values });
		await postAlert(uow, `condition:${key}:${episode}:fired`, condition.message, {
			condition: key,
			episode,
			state: "firing",
		});
		return "fired";
	}
	if (uow.now.getTime() - row.notifiedAt.getTime() < ALERT_REMINDER_MS) {
		return null;
	}
	await db
		.update(alertStates)
		.set({ notifiedAt: uow.now, message: condition.message })
		.where(eq(alertStates.key, key));
	await postAlert(
		uow,
		`condition:${key}:${row.episode}:reminder:${uow.now.getTime()}`,
		`Still: ${condition.message} (since ${row.firedAt.toISOString()})`,
		{ condition: key, episode: row.episode, state: "firing" },
	);
	return "reminded";
}

type CountRow = Readonly<{ key: string; count: string }>;

/** Every condition that holds now. Reads only; the caller settles them. */
export async function currentAlertConditions(
	uow: UnitOfWork,
	inputs: AlertInputs,
): Promise<Readonly<AlertCondition[]>> {
	const { client } = uow.tx;
	const now = uow.now;
	const conditions: AlertCondition[] = [];

	conditions.push(...(await mattermostCondition(uow, inputs.mattermost)));
	conditions.push(...(await configHistoryConditions(uow)));

	const deadLetters = await client.query<CountRow>(
		`select name as key, count(*)::text as count from pgboss.job
		  where name like 'dlq.%' and state in ('created', 'retry') group by name order by name`,
	);
	for (const row of deadLetters.rows) {
		conditions.push({
			key: `dlq:${row.key}`,
			message: `${row.count} job(s) in the dead letter queue ${row.key}: see \`gateway dlq list\`.`,
		});
	}

	const deadOutbox = await client.query<{ count: string }>(
		`select count(*)::text as count from outbox
		  where status = 'dead' and content_expired_at is null`,
	);
	const deadCount = Number(deadOutbox.rows[0]?.count ?? 0);
	if (deadCount > 0) {
		conditions.push({
			key: "outbox:dead",
			message: `${deadCount} outbox item(s) could not be delivered: see \`gateway outbox list --status dead\`.`,
		});
	}

	conditions.push(...(await budgetConditions(uow)));

	const invalid = await client.query<CountRow>(
		`select runtime_adapter as key, count(*)::text as count from agent_runs
		  where error_code = 'invalid_output'
		    and coalesce(finished_at, started_at, queued_at) > $1
		  group by runtime_adapter order by runtime_adapter`,
		[new Date(now.getTime() - INVALID_OUTPUT_WINDOW_MS)],
	);
	for (const row of invalid.rows) {
		const adapter: RuntimeAdapterId | undefined = RuntimeAdapterIdSchema.safeParse(row.key).data;
		if (adapter !== undefined && Number(row.count) >= INVALID_OUTPUT_ALERT_COUNT) {
			conditions.push({
				key: `invalid-output:${adapter}`,
				message: `${row.count} runs on ${adapter} returned invalid structured output in the last 15 minutes.`,
			});
		}
	}

	const watches = await client.query<{ mailbox_id: string; watch_expires_at: Date }>(
		`select mailbox_id, watch_expires_at from gmail_mailboxes
		  where mode = 'pubsub' and watch_expires_at is not null and watch_expires_at < $1
		  order by mailbox_id`,
		[new Date(now.getTime() + GMAIL_WATCH_ALERT_MS)],
	);
	for (const row of watches.rows) {
		const expired = row.watch_expires_at.getTime() <= now.getTime();
		conditions.push({
			key: `gmail-watch:${row.mailbox_id}`,
			message: expired
				? `The Gmail watch of mailbox '${row.mailbox_id}' expired at ${row.watch_expires_at.toISOString()}: no notifications arrive.`
				: `The Gmail watch of mailbox '${row.mailbox_id}' expires at ${row.watch_expires_at.toISOString()} and was not renewed.`,
		});
	}

	conditions.push(...(await maintenanceConditions(uow)));
	return conditions;
}

/**
 * A new outage needs the listener disconnected for the threshold. An outage that fired lasts,
 * across a controller restart too, until the listener has stayed connected for the threshold:
 * a flapping connection is one outage, not an episode every few minutes.
 */
async function mattermostCondition(
	uow: UnitOfWork,
	listener: AlertInputs["mattermost"],
): Promise<AlertCondition[]> {
	if (listener === null) {
		return [];
	}
	const now = uow.now.getTime();
	const [outage] = await uow.tx.db
		.select({ state: alertStates.state, firedAt: alertStates.firedAt })
		.from(alertStates)
		.where(eq(alertStates.key, "mattermost:disconnected"));
	const { disconnectedSince, connectedSince } = listener;
	if (outage?.state === "firing") {
		const stable =
			connectedSince !== null && now - connectedSince.getTime() >= MATTERMOST_DISCONNECT_ALERT_MS;
		if (stable) {
			return [];
		}
		return [
			{
				key: "mattermost:disconnected",
				message:
					disconnectedSince === null
						? `The Mattermost listener was disconnected (since ${outage.firedAt.toISOString()} at the latest) and reconnected; waiting for it to stay connected.`
						: `The Mattermost listener has been disconnected since ${new Date(Math.min(disconnectedSince.getTime(), outage.firedAt.getTime())).toISOString()} at the latest: no post reaches the Gateway.`,
			},
		];
	}
	if (
		disconnectedSince !== null &&
		now - disconnectedSince.getTime() >= MATTERMOST_DISCONNECT_ALERT_MS
	) {
		return [
			{
				key: "mattermost:disconnected",
				message: `The Mattermost listener has been disconnected since ${disconnectedSince.toISOString()}: no post reaches the Gateway.`,
			},
		];
	}
	return [];
}

/**
 * The most recently recorded configuration revision was a `backfill` with a parent: something
 * changed `config_versions`/`agents` outside the revision journal — most likely a release before
 * this one, which does not know the journal exists, running during a rollback interval (see
 * `ensureConfigHistoryIn`). A `backfill` with no parent is excluded: that one is the ordinary,
 * expected first entry a database upgraded from before configuration history existed gets, not a
 * sign anything drifted. Resolves once a later, actually different revision supersedes it, or once
 * a human acknowledges it with `gateway config ack <revision-id>` (`ackConfigRevision`) — not on
 * its own from merely reviewing it: `commitChange` treats identical content as a no-op, so
 * recommitting the reviewed configuration (or `config rollback` to this same revision) writes no
 * new revision and never clears this on its own.
 */
async function configHistoryConditions(uow: UnitOfWork): Promise<AlertCondition[]> {
	const [latest] = await uow.tx.db
		.select({
			id: configRevisions.id,
			source: configRevisions.source,
			generation: configRevisions.generation,
			parentRevisionId: configRevisions.parentRevisionId,
		})
		.from(configRevisions)
		.orderBy(desc(configRevisions.id))
		.limit(1);
	if (latest === undefined || latest.source !== "backfill" || latest.parentRevisionId === null) {
		return [];
	}
	const [ack] = await uow.tx.db
		.select({ revisionId: configRevisionAcks.revisionId })
		.from(configRevisionAcks)
		.where(eq(configRevisionAcks.revisionId, latest.id));
	if (ack !== undefined) {
		return [];
	}
	return [
		{
			key: "config:backfill",
			message:
				`Configuration changed outside revision history at generation ${latest.generation}; ` +
				`recorded as revision ${latest.id} (backfill): review with \`gateway config diff\`/\`history\`, ` +
				`then \`gateway config ack ${latest.id}\`.`,
		},
	];
}

async function budgetConditions(uow: UnitOfWork): Promise<AlertCondition[]> {
	const budgets = (await loadActiveConfig(uow.tx.db))?.organization.organization.budgets;
	if (budgets === undefined) {
		return [];
	}
	const day = utcDay(uow.now);
	const rows = await uow.tx.client.query<{
		agent_id: string | null;
		cost_usd: string;
		tokens: string;
	}>(
		`select agent_id, coalesce(sum(cost_usd), 0)::text as cost_usd,
		        coalesce(sum(tokens), 0)::text as tokens
		   from run_usage where day = $1 group by rollup (agent_id) order by agent_id nulls first`,
		[day],
	);
	const conditions: AlertCondition[] = [];
	for (const row of rows.rows) {
		const totals: UsageTotals = {
			costUsd: Number(row.cost_usd),
			tokens: Number(row.tokens),
			unmeteredAttempts: 0,
		};
		const global = row.agent_id === null;
		const pressure = budgetPressure(
			totals,
			global ? budgets.global_daily : budgets.per_agent_daily,
		);
		if (pressure !== null) {
			conditions.push({
				key: global ? "budget:global" : `budget:agent:${row.agent_id}`,
				message: `${global ? "The global" : `@${row.agent_id}'s`} daily budget is ${Math.round(pressure.ratio * 100)}% used on ${day} (UTC): ${pressure.reason}.`,
			});
		}
	}
	return conditions;
}

async function maintenanceConditions(uow: UnitOfWork): Promise<AlertCondition[]> {
	const rows = await uow.tx.client.query<{
		task: string;
		last_run_at: Date;
		last_success_at: Date | null;
		last_error_redacted: string | null;
		detail: JsonObject;
	}>(
		"select task, last_run_at, last_success_at, last_error_redacted, detail from maintenance_status",
	);
	const now = uow.now.getTime();
	const conditions: AlertCondition[] = [];
	for (const row of rows.rows) {
		const failed = row.last_success_at === null || row.last_success_at < row.last_run_at;
		const error = row.last_error_redacted ?? "no detail";
		if (row.task === "backup") {
			const maxAgeHours =
				typeof row.detail.max_age_hours === "number"
					? row.detail.max_age_hours
					: DEFAULT_BACKUP_MAX_AGE_HOURS;
			const stale =
				row.last_success_at === null ||
				now - row.last_success_at.getTime() > maxAgeHours * 60 * 60 * 1000;
			if (failed || stale) {
				conditions.push({
					key: "maintenance:backup",
					message: failed
						? `The last backup check failed: ${error}.`
						: `No backup check passed in the last ${maxAgeHours} hours.`,
				});
			}
			continue;
		}
		// A task that never succeeded counts from its first run: the first run of a large
		// database may still be in progress.
		const since = row.last_success_at?.getTime() ?? row.last_run_at.getTime();
		if (now - since > MAINTENANCE_STALE_MS) {
			conditions.push({
				key: `maintenance:${row.task}`,
				message: `Maintenance task '${row.task}' has not succeeded for over 3 hours${failed ? `: ${error}` : ""}.`,
			});
		}
	}
	return conditions;
}

/**
 * Evaluates every alert condition and settles its alert: fires what started, reminds what
 * lasts, resolves what ended. One sweep at a time (an advisory lock), in one transaction.
 * Returns the transitions made.
 */
export async function sweepAlertConditions(
	deps: ControlPlaneDeps,
	inputs: AlertInputs,
): Promise<Readonly<Record<string, Exclude<Transition, null>>>> {
	return withTransaction(deps.pool, async (tx) => {
		const uow: UnitOfWork = { deps, tx, jobs: deps.jobs(tx), now: deps.clock() };
		await tx.client.query("select pg_advisory_xact_lock(hashtext('agent-gateway:alert-sweep'))");
		const current = new Map((await currentAlertConditions(uow, inputs)).map((c) => [c.key, c]));
		const firing = await tx.db
			.select({ key: alertStates.key })
			.from(alertStates)
			.where(eq(alertStates.state, "firing"));
		const keys = [...new Set([...current.keys(), ...firing.map((row) => row.key)])].sort();
		const transitions: Record<string, Exclude<Transition, null>> = {};
		for (const key of keys) {
			const transition = await settleAlertCondition(uow, key, current.get(key) ?? null);
			if (transition !== null) {
				transitions[key] = transition;
			}
		}
		return transitions;
	});
}
