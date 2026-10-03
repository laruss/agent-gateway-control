import { randomBytes } from "node:crypto";
import { renameSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { GOOGLE_ENDPOINTS } from "@agent-gateway/connector-gmail";
import {
	CONSOLE_PASSWORD_HASH_SECRET_FILE,
	GatewayEventSchema,
	GmailMailboxIdSchema,
	MATTERMOST_ADMIN_TOKEN_SECRET_FILE,
	MattermostIdSchema,
	QUEUES,
	type RequestAgentCreateInput,
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
	type AdoptAgentResult,
	ackConfigRevision,
	activeConfigRevisionId,
	adoptAgentToolAttachments,
	applyConfig,
	budgetReport,
	type CancelledJob,
	type ConfigApplyInput,
	type ControlPlaneDeps,
	cancelRun,
	configBundleProblems,
	configHistoryNeedsBackfill,
	decideMemory,
	ensureAgentLifecycleAdoption,
	ensureConfigHistory,
	ensureToolAttachmentsReconciled,
	ensureToolCatalogSeeded,
	ingestEvent,
	inTransaction,
	killAll,
	listAgents,
	listApprovals,
	listGmailMailboxes,
	listLifecycleOperations,
	listMemory,
	listOutbox,
	listRuns,
	listToolActions,
	listWaits,
	loadActiveBundle,
	loadAgentChannelAssignments,
	MAINTENANCE_STALE_MS,
	MEMORY_REVIEW_STATUSES,
	pauseAgent,
	recordMaintenanceResult,
	redriveOutbox,
	redriveRun,
	releaseKillSwitch,
	requestAgentCreate,
	requestAgentRestore,
	requestAgentRetire,
	requestOperationRetry,
	resetGmailMailbox,
	resumeAgent,
	revokeChannelGrant,
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
	type DeploymentLock,
	grantToolRunnerRole,
	grantWorkerRole,
	holdDeploymentLock,
	loadLocalSchema,
	migrateSchema,
	OUTBOX_STATUSES,
	type OutboxStatus,
	readSchemaState,
	schemaCompatibility,
} from "@agent-gateway/db";
import { createLogger, redactText, releaseVersion, serviceVersion } from "@agent-gateway/logging";
import {
	createBoss,
	deadLetterQueues,
	migrateQueues,
	transactionalJobSink,
} from "@agent-gateway/queue";
import { runtimeDoctor } from "@agent-gateway/runtime-sdk";
import {
	intSetting,
	readOptionalFileSetting,
	readSetting,
	requireSetting,
	resolveCustomToolSecretPath,
	resolveSecretPath,
	secretFileExists,
	writeSecretFile,
} from "@agent-gateway/service";
import { createRuntimeAdapter, workspaceRoot } from "@agent-gateway/worker";
import type { PgBoss } from "pg-boss";
import { type BackupCheckReport, checkBackup, localPgTools } from "./backup.ts";
import {
	configDiffCommand,
	configExport,
	configHistory,
	configImport,
	configRollback,
} from "./config-commands.ts";
import { loadConfigDirectory, readPromptFile } from "./config-files.ts";
import {
	consolePasswordSet,
	nodeHiddenReader,
	revokeConsoleSessionsAfterRotation,
} from "./console-commands.ts";
import { createCustomTool, customToolSecretSet, editCustomTool } from "./custom-tool-commands.ts";
import { gmailAuthorize } from "./gmail-commands.ts";
import {
	mattermostAdminTokenRotate,
	mattermostAdminTokenSet,
	mattermostBootstrap,
	mattermostReconcile,
} from "./mattermost-commands.ts";

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
                                      deprecated: 'config import' against the current revision,
                                      without --expected-revision (existing scripts keep working;
                                      --mock-runtimes runs every agent on the mock runtime)
  config export <dir> [--revision <id>]
                                      write the active (or given) revision's snapshot as a config
                                      directory: organization.yaml, agents/<id>.yaml, their prompt
                                      files under prompts/, and a manifest.json; import it with
                                      --root set to this same <dir>. <dir> must not exist yet, or
                                      must already be empty; remove an old export yourself first
  config diff <dir> [--root .] [--json]
                                      preview <dir> as a change against the active configuration
                                      (read-only); --json prints the raw preview
  config import <dir> [--root .] [--expected-revision <id>] [--reason <text>]
                                      replace the active configuration with <dir>'s content;
                                      --expected-revision is required unless the database has no
                                      active configuration yet (run 'config diff' first to see
                                      what would change)
  config history [--limit N]          recent revisions: id, created, actor, source, a shortened
                                      snapshot hash, parent and reason (default 20, max 500)
  config rollback <revision-id> --expected-revision <id> [--reason <text>]
                                      commit a new revision whose content is <revision-id>'s own
                                      snapshot (never a pointer reset); prints the diff first
  config ack <revision-id>            acknowledge a 'backfill' revision (configuration changed
                                      outside revision history); clears the 'config:backfill'
                                      alert and doctor's 'config_history' check for it, since
                                      recommitting its own content alone is a no-op
  directory set <channel|user|team> <name> <mattermost-id>
  agents list | show <id> | enable <id> | disable <id> | pause <id> | resume <id>
  agents create <id> --display-name <name> --role-prompt-file <prompts/....md>
                [--channel <name>]... [--root .] [--runtime <adapter>] [--model <id>]
                                      provision a new agent's Mattermost bot automatically (no
                                      bootstrap needed): commits its configuration and starts the
                                      lifecycle provisioner, which creates the bot, its token and
                                      its channel memberships; 'agents operations' follows along
  agents operations [--agent <id>]    lifecycle operations (create/retire/restore/reprovision),
                                      newest first: state, checkpoints and error, if any
  agents retire <id> [--reason <text>] [--reassign-finance-to <id>]
                                      cancels its runs/waits/approvals, revokes its channel
                                      grants, blocks its pending deliveries, then asks the
                                      provisioner to deactivate its bot; refused for the
                                      organization's finance agent without --reassign-finance-to
  agents restore <id> [--make-finance-agent]
                                      re-adds a retired agent's last configuration (pending ->
                                      provisioning again); the provisioner re-enables its bot.
                                      A former finance agent's permissions are normalized unless
                                      --make-finance-agent reassigns the role back to it atomically
  agents retry <id>                   queues a fresh attempt of a failed create/restore/
                                      reprovision operation, or a retiring agent's own failed
                                      retire cleanup; carries forward whatever it already
                                      checkpointed, so a completed step is not repeated
  agents channels <id>                its channels with provenance: configured vs granted
                                      (by whom, when, evidence post) vs member-unauthorized
  agents revoke-grant <id> <channel>  revokes a channel an owner or admin granted the agent's bot
                                      directly; the bot is removed from it (provisioner/listener)
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
  tools adopt <agent-id>|--all [--dry-run] [--reason <text>]
                                      explicit migration (ADR-027): converts a legacy agent's
                                      permissions into real catalog attachments, one committed
                                      revision per agent (never implicit); prints unresolved
                                      patterns and the before/after effective permissions;
                                      --dry-run previews without committing; an agent already
                                      managed through the hub is left untouched
  tools secret set <alias> [--secrets-dir <dir>]
                                      hidden entry, confirmed: set a custom HTTPS tool's named
                                      secret (an API key, a bearer token), written verbatim to
                                      the tool runner's custom-tool secrets mount; restart the
                                      tool runner to pick it up
  tools custom create <entry-id> --name <name> --description <text>
                --definition <file.json>
                                      defines a new owner-managed custom HTTPS tool (ADR-027):
                                      fixed destination/method, typed parameters mapped into
                                      encoded path/query/header/body slots, named secrets (by
                                      alias, never a value), response limits; a write without a
                                      declared idempotency header is refused
  tools custom edit <entry-id> [--name <name>] [--description <text>]
                [--definition <file.json>]
                                      publishes a new immutable version; any approval still
                                      pending against the entry's previous version is refused
                                      at grant time, never silently executed against this one
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
  mattermost admin-token set [--secrets-dir <dir>]
                                      hidden entry: store a personal access token of a dedicated,
                                      non-bot Mattermost system-admin account (validated: must
                                      have the 'system_admin' role) for the lifecycle provisioner
                                      to create agent bots with, without a temporary admin token
  mattermost admin-token rotate [--secrets-dir <dir>]
                                      create-verify-switch-revoke: issue a new personal access
                                      token for the same account, verify it, switch to it, then
                                      revoke every other token on the account (do this every 90
                                      days; needs MATTERMOST_URL and the current admin token)
  gmail authorize --out <file> [--port <n>] [--pubsub]
                                      consent for the Gmail connector (read mail; --pubsub also
                                      pulls its notifications); stores the refresh token in
                                      <file> (needs GMAIL_OAUTH_CLIENT_ID and
                                      GMAIL_OAUTH_CLIENT_SECRET[_FILE])
  gmail status                        cursor, watch and last sync of each watched mailbox
  gmail reset <mailbox-id>            forget a mailbox's cursor (e.g. after authorizing another
                                      account); its connector starts it anew at the present
  console password set [--secrets-dir <dir>]
                                      hidden entry, confirmed: set the console's sign-in
                                      password (only its Argon2id hash is stored); revokes every
                                      active session if the database is reachable, and restart
                                      the controller to apply it everywhere else
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

