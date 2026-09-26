import { userInfo } from "node:os";
import { resolve } from "node:path";
import {
	GatewayEventSchema,
	MattermostIdSchema,
	QUEUES,
	RuntimeAdapterIdSchema,
	reportQueue,
	runDeadLetterQueue,
	runQueue,
} from "@agent-gateway/contracts";
import {
	applyConfig,
	type CancelledJob,
	type ConfigApplyInput,
	type ControlPlaneDeps,
	cancelRun,
	configBundleProblems,
	ingestEvent,
	killAll,
	listAgents,
	listApprovals,
	listOutbox,
	listRuns,
	listWaits,
	pauseAgent,
	redriveOutbox,
	redriveRun,
	releaseKillSwitch,
	resumeAgent,
	setAgentEnabled,
	setDirectoryEntry,
	showAgent,
	showEvent,
	showRun,
} from "@agent-gateway/core";
import {
	createPool,
	grantWorkerRole,
	migrateDatabase,
	pendingMigrationCount,
} from "@agent-gateway/db";
import { createLogger } from "@agent-gateway/logging";
import {
	createBoss,
	deadLetterQueues,
	ensureQueues,
	transactionalJobSink,
} from "@agent-gateway/queue";
import { requireSetting } from "@agent-gateway/service";
import type { PgBoss } from "pg-boss";
import { loadConfigDirectory } from "./config-files.ts";
import { mattermostBootstrap, mattermostReconcile } from "./mattermost-commands.ts";

export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

export type Output = Readonly<{
	print: (value: string) => void;
}>;

export type Session = Readonly<{
	deps: ControlPlaneDeps;
	boss: PgBoss;
	close: () => Promise<void>;
}>;

export const USAGE = `gateway <command>

  health | doctor                     check database, migrations, queues and controls
  db migrate                          apply database and queue migrations
  db grant-worker <role> <adapter>    limit an existing role to one adapter's worker jobs
  config validate <dir> [--root .]    validate organization.yaml and agents/*.yaml
  config apply <dir> [--root .] [--mock-runtimes]
                                      store the configuration as the active version;
                                      --mock-runtimes runs every agent on the mock runtime
  directory set <channel|user|team> <name> <mattermost-id>
  agents list | show <id> | enable <id> | disable <id> | pause <id> | resume <id>
  runs list [--agent <id>] | show <run-id> | cancel <run-id> | redrive <run-id>
  waits list
  events show <id> | ingest <file.json>
  dlq list | redrive <dlq-name> <job-id>
  outbox list [--status <status>] | redrive <outbox-id>
  approvals list [--status <status>]
  mattermost bootstrap --secrets-dir <dir> [--rotate-tokens]
                                      resolve team, channels and owners, create the bots and
                                      their memberships, store tokens in <dir> (needs
                                      MATTERMOST_URL and a temporary MATTERMOST_ADMIN_TOKEN)
  mattermost reconcile [--secrets-dir <dir>]
                                      check tokens, bot accounts and memberships
  kill-all [--release]`;

function actor(): string {
	return `cli:${userInfo().username}`;
}

function json(value: object): string {
	return JSON.stringify(value, null, 2);
}

function arg(args: Readonly<string[]>, index: number, name: string): string {
	const value = args[index];
	if (value === undefined || value.startsWith("--")) {
		throw new UsageError(`missing <${name}>`);
	}
	return value;
}

function flag(args: Readonly<string[]>, name: string): string | null {
	const index = args.indexOf(`--${name}`);
	if (index === -1) {
		return null;
	}
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) {
		throw new UsageError(`--${name} needs a value`);
	}
	return value;
}

/** Development: every agent on the mock runtime, keeping everything else as configured. */
function withMockRuntimes(input: ConfigApplyInput): ConfigApplyInput {
	return {
		...input,
		agents: input.agents.map((agent) => ({
			...agent,
			runtime: { ...agent.runtime, adapter: "mock" },
		})),
	};
}

/**
 * The latest run of each agent, when it failed: a domain-level dead letter that keeps the agent
 * FAILED (also through disable and enable) until `runs redrive`.
 */
const UNRESOLVED_FAILED_RUNS = `
	select * from (
	  select distinct on (r.agent_id) r.id, r.agent_id, a.state as agent_state, r.status,
	         r.error_code, r.finished_at
	    from agent_runs r join agents a on a.id = r.agent_id
	   order by r.agent_id, r.queued_at desc
	) latest where latest.status = 'failed'`;

/** Opens database and queue connections for commands that need them. */
export async function openSession(): Promise<Session> {
	const connectionString = requireSetting("DATABASE_URL");
	const pool = createPool(connectionString, 2);
	const boss = createBoss(connectionString, "client");
	await boss.start();
	const log = createLogger({ service: "cli", version: "0.0.0", environment: "cli", level: "warn" });
	return {
		deps: {
			pool,
			jobs: (tx) => transactionalJobSink(boss, tx.client),
			clock: () => new Date(),
			random: Math.random,
			log,
		},
		boss,
		close: async () => {
			await boss.stop({ graceful: false });
			await pool.end();
		},
	};
}

