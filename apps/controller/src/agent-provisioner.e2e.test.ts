import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@agent-gateway/contracts";
import {
	type ControlPlaneDeps,
	failOperation,
	inTransaction,
	loadConfigGeneration,
	loadLifecycleOwnedAgentIds,
	loadMattermostIdentity,
	loadMattermostPlanSource,
	lockLifecycleRows,
	markProvisioning,
	mattermostBootstrapStore,
	queueMembershipReprovisioning,
	requestAgentCreate,
	requestAgentRestore,
	requestAgentRetire,
	runtimeHealth,
} from "@agent-gateway/core";
import { silentLogger } from "@agent-gateway/logging";
import { bootstrapMattermost, MattermostClient, mattermostPlan } from "@agent-gateway/mattermost";
import {
	hashConsolePassword,
	readSecretFile,
	resolveSecretPath,
	secretFileState,
	writeSecretFile,
} from "@agent-gateway/service";
import { startTestMattermost, type TestMattermost } from "@agent-gateway/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ConsoleServerOptions, startConsoleServer } from "./console-server.ts";
import { collectConsoleStatus, createConsoleStatusCache } from "./console-status.ts";
import { eventually, startTestGateway, type TestGateway } from "./test-gateway.ts";

/**
 * The automated Mattermost provisioner (ADR-026) against a real, dev Mattermost 11.7 server: no
 * `gateway mattermost bootstrap` run for the agent this test creates — only the one-time team,
 * channel and listener setup every deployment still needs once, exactly like
 * `mattermost-bridge.e2e.test.ts`. The dev server's own first account (`sysadmin`) is a genuine
 * non-bot `system_admin`, so its token stands in for the dedicated admin account ADR-026 asks an
 * operator to create once.
 */
const TEAM = "autonomous-lab";
const CHANNELS = [
	"hq",
	"research",
	"engineering",
	"finance",
	"mail",
	"approvals",
	"gateway-alerts",
];

