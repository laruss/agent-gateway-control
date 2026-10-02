import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, OrganizationConfig } from "@agent-gateway/contracts";
import {
	AgentLifecycleCheckpointsSchema,
	OrganizationConfigSchema,
} from "@agent-gateway/contracts";
import {
	activeConfigRevisionId,
	applyConfig,
	type ControlPlaneDeps,
	checkpointOperation,
	commitChange,
	ensureAgentLifecycleAdoption,
	grantChannel,
	markProvisioning,
	recordWorkerStatus,
	requestAgentCreate,
	requestAgentRestore,
	requestAgentRetire,
	setAgentBotUser,
	setDirectoryEntry,
} from "@agent-gateway/core";
import { createPool, migrateSchema } from "@agent-gateway/db";
import { DEVELOPMENT_VERSION, type LogFields, silentLogger } from "@agent-gateway/logging";
import {
	type ApiBot,
	type ApiChannel,
	type ApiMember,
	type ApiTeam,
	type ApiUser,
	MattermostApiError,
} from "@agent-gateway/mattermost";
import { createBoss, migrateQueues, transactionalJobSink } from "@agent-gateway/queue";
import { secretFileExists, secretFileState, writeSecretFile } from "@agent-gateway/service";
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

/** `count` distinct channel name -> id pairs, named `${prefix}000`, `${prefix}001`, ...: a
 * contract-cap regression needs more channels than are worth spelling out by hand. The numeric
 * suffix is fixed-width (zero-padded) so two different names can never be `fixedId`'s own prefix
 * of each other once it pads the rest with zeros (`seta1` and `seta10` would otherwise collide:
 * `fixedId` pads with the same digit a plain, variable-width suffix could already end in). */