async function cancelJobs(boss: PgBoss, jobs: Readonly<CancelledJob[]>): Promise<void> {
	for (const job of jobs) {
		await boss.cancel(job.queue, job.jobId).catch(() => undefined);
	}
}

async function migrate(out: Output): Promise<void> {
	const connectionString = requireSetting("DATABASE_URL");
	const pool = createPool(connectionString, 2);
	try {
		await migrateDatabase(pool);
	} finally {
		await pool.end();
	}
	// A service-role boss creates or upgrades the pg-boss schema on start.
	const boss = createBoss(connectionString, "service");
	await boss.start();
	try {
		await ensureQueues(boss, RuntimeAdapterIdSchema.options);
	} finally {
		await boss.stop({ graceful: false });
	}
	out.print("migrations applied");
}

async function doctor(session: Session, out: Output): Promise<boolean> {
	const { pool } = session.deps;
	const checks: { name: string; ok: boolean; detail: string }[] = [];
	await pool.query("select 1");
	checks.push({ name: "postgres", ok: true, detail: "reachable" });
	const pending = await pendingMigrationCount(pool);
	checks.push({ name: "migrations", ok: pending === 0, detail: `${pending} pending` });
	const controls = await pool.query<{ kill_switch: boolean; active_config_version: string | null }>(
		"select kill_switch, active_config_version from gateway_controls where id = 1",
	);
	const row = controls.rows[0];
	checks.push({
		name: "config",
		ok: row?.active_config_version != null,
		detail: row?.active_config_version ?? "no active configuration",
	});
	checks.push({
		name: "kill_switch",
		ok: row?.kill_switch !== true,
		detail: row?.kill_switch ? "ON" : "off",
	});
	const dead = await pool.query<{ n: number }>(
		"select count(*)::int as n from outbox where status = 'dead'",
	);
	const deadCount = dead.rows[0]?.n ?? 0;
	checks.push({ name: "outbox", ok: deadCount === 0, detail: `${deadCount} dead item(s)` });
	// A run that failed for good (retries exhausted, timeout, invalid output) is a domain-level
	// dead letter: its agent is FAILED until `runs redrive`.
	const failed = await pool.query<{ n: number }>(
		`select count(*)::int as n from (${UNRESOLVED_FAILED_RUNS}) f`,
	);
	const failedCount = failed.rows[0]?.n ?? 0;
	checks.push({
		name: "failed_runs",
		ok: failedCount === 0,
		detail: `${failedCount} agent(s) whose latest run failed`,
	});
	for (const name of deadLetterQueues(RuntimeAdapterIdSchema.options)) {
		const jobs = await session.boss.findJobs(name, { queued: true });
		checks.push({ name, ok: jobs.length === 0, detail: `${jobs.length} dead-lettered` });
	}
	out.print(json({ checks }));
	return checks.every((check) => check.ok);
}

/** Runs one command. Returns the process exit code. */
export async function runCommand(args: Readonly<string[]>, out: Output): Promise<number> {
	const [group, action] = args;
	if (group === undefined || group === "help" || group === "--help") {
		out.print(USAGE);
		return group === undefined ? 1 : 0;
	}
	if (group === "db" && action === "migrate") {
		await migrate(out);
		return 0;
	}
	if (group === "db" && action === "grant-worker") {
		const pool = createPool(requireSetting("DATABASE_URL"), 1);
		try {
			const adapter = RuntimeAdapterIdSchema.parse(arg(args, 3, "adapter"));
			await grantWorkerRole(pool, arg(args, 2, "role"), {
				run: runQueue(adapter),
				report: reportQueue(adapter),
				deadLetter: runDeadLetterQueue(adapter),
			});
		} finally {
			await pool.end();
		}
		out.print("worker role limited to its adapter's queues");
		return 0;
	}
	if (group === "config" && (action === "validate" || action === "apply")) {
		const input = loadConfigDirectory(arg(args, 2, "dir"), resolve(flag(args, "root") ?? "."));
		const problems = configBundleProblems(input);
		if (problems.length > 0) {
			out.print(`configuration is invalid:\n- ${problems.join("\n- ")}`);
			return 1;
		}
		if (action === "validate") {
			out.print(`configuration is valid: ${input.agents.length} agents`);
			return 0;
		}
	}

	const session = await openSession();
	try {
		return await runSessionCommand(session, args, out);
	} finally {
		await session.close();
	}
}

