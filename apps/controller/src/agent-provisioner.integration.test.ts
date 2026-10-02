import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, OrganizationConfig } from "@agent-gateway/contracts";
import { OrganizationConfigSchema } from "@agent-gateway/contracts";
import {
	activeConfigRevisionId,
	applyConfig,
	type ControlPlaneDeps,
	checkpointOperation,
	commitChange,
	grantChannel,
	markProvisioning,
	recordWorkerStatus,
	requestAgentCreate,
	setDirectoryEntry,
} from "@agent-gateway/core";
import { createPool, migrateSchema } from "@agent-gateway/db";
import { DEVELOPMENT_VERSION, type LogFields, silentLogger } from "@agent-gateway/logging";
import {
	type ApiBot,
	type ApiChannel,
	type ApiUser,
	MattermostApiError,
} from "@agent-gateway/mattermost";
import { createBoss, migrateQueues, transactionalJobSink } from "@agent-gateway/queue";
import { secretFileState } from "@agent-gateway/service";
import { startTestPostgres, type TestPostgres } from "@agent-gateway/testkit";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runProvisionerPass, startAgentProvisioner } from "./agent-provisioner.ts";

const TEAM = "lab";
const TEAM_ID = "team0000000000000000000000";
const CHANNEL_IDS = {
	hq: "hqchanne1000000000000000aa",
	research: "r3searchchanne10000000000a",
	// Granted (ADR-022), never organization-configured: see the reprovision "keeps a granted
	// channel" test below.
	ops: "0pschanne1000000000000000a",
} as const;

/** A 26-lowercase-alphanumeric `MattermostId`-shaped id, for fixtures that need one but whose
 * exact value is never read back. */
function fixedId(prefix: string): string {
	return (prefix + "0".repeat(26)).slice(0, 26);
}

function organization(): OrganizationConfig {
	return OrganizationConfigSchema.parse({
		schema_version: 1,
		organization: {
			id: "lab",
			display_name: "Lab",
			global_goal: "goal",
			constitution_file: "prompts/constitution.md",
			owner_mattermost_usernames: ["owner"],
			finance_agent_id: "finance",
			rules: [],
			default_limits: {
				max_agent_hops: 8,
				max_turns_per_cascade: 20,
				max_runs_per_agent_per_hour: 30,
				default_run_timeout_seconds: 1800,
			},
		},
		mattermost: {
			team: TEAM,
			channels: ["hq", "research"],
			approvals_channel: "hq",
			alerts_channel: "hq",
			listener: {
				username: "gateway-listener",
				token_secret_file: "/run/secrets/mm_listener_token",
			},
		},
	});
}

function createInput(id: string, channels: Readonly<string[]>) {
	return {
		agent: {
			id,
			display_name: id,
			mattermost: { username: id, allowed_channels: [...channels] },
			runtime: {
				adapter: "mock" as const,
				session_policy: "stateless" as const,
				timeout_seconds: 60,
			},
			prompts: { role_file: `prompts/${id}.md` },
			wake_rules: [],
			concurrency: { max_active_runs: 1, while_running: "enqueue" as const },
			permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: ["finance.*"] },
			memory: { private_namespace: `agents/${id}`, shared_namespaces: [] },
		},
		rolePrompt: `Role prompt for ${id}.`,
		actor: "test",
		source: "cli" as const,
	};
}

/** Every `(level, message, fields)` call a `Logger` receives, so a test can assert nothing
 * secret ever reaches one. */
function recordingLogger() {
	const calls: { level: string; message: string; fields?: LogFields }[] = [];
	const make =
		(level: string) =>
		(message: string, fields?: LogFields): void => {
			calls.push({ level, message, fields });
		};
	const logger = {
		debug: make("debug"),
		info: make("info"),
		warn: make("warn"),
		error: make("error"),
		child: () => logger,
	};
	return { calls, logger };
}

type FakeUser = ApiUser;