function manyChannels(prefix: string, count: number): Readonly<Record<string, string>> {
	return Object.fromEntries(
		Array.from({ length: count }, (_, i) => {
			const name = `${prefix}${String(i).padStart(3, "0")}`;
			return [name, fixedId(name)];
		}),
	);
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
	/** Team id -> member user ids: a team-change test needs to tell "left the old team" apart from
	 * "never joined a team at all", and `userTeams` needs to answer per user across every team the
	 * fake has ever seen. */
	readonly teamMembersByTeam = new Map<string, Set<string>>();
	readonly channelMembers = new Map<string, Set<string>>();
	/** Team id -> user id -> its membership roles (`"team_user"` unless elevated): lets a test seed
	 * an existing elevated membership (`setTeamMemberRoles` itself, called directly) before a pass,
	 * then assert the provisioner's own role normalization (ADR-026) reset it. */
	private readonly teamRoles = new Map<string, Map<string, string>>();
	/** Channel id -> user id -> its membership roles, the same way `teamRoles` is for teams. */
	private readonly channelRoles = new Map<string, Map<string, string>>();
	readonly adminId: string;
	private readonly usersById = new Map<string, FakeUser>();
	private readonly usersByUsername = new Map<string, FakeUser>();
	private readonly tokensByUser = new Map<string, Set<string>>();
	private readonly tokenOwners = new Map<string, string>();
	/** `user_id` -> the account that created that bot (`ApiBot.owner_id`): every bot `createBot`
	 * itself makes is owned by this fake admin account, the same as a real server would record;
	 * `seedUser`'s own bots default to a fresh, unrelated id — a stranger's bot, never this one's. */
	private readonly botOwners = new Map<string, string>();
	private readonly channelNamesById: Readonly<Record<string, string>>;
	/** Channel id -> the team it belongs to: lets `userChannelsInTeam` scope by team, and
	 * `removeTeamMember` cascade-remove a left team's own channels, the same way a real server
	 * ends every channel membership of a team the moment it ends membership in the team itself.
	 * Every channel this fake is constructed with defaults to `defaultTeamId`; `registerChannelTeam`
	 * adds one introduced only mid-test (a team-change test's own new channel). */
	private readonly channelTeamById = new Map<string, string>();
	private sequence = 0;

	/** `channelIdsByName`: the same name-to-id shape the directory and `CHANNEL_IDS` already use;
	 * inverted here so `addChannelMember`'s own failure keys and tracking read by name, which is
	 * what a test actually scripts and asserts on. */
	constructor(channelIdsByName: Readonly<Record<string, string>>, defaultTeamId: string = TEAM_ID) {
		this.channelNamesById = Object.fromEntries(
			Object.entries(channelIdsByName).map(([name, id]) => [id, name]),
		);
		for (const id of Object.values(channelIdsByName)) {
			this.channelTeamById.set(id, defaultTeamId);
		}
		this.adminId = this.newId();
		this.usersById.set(this.adminId, {
			id: this.adminId,
			username: "gateway-admin",
			is_bot: false,
			roles: "system_user system_admin",
			delete_at: 0,
		});
	}

	/** Registers which team a channel introduced after construction belongs to. */
	registerChannelTeam(channelId: string, teamId: string): void {
		this.channelTeamById.set(channelId, teamId);
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
	 * provisioner must refuse to adopt. A seeded bot (`overrides.is_bot`) is owned by `ownerId` when
	 * given, or else a fresh, unrelated id of its own — a stranger's bot, by default, never this
	 * fake admin's own (`this.adminId`); pass `this.adminId` explicitly for the one case that is. */
	seedUser(username: string, overrides: Partial<FakeUser> = {}, ownerId?: string): FakeUser {
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
		if (user.is_bot) {
			this.botOwners.set(user.id, ownerId ?? this.newId());
		}
		return user;
	}

	/** The token value a previous `createUserAccessToken` returned for `tokenId`: lets a test
	 * write a stale value into a token file directly, or check a freshly written one. */
	tokenValueOf(tokenId: string): string {
		return `token-${tokenId}`;
	}

	/** Every user id a member of *any* team: a convenience for a test that only ever uses one team,
	 * where "in a team at all" and "in the configured team" are the same question. */
	get teamMembers(): ReadonlySet<string> {
		const all = new Set<string>();
		for (const members of this.teamMembersByTeam.values()) {
			for (const userId of members) {
				all.add(userId);
			}
		}
		return all;
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
		this.botOwners.set(id, this.adminId);
		return { user_id: id, owner_id: this.adminId, username: bot.username, delete_at: 0 };
	};

	/** Null for an id that is not a bot at all — the real client's own `include_deleted=true`
	 * query means a disabled one is still found, so this never gates on `delete_at`. */
	getBot = async (userId: string): Promise<ApiBot | null> => {
		const user = this.usersById.get(userId);
		const ownerId = this.botOwners.get(userId);
		return user === undefined || !user.is_bot || ownerId === undefined
			? null
			: { user_id: userId, owner_id: ownerId, username: user.username, delete_at: user.delete_at };
	};

	/** Updates both maps together: a real server has one user record, not two independent copies,
	 * so `enableBot`/`disableBot` must be visible to a later `userByUsername` lookup too (`ensureBot`
	 * resolves an existing, possibly-disabled bot that way). */
	private setDeleteAt(userId: string, deleteAt: number): ApiUser {
		const user = this.usersById.get(userId);
		if (user === undefined) {
			throw new MattermostApiError(404, null, "bot not found");
		}
		const updated = { ...user, delete_at: deleteAt };
		this.usersById.set(userId, updated);
		this.usersByUsername.set(user.username, updated);
		return updated;
	}

	enableBot = async (userId: string): Promise<ApiBot> => {
		const user = this.setDeleteAt(userId, 0);
		return {
			user_id: userId,
			owner_id: this.botOwners.get(userId) ?? userId,
			username: user.username,
			delete_at: 0,
		};
	};

	disableBot = async (userId: string): Promise<ApiBot> => {
		const user = this.setDeleteAt(userId, 1);
		return {
			user_id: userId,
			owner_id: this.botOwners.get(userId) ?? userId,
			username: user.username,
			delete_at: 1,
		};
	};

	addTeamMember = async (teamId: string, userId: string): Promise<void> => {
		this.maybeFail(`addTeamMember:${userId}`);
		const members = this.teamMembersByTeam.get(teamId) ?? new Set<string>();
		members.add(userId);
		this.teamMembersByTeam.set(teamId, members);
		const roles = this.teamRoles.get(teamId) ?? new Map<string, string>();
		if (!roles.has(userId)) {
			roles.set(userId, "team_user");
		}
		this.teamRoles.set(teamId, roles);
	};

	/** Keyed by team id too (unlike `addTeamMember`'s own call key): a team-change test needs to
	 * tell "left the old team" apart from "never joined a team at all". Cascades to every channel
	 * of that team too — a real server ends every channel membership of a team the moment it ends
	 * membership in the team itself, the behaviour `convergeMembership`'s own "leave every other
	 * team" step (ADR-026) relies on without ever removing a channel membership of its own first. */
	removeTeamMember = async (teamId: string, userId: string): Promise<void> => {
		this.maybeFail(`removeTeamMember:${teamId}:${userId}`);
		this.teamMembersByTeam.get(teamId)?.delete(userId);
		this.teamRoles.get(teamId)?.delete(userId);
		for (const [channelId, members] of this.channelMembers) {
			if (this.channelTeamById.get(channelId) === teamId) {
				members.delete(userId);
				this.channelRoles.get(channelId)?.delete(userId);
			}
		}
	};

	/** Every team `userId` is currently a live member of: `convergeMembership`'s own "which teams
	 * besides the configured one" check reads this fresh every pass, never a checkpoint. `name` is
	 * never read by the provisioner (only `id`), so it is left equal to `id` here. */
	userTeams = async (userId: string): Promise<ApiTeam[]> =>
		[...this.teamMembersByTeam.entries()]
			.filter(([, members]) => members.has(userId))
			.map(([teamId]) => ({ id: teamId, name: teamId, delete_at: 0 }));

	teamMember = async (teamId: string, userId: string): Promise<ApiMember | null> => {
		const roles = this.teamRoles.get(teamId)?.get(userId);
		return roles === undefined ? null : { user_id: userId, roles, scheme_admin: false };
	};

	setTeamMemberRoles = async (teamId: string, userId: string, roles: string): Promise<void> => {
		const map = this.teamRoles.get(teamId) ?? new Map<string, string>();
		map.set(userId, roles);
		this.teamRoles.set(teamId, map);
	};

	addChannelMember = async (channelId: string, userId: string): Promise<void> => {
		const name = this.channelNamesById[channelId] ?? channelId;
		this.maybeFail(`addChannelMember:${name}`);
		const members = this.channelMembers.get(channelId) ?? new Set<string>();
		members.add(userId);
		this.channelMembers.set(channelId, members);
		const roles = this.channelRoles.get(channelId) ?? new Map<string, string>();
		if (!roles.has(userId)) {
			roles.set(userId, "channel_user");
		}
		this.channelRoles.set(channelId, roles);
	};

	removeChannelMember = async (channelId: string, userId: string): Promise<void> => {
		const name = this.channelNamesById[channelId] ?? channelId;
		this.maybeFail(`removeChannelMember:${name}`);
		this.channelMembers.get(channelId)?.delete(userId);
		this.channelRoles.get(channelId)?.delete(userId);
	};

	channelMember = async (channelId: string, userId: string): Promise<ApiMember | null> => {
		const roles = this.channelRoles.get(channelId)?.get(userId);
		return roles === undefined ? null : { user_id: userId, roles, scheme_admin: false };
	};

	setChannelMemberRoles = async (
		channelId: string,
		userId: string,
		roles: string,
	): Promise<void> => {
		const map = this.channelRoles.get(channelId) ?? new Map<string, string>();
		map.set(userId, roles);
		this.channelRoles.set(channelId, map);
	};

	/** Every channel `userId` is currently a live member of **in `teamId`**, as `isExtraChannel`
	 * (`@agent-gateway/mattermost`) expects: a public channel of this team, never deleted, never
	 * `town-square`. Reads live membership (`channelMembers`) directly, not the fixed
	 * `channelIdsByName` this fake was constructed with, so a channel id introduced only mid-test
	 * (a team change's own new channel, say) is recognized as a member once joined, exactly like a
	 * real server would report it; falls back to the id itself for `name` when it is not one of the
	 * ones this fake already knows a name for (never `town-square` either way). Scoped by
	 * `channelTeamById`, the same way a real server's own per-team channel listing is — an
	 * unregistered channel id defaults to matching whatever team is asked about, permissive for a
	 * test that does not care about multi-team scoping at all. */
	userChannelsInTeam = async (userId: string, teamId: string): Promise<ApiChannel[]> =>
		[...this.channelMembers.entries()].flatMap(([id, members]) =>
			members.has(userId) && (this.channelTeamById.get(id) ?? teamId) === teamId
				? [
						{
							id,
							name: this.channelNamesById[id] ?? id,
							type: "O" as const,
							team_id: teamId,
							delete_at: 0,
						},
					]
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

	it("records the provisioning admin account's directory entry once, not on every tick, while it stays the same account", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		const { logger } = recordingLogger();

		await pass(admin, logger);
		await pass(admin, logger);
		await pass(admin, logger);

		const [{ n: directoryRows }] = (
			await pool.query(
				"select count(*)::int as n from mattermost_directory where kind = 'user' and name = '#provisioning-admin'",
			)
		).rows;
		expect(directoryRows).toBe(1);
		// `setDirectoryEntry` itself writes and audits unconditionally every time it is called; three
		// ticks resolving the very same admin account must still leave exactly one `directory.set`
		// audit row, not one per tick.
		const [{ n: auditRows }] = (
			await pool.query(
				"select count(*)::int as n from audit_log where action = 'directory.set' and subject_type = 'user' and subject_id = '#provisioning-admin'",
			)
		).rows;
		expect(auditRows).toBe(1);
	});

	it("two overlapping passes: the second skips its own tick instead of interleaving with the first (ADR-026 cross-process lock)", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		const created = await requestAgentCreate(deps, createInput("analyst", ["hq"]));
		const { logger: logger1 } = recordingLogger();
		const { logger: logger2, calls: calls2 } = recordingLogger();

		// Gates the first pass right after it must already hold the advisory lock (`me()` is the
		// very first thing a locked pass does): `meStarted` only resolves once that point is
		// reached, so waiting on it (rather than a fixed delay) makes the second pass's own lock
		// attempt deterministically race against a lock the first pass already holds, never one it
		// merely might hold by then.
		let meStarted: () => void = () => undefined;
		const meWasCalled = new Promise<void>((resolve) => {
			meStarted = resolve;
		});
		let releaseGate: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const realMe = admin.me.bind(admin);
		admin.me = async () => {
			meStarted();
			await gate;
			return realMe();
		};

		const first = pass(admin, logger1);
		await meWasCalled;

		await pass(admin, logger2);
		expect(calls2.some((call) => call.message.includes("another pass is already running"))).toBe(
			true,
		);
		// Nothing of the second pass's own ran: the first pass has not even claimed the operation yet
		// (gated at `me()`, before it ever lists or claims one), and the second never got the chance
		// to either.
		const [stillPending] = (
			await pool.query("select state from agent_lifecycle_operations where id = $1", [
				created.operationId,
			])
		).rows;
		expect(stillPending.state).toBe("pending");

		releaseGate();
		await first;

		const [finished] = (
			await pool.query("select state from agent_lifecycle_operations where id = $1", [
				created.operationId,
			])
		).rows;
		expect(finished.state).toBe("succeeded");
	});

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
			channels_joined: expect.arrayContaining([CHANNEL_IDS.hq, CHANNEL_IDS.research]),
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

	it("a channel edit committed while create is in flight is picked up by the reprovision completeOperation itself queues, never silently missed", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		const created = await requestAgentCreate(deps, createInput("analyst", ["hq"]));
		const { logger } = recordingLogger();

		// Simulates an owner's edit landing mid-flight: after `agentConfig` was already read for
		// this pass (right after the operation was claimed), but before the operation completes. The
		// agent is still `reconciling` the whole time, so `queueMembershipReprovisioning` never sees
		// this edit itself (it only reprovisions a `ready` agent) — `completeOperation`'s own
		// reconciliation fence (ADR-026) is what picks it up, exactly the same way it already does for
		// a channel the same kind of edit takes away (the next test): there is no separate "still
		// joined before completing" path any more — every pass converges from live state, and any
		// edit it does not happen to observe is caught by the fence on the next one.
		const originalAddTeamMember = admin.addTeamMember;
		admin.addTeamMember = async (teamId: string, userId: string) => {
			const [{ config }] = (await pool.query("select config from agents where id = 'analyst'"))
				.rows;
			const edited: AgentConfig = {
				...config,
				mattermost: { ...config.mattermost, allowed_channels: ["hq", "research"] },
			};
			await commitChange(deps, {
				changeSet: [{ type: "update_agent", agent: edited }],
				baseRevisionId: await activeConfigRevisionId(deps),
				actor: "owner",
				source: "console",
			});
			return originalAddTeamMember(teamId, userId);
		};

		await pass(admin, logger);

		const [lifecycle] = (
			await pool.query("select status from agent_lifecycle where agent_id = 'analyst'")
		).rows;
		expect(lifecycle.status).toBe("ready");
		const [operation] = (
			await pool.query("select state, checkpoints from agent_lifecycle_operations where id = $1", [
				created.operationId,
			])
		).rows;
		expect(operation.state).toBe("succeeded");
		// This pass's own convergence only ever saw "hq" (the channel list it read right after
		// claiming the operation); "research" is not yet joined...
		expect(operation.checkpoints.channels_joined).toEqual([CHANNEL_IDS.hq]);
		const botUserId: string = operation.checkpoints.bot_user_id;
		expect(admin.channelMembers.get(CHANNEL_IDS.hq)?.has(botUserId)).toBe(true);
		expect(admin.channelMembers.get(CHANNEL_IDS.research)?.has(botUserId) ?? false).toBe(false);
		// ...but `completeOperation` noticed the mismatch against the agent's now-current
		// configuration and queued a reprovision, rather than leaving the agent `ready` with a
		// membership nothing would otherwise ever revisit.
		const [queued] = (
			await pool.query(
				"select kind, state from agent_lifecycle_operations where agent_id = 'analyst' order by created_at desc limit 1",
			)
		).rows;
		expect(queued).toMatchObject({ kind: "reprovision", state: "pending" });

		await pass(admin, logger);

		expect(admin.channelMembers.get(CHANNEL_IDS.hq)?.has(botUserId)).toBe(true);
		expect(admin.channelMembers.get(CHANNEL_IDS.research)?.has(botUserId)).toBe(true);
	});

	it("a channel removed from configuration while create is in flight is left by a reprovision completeOperation itself queues, never silently kept", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		await requestAgentCreate(deps, createInput("analyst", ["hq", "research"]));
		const { logger } = recordingLogger();

		// Simulates an owner's edit landing mid-flight, after this operation's own `agentConfig` was
		// already read (so its main join loop still joins "research" from that stale copy, exactly
		// like the addition case above) but before `completeOperation`'s own fresh read. Unlike an
		// addition, a removal is never caught by the fresh-config reload right before completing
		// (that loop only ever adds a channel, never drops one) — only `completeOperation`'s own
		// reconciliation fence (ADR-026) can still catch it.
		const originalAddTeamMember = admin.addTeamMember;
		admin.addTeamMember = async (teamId: string, userId: string) => {
			const [{ config }] = (await pool.query("select config from agents where id = 'analyst'"))
				.rows;
			const edited: AgentConfig = {
				...config,
				mattermost: { ...config.mattermost, allowed_channels: ["hq"] },
			};
			await commitChange(deps, {
				changeSet: [{ type: "update_agent", agent: edited }],
				baseRevisionId: await activeConfigRevisionId(deps),
				actor: "owner",
				source: "console",
			});
			return originalAddTeamMember(teamId, userId);
		};

		await pass(admin, logger);

		const [lifecycle] = (
			await pool.query("select status from agent_lifecycle where agent_id = 'analyst'")
		).rows;
		expect(lifecycle.status).toBe("ready");
		const [{ mattermost_user_id: botUserId }] = (
			await pool.query(
				"select mattermost_user_id from mattermost_identities where agent_id = 'analyst'",
			)
		).rows;
		// The now-unconfigured channel was still joined by this operation's own stale read of its
		// own configuration...
		expect(admin.channelMembers.get(CHANNEL_IDS.research)?.has(botUserId)).toBe(true);
		// ...but `completeOperation` itself noticed the mismatch and queued a reprovision to leave it,
		// rather than leaving the agent `ready` with a membership nothing would otherwise revisit.
		const [queued] = (
			await pool.query(
				"select kind, state from agent_lifecycle_operations where agent_id = 'analyst' order by created_at desc limit 1",
			)
		).rows;
		expect(queued).toMatchObject({ kind: "reprovision", state: "pending" });

		await pass(admin, logger);

		expect(admin.channelMembers.get(CHANNEL_IDS.hq)?.has(botUserId)).toBe(true);
		expect(admin.channelMembers.get(CHANNEL_IDS.research)?.has(botUserId)).toBe(false);
	});

	it("a Mattermost team change mid-create is picked up on resume: every pass re-lists live teams, so the old team (and its channels) are left with no checkpoint of its own to go stale", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		const created = await requestAgentCreate(deps, createInput("analyst", ["hq", "research"]));
		const { logger } = recordingLogger();

		// "research" fails so the operation stays `running` with "hq" already joined and its own
		// `team_joined`/`team` checkpoint (the organization's original team) already persisted.
		admin.failures.set("addChannelMember:research", new Error("mattermost unavailable"));
		await pass(admin, logger);
		let [operation] = (
			await pool.query("select state, checkpoints from agent_lifecycle_operations where id = $1", [
				created.operationId,
			])
		).rows;
		expect(operation.state).toBe("running");
		expect(operation.checkpoints).toMatchObject({ team_joined: true, team: TEAM });
		const [{ mattermost_user_id: botUserId }] = (
			await pool.query(
				"select mattermost_user_id from mattermost_identities where agent_id = 'analyst'",
			)
		).rows;
		expect(admin.channelMembers.get(CHANNEL_IDS.hq)?.has(botUserId)).toBe(true);

		// The organization moves to a new Mattermost team meanwhile, resolved in the directory the
		// same way `gateway mattermost bootstrap` would once it actually exists there — exactly the
		// `replace_bundle` shape `management.integration.test.ts`'s own team-change tests already use.
		const NEW_TEAM = "lab2";
		const NEW_TEAM_ID = fixedId("newteam");
		const NEW_CHANNEL_ID = fixedId("newhq");
		admin.registerChannelTeam(NEW_CHANNEL_ID, NEW_TEAM_ID);
		const [{ config: financeConfig }] = (
			await pool.query("select config from agents where id = 'finance'")
		).rows;
		const [{ config: analystConfig }] = (
			await pool.query("select config from agents where id = 'analyst'")
		).rows;
		const org = organization();
		const movedOrg = {
			...org,
			mattermost: {
				...org.mattermost,
				team: NEW_TEAM,
				channels: ["hq2"],
				approvals_channel: "hq2",
				alerts_channel: "hq2",
			},
		};
		const movedAnalyst: AgentConfig = {
			...analystConfig,
			mattermost: { ...analystConfig.mattermost, allowed_channels: ["hq2"] },
		};
		await commitChange(deps, {
			changeSet: [
				{
					type: "replace_bundle",
					bundle: {
						organization: movedOrg,
						agents: [financeConfig, movedAnalyst],
						constitution: "Be helpful.",
						rolePrompts: {
							finance: "Role prompt.",
							analyst: createInput("analyst", []).rolePrompt,
						},
					},
				},
			],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "owner",
			source: "console",
		});
		await setDirectoryEntry(deps, "team", NEW_TEAM, NEW_TEAM_ID, "test");
		await setDirectoryEntry(deps, "channel", "hq2", NEW_CHANNEL_ID, "test");

		// Still this same `create` operation, never superseded: `queueMembershipReprovisioning` only
		// reprovisions a `ready` agent, and this one is still `reconciling` throughout.
		[operation] = (
			await pool.query("select state, kind from agent_lifecycle_operations where id = $1", [
				created.operationId,
			])
		).rows;
		expect(operation).toMatchObject({ state: "running", kind: "create" });

		await pass(admin, logger);

		[operation] = (
			await pool.query("select state, checkpoints from agent_lifecycle_operations where id = $1", [
				created.operationId,
			])
		).rows;
		expect(operation.state).toBe("succeeded");
		// Rejoined against the now-current team, not skipped as already done for the old one.
		expect(operation.checkpoints).toMatchObject({ team_joined: true, team: NEW_TEAM });
		expect(operation.checkpoints.channels_joined).toEqual([NEW_CHANNEL_ID]);
		expect(admin.channelMembers.get(NEW_CHANNEL_ID)?.has(botUserId)).toBe(true);
		// The old team's own channel is left, and the old team itself too (one team only, as a plain
		// member — the same invariant `bootstrapMattermost` already keeps).
		expect(admin.channelMembers.get(CHANNEL_IDS.hq)?.has(botUserId)).toBe(false);
		expect(admin.calls).toContain(`removeTeamMember:${TEAM_ID}:${botUserId}`);
	});

	it("a team change committed on an already-ready agent queues a reprovision; the provisioner leaves the old team and joins the new", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		await requestAgentCreate(deps, createInput("analyst", ["hq"]));
		const { logger } = recordingLogger();
		await pass(admin, logger);

		const [{ mattermost_user_id: botUserId }] = (
			await pool.query(
				"select mattermost_user_id from mattermost_identities where agent_id = 'analyst'",
			)
		).rows;
		expect(admin.teamMembersByTeam.get(TEAM_ID)?.has(botUserId)).toBe(true);
		expect(admin.channelMembers.get(CHANNEL_IDS.hq)?.has(botUserId)).toBe(true);

		const NEW_TEAM = "lab2";
		const NEW_TEAM_ID = fixedId("newteam2");
		const NEW_CHANNEL_ID = fixedId("newhq2");
		admin.registerChannelTeam(NEW_CHANNEL_ID, NEW_TEAM_ID);
		const [{ config: financeConfig }] = (
			await pool.query("select config from agents where id = 'finance'")
		).rows;
		const [{ config: analystConfig }] = (
			await pool.query("select config from agents where id = 'analyst'")
		).rows;
		const org = organization();
		const movedOrg = {
			...org,
			mattermost: {
				...org.mattermost,
				team: NEW_TEAM,
				channels: ["hq2"],
				approvals_channel: "hq2",
				alerts_channel: "hq2",
			},
		};
		const movedAnalyst: AgentConfig = {
			...analystConfig,
			mattermost: { ...analystConfig.mattermost, allowed_channels: ["hq2"] },
		};
		await commitChange(deps, {
			changeSet: [
				{
					type: "replace_bundle",
					bundle: {
						organization: movedOrg,
						agents: [financeConfig, movedAnalyst],
						constitution: "Be helpful.",
						rolePrompts: {
							finance: "Role prompt.",
							analyst: createInput("analyst", []).rolePrompt,
						},
					},
				},
			],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "owner",
			source: "console",
		});
		await setDirectoryEntry(deps, "team", NEW_TEAM, NEW_TEAM_ID, "test");
		await setDirectoryEntry(deps, "channel", "hq2", NEW_CHANNEL_ID, "test");

		// Queued the moment the team changed, for every current, lifecycle-owned, ready agent
		// (ADR-026) — never blocking scheduling: `analyst` stays `ready` throughout.
		const [queued] = (
			await pool.query(
				"select kind, state from agent_lifecycle_operations where agent_id = 'analyst' order by created_at desc limit 1",
			)
		).rows;
		expect(queued).toMatchObject({ kind: "reprovision", state: "pending" });
		const [stillReady] = (
			await pool.query("select status from agent_lifecycle where agent_id = 'analyst'")
		).rows;
		expect(stillReady.status).toBe("ready");

		await pass(admin, logger);

		const [done] = (
			await pool.query(
				"select state, checkpoints from agent_lifecycle_operations where agent_id = 'analyst' order by created_at desc limit 1",
			)
		).rows;
		expect(done.state).toBe("succeeded");
		expect(done.checkpoints).toMatchObject({ team_joined: true, team: NEW_TEAM });
		expect(done.checkpoints.channels_joined).toEqual([NEW_CHANNEL_ID]);
		expect(admin.teamMembersByTeam.get(NEW_TEAM_ID)?.has(botUserId)).toBe(true);
		expect(admin.channelMembers.get(NEW_CHANNEL_ID)?.has(botUserId)).toBe(true);
		// The old team (and, cascading from it, its own channel) is left: one team only, as a plain
		// member, the same invariant `bootstrapMattermost` already keeps.
		expect(admin.teamMembersByTeam.get(TEAM_ID)?.has(botUserId)).toBe(false);
		expect(admin.channelMembers.get(CHANNEL_IDS.hq)?.has(botUserId)).toBe(false);
		expect(admin.calls).toContain(`removeTeamMember:${TEAM_ID}:${botUserId}`);
	});

	it("a team change's own reprovision resumes correctly from a transient failure at each of its steps in turn, converging without repeating what already succeeded", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		await requestAgentCreate(deps, createInput("analyst", ["hq"]));
		const { logger } = recordingLogger();
		await pass(admin, logger);

		const [{ mattermost_user_id: botUserId }] = (
			await pool.query(
				"select mattermost_user_id from mattermost_identities where agent_id = 'analyst'",
			)
		).rows;

		const NEW_TEAM = "lab3";
		const NEW_TEAM_ID = fixedId("newteam3");
		const NEW_CHANNEL_ID = fixedId("newhq3");
		admin.registerChannelTeam(NEW_CHANNEL_ID, NEW_TEAM_ID);
		const [{ config: financeConfig }] = (
			await pool.query("select config from agents where id = 'finance'")
		).rows;
		const [{ config: analystConfig }] = (
			await pool.query("select config from agents where id = 'analyst'")
		).rows;
		const org = organization();
		const movedOrg = {
			...org,
			mattermost: {
				...org.mattermost,
				team: NEW_TEAM,
				channels: ["hq3"],
				approvals_channel: "hq3",
				alerts_channel: "hq3",
			},
		};
		const movedAnalyst: AgentConfig = {
			...analystConfig,
			mattermost: { ...analystConfig.mattermost, allowed_channels: ["hq3"] },
		};
		await commitChange(deps, {
			changeSet: [
				{
					type: "replace_bundle",
					bundle: {
						organization: movedOrg,
						agents: [financeConfig, movedAnalyst],
						constitution: "Be helpful.",
						rolePrompts: {
							finance: "Role prompt.",
							analyst: createInput("analyst", []).rolePrompt,
						},
					},
				},
			],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "owner",
			source: "console",
		});
		await setDirectoryEntry(deps, "team", NEW_TEAM, NEW_TEAM_ID, "test");
		await setDirectoryEntry(deps, "channel", "hq3", NEW_CHANNEL_ID, "test");

		// Crash point 1: fails leaving the old team, right after the new one was joined.
		admin.failures.set(
			`removeTeamMember:${TEAM_ID}:${botUserId}`,
			new Error("mattermost unavailable"),
		);
		await pass(admin, logger);
		let [operation] = (
			await pool.query(
				"select state, checkpoints from agent_lifecycle_operations where agent_id = 'analyst' order by created_at desc limit 1",
			)
		).rows;
		expect(operation.state).toBe("running");
		expect(operation.checkpoints).toMatchObject({ team_joined: true, team: NEW_TEAM });
		expect(admin.teamMembersByTeam.get(NEW_TEAM_ID)?.has(botUserId)).toBe(true);
		// Still a member of the old team: leaving it is exactly the step that just failed.
		expect(admin.teamMembersByTeam.get(TEAM_ID)?.has(botUserId)).toBe(true);
		expect(admin.channelMembers.get(NEW_CHANNEL_ID)?.has(botUserId) ?? false).toBe(false);

		// Crash point 2: leaving the old team now succeeds (resumed, not repeated — the failure was
		// consumed), but joining the new channel fails this time.
		admin.failures.set(`addChannelMember:${NEW_CHANNEL_ID}`, new Error("mattermost unavailable"));
		await pass(admin, logger);
		[operation] = (
			await pool.query(
				"select state, checkpoints from agent_lifecycle_operations where agent_id = 'analyst' order by created_at desc limit 1",
			)
		).rows;
		expect(operation.state).toBe("running");
		expect(admin.teamMembersByTeam.get(TEAM_ID)?.has(botUserId)).toBe(false);
		expect(admin.calls).toContain(`removeTeamMember:${TEAM_ID}:${botUserId}`);
		expect(admin.channelMembers.get(NEW_CHANNEL_ID)?.has(botUserId) ?? false).toBe(false);

		// Resumed once more: nothing left to fail, converges.
		await pass(admin, logger);
		[operation] = (
			await pool.query(
				"select state, checkpoints from agent_lifecycle_operations where agent_id = 'analyst' order by created_at desc limit 1",
			)
		).rows;
		expect(operation.state).toBe("succeeded");
		expect(admin.channelMembers.get(NEW_CHANNEL_ID)?.has(botUserId)).toBe(true);
		const [lifecycle] = (
			await pool.query("select status from agent_lifecycle where agent_id = 'analyst'")
		).rows;
		expect(lifecycle.status).toBe("ready");
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
		expect(operation.checkpoints.channels_joined).toEqual([CHANNEL_IDS.hq]);
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
			expect.arrayContaining([CHANNEL_IDS.hq, CHANNEL_IDS.research]),
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

	it("refuses to adopt a stranger's existing plain bot for a fresh create, never touching its tokens", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		// An unrelated integration's own bot, already at this exact username: a plain member
		// (`is_bot`, plain roles), same as a Gateway-owned bot would be, but never created by this
		// admin account (`seedUser`'s own default: an owner id of its own, never `admin.adminId`).
		const stranger = admin.seedUser("github", { is_bot: true });
		const strangerToken = await admin.createUserAccessToken(stranger.id, "unrelated integration");
		const created = await requestAgentCreate(deps, createInput("github", ["hq"]));
		const { logger } = recordingLogger();

		await pass(admin, logger);

		const [lifecycle] = (
			await pool.query("select status, last_error from agent_lifecycle where agent_id = 'github'")
		).rows;
		expect(lifecycle.status).toBe("failed");
		expect(lifecycle.last_error).toMatch(/taken/i);
		const [operation] = (
			await pool.query("select state from agent_lifecycle_operations where id = $1", [
				created.operationId,
			])
		).rows;
		expect(operation.state).toBe("failed");
		// The stranger's own bot is never adopted at all: its existing token is left exactly as it
		// was, never revoked the way a legitimately adopted bot's own stray token would be.
		expect(await admin.userAccessTokenIds(stranger.id)).toContain(strangerToken.id);
		expect(admin.calls).not.toContain(`enableBot:${stranger.id}`);
	});

	it("still adopts a bot this Gateway's own admin account created, with no recorded identity yet (a create resuming after a crash before its bot_user_id checkpoint was ever written)", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		const created = await requestAgentCreate(deps, createInput("analyst", ["hq"]));
		// Simulates a crash between `createBot` succeeding and the very first checkpoint
		// (`bot_user_id`) ever being persisted: the bot already exists, owned by this same admin
		// account, but nothing here has recorded it yet — no checkpoint, no identity row.
		const bot = await admin.createBot({
			username: "analyst",
			display_name: "analyst",
			description: "",
		});
		const { logger } = recordingLogger();

		await pass(admin, logger);

		const [operation] = (
			await pool.query("select state, checkpoints from agent_lifecycle_operations where id = $1", [
				created.operationId,
			])
		).rows;
		expect(operation.state).toBe("succeeded");
		expect(operation.checkpoints.bot_user_id).toBe(bot.user_id);
	});

	it("still adopts a bot created by an earlier, now-rotated-away provisioning admin account for a fresh create (resumed with no recorded identity yet)", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		const OLD_ADMIN_ID = fixedId("oldadmin");
		// Simulates a tick from before the admin account was rotated (`gateway mattermost
		// admin-token set` pointed at a different account): this Gateway's own
		// `#provisioning-admin` directory entry named a different account back then.
		await setDirectoryEntry(deps, "user", "#provisioning-admin", OLD_ADMIN_ID, "test");

		const created = await requestAgentCreate(deps, createInput("analyst", ["hq"]));
		// The create never got far enough to resolve a bot of its own (no checkpoint, no identity) —
		// but a bot already exists at its configured username, created by this very Gateway back
		// when `OLD_ADMIN_ID` was its provisioning admin.
		const bot = admin.seedUser("analyst", { is_bot: true }, OLD_ADMIN_ID);
		const { logger } = recordingLogger();

		// This same pass resolves (and records) the current admin account (`admin.adminId`), rotated
		// away from `OLD_ADMIN_ID` — the directory/audit now holds both, and this bot's `owner_id`
		// matches the older one, so the create must adopt it rather than fail "taken".
		await pass(admin, logger);

		const [operation] = (
			await pool.query("select state, checkpoints from agent_lifecycle_operations where id = $1", [
				created.operationId,
			])
		).rows;
		expect(operation.state).toBe("succeeded");
		expect(operation.checkpoints.bot_user_id).toBe(bot.id);
		const [lifecycle] = (
			await pool.query("select status from agent_lifecycle where agent_id = 'analyst'")
		).rows;
		expect(lifecycle.status).toBe("ready");
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

	it("normalizes an existing Gateway-owned bot's elevated team/channel membership roles back to a plain member before declaring it ready", async () => {
		const admin = new FakeAdminClient(CHANNEL_IDS);
		await requestAgentCreate(deps, createInput("analyst", ["hq"]));
		const { logger } = recordingLogger();
		await pass(admin, logger);

		const [{ mattermost_user_id: botUserId }] = (
			await pool.query(
				"select mattermost_user_id from mattermost_identities where agent_id = 'analyst'",
			)
		).rows;
		// Elevated by hand in Mattermost (or left over from an earlier manual change) — real-world
		// repro: an existing Gateway-owned bot with `team_admin`/`channel_admin` membership roles.
		await admin.setTeamMemberRoles(TEAM_ID, botUserId, "team_user team_admin");
		await admin.setChannelMemberRoles(CHANNEL_IDS.hq, botUserId, "channel_user channel_admin");

		// Any reprovision pass re-checks and normalizes roles, not only a fresh create: a channel
		// edit queues one for this already-`ready` agent the same way a team change would.
		const [{ config }] = (await pool.query("select config from agents where id = 'analyst'")).rows;
		const after: AgentConfig = {
			...config,
			mattermost: { ...config.mattermost, allowed_channels: ["hq", "research"] },
		};
		await commitChange(deps, {
			changeSet: [{ type: "update_agent", agent: after }],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "owner",
			source: "console",
		});

		await pass(admin, logger);

		const [operation] = (
			await pool.query(
				"select state from agent_lifecycle_operations where agent_id = 'analyst' order by created_at desc limit 1",
			)
		).rows;
		expect(operation.state).toBe("succeeded");
		expect(await admin.teamMember(TEAM_ID, botUserId)).toMatchObject({ roles: "team_user" });
		expect(await admin.channelMember(CHANNEL_IDS.hq, botUserId)).toMatchObject({
			roles: "channel_user",
		});
	});

	it("a create with 31 channels, resized to 32 different ones while still in flight, never stores a checkpoint past its own contract bound (never breaking fetchAgentLifecycle)", async () => {
		const setA = manyChannels("seta", 31);
		const setB = manyChannels("setb", 32);
		const admin = new FakeAdminClient({ ...CHANNEL_IDS, ...setA, ...setB });
		for (const [name, id] of [...Object.entries(setA), ...Object.entries(setB)]) {
			await setDirectoryEntry(deps, "channel", name, id, "test");
		}
		const org = organization();
		const [{ config: financeConfig }] = (
			await pool.query("select config from agents where id = 'finance'")
		).rows;
		await commitChange(deps, {
			changeSet: [
				{
					type: "replace_bundle",
					bundle: {
						organization: {
							...org,
							mattermost: {
								...org.mattermost,
								channels: [...org.mattermost.channels, ...Object.keys(setA), ...Object.keys(setB)],
							},
						},
						agents: [financeConfig],
						constitution: "Be helpful.",
						rolePrompts: { finance: "Role prompt." },
					},
				},
			],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "owner",
			source: "console",
		});

		const created = await requestAgentCreate(deps, createInput("analyst", Object.keys(setA)));
		const { logger } = recordingLogger();

		// The owner resizes to a completely disjoint set of 32 channels mid-flight, after this
		// operation's own channel list (31 entries) was already captured for this pass: the old,
		// name-keyed checkpoint could accumulate both reads' own channels into one array past its
		// own `.max(32)` bound (31 + 32 = 63, never overlapping); the new design never reads a
		// channel list more than once per pass, so there is nothing left here to accumulate at all.
		const originalAddTeamMember = admin.addTeamMember;
		admin.addTeamMember = async (teamId: string, userId: string) => {
			const [{ config }] = (await pool.query("select config from agents where id = 'analyst'"))
				.rows;
			const edited: AgentConfig = {
				...config,
				mattermost: { ...config.mattermost, allowed_channels: Object.keys(setB) },
			};
			await commitChange(deps, {
				changeSet: [{ type: "update_agent", agent: edited }],
				baseRevisionId: await activeConfigRevisionId(deps),
				actor: "owner",
				source: "console",
			});
			return originalAddTeamMember(teamId, userId);
		};

		await pass(admin, logger);

		const [operation] = (
			await pool.query("select state, checkpoints from agent_lifecycle_operations where id = $1", [
				created.operationId,
			])
		).rows;
		expect(operation.state).toBe("succeeded");
		expect(operation.checkpoints.channels_joined).toHaveLength(31);
		expect(AgentLifecycleCheckpointsSchema.safeParse(operation.checkpoints).success).toBe(true);

		// `completeOperation`'s own fence noticed the configuration had already moved on and queued a
		// reprovision, rather than leaving the agent `ready` with a membership nothing would revisit.
		const [queued] = (
			await pool.query(
				"select kind, state from agent_lifecycle_operations where agent_id = 'analyst' order by created_at desc limit 1",
			)
		).rows;
		expect(queued).toMatchObject({ kind: "reprovision", state: "pending" });

		await pass(admin, logger);

		const [reprovisioned] = (
			await pool.query(
				"select state, checkpoints from agent_lifecycle_operations where agent_id = 'analyst' order by created_at desc limit 1",
			)
		).rows;
		expect(reprovisioned.state).toBe("succeeded");
		expect(reprovisioned.checkpoints.channels_joined).toHaveLength(32);
		expect(AgentLifecycleCheckpointsSchema.safeParse(reprovisioned.checkpoints).success).toBe(true);
		const [lifecycle] = (
			await pool.query("select status from agent_lifecycle where agent_id = 'analyst'")
		).rows;
		expect(lifecycle.status).toBe("ready");
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

	describe("retire and restore (ADR-026)", () => {
		it("retires an agent end to end: tokens revoked, bot deactivated, channels left, token file removed", async () => {
			const admin = new FakeAdminClient(CHANNEL_IDS);
			await requestAgentCreate(deps, createInput("analyst", ["hq", "research"]));
			const { logger } = recordingLogger();
			await pass(admin, logger);

			const [{ mattermost_user_id: botUserId }] = (
				await pool.query(
					"select mattermost_user_id from mattermost_identities where agent_id = 'analyst'",
				)
			).rows;
			expect(await admin.userAccessTokenIds(botUserId)).not.toHaveLength(0);
			const tokenPath = join(secretsDir, "mm_analyst_token");
			expect(secretFileExists(tokenPath)).toBe(true);

			const retired = await requestAgentRetire(deps, {
				agentId: "analyst",
				actor: "test",
				source: "cli",
			});
			await pass(admin, logger);

			const [lifecycle] = (
				await pool.query(
					"select status, retired_at from agent_lifecycle where agent_id = 'analyst'",
				)
			).rows;
			expect(lifecycle.status).toBe("retired");
			expect(lifecycle.retired_at).not.toBeNull();
			const [operation] = (
				await pool.query(
					"select state, checkpoints from agent_lifecycle_operations where id = $1",
					[retired.operationId],
				)
			).rows;
			expect(operation.state).toBe("succeeded");
			expect(operation.checkpoints).toMatchObject({
				tokens_revoked: true,
				bot_disabled: true,
				token_file_deleted: true,
			});
			expect(await admin.user(botUserId)).toMatchObject({ delete_at: 1 });
			expect(await admin.userAccessTokenIds(botUserId)).toHaveLength(0);
			expect(admin.channelMembers.get(CHANNEL_IDS.hq)?.has(botUserId)).toBe(false);
			expect(admin.channelMembers.get(CHANNEL_IDS.research)?.has(botUserId)).toBe(false);
			expect(secretFileExists(tokenPath)).toBe(false);
		});

		it("retires a bot that is a live member of more than 64 channels (unbounded grants/manual adds) without ever storing a checkpoint past its own contract bound", async () => {
			const admin = new FakeAdminClient(CHANNEL_IDS);
			await requestAgentCreate(deps, createInput("analyst", ["hq"]));
			const { logger } = recordingLogger();
			await pass(admin, logger);

			const [{ mattermost_user_id: botUserId }] = (
				await pool.query(
					"select mattermost_user_id from mattermost_identities where agent_id = 'analyst'",
				)
			).rows;
			// Simulates a bot whose live Mattermost membership has grown past its own 64-channel
			// checkpoint bound — ADR-022 grants and channels added by hand are never pruned by this
			// release, so this is unbounded in practice, unlike `allowed_channels` itself (at most 32).
			const extraChannels = manyChannels("extra", 70);
			for (const channelId of Object.values(extraChannels)) {
				await admin.addChannelMember(channelId, botUserId);
			}

			const retired = await requestAgentRetire(deps, {
				agentId: "analyst",
				actor: "test",
				source: "cli",
			});
			await pass(admin, logger);

			const [lifecycle] = (
				await pool.query("select status from agent_lifecycle where agent_id = 'analyst'")
			).rows;
			expect(lifecycle.status).toBe("retired");
			const [operation] = (
				await pool.query(
					"select state, checkpoints from agent_lifecycle_operations where id = $1",
					[retired.operationId],
				)
			).rows;
			expect(operation.state).toBe("succeeded");
			expect(operation.checkpoints.channels_left.length).toBeLessThanOrEqual(64);
			expect(AgentLifecycleCheckpointsSchema.safeParse(operation.checkpoints).success).toBe(true);
			// Every live channel was actually left, the clamp trimming only the stored checkpoint's own
			// memory of it, never the actual cleanup: sampled across the ones most likely to have been
			// trimmed from a bounded, tail-kept list (`hq`, the very first channel processed) and ones
			// certainly still in it (the last few added).
			expect(admin.channelMembers.get(CHANNEL_IDS.hq)?.has(botUserId)).toBe(false);
			for (const channelId of Object.values(extraChannels)) {
				expect(admin.channelMembers.get(channelId)?.has(botUserId)).toBe(false);
			}
		});

		it("recovers the bot id from a superseded create operation's own checkpoint when the identity was never recorded, instead of skipping cleanup", async () => {
			const admin = new FakeAdminClient(CHANNEL_IDS);
			const created = await requestAgentCreate(deps, createInput("analyst", ["hq"]));
			// The same crash the create-side test above injects (bot_user_id checkpointed, but
			// `setAgentBotUser` never ran) — except this time the agent is retired before the create
			// ever gets a chance to finish resolving its own identity.
			const bot = await admin.createBot({
				username: "analyst",
				display_name: "analyst",
				description: "",
			});
			await markProvisioning(deps, created.operationId, "test");
			await checkpointOperation(deps, created.operationId, { bot_user_id: bot.user_id });
			const [identityBefore] = (
				await pool.query(
					"select mattermost_user_id from mattermost_identities where agent_id = 'analyst'",
				)
			).rows;
			expect(identityBefore.mattermost_user_id).toBeNull();

			await requestAgentRetire(deps, { agentId: "analyst", actor: "test", source: "cli" });
			const [supersededCreate] = (
				await pool.query("select state from agent_lifecycle_operations where id = $1", [
					created.operationId,
				])
			).rows;
			expect(supersededCreate.state).toBe("cancelled");
			const { logger } = recordingLogger();
			await pass(admin, logger);

			// Never concluded "no Mattermost identity had been provisioned": the bot is actually
			// cleaned up, not left enabled with a working token.
			expect(await admin.user(bot.user_id)).toMatchObject({ delete_at: 1 });
			expect(await admin.userAccessTokenIds(bot.user_id)).toHaveLength(0);
			const [lifecycle] = (
				await pool.query("select status from agent_lifecycle where agent_id = 'analyst'")
			).rows;
			expect(lifecycle.status).toBe("retired");
			// The identity is backfilled too, now that the bot id is known.
			const [identityAfter] = (
				await pool.query(
					"select mattermost_user_id from mattermost_identities where agent_id = 'analyst'",
				)
			).rows;
			expect(identityAfter.mattermost_user_id).toBe(bot.user_id);
		});

		it("falls back to looking the bot up by its configured username when even its create operation's checkpoints never named it", async () => {
			const admin = new FakeAdminClient(CHANNEL_IDS);
			await requestAgentCreate(deps, createInput("analyst", ["hq"]));
			// The bot exists in Mattermost (an interrupted create got this far), but nothing in the
			// database ever named it: no checkpoint, no identity.
			const bot = await admin.createBot({
				username: "analyst",
				display_name: "analyst",
				description: "",
			});

			await requestAgentRetire(deps, { agentId: "analyst", actor: "test", source: "cli" });
			const { logger } = recordingLogger();
			await pass(admin, logger);

			expect(await admin.user(bot.user_id)).toMatchObject({ delete_at: 1 });
			expect(await admin.userAccessTokenIds(bot.user_id)).toHaveLength(0);
			const [lifecycle] = (
				await pool.query("select status from agent_lifecycle where agent_id = 'analyst'")
			).rows;
			expect(lifecycle.status).toBe("retired");
		});

		it("skips Mattermost cleanup, rather than adopting it, when a plain bot at the agent's own username is not plausibly this Gateway's own — warning visibly and flagging the operation, since no admin-rotation history exists to rule it out either way", async () => {
			const admin = new FakeAdminClient(CHANNEL_IDS);
			await requestAgentCreate(deps, createInput("analyst", ["hq"]));
			// The create itself never got far enough to resolve a bot (no checkpoint, no identity) —
			// but by the time this agent is retired, an unrelated integration already created its own
			// plain bot at the exact same username (`analyst`'s own create would have failed on
			// "username taken" had it ever run; this retire must not revoke that stranger's tokens).
			const stranger = admin.seedUser("analyst", { is_bot: true });
			const strangerToken = await admin.createUserAccessToken(stranger.id, "unrelated integration");

			await requestAgentRetire(deps, { agentId: "analyst", actor: "test", source: "cli" });
			const { logger, calls } = recordingLogger();
			await pass(admin, logger);

			const [lifecycle] = (
				await pool.query("select status from agent_lifecycle where agent_id = 'analyst'")
			).rows;
			expect(lifecycle.status).toBe("retired");
			// The stranger's own bot is never touched: not disabled, its token never revoked.
			expect(await admin.user(stranger.id)).toMatchObject({ delete_at: 0 });
			expect(await admin.userAccessTokenIds(stranger.id)).toContain(strangerToken.id);
			expect(
				calls.some((call) => {
					const reason = call.fields?.reason;
					return (
						call.level === "warn" &&
						call.message.includes("Mattermost-side cleanup was skipped") &&
						typeof reason === "string" &&
						reason.includes("not plausibly")
					);
				}),
			).toBe(true);
			// Flagged on the operation too (ADR-026): `gateway doctor` surfaces this, unlike the
			// ordinary skip, since this Gateway's own admin-rotation history — had any of it been
			// recorded — could in principle have vindicated this very bot instead.
			const [operation] = (
				await pool.query(
					"select checkpoints from agent_lifecycle_operations where agent_id = 'analyst' order by created_at desc limit 1",
				)
			).rows;
			expect(operation.checkpoints.owner_unverified).toBe(true);
		});

		it("accepts a bot owned by an earlier, now-rotated-away provisioning admin account when recovering a retiring agent's bot id", async () => {
			const admin = new FakeAdminClient(CHANNEL_IDS);
			const OLD_ADMIN_ID = fixedId("oldadmin");
			// Simulates a tick from before the admin account was rotated (`gateway mattermost
			// admin-token set` pointed at a different account): this Gateway's own
			// `#provisioning-admin` directory entry named a different account back then.
			await setDirectoryEntry(deps, "user", "#provisioning-admin", OLD_ADMIN_ID, "test");

			await requestAgentCreate(deps, createInput("analyst", ["hq"]));
			// The create never got far enough to resolve a bot of its own (no checkpoint, no
			// identity) — but a bot already exists at its configured username, created by this very
			// Gateway back when `OLD_ADMIN_ID` was its provisioning admin.
			const bot = admin.seedUser("analyst", { is_bot: true }, OLD_ADMIN_ID);

			await requestAgentRetire(deps, { agentId: "analyst", actor: "test", source: "cli" });
			const { logger } = recordingLogger();
			// This same pass resolves (and records) the current admin account (`admin.adminId`),
			// rotated away from `OLD_ADMIN_ID` — the directory/audit now holds both, and this bot's
			// `owner_id` matches the older one.
			await pass(admin, logger);

			expect(await admin.user(bot.id)).toMatchObject({ delete_at: 1 });
			expect(await admin.userAccessTokenIds(bot.id)).toHaveLength(0);
			const [lifecycle] = (
				await pool.query("select status from agent_lifecycle where agent_id = 'analyst'")
			).rows;
			expect(lifecycle.status).toBe("retired");
			const [operation] = (
				await pool.query(
					"select checkpoints from agent_lifecycle_operations where agent_id = 'analyst' order by created_at desc limit 1",
				)
			).rows;
			expect(operation.checkpoints.owner_unverified).toBeUndefined();
		});

		it("resumes retirement after a transient failure, without repeating an already-checkpointed step", async () => {
			const admin = new FakeAdminClient(CHANNEL_IDS);
			await requestAgentCreate(deps, createInput("analyst", ["hq", "research"]));
			const { logger } = recordingLogger();
			await pass(admin, logger);
			const [{ mattermost_user_id: botUserId }] = (
				await pool.query(
					"select mattermost_user_id from mattermost_identities where agent_id = 'analyst'",
				)
			).rows;

			admin.failures.set("removeChannelMember:research", new Error("mattermost unavailable"));
			const retired = await requestAgentRetire(deps, {
				agentId: "analyst",
				actor: "test",
				source: "cli",
			});
			await pass(admin, logger);

			let [operation] = (
				await pool.query(
					"select state, checkpoints from agent_lifecycle_operations where id = $1",
					[retired.operationId],
				)
			).rows;
			expect(operation.state).toBe("running");
			expect(operation.checkpoints).toMatchObject({ tokens_revoked: true, bot_disabled: true });
			expect(operation.checkpoints.channels_left).toEqual([CHANNEL_IDS.hq]);
			// Already harmless (deactivated, token-less) even though the retire has not finished: the
			// remaining channel removals are cosmetic from here on.
			expect(await admin.userAccessTokenIds(botUserId)).toHaveLength(0);

			await pass(admin, logger);
			[operation] = (
				await pool.query(
					"select state, checkpoints from agent_lifecycle_operations where id = $1",
					[retired.operationId],
				)
			).rows;
			expect(operation.state).toBe("succeeded");
			expect(operation.checkpoints.channels_left).toEqual(
				expect.arrayContaining([CHANNEL_IDS.hq, CHANNEL_IDS.research]),
			);
			// `tokens_revoked`/`bot_disabled` never repeated across the two passes.
			expect(admin.calls.filter((c) => c === `removeChannelMember:research`).length).toBe(2); // one failed, one succeeded
		});

		it("fails retirement permanently when the admin token cannot even read the bot account", async () => {
			const admin = new FakeAdminClient(CHANNEL_IDS);
			await requestAgentCreate(deps, createInput("analyst", ["hq"]));
			const { logger } = recordingLogger();
			await pass(admin, logger);

			// `user` (the `bot_disabled` step's own read) is not keyed per-id in `FakeAdminClient`'s
			// `failures` map; patched directly for this one case instead.
			admin.user = async () => {
				throw new MattermostApiError(403, "permission_denied", "GET /api/v4/users: HTTP 403");
			};
			await requestAgentRetire(deps, { agentId: "analyst", actor: "test", source: "cli" });
			await pass(admin, logger);

			const [lifecycle] = (
				await pool.query(
					"select status, last_error from agent_lifecycle where agent_id = 'analyst'",
				)
			).rows;
			expect(lifecycle.status).toBe("retiring");
			expect(lifecycle.last_error).toMatch(/403/);
		});

		it("never touches a bootstrap-managed agent's own token file, only reports it stale by leaving it alone", async () => {
			// The "finance" agent (`beforeEach`) is adopted, not lifecycle-owned: its token file is a
			// plain `/run/secrets/...` reference, the operator's own, never the provisioner's
			// `/run/bot-secrets/` directory. It is also the organization's configured finance agent,
			// so retiring it reassigns the role to a second, lifecycle-created agent in the same
			// request.
			await ensureAgentLifecycleAdoption(deps, "test");
			const admin = new FakeAdminClient(CHANNEL_IDS);
			await requestAgentCreate(deps, createInput("backup-finance", ["hq"]));
			const bot = await admin.createBot({
				username: "finance",
				display_name: "finance",
				description: "",
			});
			await setAgentBotUser(deps, "finance", bot.user_id, "test");
			await admin.createUserAccessToken(bot.user_id, "agent-gateway");
			const bootstrapToken = join(secretsDir, "mm_finance_token");
			writeSecretFile(bootstrapToken, "bootstrap-managed-token-value");

			await requestAgentRetire(deps, {
				agentId: "finance",
				actor: "test",
				source: "cli",
				reassignFinanceTo: "backup-finance",
			});
			const { logger } = recordingLogger();
			await pass(admin, logger);

			const [lifecycle] = (
				await pool.query("select status from agent_lifecycle where agent_id = 'finance'")
			).rows;
			expect(lifecycle.status).toBe("retired");
			expect(await admin.user(bot.user_id)).toMatchObject({ delete_at: 1 });
			expect(await admin.userAccessTokenIds(bot.user_id)).toHaveLength(0);
			// The operator's own file: left exactly as it was, never deleted.
			expect(secretFileExists(bootstrapToken)).toBe(true);
		});

		it("restore re-enables the same bot, issues a fresh token and rejoins its channels", async () => {
			const admin = new FakeAdminClient(CHANNEL_IDS);
			await requestAgentCreate(deps, createInput("analyst", ["hq", "research"]));
			const { logger } = recordingLogger();
			await pass(admin, logger);
			const [{ mattermost_user_id: botUserId }] = (
				await pool.query(
					"select mattermost_user_id from mattermost_identities where agent_id = 'analyst'",
				)
			).rows;
			const tokenPath = join(secretsDir, "mm_analyst_token");
			const tokenBeforeRetire = readFileSync(tokenPath, "utf8").trim();

			await requestAgentRetire(deps, { agentId: "analyst", actor: "test", source: "cli" });
			await pass(admin, logger);
			expect(await admin.user(botUserId)).toMatchObject({ delete_at: 1 });
			expect(secretFileExists(tokenPath)).toBe(false);

			const restored = await requestAgentRestore(deps, {
				agentId: "analyst",
				actor: "test",
				source: "cli",
			});
			await pass(admin, logger);

			const [lifecycle] = (
				await pool.query("select status from agent_lifecycle where agent_id = 'analyst'")
			).rows;
			expect(lifecycle.status).toBe("ready");
			const [operation] = (
				await pool.query("select state from agent_lifecycle_operations where id = $1", [
					restored.operationId,
				])
			).rows;
			expect(operation.state).toBe("succeeded");
			// The very same bot account, re-enabled rather than recreated.
			expect(await admin.user(botUserId)).toMatchObject({ delete_at: 0 });
			expect(secretFileExists(tokenPath)).toBe(true);
			expect(readFileSync(tokenPath, "utf8").trim()).not.toBe(tokenBeforeRetire);
			expect(admin.channelMembers.get(CHANNEL_IDS.hq)?.has(botUserId)).toBe(true);
			expect(admin.channelMembers.get(CHANNEL_IDS.research)?.has(botUserId)).toBe(true);
		});

		it("a config edit that lands while a reprovision is already running cancels it and queues a fresh one, never losing the edit", async () => {
			const admin = new FakeAdminClient(CHANNEL_IDS);
			await requestAgentCreate(deps, createInput("analyst", ["hq"]));
			const { logger } = recordingLogger();
			await pass(admin, logger);

			const [{ config: config1 }] = (
				await pool.query("select config from agents where id = 'analyst'")
			).rows;
			const afterFirstEdit: AgentConfig = {
				...config1,
				mattermost: { ...config1.mattermost, allowed_channels: ["hq", "research"] },
			};
			await commitChange(deps, {
				changeSet: [{ type: "update_agent", agent: afterFirstEdit }],
				baseRevisionId: await activeConfigRevisionId(deps),
				actor: "owner",
				source: "console",
			});
			const [firstOp] = (
				await pool.query(
					"select id from agent_lifecycle_operations where agent_id = 'analyst' and kind = 'reprovision' order by created_at desc limit 1",
				)
			).rows;
			// Simulates the provisioner having already claimed this operation on a previous tick,
			// reading `["hq", "research"]` as the configuration to provision — before the second edit
			// below ever happens.
			await markProvisioning(deps, firstOp.id, "test");

			const [{ config: config2 }] = (
				await pool.query("select config from agents where id = 'analyst'")
			).rows;
			const afterSecondEdit: AgentConfig = {
				...config2,
				mattermost: { ...config2.mattermost, allowed_channels: ["research"] },
			};
			await commitChange(deps, {
				changeSet: [{ type: "update_agent", agent: afterSecondEdit }],
				baseRevisionId: await activeConfigRevisionId(deps),
				actor: "owner",
				source: "console",
			});

			const [cancelledFirst] = (
				await pool.query("select state from agent_lifecycle_operations where id = $1", [firstOp.id])
			).rows;
			expect(cancelledFirst.state).toBe("cancelled");
			const [secondOp] = (
				await pool.query(
					"select id, state from agent_lifecycle_operations where agent_id = 'analyst' and kind = 'reprovision' order by created_at desc limit 1",
				)
			).rows;
			expect(secondOp.id).not.toBe(firstOp.id);
			expect(secondOp.state).toBe("pending");

			await pass(admin, logger);

			const [{ mattermost_user_id: botUserId }] = (
				await pool.query(
					"select mattermost_user_id from mattermost_identities where agent_id = 'analyst'",
				)
			).rows;
			// The edit made while the first (now-cancelled) operation was running is not lost: the
			// fresh operation that replaced it reads the fully current configuration (channels
			// narrowed to just "research"), not the one the cancelled operation had read.
			expect(admin.channelMembers.get(CHANNEL_IDS.hq)?.has(botUserId)).toBe(false);
			expect(admin.channelMembers.get(CHANNEL_IDS.research)?.has(botUserId)).toBe(true);
			const [finished] = (
				await pool.query("select state from agent_lifecycle_operations where id = $1", [
					secondOp.id,
				])
			).rows;
			expect(finished.state).toBe("succeeded");
		});
	});
});