async function runSessionCommand(
	session: Session,
	args: Readonly<string[]>,
	out: Output,
): Promise<number> {
	const { deps, boss } = session;
	const [group, action] = args;
	const who = actor();
	switch (`${group} ${action ?? ""}`.trim()) {
		case "health":
		case "doctor":
			return (await doctor(session, out)) ? 0 : 1;
		case "config apply": {
			const loaded = loadConfigDirectory(arg(args, 2, "dir"), resolve(flag(args, "root") ?? "."));
			const input = args.includes("--mock-runtimes") ? withMockRuntimes(loaded) : loaded;
			out.print(json(await applyConfig(deps, input, who)));
			return 0;
		}
		case "directory set": {
			const kind = arg(args, 2, "channel|user|team");
			if (kind !== "channel" && kind !== "user" && kind !== "team") {
				throw new UsageError("kind must be 'channel', 'user' or 'team'");
			}
			const id = MattermostIdSchema.parse(arg(args, 4, "mattermost-id"));
			await setDirectoryEntry(deps, kind, arg(args, 3, "name"), id, who);
			out.print("directory entry stored");
			return 0;
		}
		case "agents list":
			out.print(json((await listAgents(deps)).rows));
			return 0;
		case "agents show":
			out.print(json(await showAgent(deps, arg(args, 2, "id"))));
			return 0;
		case "agents enable":
		case "agents disable":
			out.print(await setAgentEnabled(deps, arg(args, 2, "id"), action === "enable", who));
			return 0;
		case "agents pause":
			await cancelJobs(boss, await pauseAgent(deps, arg(args, 2, "id"), who));
			out.print("paused");
			return 0;
		case "agents resume":
			out.print(await resumeAgent(deps, arg(args, 2, "id"), who));
			return 0;
		case "runs list":
			out.print(json(await listRuns(deps, flag(args, "agent"))));
			return 0;
		case "runs show":
			out.print(json(await showRun(deps, arg(args, 2, "run-id"))));
			return 0;
		case "runs cancel":
			await cancelJobs(boss, await cancelRun(deps, arg(args, 2, "run-id"), who));
			out.print("cancelled; the agent is paused");
			return 0;
		case "runs redrive":
			out.print(json(await redriveRun(deps, arg(args, 2, "run-id"), who)));
			return 0;
		case "waits list":
			out.print(json(await listWaits(deps)));
			return 0;
		case "events show":
			out.print(json(await showEvent(deps, arg(args, 2, "id"))));
			return 0;
		case "events ingest": {
			const event = GatewayEventSchema.parse(await Bun.file(arg(args, 2, "file.json")).json());
			out.print(json(await ingestEvent(deps, event)));
			return 0;
		}
		case "dlq list": {
			const entries: { queue: string; id: string; createdOn: Date; detail?: string }[] = [];
			// Failed runs that hold their agent in FAILED, recovered with `runs redrive`.
			const failedRuns = await deps.pool.query<{
				id: string;
				agent_id: string;
				agent_state: string;
				error_code: string;
				finished_at: Date;
			}>(UNRESOLVED_FAILED_RUNS);
			for (const run of failedRuns.rows) {
				entries.push({
					queue: "runs.failed",
					id: run.id,
					createdOn: run.finished_at,
					detail: `@${run.agent_id} (${run.agent_state}): ${run.error_code}; gateway runs redrive ${run.id}`,
				});
			}
			for (const name of deadLetterQueues(RuntimeAdapterIdSchema.options)) {
				for (const job of await boss.findJobs(name, { queued: true })) {
					entries.push({ queue: name, id: job.id, createdOn: job.createdOn });
				}
			}
			out.print(json(entries));
			return 0;
		}
		case "dlq redrive": {
			const name = arg(args, 2, "dlq-name");
			if (name.startsWith("dlq.agent.run.") && name !== QUEUES.deadLetterReports) {
				// A dead run job is an obsolete attempt; re-running it would execute a stale turn.
				throw new UsageError("run jobs are recovered with 'gateway runs redrive <run-id>'");
			}
			const moved = await boss.redrive(name, { ids: [arg(args, 3, "job-id")] });
			out.print(`${moved} job(s) redriven`);
			return 0;
		}
		case "outbox list": {
			const status = flag(args, "status");
			const statuses = ["pending", "sending", "sent", "dead"] as const;
			const valid = statuses.find((s) => s === status);
			if (status !== null && valid === undefined) {
				throw new UsageError(`--status must be one of ${statuses.join(", ")}`);
			}
			out.print(json(await listOutbox(deps, valid ?? null)));
			return 0;
		}
		case "outbox redrive":
			await redriveOutbox(deps, arg(args, 2, "outbox-id"), who);
			out.print("outbox item redriven");
			return 0;
		case "approvals list":
			out.print(json(await listApprovals(deps, flag(args, "status"))));
			return 0;
		case "mattermost bootstrap":
			await mattermostBootstrap(
				deps,
				{
					secretsDir: flag(args, "secrets-dir"),
					rotateTokens: args.includes("--rotate-tokens"),
					actor: who,
				},
				out.print,
			);
			return 0;
		case "mattermost reconcile":
			return (await mattermostReconcile(deps, flag(args, "secrets-dir"), out.print)) ? 0 : 1;
		case "kill-all":
			if (args.includes("--release")) {
				await releaseKillSwitch(deps, who);
				out.print("kill switch released; resume agents individually");
			} else {
				await cancelJobs(boss, await killAll(deps, who));
				out.print("kill switch ON: no new runs; all agents paused");
			}
			return 0;
		default:
			throw new UsageError(`unknown command '${args.join(" ")}'\n\n${USAGE}`);
	}
}