/** A Mattermost admin account, standing in for a real one: everything `agent-provisioner.ts`
 * calls through `AdminMattermostClient`, with no network. `calls` records a key per invocation
 * (`<method>:<subject>`), and `failures` lets a test script exactly one thrown error per key —
 * consumed on the first matching call, so a retry after it succeeds. */
class FakeAdminClient {
	readonly calls: string[] = [];
	readonly failures = new Map<string, unknown>();
	readonly teamMembers = new Set<string>();
	readonly channelMembers = new Map<string, Set<string>>();
	readonly adminId: string;
	private readonly usersById = new Map<string, FakeUser>();
	private readonly usersByUsername = new Map<string, FakeUser>();
	private readonly tokensByUser = new Map<string, Set<string>>();
	private readonly tokenOwners = new Map<string, string>();
	private readonly channelNamesById: Readonly<Record<string, string>>;
	private sequence = 0;

	/** `channelIdsByName`: the same name-to-id shape the directory and `CHANNEL_IDS` already use;
	 * inverted here so `addChannelMember`'s own failure keys and tracking read by name, which is
	 * what a test actually scripts and asserts on. */
	constructor(channelIdsByName: Readonly<Record<string, string>>) {
		this.channelNamesById = Object.fromEntries(
			Object.entries(channelIdsByName).map(([name, id]) => [id, name]),
		);
		this.adminId = this.newId();
		this.usersById.set(this.adminId, {
			id: this.adminId,
			username: "gateway-admin",
			is_bot: false,
			roles: "system_user system_admin",
			delete_at: 0,
		});
	}

	private newId(): string {
		this.sequence += 1;
		return `fakeid${String(this.sequence).padStart(20, "0")}`;
	}

	private maybeFail(key: string): void {
		this.calls.push(key);
		const error = this.failures.get(key);
		if (error !== undefined) {
			this.failures.delete(key);
			throw error;
		}
	}

	/** Seeds an existing account under `username`: a name already taken by something the
	 * provisioner must refuse to adopt. */
	seedUser(username: string, overrides: Partial<FakeUser> = {}): FakeUser {
		const user: FakeUser = {
			id: this.newId(),
			username,
			is_bot: false,
			roles: "system_user",
			delete_at: 0,
			...overrides,
		};
		this.usersById.set(user.id, user);
		this.usersByUsername.set(username, user);
		return user;
	}

	/** The token value a previous `createUserAccessToken` returned for `tokenId`: lets a test
	 * write a stale value into a token file directly, or check a freshly written one. */
	tokenValueOf(tokenId: string): string {
		return `token-${tokenId}`;
	}

	me = async (): Promise<ApiUser> => {
		const user = this.usersById.get(this.adminId);
		if (user === undefined) {
			throw new MattermostApiError(401, null, "GET /api/v4/users/me: HTTP 401");
		}
		return user;
	};

	user = async (userId: string): Promise<ApiUser> => {
		const found = this.usersById.get(userId);
		if (found === undefined) {
			throw new MattermostApiError(404, null, `GET /api/v4/users/${userId}: HTTP 404`);
		}
		return found;
	};

	userByUsername = async (username: string): Promise<ApiUser | null> =>
		this.usersByUsername.get(username) ?? null;

	createBot = async (bot: {
		username: string;
		display_name: string;
		description: string;
	}): Promise<ApiBot> => {
		this.maybeFail(`createBot:${bot.username}`);
		const id = this.newId();
		const user: FakeUser = {
			id,
			username: bot.username,
			is_bot: true,
			roles: "system_user",
			delete_at: 0,
		};
		this.usersById.set(id, user);
		this.usersByUsername.set(bot.username, user);
		return { user_id: id, username: bot.username, delete_at: 0 };
	};

	enableBot = async (userId: string): Promise<ApiBot> => {
		const user = this.usersById.get(userId);
		if (user === undefined) {
			throw new MattermostApiError(404, null, "bot not found");
		}
		this.usersById.set(userId, { ...user, delete_at: 0 });
		return { user_id: userId, username: user.username, delete_at: 0 };
	};

