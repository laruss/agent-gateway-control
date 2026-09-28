import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { GOOGLE_ENDPOINTS } from "@agent-gateway/connector-gmail";
import {
	GatewayEventSchema,
	GmailMailboxIdSchema,
	MattermostIdSchema,
	QUEUES,
	RuntimeAdapterIdSchema,
	reportQueue,
	runDeadLetterQueue,
	runQueue,
	ToolNamespaceSchema,
	toolDeadLetterQueue,
	toolExecuteQueue,
	toolReportQueue,
} from "@agent-gateway/contracts";
import {
	applyConfig,
	budgetReport,
	type CancelledJob,
	type ConfigApplyInput,
	type ControlPlaneDeps,
	cancelRun,
	configBundleProblems,
	decideMemory,
	ingestEvent,
	killAll,
	listAgents,
	listApprovals,
	listGmailMailboxes,
	listMemory,
	listOutbox,
	listRuns,
	listToolActions,
	listWaits,
	MAINTENANCE_STALE_MS,
	MEMORY_REVIEW_STATUSES,
	pauseAgent,
	recordMaintenanceResult,
	redriveOutbox,
	redriveRun,
	releaseKillSwitch,
	resetGmailMailbox,
	resumeAgent,
	runtimeHealth,
	setAgentEnabled,
	setDirectoryEntry,
	settleToolAction,
	showAgent,
	showEvent,
	showRun,
} from "@agent-gateway/core";
import {
	checkCompatibility,
	createLoginRole,
	createPool,
	grantToolRunnerRole,
	grantWorkerRole,
	loadLocalSchema,
	migrateSchema,
	readSchemaState,
	schemaCompatibility,
} from "@agent-gateway/db";
import { createLogger, releaseVersion, serviceVersion } from "@agent-gateway/logging";
import {
	createBoss,
	deadLetterQueues,
	migrateQueues,
	transactionalJobSink,
} from "@agent-gateway/queue";
import { runtimeDoctor } from "@agent-gateway/runtime-sdk";
import { intSetting, readSetting, requireSetting, writeSecretFile } from "@agent-gateway/service";
import { createRuntimeAdapter, workspaceRoot } from "@agent-gateway/worker";
import type { PgBoss } from "pg-boss";
import { type BackupCheckReport, checkBackup, localPgTools } from "./backup.ts";
import { loadConfigDirectory } from "./config-files.ts";
import { gmailAuthorize } from "./gmail-commands.ts";
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

  version                             this build's version and the migrations it ships
  health | doctor                     check database, migrations, queues and controls
  db migrate                          apply database and queue migrations, then certify the
                                      releases that may run on the result (stop services first)
  db status                           the database's migrations, the releases certified for
                                      them, and whether this build may run (exit 1 if not)
  db create-role <role> <url-file>    create a login role (or give it a new password) and write
                                      its connection URL to <url-file> (mode 0600)
  db grant-worker <role> <adapter>    limit an existing role to one adapter's worker jobs
  db grant-tool-runner <role> <namespace>[,<namespace>...]
                                      limit an existing role to the tool actions of these
                                      namespaces (e.g. finance) and their begin check
  config validate <dir> [--root .]    validate organization.yaml and agents/*.yaml
  config apply <dir> [--root .] [--mock-runtimes]
                                      store the configuration as the active version;
                                      --mock-runtimes runs every agent on the mock runtime
  directory set <channel|user|team> <name> <mattermost-id>
  agents list | show <id> | enable <id> | disable <id> | pause <id> | resume <id>
  runtimes list                       worker availability and runtime versions per adapter
  runs list [--agent <id>] | show <run-id> | cancel <run-id> | redrive <run-id>
  waits list
  events show <id> | ingest <file.json>
  dlq list | redrive <dlq-name> <job-id>
  outbox list [--status <status>] | redrive <outbox-id>
  approvals list [--status <status>]  approval requests and how their execution went
  tools list [--open]                 tool actions (--open: queued, running or unknown)
  tools settle <action-id> <succeeded|failed|cancelled> --note <text>
                                      record what an unknown action did, after checking the
                                      provider by its idempotency key
  budgets                             today's usage (UTC) per agent and in total, and holds
  memory list [--status <status>] [--namespace <ns>] [--limit <n>] [--offset <n>]
  memory accept <id> | reject <id>    review memory proposals to shared namespaces
                                      (proposed items are listed oldest first)
  mattermost bootstrap --secrets-dir <dir> [--rotate-tokens]
                                      resolve team, channels and owners, create the bots and
                                      their memberships, store tokens in <dir> (needs
                                      MATTERMOST_URL and a temporary MATTERMOST_ADMIN_TOKEN)
  mattermost reconcile [--secrets-dir <dir>]
                                      check tokens, bot accounts and memberships
  gmail authorize --out <file> [--port <n>] [--pubsub]
                                      consent for the Gmail connector (read mail; --pubsub also
                                      pulls its notifications); stores the refresh token in
                                      <file> (needs GMAIL_OAUTH_CLIENT_ID and
                                      GMAIL_OAUTH_CLIENT_SECRET[_FILE])
  gmail status                        cursor, watch and last sync of each watched mailbox
  gmail reset <mailbox-id>            forget a mailbox's cursor (e.g. after authorizing another
                                      account); its connector starts it anew at the present
  runtime doctor <adapter> [--model <id>]
                                      preflight of a runtime on this host, configured like
                                      its worker: version, auth, a real structured turn,
                                      cancel, session resume, policy risks (spends turns)
  backup check [--dir <dir>] [--max-age-hours <n>] [--restore-test] [--record]
                                      verify the newest backup in BACKUP_DIR: manifest, age,
                                      checksum, identity, schema, archive; --restore-test
                                      restores it into BACKUP_RESTORE_DATABASE_URL (emptied
                                      first); --record stores the result, and the controller
                                      alerts on a failure or when checks stop passing
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

/** A mailbox not synced for three of its connector's sync intervals counts as failing. */
function gmailSyncStaleMs(syncSeconds: number | null): number {
	return 3 * (syncSeconds ?? 300) * 1000;
}