/** `gateway outbox list --status <status>`'s own validation: `null` for no flag at all, the
 * matching status otherwise, refusing anything not in {@link OUTBOX_STATUSES} — kept in sync with
 * that shared, authoritative list (the same one the database's own check constraint enforces,
 * `@agent-gateway/db`) rather than a second, separately maintained one that can drift from it and
 * silently refuse a real status (`cancelled`, added for a retired agent's own blocked deliveries,
 * ADR-026). Exported so this one rule is tested without a database. */
export function parseOutboxStatusFlag(status: string | null): OutboxStatus | null {
	const valid = OUTBOX_STATUSES.find((candidate) => candidate === status);
	if (status !== null && valid === undefined) {
		throw new UsageError(`--status must be one of ${OUTBOX_STATUSES.join(", ")}`);
	}
	return valid ?? null;
}

/** Every value of a flag given more than once (`--channel hq --channel research`), in order. */
function flagsAll(args: Readonly<string[]>, name: string): Readonly<string[]> {
	const values: string[] = [];
	for (const [index, token] of args.entries()) {
		if (token === `--${name}`) {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new UsageError(`--${name} needs a value`);
			}
			values.push(value);
		}
	}
	return values;
}

/**
 * `gateway agents create`'s own arguments, turned into a `requestAgentCreate` input: reads the
 * role prompt file (a `prompts/<...>.md` path, relative to `root`) and assembles the rest from
 * flags, leaving `mattermost.token_secret_file`, `runtime` and `permissions` for the service to
 * default — `permissions` in particular needs the active organization's `finance_agent_id`
 * (`defaultAgentPermissions`, `config-bundle.ts`) to know whether the new agent must deny
 * `finance.*`, which this builder has no database access to read. No database or network access
 * otherwise, so a test can call it directly with a `root` of its own.
 */