	disableBot = async (userId: string): Promise<ApiBot> => {
		const user = this.usersById.get(userId);
		if (user === undefined) {
			throw new MattermostApiError(404, null, "bot not found");
		}
		this.usersById.set(userId, { ...user, delete_at: 1 });
		return { user_id: userId, username: user.username, delete_at: 1 };
	};

	addTeamMember = async (_teamId: string, userId: string): Promise<void> => {
		this.maybeFail(`addTeamMember:${userId}`);
		this.teamMembers.add(userId);
	};

	addChannelMember = async (channelId: string, userId: string): Promise<void> => {
		const name = this.channelNamesById[channelId] ?? channelId;
		this.maybeFail(`addChannelMember:${name}`);
		const members = this.channelMembers.get(channelId) ?? new Set<string>();
		members.add(userId);
		this.channelMembers.set(channelId, members);
	};

	removeChannelMember = async (channelId: string, userId: string): Promise<void> => {
		const name = this.channelNamesById[channelId] ?? channelId;
		this.maybeFail(`removeChannelMember:${name}`);
		this.channelMembers.get(channelId)?.delete(userId);
	};

	/** Every managed channel `userId` is currently in, as `isExtraChannel` (`@agent-gateway/mattermost`)
	 * expects: a public channel of this team, never deleted, never `town-square`. */
	userChannelsInTeam = async (userId: string, teamId: string): Promise<ApiChannel[]> =>
		Object.entries(this.channelNamesById).flatMap(([id, name]) =>
			this.channelMembers.get(id)?.has(userId) === true
				? [{ id, name, type: "O" as const, team_id: teamId, delete_at: 0 }]
				: [],
		);

	userAccessTokenIds = async (userId: string): Promise<Readonly<string[]>> => [
		...(this.tokensByUser.get(userId) ?? []),
	];

	revokeUserAccessToken = async (tokenId: string): Promise<void> => {
		this.tokenOwners.delete(tokenId);
		for (const ids of this.tokensByUser.values()) {
			ids.delete(tokenId);
		}
	};

	createUserAccessToken = async (
		userId: string,
		_description: string,
	): Promise<Readonly<{ id: string; token: string }>> => {
		this.maybeFail(`createUserAccessToken:${userId}`);
		const id = this.newId();
		this.tokenOwners.set(id, userId);
		const ids = this.tokensByUser.get(userId) ?? new Set<string>();
		ids.add(id);
		this.tokensByUser.set(userId, ids);
		return { id, token: this.tokenValueOf(id) };
	};

	/** The fake counterpart of `tokenOwner` (`@agent-gateway/mattermost`): the user id a token
	 * value belongs to, by reversing `tokenValueOf`, or null for one this account never issued (or
	 * already revoked) — exactly `tokenOwner`'s own contract, with no network. */
	resolveTokenOwner = async (_baseUrl: string, token: string): Promise<string | null> => {
		const match = /^token-(.+)$/.exec(token);
		const tokenId = match?.[1];
		return tokenId === undefined ? null : (this.tokenOwners.get(tokenId) ?? null);
	};
}