/** Opens database and queue connections for commands that need them. */
export async function openSession(): Promise<Session> {
	const connectionString = requireSetting("DATABASE_URL");
	const pool = createPool(connectionString, 2);
	const boss = createBoss(connectionString, "client");
	await boss.start();
	const log = createLogger({
		service: "cli",
		version: serviceVersion(),
		environment: "cli",
		level: "warn",
	});
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
		const certified = await migrateSchema({
			pool,
			connectionString,
			release: releaseVersion(),
			migrateQueues: () => migrateQueues(connectionString),
		});
		out.print(`migrations applied; certified releases: ${certified.join(", ")}`);
	} finally {
		await pool.end();
	}
}

async function doctor(session: Session, out: Output): Promise<boolean> {
	const { pool } = session.deps;
	const checks: { name: string; ok: boolean; detail: string }[] = [];
	await pool.query("select 1");
	checks.push({ name: "postgres", ok: true, detail: "reachable" });
	const schema = await schemaCompatibility(pool, releaseVersion());
	checks.push({ name: "migrations", ok: schema.ok, detail: schema.detail });
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
	// Only adapters with enabled agents or live workers are listed; an unavailable one degrades
	// its agents (their runs wait in the queue) and nothing else.
	for (const health of await runtimeHealth(session.deps)) {
		checks.push({
			name: `runtime:${health.adapter}`,
			ok: health.available,
			detail: health.available
				? `${health.readyWorkers} ready worker(s), ${health.runtimeVersions.join(", ")}`
				: `no ready worker${health.detail === null ? "" : `: ${health.detail}`}; its agents are degraded`,
		});
	}
	// A mailbox whose watch lapsed only gets mail through the periodic sync; one that stopped
	// syncing gets none.
	const now = Date.now();
	for (const mailbox of await listGmailMailboxes(session.deps)) {
		// The connector records its mode: only a mailbox with Pub/Sub needs a live watch.
		const pushed = mailbox.mode === "pubsub";
		const watchOk =
			!pushed || (mailbox.watchExpiresAt !== null && mailbox.watchExpiresAt.getTime() > now);
		const syncOk =
			mailbox.lastSyncAt !== null &&
			now - mailbox.lastSyncAt.getTime() <= gmailSyncStaleMs(mailbox.syncSeconds);
		const watch = !pushed
			? "polling"
			: watchOk
				? `watch until ${mailbox.watchExpiresAt?.toISOString()}`
				: "watch not active";
		checks.push({
			name: `gmail:${mailbox.mailboxId}`,
			ok: watchOk && syncOk,
			detail: `${watch}, last sync ${mailbox.lastSyncAt?.toISOString() ?? "never"}`,
		});
	}
	// Checks of tables and queues newer migrations create: skipped until they are applied.
	if (schema.ok) {
		// An action that began and never reported may or may not have happened: an operator checks
		// the provider. One overdue that the sweep has not settled means the controller is behind.
		const tools = await pool.query<{ unknown: number; overdue: number }>(
			`select count(*) filter (where status = 'unknown')::int as unknown,
			        count(*) filter (where status in ('queued', 'running') and deadline_at < now() - interval '30 minutes')::int as overdue
			   from tool_actions`,
		);
		const toolRow = tools.rows[0];
		checks.push({
			name: "tool_actions",
			ok: (toolRow?.unknown ?? 0) === 0 && (toolRow?.overdue ?? 0) === 0,
			detail: `${toolRow?.unknown ?? 0} with an unknown outcome, ${toolRow?.overdue ?? 0} overdue`,
		});
		const budgets = await budgetReport(session.deps);
		const held = budgets.agents.filter((agent) => agent.hold !== null);
		checks.push({
			name: "budgets",
			ok: held.length === 0,
			detail:
				held.length === 0
					? `no hold on ${budgets.day}`
					: `held on ${budgets.day}: ${held.map((agent) => `@${agent.agentId}`).join(", ")}`,
		});
		const firing = await pool.query<{ key: string }>(
			"select key from alert_states where state = 'firing' order by key",
		);
		checks.push({
			name: "alerts",
			ok: firing.rows.length === 0,
			detail:
				firing.rows.length === 0
					? "no condition holds"
					: `firing: ${firing.rows.map((alert) => alert.key).join(", ")}`,
		});
		// The controller applies retention hourly; a run that has not succeeded for three hours
		// means content piles up (and the alert sweep says so too).
		const [retention] = (
			await pool.query<{ last_success_at: Date | null; last_error_redacted: string | null }>(
				"select last_success_at, last_error_redacted from maintenance_status where task = 'retention'",
			)
		).rows;
		const retentionOk =
			retention === undefined ||
			(retention.last_success_at !== null &&
				now - retention.last_success_at.getTime() <= MAINTENANCE_STALE_MS);
		checks.push({
			name: "retention",
			ok: retentionOk,
			detail:
				retention === undefined
					? "not run yet (the controller runs it hourly)"
					: `last success ${retention.last_success_at?.toISOString() ?? "never"}${retention.last_error_redacted === null ? "" : `; last error: ${retention.last_error_redacted}`}`,
		});
	}
	for (const name of deadLetterQueues(RuntimeAdapterIdSchema.options)) {
		const jobs = await session.boss.findJobs(name, { queued: true }).catch(() => null);
		checks.push(
			jobs === null
				? { name, ok: false, detail: "queue missing; run 'gateway db migrate'" }
				: { name, ok: jobs.length === 0, detail: `${jobs.length} dead-lettered` },
		);
	}
	out.print(json({ checks }));
	return checks.every((check) => check.ok);
}