export function buildAgentCreateRequest(
	args: Readonly<string[]>,
	root: string,
	actor: string,
): RequestAgentCreateInput {
	const id = arg(args, 2, "id");
	const displayName = flag(args, "display-name");
	if (displayName === null) {
		throw new UsageError("missing --display-name <name>");
	}
	const rolePromptFile = flag(args, "role-prompt-file");
	if (rolePromptFile === null) {
		throw new UsageError(
			"missing --role-prompt-file <path> (a 'prompts/<...>.md' path, relative to --root)",
		);
	}
	const runtimeFlag = flag(args, "runtime");
	const modelFlag = flag(args, "model");
	const runtime =
		runtimeFlag === null && modelFlag === null
			? undefined
			: {
					...(runtimeFlag === null ? {} : { adapter: RuntimeAdapterIdSchema.parse(runtimeFlag) }),
					...(modelFlag === null ? {} : { model: modelFlag }),
				};
	return {
		agent: {
			id,
			display_name: displayName,
			mattermost: { username: id, allowed_channels: [...flagsAll(args, "channel")] },
			...(runtime === undefined ? {} : { runtime }),
			prompts: { role_file: rolePromptFile },
			wake_rules: [{ event_type: "mattermost.agent.mentioned", target_agent_id: id }],
			concurrency: { while_running: "enqueue" },
			memory: { private_namespace: `agents/${id}`, shared_namespaces: [] },
		},
		rolePrompt: readPromptFile(root, rolePromptFile),
		actor,
		source: "cli",
	};
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

export async function doctor(session: Session, out: Output): Promise<boolean> {
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
		// The lifecycle provisioner (ADR-026) is idle with no admin token configured: a
		// `create`/`restore`/`reprovision` operation stays `pending` indefinitely until one is set —
		// and so does a `retire`, driven by the very same tick (`runProvisionerPass`'s own
		// `processRetireOperation` loop, gated on the same admin token as `processOperation`).
		const adminTokenConfigured = readOptionalFileSetting("MATTERMOST_ADMIN_TOKEN") !== undefined;
		const waiting = await pool.query<{ n: number }>(
			`select count(*)::int as n from agent_lifecycle_operations
			  where state in ('pending', 'running')
			    and kind in ('create', 'restore', 'reprovision', 'retire')`,
		);
		const waitingCount = waiting.rows[0]?.n ?? 0;
		checks.push({
			name: "mattermost_provisioning",
			ok: adminTokenConfigured || waitingCount === 0,
			detail: adminTokenConfigured
				? `admin token configured; ${waitingCount} operation(s) in progress`
				: `no Mattermost admin token configured; ${waitingCount} operation(s) waiting ` +
					"('gateway mattermost admin-token set')",
		});
		// An agent's own current operation left `failed`: a stuck `create`/`restore` (the agent
		// itself `failed`) or `retire` (`retiring` with its own cleanup stuck) already show up as the
		// agent's own status, but a failed `reprovision` never moves its agent out of `ready`
		// (ADR-026) — invisible from `gateway agents list` alone, and easy to miss without this,
		// since nothing else about a `ready` agent says one of its own operations needs attention.
		const failedLifecycle = await pool.query<{ n: number }>(
			`select count(*)::int as n
			   from agent_lifecycle al
			   join agent_lifecycle_operations op on op.id = al.operation_id
			  where op.state = 'failed'`,
		);
		const failedLifecycleCount = failedLifecycle.rows[0]?.n ?? 0;
		checks.push({
			name: "lifecycle_failures",
			ok: failedLifecycleCount === 0,
			detail:
				`${failedLifecycleCount} agent(s) with a failed lifecycle operation` +
				(failedLifecycleCount === 0 ? "" : " ('gateway agents retry <id>')"),
		});
		// A retiring agent's own Mattermost-side cleanup was skipped because a plain bot at its
		// configured username matched no admin account this Gateway has on record, current or past
		// (`owner_unverified`, ADR-026): a confirmed, legitimate outcome (the username belongs to a
		// stranger's bot, or to an account that is not plausibly the Gateway's own plain bot at all),
		// not an unresolved one — the agent is still correctly `retired` either way, and there is
		// nothing left to clean up for it. Surfaced for a human look, never failing doctor over it.
		const ambiguousRetirements = await pool.query<{ n: number }>(
			`select count(*)::int as n
			   from agent_lifecycle al
			   join agent_lifecycle_operations op on op.id = al.operation_id
			  where op.kind = 'retire' and op.checkpoints ->> 'owner_unverified' = 'true'`,
		);
		const ambiguousRetirementCount = ambiguousRetirements.rows[0]?.n ?? 0;
		checks.push({
			name: "lifecycle_retire_ownership",
			ok: true,
			detail:
				`${ambiguousRetirementCount} retired agent(s) whose own bot's Mattermost-side cleanup ` +
				"was skipped because its username belonged to an account this Gateway never created; " +
				"nothing was left to clean up for them",
		});
		// `doctor` never runs `ensureConfigHistory` itself (it is read-only), so right after a
		// forward upgrade the journal's latest entry can still look exactly as it did before the
		// upgrade even though the live projections have already drifted (see
		// `configHistoryNeedsBackfill`): checked first, since the second check below (the latest
		// entry already recorded as a drifted backfill) can only ever be true once that backfill
		// has actually run.
		const needsBackfill = await configHistoryNeedsBackfill(session.deps);
		// Checked directly, not only through the alert sweep (which may not have run since a
		// drift just got backfilled): the most recently recorded revision is a `backfill` with a
		// parent, meaning a release before this one changed `config_versions`/`agents` outside the
		// revision journal (most likely during a rollback interval; see `ensureConfigHistoryIn`). A
		// parentless `backfill` is the ordinary first entry a database upgraded from before
		// configuration history existed gets, not a sign of drift.
		const [latestRevision] = (
			await pool.query<{
				id: number;
				source: string;
				generation: number;
				parent_revision_id: number | null;
			}>(
				`select id::int as id, source, generation::int as generation,
				        parent_revision_id::int as parent_revision_id
				   from config_revisions order by id desc limit 1`,
			)
		).rows;
		const recordedDrift =
			latestRevision?.source === "backfill" && latestRevision.parent_revision_id !== null;
		// A faithful recommit of the drifted content is a no-op (`commitChange`), so reviewing it
		// alone never clears this check; an explicit `gateway config ack` does.
		const acked =
			!recordedDrift || latestRevision === undefined
				? false
				: ((
						await pool.query<{ n: number }>(
							"select count(*)::int as n from config_revision_acks where revision_id = $1",
							[latestRevision.id],
						)
					).rows[0]?.n ?? 0) > 0;
		const configDrift = needsBackfill || (recordedDrift && !acked);
		checks.push({
			name: "config_history",
			ok: !configDrift,
			detail: needsBackfill
				? "configuration changed outside revision history; it will be recorded as a backfill " +
					"revision on the next controller start or config command"
				: !recordedDrift
					? "no drift since the last recorded revision"
					: acked
						? `configuration changed outside revision history at generation ${latestRevision?.generation}; ` +
							`recorded as revision ${latestRevision?.id} (backfill); acknowledged`
						: `configuration changed outside revision history at generation ${latestRevision?.generation}; ` +
							`recorded as revision ${latestRevision?.id} (backfill); review with 'gateway config diff'/'history', ` +
							`then 'gateway config ack ${latestRevision?.id}'`,
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
	let lock: DeploymentLock | undefined;
	try {
		lock = await holdDeploymentLock(requireSetting("DATABASE_URL"), exitOnLostLock);
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
		await lock?.release();
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
		const url = new URL(connectionString);
		url.username = role;
		url.password = password;
		// The new URL is written beside the old one first and replaces it only once the password
		// changed: a failure on either side never leaves the service a URL that no longer works.
		const pending = `${urlFile}.pending`;
		// A pending file left by an interrupted rotation may hold the only working URL.
		if (secretFileExists(pending)) {
			throw new Error(`${pending} is left from an earlier change; move it to ${urlFile} first`);
		}
		writeSecretFile(pending, url.toString());
		const pool = createPool(connectionString, 1);
		try {
			await createLoginRole(pool, role, password);
		} catch (error) {
			rmSync(pending, { force: true });
			throw error;
		} finally {
			await pool.end();
		}
		try {
			renameSync(pending, urlFile);
		} catch (error) {
			throw new Error(
				`the password changed, but ${urlFile} could not be replaced; the working URL is in ${pending}: move it there`,
				{ cause: error },
			);
		}
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
	if (group === "console" && action === "password" && args[2] === "set") {
		const secretsDirFlag = flag(args, "secrets-dir") ?? readSetting("SECRETS_DIR");
		const secretsDir = secretsDirFlag === undefined ? undefined : resolve(secretsDirFlag);
		await consolePasswordSet(
			{
				secretPath: resolveSecretPath(CONSOLE_PASSWORD_HASH_SECRET_FILE, secretsDir),
				reader: nodeHiddenReader(),
			},
			out.print,
		);
		// A rotated password invalidates every session bound to the old hash through its
		// `password_hash_fingerprint` (ADR-025), but only once the controller restarts and
		// re-reads the file. When the database is reachable from here, every active session is
		// also revoked directly, so the rotation takes effect immediately instead of waiting for
		// that restart.
		const databaseUrl = readSetting("DATABASE_URL");
		if (databaseUrl !== undefined) {
			await revokeConsoleSessionsAfterRotation(databaseUrl, out.print);
		}
		return 0;
	}
	if (group === "tools" && action === "secret" && args[2] === "set") {
		const alias = args[3];
		if (alias === undefined) {
			throw new UsageError("missing <alias>");
		}
		const secretsDirFlag = flag(args, "secrets-dir") ?? readSetting("CUSTOM_TOOL_SECRETS_DIR");
		const secretsDir = secretsDirFlag === undefined ? undefined : resolve(secretsDirFlag);
		await customToolSecretSet(
			{
				alias,
				secretPath: resolveCustomToolSecretPath(alias, secretsDir),
				reader: nodeHiddenReader(),
			},
			out.print,
		);
		return 0;
	}
	if (group === "mattermost" && action === "admin-token" && args[2] === "set") {
		const secretsDirFlag = flag(args, "secrets-dir") ?? readSetting("SECRETS_DIR");
		const secretsDir = secretsDirFlag === undefined ? undefined : resolve(secretsDirFlag);
		// A lightweight pool of its own, like `db status`'s own one-off commands: this command needs
		// the database only to hold the admin-token lock (ADR-026), never a full session.
		const pool = createPool(requireSetting("DATABASE_URL"), 1);
		try {
			await mattermostAdminTokenSet(
				{
					baseUrl: requireSetting("MATTERMOST_URL"),
					secretPath: resolveSecretPath(MATTERMOST_ADMIN_TOKEN_SECRET_FILE, secretsDir),
					reader: nodeHiddenReader(),
					pool,
				},
				out.print,
			);
		} finally {
			await pool.end();
		}
		return 0;
	}
	if (group === "mattermost" && action === "admin-token" && args[2] === "rotate") {
		const secretsDirFlag = flag(args, "secrets-dir") ?? readSetting("SECRETS_DIR");
		const secretsDir = secretsDirFlag === undefined ? undefined : resolve(secretsDirFlag);
		const pool = createPool(requireSetting("DATABASE_URL"), 1);
		try {
			await mattermostAdminTokenRotate(
				{
					baseUrl: requireSetting("MATTERMOST_URL"),
					secretPath: resolveSecretPath(MATTERMOST_ADMIN_TOKEN_SECRET_FILE, secretsDir),
					pool,
				},
				out.print,
			);
		} finally {
			await pool.end();
		}
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

/** A command that lost the deployment lock stops at once: a migration may start now. */
function exitOnLostLock(error: Error): void {
	process.stderr.write(
		`gateway: the deployment lock was lost (${redactText(error.message)}); stopping\n`,
	);
	process.exit(1);
}

/** Session commands that run whether or not this release may run against the schema. */
const SCHEMA_EXEMPT_COMMANDS: Readonly<string[]> = ["health", "doctor", "kill-all"];
/** Read-only reports: they need no deployment lock and run during a migration too. */
const READ_ONLY_COMMANDS: Readonly<string[]> = ["health", "doctor"];

async function runSessionCommand(
	session: Session,
	args: Readonly<string[]>,
	out: Output,
): Promise<number> {
	const [group, action] = args;
	// A flag after the group (`kill-all --release`) is not an action.
	const command =
		action === undefined || action.startsWith("--") ? `${group}` : `${group} ${action}`;
	if (READ_ONLY_COMMANDS.includes(command)) {
		return dispatchSessionCommand(session, command, args, out);
	}
	// Like a service, a command that writes holds the deployment lock: no migration runs under
	// it. The doctor reports an incompatible schema; kill-all works whatever the schema.
	const lock = await holdDeploymentLock(requireSetting("DATABASE_URL"), exitOnLostLock);
	try {
		if (!SCHEMA_EXEMPT_COMMANDS.includes(command)) {
			const schema = await schemaCompatibility(session.deps.pool, releaseVersion());
			if (!schema.ok) {
				throw new Error(`this CLI cannot run against this database: ${schema.detail}`);
			}
			// Backfills configuration history once the schema is confirmed compatible, so every
			// command past this point — not just `config apply` — sees an up-to-date base revision
			// (a console or `gateway agents enable|disable` reads it through `prepareChange`).
			await ensureConfigHistory(session.deps, actor());
			// ADR-027: reconciles `catalog_attachments`/`agents.tool_attachments_managed` back to the
			// active revision's own attachments document, in case a release before ADR-027 changed
			// the active configuration during a rollback interval.
			await ensureToolAttachmentsReconciled(session.deps, actor());
			// ADR-026: adopts every configured agent that has no `agent_lifecycle` row yet.
			await ensureAgentLifecycleAdoption(session.deps, actor());
			// ADR-027: seeds every built-in catalog entry this release ships.
			await ensureToolCatalogSeeded(session.deps, actor());
		}
		return await dispatchSessionCommand(session, command, args, out);
	} finally {
		await lock.release();
	}
}

/** Exported so integration tests can exercise one command's dispatch (argument parsing, the
 * actual service call, its printed output and exit code) directly against a manually-built
 * `Session`, the same way `doctor` already is — without `runCommand`'s own `DATABASE_URL`/
 * deployment-lock machinery, which exists for the real CLI entrypoint, not for testing one
 * command's own logic in isolation. */
export async function dispatchSessionCommand(
	session: Session,
	command: string,
	args: Readonly<string[]>,
	out: Output,
): Promise<number> {
	const { deps, boss } = session;
	const [, action] = args;
	const who = actor();
	switch (command) {
		case "health":
		case "doctor":
			return (await doctor(session, out)) ? 0 : 1;
		case "config apply": {
			process.stderr.write(
				"gateway: 'config apply' is deprecated; use 'config import --expected-revision <id>' " +
					"(see 'gateway config history' for the current id)\n",
			);
			const loaded = loadConfigDirectory(arg(args, 2, "dir"), resolve(flag(args, "root") ?? "."));
			const input = args.includes("--mock-runtimes") ? withMockRuntimes(loaded) : loaded;
			out.print(json(await applyConfig(deps, input, who)));
			return 0;
		}
		case "config export": {
			const dir = arg(args, 2, "dir");
			const revisionFlag = flag(args, "revision");
			let revisionId: number | null = null;
			if (revisionFlag !== null) {
				revisionId = Number(revisionFlag);
				if (!Number.isInteger(revisionId) || revisionId < 1) {
					throw new UsageError("--revision must be a positive integer");
				}
			}
			await configExport(deps, { dir, revisionId }, out.print);
			return 0;
		}
		case "config diff": {
			const dir = arg(args, 2, "dir");
			const root = resolve(flag(args, "root") ?? ".");
			const ok = await configDiffCommand(
				deps,
				{ dir, root, json: args.includes("--json") },
				out.print,
			);
			return ok ? 0 : 1;
		}
		case "config import": {
			const dir = arg(args, 2, "dir");
			const root = resolve(flag(args, "root") ?? ".");
			const expectedFlag = flag(args, "expected-revision");
			let expectedRevision: number | null = null;
			if (expectedFlag !== null) {
				expectedRevision = Number(expectedFlag);
				if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
					throw new UsageError("--expected-revision must be a positive integer");
				}
			}
			await configImport(
				deps,
				{ dir, root, expectedRevision, reason: flag(args, "reason"), actor: who },
				out.print,
			);
			return 0;
		}
		case "config history": {
			const limitFlag = flag(args, "limit");
			const limit = limitFlag === null ? 20 : Number(limitFlag);
			if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
				throw new UsageError("--limit must be an integer from 1 to 500");
			}
			await configHistory(deps, limit, out.print);
			return 0;
		}
		case "config rollback": {
			const revisionId = Number(arg(args, 2, "revision-id"));
			if (!Number.isInteger(revisionId) || revisionId < 1) {
				throw new UsageError("<revision-id> must be a positive integer");
			}
			const expectedFlag = flag(args, "expected-revision");
			if (expectedFlag === null) {
				throw new UsageError(
					"missing --expected-revision <id>: run 'gateway config history' first",
				);
			}
			const expectedRevision = Number(expectedFlag);
			if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
				throw new UsageError("--expected-revision must be a positive integer");
			}
			await configRollback(
				deps,
				{ revisionId, expectedRevision, reason: flag(args, "reason"), actor: who },
				out.print,
			);
			return 0;
		}
		case "config ack": {
			const revisionId = Number(arg(args, 2, "revision-id"));
			if (!Number.isInteger(revisionId) || revisionId < 1) {
				throw new UsageError("<revision-id> must be a positive integer");
			}
			await ackConfigRevision(deps, revisionId, who);
			out.print(`revision ${revisionId} acknowledged`);
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
		case "agents disable": {
			const agentId = arg(args, 2, "id");
			const { result, removed } = await setAgentEnabled(deps, agentId, action === "enable", who);
			if (removed) {
				out.print(
					`note: '${agentId}' could not be disabled without leaving the configuration invalid ` +
						"(its own retained configuration no longer validates); removed from it instead, " +
						"still disabled rather than deleted, visible in 'gateway config history'",
				);
			}
			out.print(json(result));
			return 0;
		}
		case "agents pause":
			await cancelJobs(boss, await pauseAgent(deps, arg(args, 2, "id"), who));
			out.print("paused");
			return 0;
		case "agents resume":
			out.print(await resumeAgent(deps, arg(args, 2, "id"), who));
			return 0;
		case "agents create": {
			const created = await requestAgentCreate(
				deps,
				buildAgentCreateRequest(args, resolve(flag(args, "root") ?? "."), who),
			);
			out.print(json(created));
			return 0;
		}
		case "agents operations": {
			const agentFlag = flag(args, "agent");
			out.print(json(await listLifecycleOperations(deps, agentFlag ?? undefined)));
			return 0;
		}
		case "agents retire": {
			const agentId = arg(args, 2, "id");
			const reasonFlag = flag(args, "reason");
			const reassignFlag = flag(args, "reassign-finance-to");
			const retired = await requestAgentRetire(deps, {
				agentId,
				actor: who,
				source: "cli",
				...(reasonFlag === null ? {} : { reason: reasonFlag }),
				...(reassignFlag === null ? {} : { reassignFinanceTo: reassignFlag }),
			});
			await cancelJobs(boss, retired.cancelledJobs);
			out.print(json(retired));
			return 0;
		}
		case "agents restore":
			out.print(
				json(
					await requestAgentRestore(deps, {
						agentId: arg(args, 2, "id"),
						actor: who,
						source: "cli",
						...(args.includes("--make-finance-agent") ? { makeFinanceAgent: true } : {}),
					}),
				),
			);
			return 0;
		case "agents retry":
			out.print(
				json(
					await requestOperationRetry(deps, {
						agentId: arg(args, 2, "id"),
						actor: who,
						source: "cli",
					}),
				),
			);
			return 0;
		case "agents channels":
			out.print(json(await loadAgentChannelAssignments(deps, arg(args, 2, "id"))));
			return 0;
		case "agents revoke-grant": {
			const agentId = arg(args, 2, "id");
			const channel = arg(args, 3, "channel");
			const assignments = await loadAgentChannelAssignments(deps, agentId);
			const match = assignments.find(
				(assignment) => assignment.channelName === channel || assignment.channelId === channel,
			);
			if (match === undefined) {
				throw new UsageError(`agent '${agentId}' has no channel '${channel}' to revoke`);
			}
			const stillFollowed = await revokeChannelGrant(deps, {
				agentId,
				channelId: match.channelId,
				actor: who,
			});
			out.print(
				json({ channelId: match.channelId, channelName: match.channelName, stillFollowed }),
			);
			return 0;
		}
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
			out.print(json(await listOutbox(deps, parseOutboxStatusFlag(flag(args, "status")))));
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
		case "tools adopt": {
			const target = args[2];
			if (target === undefined || (target.startsWith("--") && target !== "--all")) {
				throw new UsageError("missing <agent-id>|--all");
			}
			const dryRun = args.includes("--dry-run");
			const reason = flag(args, "reason");
			// `listAgents` reads every row of the `agents` projection, retired ones kept for history
			// (ADR-026) included; `--all` means every agent the *active configuration* actually
			// names, or adopting one no longer in it throws mid-batch (`adoptOneAgent`'s own "agent
			// does not exist", since it resolves against the active bundle, not the `agents` table).
			let agentIds: Readonly<string[]>;
			if (target === "--all") {
				const activeRevisionId = await activeConfigRevisionId(deps);
				const { bundle } = await inTransaction(deps, ({ tx }) =>
					loadActiveBundle(tx.db, activeRevisionId),
				);
				agentIds = bundle.agents.map((agent) => agent.id);
			} else {
				agentIds = [target];
			}
			const results: Readonly<AdoptAgentResult[]> = await adoptAgentToolAttachments(deps, {
				agentIds,
				dryRun,
				actor: who,
				...(reason === null ? {} : { reason }),
			});
			out.print(json(results));
			return results.some((result) => result.problems.length > 0) ? 1 : 0;
		}
		case "tools custom": {
			const subcommand = args[2];
			const entryId = args[3];
			if (entryId === undefined || entryId.startsWith("--")) {
				throw new UsageError("usage: tools custom create|edit <entry-id> ...");
			}
			const name = flag(args, "name");
			const description = flag(args, "description");
			const definitionFile = flag(args, "definition");
			if (subcommand === "create") {
				if (name === null || description === null || definitionFile === null) {
					throw new UsageError(
						"missing --name <name>, --description <text> or --definition <file.json>",
					);
				}
				await createCustomTool(deps, {
					entryId,
					name,
					description,
					definitionFile: resolve(definitionFile),
					actor: who,
				});
				out.print(`custom HTTPS tool '${entryId}' created`);
				return 0;
			}
			if (subcommand === "edit") {
				if (name === null && description === null && definitionFile === null) {
					throw new UsageError("nothing to edit: give --name, --description or --definition");
				}
				await editCustomTool(deps, {
					entryId,
					actor: who,
					...(name === null ? {} : { name }),
					...(description === null ? {} : { description }),
					...(definitionFile === null ? {} : { definitionFile: resolve(definitionFile) }),
				});
				out.print(`custom HTTPS tool '${entryId}' edited`);
				return 0;
			}
			throw new UsageError("usage: tools custom create|edit <entry-id> ...");
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