describe("agent lifecycle provisioner against a real server (ADR-026)", () => {
	let mm: TestMattermost;
	let gateway: TestGateway;
	const secretsDir = mkdtempSync(join(tmpdir(), "gateway-provisioner-e2e-secrets-"));

	const bootstrap = async (deps: ControlPlaneDeps) => {
		const source = await loadMattermostPlanSource(deps);
		if (source === null) {
			throw new Error("no active configuration");
		}
		const generation = await loadConfigGeneration(deps);
		const plan = mattermostPlan(
			source.organization,
			source.agents,
			(ref) => resolveSecretPath(ref, secretsDir),
			source.retired,
			await loadLifecycleOwnedAgentIds(deps),
		);
		await bootstrapMattermost({
			baseUrl: mm.url,
			adminToken: mm.adminToken,
			plan,
			store: mattermostBootstrapStore(deps, "e2e"),
			tokens: { state: secretFileState, read: readSecretFile, write: writeSecretFile },
			rotateTokens: false,
			report: () => undefined,
			generation,
		});
	};

	beforeAll(async () => {
		mm = await startTestMattermost({ team: TEAM, channels: CHANNELS, users: ["owner", "human"] });
		// The provisioner's own admin token: the dev server's sysadmin, standing in for the
		// dedicated account ADR-026 asks an operator to create once. `readSetting` picks this up
		// fresh on every provisioner tick, so setting it once here (before the controller starts)
		// is enough — no file, no restart.
		process.env.MATTERMOST_ADMIN_TOKEN = mm.adminToken;
		gateway = await startTestGateway({
			mattermost: {
				bridge: {
					baseUrl: mm.url,
					routingKey: randomBytes(32).toString("hex"),
					secretsDir,
					syncIntervalMs: 2000,
				},
				bootstrap,
			},
		});
		await eventually(
			async () => gateway.controller().listener?.status().connected,
			60_000,
			"listener connected",
		);
		await eventually(
			async () =>
				(await runtimeHealth(gateway.deps())).some((h) => h.adapter === "mock" && h.available) ||
				null,
			30_000,
			"mock runtime ready",
		);
	});

	afterAll(async () => {
		delete process.env.MATTERMOST_ADMIN_TOKEN;
		await gateway?.stop();
		await mm?.stop();
	});

	const mmApi = async (method: string, path: string, token: string, body?: object) => {
		const response = await fetch(`${mm.url}/api/v4/${path}`, {
			method,
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`${method} ${path}: HTTP ${response.status} ${text}`);
		}
		return JSON.parse(text) as JsonObject;
	};

	const humanToken = () => {
		const human = mm.users.get("human");
		if (human === undefined) {
			throw new Error("no human user");
		}
		return human.token;
	};

	it("provisions a new agent's bot automatically, and a mention wakes it and gets a reply from it", async () => {
		const deps = gateway.deps();
		const agentId = "analyst";
		const created = await requestAgentCreate(deps, {
			agent: {
				id: agentId,
				display_name: "Analyst",
				mattermost: { username: agentId, allowed_channels: ["hq"] },
				runtime: { adapter: "mock", session_policy: "stateless", timeout_seconds: 30 },
				prompts: { role_file: "prompts/agents/analyst.md" },
				wake_rules: [{ event_type: "mattermost.agent.mentioned", target_agent_id: agentId }],
				concurrency: { max_active_runs: 1, while_running: "enqueue" },
				permissions: {
					tools_allow: ["mattermost.post"],
					tools_require_human_approval: [],
					tools_deny: ["finance.*"],
				},
				memory: { private_namespace: `agents/${agentId}`, shared_namespaces: [] },
			},
			rolePrompt: "You are the analyst. Reply briefly.",
			actor: "e2e",
			source: "cli",
		});
		expect(created.agentId).toBe(agentId);

		await eventually(
			async () =>
				(
					await gateway.pool.query<{ status: string }>(
						"select status from agent_lifecycle where agent_id = $1",
						[agentId],
					)
				).rows[0]?.status === "ready" || null,
			60_000,
			"the analyst's lifecycle becomes ready (the provisioner finished)",
		);

		const identity = await loadMattermostIdentity(deps, agentId);
		const botUserId = identity?.userId ?? null;
		if (botUserId === null) {
			throw new Error("unreachable: the lifecycle is ready, so the identity must be resolved");
		}
		// The bot really exists on the server, as a plain member, with a working token the
		// provisioner itself issued and wrote.
		const bot = await mmApi("GET", `users/${botUserId}`, mm.adminToken);
		expect(bot).toMatchObject({ username: agentId, is_bot: true, roles: "system_user" });

		const team = await mmApi("GET", `teams/name/${TEAM}`, mm.adminToken);
		const teamId = team.id;
		if (typeof teamId !== "string") {
			throw new Error("team has no id");
		}
		const channel = await mmApi("GET", `teams/${teamId}/channels/name/hq`, mm.adminToken);
		const hqChannel = channel.id;
		if (typeof hqChannel !== "string") {
			throw new Error("channel has no id");
		}

		const mention = await mmApi("POST", "posts", humanToken(), {
			channel_id: hqChannel,
			message: `@${agentId} are you there?`,
		});
		const mentionId = mention.id;
		if (typeof mentionId !== "string") {
			throw new Error("mention post has no id");
		}

		const reply = await eventually(
			async () => {
				const list = await mmApi("GET", `channels/${hqChannel}/posts?per_page=10`, mm.adminToken);
				const order = list.order;
				const posts = list.posts;
				if (!Array.isArray(order) || typeof posts !== "object" || posts === null) {
					return null;
				}
				for (const id of order) {
					if (typeof id !== "string" || id === mentionId) {
						continue;
					}
					const post = (posts as Record<string, JsonObject>)[id];
					if (post !== undefined && post.user_id === botUserId) {
						return post;
					}
				}
				return null;
			},
			60_000,
			"the analyst's own bot replies in #hq",
		);
		expect(reply.user_id).toBe(botUserId);
	});

	it("retires the agent against the real server: bot deactivated, removed from its channels, its token rejected; restore brings it back to working", async () => {
		const deps = gateway.deps();
		const agentId = "analyst";
		const identity = await loadMattermostIdentity(deps, agentId);
		const botUserId = identity?.userId ?? null;
		if (botUserId === null) {
			throw new Error("unreachable: the analyst was already provisioned by the earlier test");
		}
		const tokenPath = resolveSecretPath(`/run/bot-secrets/mm_${agentId}_token`, secretsDir);
		const tokenBeforeRetire = readSecretFile(tokenPath);
		expect(
			(await new MattermostClient({ baseUrl: mm.url, token: tokenBeforeRetire }).me()).id,
		).toBe(botUserId);

		await requestAgentRetire(deps, { agentId, actor: "e2e", source: "cli" });
		await eventually(
			async () =>
				(
					await gateway.pool.query<{ status: string }>(
						"select status from agent_lifecycle where agent_id = $1",
						[agentId],
					)
				).rows[0]?.status === "retired" || null,
			60_000,
			"the analyst's lifecycle becomes retired (the provisioner finished)",
		);

		const retiredBot = await mmApi("GET", `users/${botUserId}`, mm.adminToken);
		expect(retiredBot.delete_at).not.toBe(0);
		await expect(
			new MattermostClient({ baseUrl: mm.url, token: tokenBeforeRetire }).me(),
		).rejects.toThrow();
		const team = await mmApi("GET", `teams/name/${TEAM}`, mm.adminToken);
		const teamId = team.id;
		if (typeof teamId !== "string") {
			throw new Error("team has no id");
		}
		const channel = await mmApi("GET", `teams/${teamId}/channels/name/hq`, mm.adminToken);
		const hqChannel = channel.id;
		if (typeof hqChannel !== "string") {
			throw new Error("channel has no id");
		}
		const members = await mmApi(
			"GET",
			`channels/${hqChannel}/members/${botUserId}`,
			mm.adminToken,
		).catch((error: unknown) => error);
		expect(members).toBeInstanceOf(Error);

		await requestAgentRestore(deps, { agentId, actor: "e2e", source: "cli" });
		await eventually(
			async () =>
				(
					await gateway.pool.query<{ status: string }>(
						"select status from agent_lifecycle where agent_id = $1",
						[agentId],
					)
				).rows[0]?.status === "ready" || null,
			60_000,
			"the analyst's lifecycle becomes ready again (restored)",
		);
		const tokenAfterRestore = readSecretFile(tokenPath);
		expect(tokenAfterRestore).not.toBe(tokenBeforeRetire);
		expect(
			(await new MattermostClient({ baseUrl: mm.url, token: tokenAfterRestore }).me()).id,
		).toBe(botUserId);
		const restoredBot = await mmApi("GET", `users/${botUserId}`, mm.adminToken);
		expect(restoredBot.delete_at).toBe(0);

		const mention = await mmApi("POST", "posts", humanToken(), {
			channel_id: hqChannel,
			message: `@${agentId} are you still there?`,
		});
		const mentionId = mention.id;
		if (typeof mentionId !== "string") {
			throw new Error("mention post has no id");
		}
		const reply = await eventually(
			async () => {
				const list = await mmApi("GET", `channels/${hqChannel}/posts?per_page=10`, mm.adminToken);
				const order = list.order;
				const posts = list.posts;
				if (!Array.isArray(order) || typeof posts !== "object" || posts === null) {
					return null;
				}
				for (const id of order) {
					if (typeof id !== "string" || id === mentionId) {
						continue;
					}
					const post = (posts as Record<string, JsonObject>)[id];
					if (post !== undefined && post.user_id === botUserId) {
						return post;
					}
				}
				return null;
			},
			60_000,
			"the restored analyst replies in #hq",
		);
		expect(reply.user_id).toBe(botUserId);
	});

	it("a reprovision pass leaves a team the bot is a live member of but the organization no longer configures, cascading to every channel of that team too (ADR-026)", async () => {
		const deps = gateway.deps();
		const agentId = "analyst";
		const identity = await loadMattermostIdentity(deps, agentId);
		const botUserId = identity?.userId ?? null;
		if (botUserId === null) {
			throw new Error("unreachable: the analyst was already restored by the earlier test");
		}

		// A second team the organization's own configuration never names, created directly on the
		// server (never through the Gateway) — standing in for a team the bot was added to by hand,
		// or one the organization moved away from (`organization.mattermost.team` changed) without
		// this very bot's own membership ever being revisited until now.
		const secondTeam = await mmApi("POST", "teams", mm.adminToken, {
			name: "second-team",
			display_name: "Second Team",
			type: "O",
		});
		const secondTeamId = secondTeam.id;
		if (typeof secondTeamId !== "string") {
			throw new Error("second team has no id");
		}
		const secondChannel = await mmApi("POST", "channels", mm.adminToken, {
			team_id: secondTeamId,
			name: "second-hq",
			display_name: "Second HQ",
			type: "O",
		});
		const secondChannelId = secondChannel.id;
		if (typeof secondChannelId !== "string") {
			throw new Error("second team's channel has no id");
		}
		await mmApi("POST", `teams/${secondTeamId}/members`, mm.adminToken, {
			team_id: secondTeamId,
			user_id: botUserId,
		});
		await mmApi("POST", `channels/${secondChannelId}/members`, mm.adminToken, {
			user_id: botUserId,
		});
		expect(
			(await mmApi("GET", `teams/${secondTeamId}/members/${botUserId}`, mm.adminToken)).user_id,
		).toBe(botUserId);

		// Queues a `reprovision` directly (the same call a channel grant revoke or a committed
		// channel/team edit already queues under the hood, ADR-026): the provisioner's own
		// `convergeMembership` re-lists the bot's live teams on every pass, joins/keeps the
		// organization's own configured team, and leaves every other one outright, which Mattermost
		// itself then cascades into every channel of that left team — this is the one path the real
		// server actually exercises; a fake can only ever assert that `removeTeamMember` was called.
		await inTransaction(deps, async (uow) => {
			const locked = await lockLifecycleRows(uow.tx.db, [agentId]);
			await queueMembershipReprovisioning(uow, [agentId], locked, null, "e2e", "cli");
		});

		await eventually(
			async () =>
				(
					await gateway.pool.query<{ state: string }>(
						"select state from agent_lifecycle_operations where agent_id = $1 and kind = 'reprovision' order by created_at desc limit 1",
						[agentId],
					)
				).rows[0]?.state === "succeeded" || null,
			60_000,
			"the analyst's reprovision finishes",
		);

		// Mattermost soft-deletes a team membership (`delete_at` set, the row itself still readable),
		// unlike a channel membership, which the server stops reporting at all (404) the moment it
		// ends — the retire test above already relies on that same difference.
		const secondTeamMembership = await mmApi(
			"GET",
			`teams/${secondTeamId}/members/${botUserId}`,
			mm.adminToken,
		);
		expect(secondTeamMembership.delete_at).not.toBe(0);
		const stillInSecondChannel = await mmApi(
			"GET",
			`channels/${secondChannelId}/members/${botUserId}`,
			mm.adminToken,
		).catch((error: unknown) => error);
		expect(stillInSecondChannel).toBeInstanceOf(Error);

		// Unaffected: the organization's own configured team and channel, never touched by leaving an
		// unrelated one.
		const team = await mmApi("GET", `teams/name/${TEAM}`, mm.adminToken);
		const teamId = team.id;
		if (typeof teamId !== "string") {
			throw new Error("team has no id");
		}
		expect(
			(await mmApi("GET", `teams/${teamId}/members/${botUserId}`, mm.adminToken)).user_id,
		).toBe(botUserId);
		const hqChannel = await mmApi("GET", `teams/${teamId}/channels/name/hq`, mm.adminToken);
		const hqChannelId = hqChannel.id;
		if (typeof hqChannelId !== "string") {
			throw new Error("channel has no id");
		}
		expect(
			(await mmApi("GET", `channels/${hqChannelId}/members/${botUserId}`, mm.adminToken)).user_id,
		).toBe(botUserId);
	});

	describe("the console's own lifecycle routes against the real server (ADR-026)", () => {
		const PASSWORD = "console e2e lifecycle test password";
		const ORIGIN = "https://gateway.local";
		const CSRF_KEY = "a-test-only-csrf-derivation-key-at-least-32-chars";
		let passwordHash: string;
		let consoleBase: string;
		let stopConsole: () => Promise<void>;

		beforeAll(async () => {
			passwordHash = await hashConsolePassword(PASSWORD);
			const server = startConsoleServer({
				port: 0,
				hostname: "127.0.0.1",
				passwordHash,
				origin: ORIGIN,
				csrfKey: CSRF_KEY,
				deps: gateway.deps(),
				cache: createConsoleStatusCache((now) => collectConsoleStatus(gateway.pool, now)),
				log: silentLogger,
			} satisfies ConsoleServerOptions);
			consoleBase = `http://127.0.0.1:${server.port}`;
			stopConsole = server.stop;
		});

		afterAll(async () => {
			await stopConsole?.();
		});

		async function signIn(): Promise<{ cookie: string; csrfToken: string }> {
			const res = await fetch(`${consoleBase}/api/session`, {
				method: "POST",
				headers: { "content-type": "application/json", origin: ORIGIN },
				body: JSON.stringify({ password: PASSWORD }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { csrfToken: string };
			const setCookie = res.headers.get("set-cookie") ?? "";
			return { cookie: setCookie.split(";")[0] ?? "", csrfToken: body.csrfToken };
		}

		async function postJson(
			path: string,
			session: { cookie: string; csrfToken: string },
			body: unknown,
		): Promise<{ status: number; body: JsonObject }> {
			const res = await fetch(`${consoleBase}${path}`, {
				method: "POST",
				headers: {
					cookie: session.cookie,
					origin: ORIGIN,
					"content-type": "application/json",
					"x-csrf-token": session.csrfToken,
				},
				body: JSON.stringify(body),
			});
			return { status: res.status, body: (await res.json()) as JsonObject };
		}

		async function getJson(
			path: string,
			session: { cookie: string },
		): Promise<{ status: number; body: JsonObject }> {
			const res = await fetch(`${consoleBase}${path}`, { headers: { cookie: session.cookie } });
			return { status: res.status, body: (await res.json()) as JsonObject };
		}

		async function resolveChannelId(name: string): Promise<string> {
			const team = await mmApi("GET", `teams/name/${TEAM}`, mm.adminToken);
			const teamId = team.id;
			if (typeof teamId !== "string") {
				throw new Error("team has no id");
			}
			const channel = await mmApi("GET", `teams/${teamId}/channels/name/${name}`, mm.adminToken);
			const channelId = channel.id;
			if (typeof channelId !== "string") {
				throw new Error("channel has no id");
			}
			return channelId;
		}

		it("creates an agent through the console's own HTTP routes, no manual YAML/bootstrap/reconcile: ready, a mention wakes it and gets a reply, then retire deactivates its bot", async () => {
			const agentId = "advisor";
			const session = await signIn();

			const created = await postJson("/api/agents", session, {
				idempotencyKey: randomUUID(),
				id: agentId,
				displayName: "Advisor",
				allowedChannels: ["hq"],
				rolePrompt: "You are the advisor. Reply briefly.",
				runtime: { adapter: "mock" },
			});
			expect(created.status).toBe(200);
			expect(created.body.agentId).toBe(agentId);

			await eventually(
				async () =>
					(
						await gateway.pool.query<{ status: string }>(
							"select status from agent_lifecycle where agent_id = $1",
							[agentId],
						)
					).rows[0]?.status === "ready" || null,
				120_000,
				"the advisor's lifecycle becomes ready (the real provisioner finished)",
			);

			const lifecycleState = await getJson(`/api/agents/${agentId}/lifecycle`, session);
			expect(lifecycleState.status).toBe(200);
			expect(lifecycleState.body.status).toBe("ready");

			const identity = await loadMattermostIdentity(gateway.deps(), agentId);
			const botUserId = identity?.userId ?? null;
			if (botUserId === null) {
				throw new Error("unreachable: the lifecycle is ready, so the identity must be resolved");
			}
			const bot = await mmApi("GET", `users/${botUserId}`, mm.adminToken);
			expect(bot).toMatchObject({ username: agentId, is_bot: true });

			// `requestAgentCreate` defaults a new agent's permissions to `tools_allow:
			// ["mattermost.post"]` (`defaultAgentPermissions`) the same way the CLI's own
			// `gateway agents create` does, so it can reply right away — no permission grant through
			// the console's preview/commit flow is needed before the mention below gets a reply.
			const hqChannel = await resolveChannelId("hq");
			const mention = await mmApi("POST", "posts", humanToken(), {
				channel_id: hqChannel,
				message: `@${agentId} are you there?`,
			});
			const mentionId = mention.id;
			if (typeof mentionId !== "string") {
				throw new Error("mention post has no id");
			}
			const reply = await eventually(
				async () => {
					const list = await mmApi("GET", `channels/${hqChannel}/posts?per_page=10`, mm.adminToken);
					const order = list.order;
					const posts = list.posts;
					if (!Array.isArray(order) || typeof posts !== "object" || posts === null) {
						return null;
					}
					for (const id of order) {
						if (typeof id !== "string" || id === mentionId) {
							continue;
						}
						const post = (posts as Record<string, JsonObject>)[id];
						if (post !== undefined && post.user_id === botUserId) {
							return post;
						}
					}
					return null;
				},
				90_000,
				"the advisor's own bot replies in #hq",
			);
			expect(reply.user_id).toBe(botUserId);

			const retire = await postJson(`/api/agents/${agentId}/retire`, session, {
				idempotencyKey: randomUUID(),
			});
			expect(retire.status).toBe(200);
			await eventually(
				async () =>
					(
						await gateway.pool.query<{ status: string }>(
							"select status from agent_lifecycle where agent_id = $1",
							[agentId],
						)
					).rows[0]?.status === "retired" || null,
				90_000,
				"the advisor's lifecycle becomes retired (the real provisioner finished)",
			);
			const retiredBot = await mmApi("GET", `users/${botUserId}`, mm.adminToken);
			expect(retiredBot.delete_at).not.toBe(0);
		}, 300_000);

		it("retries a permanently failed create (e.g. its username was taken) once the cause is fixed, completing against the real server", async () => {
			const agentId = "retry-demo";
			const session = await signIn();

			const created = await postJson("/api/agents", session, {
				idempotencyKey: randomUUID(),
				id: agentId,
				displayName: "Retry Demo",
				allowedChannels: [],
				rolePrompt: "You are retry-demo.",
				runtime: { adapter: "mock" },
			});
			expect(created.status).toBe(200);
			const operationId = created.body.operationId;
			if (typeof operationId !== "string") {
				throw new Error("create did not return an operation id");
			}

			// Simulates the real provisioner's own permanent-failure classification (its bot's
			// username is taken by an account that is not plausibly the Gateway's own) — covered on
			// its own terms by `agent-provisioner.integration.test.ts`'s fake-client suite; this test
			// is about the console's own retry route resuming real provisioning afterward, not about
			// re-proving that classification against a real server.
			await markProvisioning(gateway.deps(), operationId, "e2e");
			await failOperation(gateway.deps(), operationId, "e2e", "username taken");

			const failedState = await getJson(`/api/agents/${agentId}/lifecycle`, session);
			expect(failedState.status).toBe(200);
			expect(failedState.body.status).toBe("failed");
			expect(failedState.body.lastError).toBe("username taken");

			const retry = await postJson(`/api/agents/${agentId}/retry`, session, {
				idempotencyKey: randomUUID(),
			});
			expect(retry.status).toBe(200);
			expect(retry.body.kind).toBe("create");

			await eventually(
				async () =>
					(
						await gateway.pool.query<{ status: string }>(
							"select status from agent_lifecycle where agent_id = $1",
							[agentId],
						)
					).rows[0]?.status === "ready" || null,
				120_000,
				"retry-demo's lifecycle becomes ready (the real provisioner finished the retried operation)",
			);
			const identity = await loadMattermostIdentity(gateway.deps(), agentId);
			expect(identity?.userId ?? null).not.toBeNull();
		}, 180_000);
	});

	it("admin token rotate against the real server: the old token stops working, the new one works", async () => {
		const admin = new MattermostClient({ baseUrl: mm.url, token: mm.adminToken });
		const me = await admin.me();
		const created = await admin.createUserAccessToken(me.id, "agent-gateway-admin");
		const rotated = new MattermostClient({ baseUrl: mm.url, token: created.token });
		expect((await rotated.me()).id).toBe(me.id);

		for (const tokenId of await rotated.userAccessTokenIds(me.id)) {
			if (tokenId !== created.id) {
				await rotated.revokeUserAccessToken(tokenId);
			}
		}

		await expect(
			new MattermostClient({ baseUrl: mm.url, token: mm.adminToken }).me(),
		).rejects.toThrow();
		expect((await rotated.me()).id).toBe(me.id);
	});
});