/**
 * Stores a backup check's result for the controller: it alerts while the last check failed, or
 * when none passed within the maximum age (a check that stopped running included).
 */
async function recordBackupCheck(report: BackupCheckReport, maxAgeHours: number): Promise<void> {
	const failed = report.checks.filter((check) => !check.ok);
	const session = await openSession();
	try {
		await recordMaintenanceResult(session.deps, "backup", {
			ok: report.ok,
			error: report.ok
				? null
				: `${report.backup === null ? "" : `${report.backup}: `}${failed
						.map((check) => `${check.name} (${check.detail})`)
						.join("; ")}`,
			detail: { max_age_hours: maxAgeHours, backup: report.backup },
		});
	} finally {
		await session.close();
	}
}

/** `gateway backup check`: verifies the newest backup; exit code 1 when a check fails. */
async function backupCheck(args: Readonly<string[]>, out: Output): Promise<number> {
	const dir = flag(args, "dir") ?? readSetting("BACKUP_DIR");
	if (dir === undefined) {
		throw new UsageError("missing --dir <dir> (or BACKUP_DIR)");
	}
	const hoursFlag = flag(args, "max-age-hours");
	const maxAgeHours =
		hoursFlag === null ? intSetting("BACKUP_MAX_AGE_HOURS", 26) : Number(hoursFlag);
	if (!Number.isInteger(maxAgeHours) || maxAgeHours < 1) {
		throw new UsageError("the maximum age must be a positive whole number of hours");
	}
	const now = new Date();
	const report = await checkBackup({
		dir: resolve(dir),
		maxAgeHours,
		restoreTest: args.includes("--restore-test"),
		liveUrl: readSetting("DATABASE_URL") ?? null,
		scratchUrl: readSetting("BACKUP_RESTORE_DATABASE_URL") ?? null,
		tools: localPgTools(),
		now,
	});
	out.print(json(report));
	if (args.includes("--record")) {
		await recordBackupCheck(report, maxAgeHours);
	}
	return report.ok ? 0 : 1;
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
	if (group === "version") {
		const local = await loadLocalSchema();
		out.print(
			json({
				version: serviceVersion(),
				release: releaseVersion(),
				migrations: local.migrations.length,
				schema_head: local.migrations.at(-1)?.tag ?? null,
			}),
		);
		return 0;
	}
	if (group === "db" && action === "status") {
		const pool = createPool(requireSetting("DATABASE_URL"), 1);
		try {
			const local = await loadLocalSchema();
			const state = await readSchemaState(pool);
			const release = releaseVersion();
			const compatibility = checkCompatibility(local, state, release);
			out.print(
				json({
					release,
					shipped_migrations: local.migrations.length,
					applied_migrations: state?.hashes.length ?? 0,
					certified_releases: state?.certified ?? [],
					compatible: compatibility.ok,
					detail: compatibility.detail,
				}),
			);
			return compatibility.ok ? 0 : 1;
		} finally {
			await pool.end();
		}
	}
	if (group === "db" && action === "create-role") {
		const connectionString = requireSetting("DATABASE_URL");
		const role = arg(args, 2, "role");
		const urlFile = arg(args, 3, "url-file");
		const password = randomBytes(24).toString("base64url");
		// The URL first: a role whose URL could not be written would have a password nobody has.
		const url = new URL(connectionString);
		url.username = role;
		url.password = password;
		const pool = createPool(connectionString, 1);
		try {
			await createLoginRole(pool, role, password);
		} finally {
			await pool.end();
		}
		writeSecretFile(urlFile, url.toString());
		out.print(`role ${role} can log in; its connection URL is in ${urlFile}`);
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
	if (group === "db" && action === "grant-tool-runner") {
		const namespaces = arg(args, 3, "namespace")
			.split(",")
			.map((name) => ToolNamespaceSchema.parse(name.trim()));
		const pool = createPool(requireSetting("DATABASE_URL"), 1);
		try {
			await grantToolRunnerRole(
				pool,
				arg(args, 2, "role"),
				namespaces.map((namespace) => ({
					run: toolExecuteQueue(namespace),
					report: toolReportQueue(namespace),
					deadLetter: toolDeadLetterQueue(namespace),
				})),
			);
		} finally {
			await pool.end();
		}
		out.print(`tool runner role limited to ${namespaces.join(", ")}`);
		return 0;
	}
	if (group === "gmail" && action === "authorize") {
		const file = flag(args, "out");
		if (file === null) {
			throw new UsageError("missing --out <file>");
		}
		const portFlag = flag(args, "port");
		const port = portFlag === null ? null : Number(portFlag);
		if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
			throw new UsageError("--port must be an integer from 1 to 65535");
		}
		await gmailAuthorize(
			{
				client: {
					clientId: requireSetting("GMAIL_OAUTH_CLIENT_ID"),
					clientSecret: requireSetting("GMAIL_OAUTH_CLIENT_SECRET"),
				},
				out: resolve(file),
				endpoints: GOOGLE_ENDPOINTS,
				pubsub: args.includes("--pubsub"),
				...(port === null ? {} : { port }),
			},
			out.print,
		);
		return 0;
	}
	if (group === "runtime" && action === "doctor") {
		const adapter = RuntimeAdapterIdSchema.parse(arg(args, 2, "adapter"));
		const report = await runtimeDoctor(createRuntimeAdapter(adapter), {
			workspaceRoot: workspaceRoot(),
			model: flag(args, "model"),
		});
		out.print(json(report));
		return report.ok ? 0 : 1;
	}
	if (group === "backup" && action === "check") {
		return backupCheck(args, out);
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

/** Session commands that run whether or not this release may run against the schema. */
const SCHEMA_EXEMPT_COMMANDS: Readonly<string[]> = ["health", "doctor", "kill-all"];

async function runSessionCommand(
	session: Session,
	args: Readonly<string[]>,
	out: Output,
): Promise<number> {
	const { deps, boss } = session;
	const [group, action] = args;
	const who = actor();
	// A flag after the group (`kill-all --release`) is not an action.
	const command =
		action === undefined || action.startsWith("--") ? `${group}` : `${group} ${action}`;
	// The doctor reports an incompatible schema; kill-all must work whatever the schema.
	if (!SCHEMA_EXEMPT_COMMANDS.includes(command)) {
		const schema = await schemaCompatibility(deps.pool, releaseVersion());
		if (!schema.ok) {
			throw new Error(`this CLI cannot run against this database: ${schema.detail}`);
		}
	}
	switch (command) {
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
			out.print(json(await listAgents(deps)));
			return 0;
		case "runtimes list":
			out.print(json(await runtimeHealth(deps)));
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
		case "memory list": {
			const status = flag(args, "status");
			const valid = MEMORY_REVIEW_STATUSES.find((s) => s === status);
			if (status !== null && valid === undefined) {
				throw new UsageError(`--status must be one of ${MEMORY_REVIEW_STATUSES.join(", ")}`);
			}
			const count = (name: string, fallback: number, max: number) => {
				const raw = flag(args, name);
				const value = raw === null ? fallback : Number(raw);
				if (!Number.isInteger(value) || value < 0 || value > max) {
					throw new UsageError(`--${name} must be an integer from 0 to ${max}`);
				}
				return value;
			};
			const entries = await listMemory(deps, {
				status: valid ?? null,
				namespace: flag(args, "namespace"),
				oldestFirst: valid === "proposed",
				limit: count("limit", 100, 1000),
				offset: count("offset", 0, 1_000_000),
			});
			out.print(json(entries));
			return 0;
		}
		case "memory accept":
		case "memory reject": {
			const decision = args[1] === "accept" ? "accept" : "reject";
			await decideMemory(deps, arg(args, 2, "id"), decision, who);
			out.print(`memory item ${decision === "accept" ? "accepted" : "rejected"}`);
			return 0;
		}
		case "gmail status":
			out.print(json(await listGmailMailboxes(deps)));
			return 0;
		case "gmail reset": {
			const mailbox = GmailMailboxIdSchema.parse(arg(args, 2, "mailbox-id"));
			const reset = await resetGmailMailbox(deps, mailbox, who);
			out.print(
				reset
					? `mailbox '${mailbox}' reset; restart its connector to start it anew`
					: `mailbox '${mailbox}' has no stored state`,
			);
			return 0;
		}
		case "approvals list":
			out.print(json(await listApprovals(deps, flag(args, "status"))));
			return 0;
		case "tools list":
			out.print(json(await listToolActions(deps, args.includes("--open"))));
			return 0;
		case "tools settle": {
			const outcome = arg(args, 3, "outcome");
			if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "cancelled") {
				throw new UsageError("the outcome is succeeded, failed or cancelled");
			}
			const note = flag(args, "note");
			if (note === null) {
				throw new UsageError("missing --note <text>: what the provider says");
			}
			const settled = await settleToolAction(deps, arg(args, 2, "action-id"), outcome, who, note);
			out.print(`tool action ${settled.id} settled as ${settled.status}`);
			return 0;
		}
		case "budgets":
			out.print(json(await budgetReport(deps)));
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