describe("agent lifecycle provisioner (ADR-026)", () => {
	let postgres: TestPostgres;
	let pool: pg.Pool;
	let boss: Awaited<ReturnType<typeof createBoss>>;
	let deps: ControlPlaneDeps;
	let secretsDir: string;

	beforeAll(async () => {
		postgres = await startTestPostgres();
		pool = createPool(postgres.connectionString, 8);
		await migrateSchema({
			pool,
			connectionString: postgres.connectionString,
			release: DEVELOPMENT_VERSION,
			migrateQueues: () => migrateQueues(postgres.connectionString),
		});
		boss = createBoss(postgres.connectionString, "client");
		await boss.start();
		deps = {
			pool,
			jobs: (tx) => transactionalJobSink(boss, tx.client),
			clock: () => new Date(),
			random: Math.random,
			log: silentLogger,
		};
	});

	afterAll(async () => {
		await boss?.stop({ graceful: false });
		await pool?.end();
		await postgres?.stop();
	});

	beforeEach(async () => {
		await pool.query(
			"truncate agent_lifecycle_operations, agent_lifecycle, agent_runs, agent_inbox, mattermost_identities, mattermost_directory, agents, config_versions, gateway_controls, runtime_workers, runtime_availability restart identity cascade",
		);
		const financeAgent = {
			schema_version: 1 as const,
			id: "finance",
			display_name: "finance",
			enabled: true,
			mattermost: {
				username: "finance",
				token_secret_file: "/run/secrets/mm_finance_token",
				allowed_channels: [],
			},
			runtime: {
				adapter: "mock" as const,
				profile: "default",
				session_policy: "stateless" as const,
				timeout_seconds: 60,
			},
			prompts: { role_file: "prompts/finance.md" },
			wake_rules: [],
			concurrency: { max_active_runs: 1, while_running: "enqueue" as const },
			permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: [] },
			memory: { private_namespace: "agents/finance", shared_namespaces: [] },
		};
		await applyConfig(
			deps,
			{
				organization: organization(),
				agents: [financeAgent],
				constitution: "Be helpful.",
				rolePrompts: { finance: "Role prompt." },
			},
			"test",
		);
		await recordWorkerStatus(
			deps,
			"mock",
			{
				kind: "worker_status",
				workerId: randomUUID(),
				sequence: 1,
				status: "ready",
				runtimeVersion: "test",
				detail: "",
			},
			new Date(),
		);
		// Seeded the way `gateway mattermost bootstrap` already would have, once, before any agent
		// is created through the lifecycle: the provisioner only ever reads these, never resolves
		// them itself.
		await setDirectoryEntry(deps, "team", TEAM, TEAM_ID, "test");
		for (const [name, id] of Object.entries(CHANNEL_IDS)) {
			await setDirectoryEntry(deps, "channel", name, id, "test");
		}
		secretsDir = mkdtempSync(join(tmpdir(), "gateway-provisioner-test-"));
	});

	const options = () => ({ baseUrl: "http://mattermost.invalid", secretsDir });
	const pass = (admin: FakeAdminClient, logger: ReturnType<typeof recordingLogger>["logger"]) =>
		runProvisionerPass(
			deps,
			admin,
			options(),
			"test",
			logger,
			() => false,
			admin.resolveTokenOwner,
		);

	it("provisions a new agent end to end: bot, token, team and channel membership, then ready", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		const created = await requestAgentCreate(deps, createInput("analyst", ["hq", "research"]));
		const { logger } = recordingLogger();

		await pass(admin, logger);

		const [lifecycle] = (
			await pool.query("select status from agent_lifecycle where agent_id = 'analyst'")
		).rows;
		expect(lifecycle).toMatchObject({ status: "ready" });

		const [operation] = (
			await pool.query("select state, checkpoints from agent_lifecycle_operations where id = $1", [
				created.operationId,
			])
		).rows;
		expect(operation.state).toBe("succeeded");
		expect(operation.checkpoints).toMatchObject({
			team_joined: true,
			channels_joined: expect.arrayContaining(["hq", "research"]),
		});
		expect(typeof operation.checkpoints.bot_user_id).toBe("string");
		expect(operation.checkpoints.token_ref).toBe("/run/bot-secrets/mm_analyst_token");
		const botUserId: string = operation.checkpoints.bot_user_id;

		const [identity] = (
			await pool.query(
				"select mattermost_user_id from mattermost_identities where agent_id = 'analyst'",
			)
		).rows;
		expect(identity.mattermost_user_id).toBe(botUserId);
		expect(admin.teamMembers.has(botUserId)).toBe(true);
		expect(admin.channelMembers.get(CHANNEL_IDS.hq)?.has(botUserId)).toBe(true);
		expect(admin.channelMembers.get(CHANNEL_IDS.research)?.has(botUserId)).toBe(true);

		const tokenPath = join(secretsDir, "mm_analyst_token");
		expect(secretFileState(tokenPath)).toBe("private");
		expect(readFileSync(tokenPath, "utf8").trim().length).toBeGreaterThan(0);
	});

	it("resumes after a transient failure without repeating already-checkpointed steps", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		await requestAgentCreate(deps, createInput("analyst", ["hq", "research"]));
		admin.failures.set("addChannelMember:research", new Error("mattermost unavailable"));
		const { logger } = recordingLogger();

		await pass(admin, logger);

		let [operation] = (
			await pool.query(
				"select state, checkpoints from agent_lifecycle_operations where agent_id = 'analyst'",
			)
		).rows;
		expect(operation.state).toBe("running");
		expect(operation.checkpoints.channels_joined).toEqual(["hq"]);
		expect(admin.calls.filter((c) => c.startsWith("createBot:")).length).toBe(1);
		expect(admin.calls.filter((c) => c.startsWith("createUserAccessToken:")).length).toBe(1);
		expect(admin.calls.filter((c) => c === "addChannelMember:hq").length).toBe(1);

		await pass(admin, logger);

		[operation] = (
			await pool.query(
				"select state, checkpoints from agent_lifecycle_operations where agent_id = 'analyst'",
			)
		).rows;
		expect(operation.state).toBe("succeeded");
		expect(operation.checkpoints.channels_joined).toEqual(
			expect.arrayContaining(["hq", "research"]),
		);
		// Nothing already checkpointed ran again: one `createBot`/`createUserAccessToken` call and
		// one successful `addChannelMember:hq` call across both passes, total.
		expect(admin.calls.filter((c) => c.startsWith("createBot:")).length).toBe(1);
		expect(admin.calls.filter((c) => c.startsWith("createUserAccessToken:")).length).toBe(1);
		expect(admin.calls.filter((c) => c === "addChannelMember:hq").length).toBe(1);
	});

	it("recovers a lost token response: revokes a stray token and writes a fresh one", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		const created = await requestAgentCreate(deps, createInput("analyst", ["hq"]));

		// Simulates a crash between the bot being created and its first token being written: the
		// bot exists and already has a token on the Mattermost side (from the interrupted attempt),
		// but no file holds a working value and no checkpoint recorded the token yet.
		const bot = await admin.createBot({
			username: "analyst",
			display_name: "analyst",
			description: "",
		});
		await admin.createUserAccessToken(bot.user_id, "agent-gateway");
		await markProvisioning(deps, created.operationId, "test");
		await checkpointOperation(deps, created.operationId, { bot_user_id: bot.user_id });
		expect(await admin.userAccessTokenIds(bot.user_id)).toHaveLength(1);

		const { logger } = recordingLogger();
		await pass(admin, logger);

		const remainingTokens = await admin.userAccessTokenIds(bot.user_id);
		expect(remainingTokens).toHaveLength(1);
		const [remainingToken] = remainingTokens;
		if (remainingToken === undefined) {
			throw new Error("unreachable: just asserted length 1");
		}
		const tokenPath = join(secretsDir, "mm_analyst_token");
		expect(readFileSync(tokenPath, "utf8").trim()).toBe(admin.tokenValueOf(remainingToken));
	});

	it("resumes a crash between the bot_user_id checkpoint and the identity write: the agent still ends up with its bot recorded", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		const created = await requestAgentCreate(deps, createInput("analyst", ["hq"]));

		// Simulates a crash right after `bot_user_id` was checkpointed but before
		// `mattermost_identities` was ever written: the bot exists, the checkpoint already names
		// it, but the identity row this agent's config was created with still has no resolved
		// account.
		const bot = await admin.createBot({
			username: "analyst",
			display_name: "analyst",
			description: "",
		});
		await markProvisioning(deps, created.operationId, "test");
		await checkpointOperation(deps, created.operationId, { bot_user_id: bot.user_id });
		const [before] = (
			await pool.query(
				"select mattermost_user_id from mattermost_identities where agent_id = 'analyst'",
			)
		).rows;
		expect(before.mattermost_user_id).toBeNull();
		// `createBot:analyst` was already called once, directly above, to seed the bot: the count
		// from here is what matters — `ensureBot` must not run again now that a checkpoint names it.
		const createBotCallsBefore = admin.calls.filter((c) => c.startsWith("createBot:")).length;

		const { logger } = recordingLogger();
		await pass(admin, logger);

		const [operation] = (
			await pool.query("select state from agent_lifecycle_operations where id = $1", [
				created.operationId,
			])
		).rows;
		expect(operation.state).toBe("succeeded");
		// `ensureBot` is never called again: the checkpoint already named the account.
		expect(admin.calls.filter((c) => c.startsWith("createBot:")).length).toBe(createBotCallsBefore);
		const [identity] = (
			await pool.query(
				"select mattermost_user_id from mattermost_identities where agent_id = 'analyst'",
			)
		).rows;
		expect(identity.mattermost_user_id).toBe(bot.user_id);
	});

	it("fails permanently when the bot's username is taken by a non-Gateway account", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		admin.seedUser("analyst", { is_bot: false });
		await requestAgentCreate(deps, createInput("analyst", ["hq"]));
		const { logger, calls } = recordingLogger();

		await pass(admin, logger);

		const [lifecycle] = (
			await pool.query("select status, last_error from agent_lifecycle where agent_id = 'analyst'")
		).rows;
		expect(lifecycle.status).toBe("failed");
		expect(lifecycle.last_error).toMatch(/taken/i);
		const [operation] = (
			await pool.query(
				"select state, error from agent_lifecycle_operations where agent_id = 'analyst'",
			)
		).rows;
		expect(operation.state).toBe("failed");
		expect(operation.error).toMatch(/taken/i);
		// Never adopted the stranger's account: no token was ever requested for it.
		expect(admin.calls.some((c) => c.startsWith("createUserAccessToken:"))).toBe(false);
		for (const call of calls) {
			expect(JSON.stringify(call)).not.toContain("token-");
		}
	});

	it("treats a non-retryable Mattermost error (admin token rejected) as permanent", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		await requestAgentCreate(deps, createInput("analyst", ["hq"]));
		admin.failures.set(
			"createBot:analyst",
			new MattermostApiError(403, "permission_denied", "POST /api/v4/bots: HTTP 403"),
		);
		const { logger } = recordingLogger();

		await pass(admin, logger);

		const [operation] = (
			await pool.query(
				"select state, error from agent_lifecycle_operations where agent_id = 'analyst'",
			)
		).rows;
		expect(operation.state).toBe("failed");
		expect(operation.error).toMatch(/403/);
	});

	it("retries a retryable Mattermost error instead of failing the operation", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		await requestAgentCreate(deps, createInput("analyst", ["hq"]));
		admin.failures.set(
			"createBot:analyst",
			new MattermostApiError(503, null, "POST /api/v4/bots: HTTP 503"),
		);
		const { logger } = recordingLogger();

		await pass(admin, logger);
		let [operation] = (
			await pool.query("select state from agent_lifecycle_operations where agent_id = 'analyst'")
		).rows;
		expect(operation.state).toBe("running");

		await pass(admin, logger);
		[operation] = (
			await pool.query("select state from agent_lifecycle_operations where agent_id = 'analyst'")
		).rows;
		expect(operation.state).toBe("succeeded");
	});

	it("a committed channel change queues a reprovision operation; the provisioner joins the new channel and keeps the agent ready throughout", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		await requestAgentCreate(deps, createInput("analyst", ["hq"]));
		const { logger } = recordingLogger();
		await pass(admin, logger);

		const [ready] = (
			await pool.query("select status from agent_lifecycle where agent_id = 'analyst'")
		).rows;
		expect(ready.status).toBe("ready");

		const [{ config }] = (await pool.query("select config from agents where id = 'analyst'")).rows;
		const after: AgentConfig = {
			...config,
			mattermost: { ...config.mattermost, allowed_channels: ["hq", "research"] },
		};
		const baseRevisionId = await activeConfigRevisionId(deps);
		await commitChange(deps, {
			changeSet: [{ type: "update_agent", agent: after }],
			baseRevisionId,
			actor: "owner",
			source: "console",
		});

		const [queued] = (
			await pool.query(
				"select kind, state from agent_lifecycle_operations where agent_id = 'analyst' order by created_at desc limit 1",
			)
		).rows;
		expect(queued).toMatchObject({ kind: "reprovision", state: "pending" });
		// Queuing a reprovision never blocks scheduling: the agent stays `ready` the moment it is
		// queued, not only once the provisioner finishes it.
		const [stillReady] = (
			await pool.query("select status from agent_lifecycle where agent_id = 'analyst'")
		).rows;
		expect(stillReady.status).toBe("ready");

		await pass(admin, logger);

		const [done] = (
			await pool.query(
				"select state from agent_lifecycle_operations where agent_id = 'analyst' order by created_at desc limit 1",
			)
		).rows;
		expect(done.state).toBe("succeeded");
		const [afterPass] = (
			await pool.query("select status from agent_lifecycle where agent_id = 'analyst'")
		).rows;
		expect(afterPass.status).toBe("ready");
		const [identity] = (
			await pool.query(
				"select mattermost_user_id from mattermost_identities where agent_id = 'analyst'",
			)
		).rows;
		expect(admin.channelMembers.get(CHANNEL_IDS.hq)?.has(identity.mattermost_user_id)).toBe(true);
		expect(admin.channelMembers.get(CHANNEL_IDS.research)?.has(identity.mattermost_user_id)).toBe(
			true,
		);
	});

	it("a committed channel removal leaves the channel, but keeps one granted via ADR-022", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		await requestAgentCreate(deps, createInput("analyst", ["hq", "research"]));
		const { logger } = recordingLogger();
		await pass(admin, logger);

		const [identity] = (
			await pool.query(
				"select mattermost_user_id from mattermost_identities where agent_id = 'analyst'",
			)
		).rows;
		const botUserId: string = identity.mattermost_user_id;
		// Granted directly by an owner adding the bot in Mattermost (ADR-022): never through the
		// provisioner, never part of `allowed_channels`.
		await admin.addChannelMember(CHANNEL_IDS.ops, botUserId);
		const granted = await grantChannel(deps, {
			agentId: "analyst",
			botUserId,
			teamId: TEAM_ID,
			channelId: CHANNEL_IDS.ops,
			channelName: "ops",
			grantorUserId: fixedId("owner"),
			evidencePostId: fixedId("evidence"),
			sinceMs: Date.now(),
		});
		expect(granted).toBe(true);

		const [{ config }] = (await pool.query("select config from agents where id = 'analyst'")).rows;
		const after: AgentConfig = {
			...config,
			mattermost: { ...config.mattermost, allowed_channels: ["hq"] },
		};
		const baseRevisionId = await activeConfigRevisionId(deps);
		await commitChange(deps, {
			changeSet: [{ type: "update_agent", agent: after }],
			baseRevisionId,
			actor: "owner",
			source: "console",
		});

		await pass(admin, logger);

		expect(admin.channelMembers.get(CHANNEL_IDS.hq)?.has(botUserId)).toBe(true);
		expect(admin.channelMembers.get(CHANNEL_IDS.research)?.has(botUserId)).toBe(false);
		expect(admin.channelMembers.get(CHANNEL_IDS.ops)?.has(botUserId)).toBe(true);
	});

	it("stays idle with no admin token configured: the operation is left pending, untouched", async () => {
		delete process.env.MATTERMOST_ADMIN_TOKEN;
		delete process.env.MATTERMOST_ADMIN_TOKEN_FILE;
		const created = await requestAgentCreate(deps, createInput("analyst", ["hq"]));
		const { logger } = recordingLogger();

		const provisioner = startAgentProvisioner(
			deps,
			{ baseUrl: "http://mattermost.invalid", secretsDir, pollIntervalMs: 20 },
			logger,
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		await provisioner.stop();

		const [operation] = (
			await pool.query("select state from agent_lifecycle_operations where id = $1", [
				created.operationId,
			])
		).rows;
		expect(operation.state).toBe("pending");
	});
});
