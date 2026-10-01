import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTurnInput, JsonObject, JsonValue } from "@agent-gateway/contracts";
import {
	applyConfig,
	type ControlPlaneDeps,
	loadConfigGeneration,
	loadDirectoryEntry,
	loadMattermostIdentity,
	loadMattermostPlanSource,
	mattermostBootstrapStore,
	mattermostReconcileStore,
	pauseAgent,
	resumeAgent,
} from "@agent-gateway/core";
import {
	bootstrapMattermost,
	type MattermostPlan,
	mattermostPlan,
	reconcileMattermost,
	type TokenFiles,
} from "@agent-gateway/mattermost";
import { approvalCode } from "@agent-gateway/policy";
import {
	readSecretFile,
	resolveSecretPath,
	secretFileState,
	writeSecretFile,
} from "@agent-gateway/service";
import { startTestMattermost, type TestMattermost } from "@agent-gateway/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	eventually,
	exampleConfig,
	setAgentEnabledThroughConfig,
	startTestGateway,
	type TestGateway,
} from "./test-gateway.ts";

type Row = Record<string, JsonValue>;

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
const tokenFiles: TokenFiles = {
	state: secretFileState,
	read: readSecretFile,
	write: writeSecretFile,
};

describe("Mattermost bridge against a real server", () => {
	let mm: TestMattermost;
	let gateway: TestGateway;
	let plan: MattermostPlan;
	const secretsDir = mkdtempSync(join(tmpdir(), "gateway-e2e-secrets-"));
	const routingKey = randomBytes(32).toString("hex");
	const bootstrapReport: string[] = [];

	const bootstrap = async (deps: ControlPlaneDeps, rotateTokens = false) => {
		const generation = await loadConfigGeneration(deps);
		const source = await loadMattermostPlanSource(deps);
		if (source === null) {
			throw new Error("no active configuration");
		}
		plan = mattermostPlan(
			source.organization,
			source.agents,
			(ref) => resolveSecretPath(ref, secretsDir),
			source.retired,
		);
		await bootstrapMattermost({
			baseUrl: mm.url,
			adminToken: mm.adminToken,
			plan,
			store: mattermostBootstrapStore(deps, "e2e"),
			tokens: tokenFiles,
			rotateTokens,
			report: (line) => bootstrapReport.push(line),
			generation,
		});
	};

	beforeAll(async () => {
		mm = await startTestMattermost({
			team: TEAM,
			channels: CHANNELS,
			privateChannels: ["finance"],
			users: ["owner", "human"],
		});
		gateway = await startTestGateway({
			mattermost: {
				bridge: {
					baseUrl: mm.url,
					routingKey,
					secretsDir,
					syncIntervalMs: 60_000,
					reconnectMinMs: 2000,
					membershipIntervalMs: 1000,
					membershipGraceMs: 3000,
				},
				bootstrap: (deps) => bootstrap(deps),
			},
		});
		await eventually(
			async () => gateway.controller().listener?.status().connected,
			60_000,
			"listener connected",
		);
	});

	afterAll(async () => {
		await gateway?.stop();
		await mm?.stop();
	});

	const query = async <T extends Row>(text: string, values: Readonly<(string | number)[]> = []) =>
		(await gateway.pool.query<T>(text, [...values])).rows;

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
		const json: JsonObject = JSON.parse(text);
		return json;
	};

	const channel = (name: string) => {
		const id = mm.channels.get(name);
		if (id === undefined) {
			throw new Error(`no channel '${name}'`);
		}
		return id;
	};

	const humanToken = () => {
		const human = mm.users.get("human");
		if (human === undefined) {
			throw new Error("no human user");
		}
		return human.token;
	};

	/** Posts as the human; returns the post id. */
	const say = async (
		channelName: string,
		message: string,
		options: Readonly<{
			rootId?: string;
			token?: string;
			props?: JsonObject;
			channelId?: string;
		}> = {},
	) => {
		const created = await mmApi("POST", "posts", options.token ?? humanToken(), {
			channel_id: options.channelId ?? channel(channelName),
			message,
			...(options.rootId === undefined ? {} : { root_id: options.rootId }),
			...(options.props === undefined ? {} : { props: options.props }),
		});
		const id = created.id;
		if (typeof id !== "string") {
			throw new Error("created post has no id");
		}
		return id;
	};

	const eventOf = (postId: string) =>
		eventually(
			async () =>
				(
					await query<{ id: string; type: string; sender_agent_id: string | null }>(
						`select id, type, sender_agent_id from events
						  where subject like $1 and type not in ('mattermost.post.edited', 'mattermost.post.deleted')`,
						[`channel/%/post/${postId}`],
					)
				)[0],
			30_000,
			`event of post ${postId}`,
		);

	const runsOf = (eventId: string) =>
		query<{ id: string; agent_id: string; status: string }>(
			"select id, agent_id, status from agent_runs where trigger_event_id = $1 order by queued_at",
			[eventId],
		);

	const finishedRun = (eventId: string, what: string) =>
		eventually(
			async () => {
				const run = (await runsOf(eventId)).at(-1);
				return run !== undefined && run.status !== "queued" && run.status !== "running"
					? run
					: null;
			},
			60_000,
			what,
		);

	/** The Mattermost post an agent run published. */
	const publishedPost = async (runId: string) => {
		const receipt = await eventually(
			async () =>
				(
					await query<{ receipt: JsonValue }>(
						"select receipt from outbox where run_id = $1 and status = 'sent'",
						[runId],
					)
				)[0]?.receipt,
			30_000,
			`published post of run ${runId}`,
		);
		if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
			throw new Error("receipt is not an object");
		}
		const postId = receipt.postId;
		if (typeof postId !== "string") {
			throw new Error("receipt has no post id");
		}
		return mmApi("GET", `posts/${postId}`, mm.adminToken);
	};

	const botUserId = async (agentId: string) =>
		(await loadMattermostIdentity(gateway.deps(), agentId))?.userId ?? null;

	/** The stored creation of a post, if any (agent posts are keyed by their signed key). */
	const creationOf = (postId: string) =>
		query<{ id: string; type: string; payload: JsonObject }>(
			`select id, type, payload from events
			  where subject like $1 and type not in ('mattermost.post.edited', 'mattermost.post.deleted')`,
			[`channel/%/post/${postId}`],
		);

	const reconcile = () => {
		const deps = gateway.deps();
		return reconcileMattermost({
			baseUrl: mm.url,
			plan,
			tokens: tokenFiles,
			store: mattermostReconcileStore(deps),
		});
	};

	/**
	 * Holds the row lock a channel grant takes (`gateway_controls`, ADR-022) for `work`: the live
	 * membership synchronizer cannot turn a membership `work` adds into a grant before `work` is
	 * done examining it, since granting takes this same row for update and waits behind it. Reads
	 * (reconcile among them) are not blocked by it.
	 */
	const withGrantsBlocked = async <T>(work: () => Promise<T>): Promise<T> => {
		const client = await gateway.pool.connect();
		try {
			await client.query("begin");
			await client.query("insert into gateway_controls (id) values (1) on conflict do nothing");
			await client.query("select id from gateway_controls where id = 1 for update");
			return await work();
		} finally {
			await client.query("rollback");
			client.release();
		}
	};

	/** Give routing a moment, then prove nothing ran. */
	const settle = () => Bun.sleep(3000);

	const agentState = async (agentId: string) =>
		(await query<{ state: string }>("select state from agents where id = $1", [agentId]))[0]?.state;

	const waitingAgent = (agentId: string) =>
		eventually(async () => (await agentState(agentId)) === "waiting", 60_000, `${agentId} waits`);

	const inputOf = async (runId: string) => {
		const [row] = await query<{ input: AgentTurnInput }>(
			"select input from context_snapshots where run_id = $1",
			[runId],
		);
		if (row === undefined) {
			throw new Error(`run ${runId} has no snapshot`);
		}
		return row.input;
	};

	const idOf = (post: JsonObject) => {
		const id = post.id;
		if (typeof id !== "string") {
			throw new Error("post has no id");
		}
		return id;
	};

	const waitsIn = (root: string) =>
		query<{ agent_id: string; status: string }>(
			"select agent_id, status from wait_subscriptions where correlation_id = $1 order by created_at",
			[`thread:${root}`],
		);

	it("bootstraps bots, memberships and tokens, and reconcile finds nothing to fix", async () => {
		// Every example agent's bot, plus the Gateway's own listener bot.
		const bots = exampleConfig().agents.length + 1;
		expect(bootstrapReport.filter((line) => line.includes("token issued"))).toHaveLength(bots);
		const deps = gateway.deps();
		expect(await reconcile()).toEqual([]);
		// Bots are plain members, never admins.
		const developer = await mmApi("GET", `users/${await botUserId("developer")}`, mm.adminToken);
		expect(developer).toMatchObject({ is_bot: true, roles: "system_user" });
		// A second run keeps working tokens.
		const before = readFileSync(join(secretsDir, "mm_developer_token"), "utf8");
		bootstrapReport.length = 0;
		await bootstrap(deps);
		expect(readFileSync(join(secretsDir, "mm_developer_token"), "utf8")).toBe(before);
		expect(bootstrapReport).toHaveLength(bots);
		expect(bootstrapReport.every((line) => line.includes("token kept"))).toBe(true);

		// A membership outside the bot's channels is found, and bootstrap removes it.
		await mmApi("POST", `channels/${channel("finance")}/members`, mm.adminToken, {
			user_id: await botUserId("developer"),
		});
		expect(await reconcile()).toEqual([
			"developer: member of channel 'finance' it is not allowed in",
		]);
		await bootstrap(deps);
		expect(await reconcile()).toEqual([]);

		// Admin rights in a channel and membership of an unmanaged channel are found and undone.
		const developerId = await botUserId("developer");
		await mmApi("PUT", `channels/${channel("hq")}/members/${developerId}/roles`, mm.adminToken, {
			roles: "channel_user channel_admin",
		});
		const townSquare = await mmApi(
			"GET",
			`teams/${mm.teamId}/channels/name/town-square`,
			mm.adminToken,
		);
		await mmApi(
			"PUT",
			`channels/${String(townSquare.id)}/members/${developerId}/roles`,
			mm.adminToken,
			{ roles: "channel_user channel_admin" },
		);
		const random = await mmApi("POST", "channels", mm.adminToken, {
			team_id: mm.teamId,
			name: "unmanaged-room",
			display_name: "unmanaged-room",
			type: "P",
		});
		// Blocked against the live membership synchronizer (it polls every second here): the admin
		// who added this bot is also an owner-equivalent add under ADR-022, and without the block
		// the synchronizer could grant the channel, and bring the listener into it, before this
		// checks it is still an unmanaged, unauthorized membership.
		await withGrantsBlocked(async () => {
			await mmApi("POST", `channels/${String(random.id)}/members`, mm.adminToken, {
				user_id: developerId,
			});
			expect([...(await reconcile())].sort()).toEqual([
				"developer: has admin rights in channel 'hq'",
				"developer: has admin rights in channel 'town-square'",
				"developer: member of channel 'unmanaged-room' it is not allowed in",
			]);
		});
		await bootstrap(deps);
		expect(await reconcile()).toEqual([]);

		// Rotation revokes every earlier token of the bot, not only the stored one.
		const oldToken = readSecretFile(join(secretsDir, "mm_research_token"));
		const extra = await mmApi(
			"POST",
			`users/${await botUserId("research")}/tokens`,
			mm.adminToken,
			{
				description: "someone else's",
			},
		);
		await bootstrap(deps, true);
		for (const token of [oldToken, String(extra.token)]) {
			const me = await fetch(`${mm.url}/api/v4/users/me`, {
				headers: { authorization: `Bearer ${token}` },
			});
			expect(me.status).toBe(401);
		}
		expect(await reconcile()).toEqual([]);
	});

	it("wakes exactly the mentioned agent and replies as its bot in the thread", async () => {
		const postId = await say("hq", "@developer please report the status");
		const event = await eventOf(postId);
		expect(event.type).toBe("mattermost.agent.mentioned");
		const run = await finishedRun(event.id, "developer run");
		expect(run).toMatchObject({ agent_id: "developer", status: "succeeded" });
		expect(await runsOf(event.id)).toHaveLength(1);

		const reply = await publishedPost(run.id);
		expect(reply.user_id).toBe(await botUserId("developer"));
		expect(reply.root_id).toBe(postId);
		expect(reply.channel_id).toBe(channel("hq"));

		// The reply comes back through the listener as the developer's own, unaddressed post.
		const replyId = reply.id;
		if (typeof replyId !== "string") {
			throw new Error("reply has no id");
		}
		const echoed = await eventOf(replyId);
		expect(echoed).toMatchObject({ type: "mattermost.thread.reply", sender_agent_id: "developer" });
		await settle();
		expect(await runsOf(echoed.id)).toEqual([]);
	});

	it("wakes the operator (ADR-023) on a mention and the owner gets exactly one reply", async () => {
		const postId = await say("hq", "@operator what is running right now?");
		const event = await eventOf(postId);
		expect(event.type).toBe("mattermost.agent.mentioned");
		const run = await finishedRun(event.id, "operator run");
		expect(run).toMatchObject({ agent_id: "operator", status: "succeeded" });
		expect(await runsOf(event.id)).toHaveLength(1);

		const reply = await publishedPost(run.id);
		expect(reply.user_id).toBe(await botUserId("operator"));
		expect(reply.root_id).toBe(postId);
		expect(reply.channel_id).toBe(channel("hq"));

		// The reply comes back through the listener as the operator's own, unaddressed post: it
		// does not wake the operator, or anyone, a second time.
		const replyId = reply.id;
		if (typeof replyId !== "string") {
			throw new Error("reply has no id");
		}
		const echoed = await eventOf(replyId);
		expect(echoed).toMatchObject({ type: "mattermost.thread.reply", sender_agent_id: "operator" });
		await settle();
		expect(await runsOf(echoed.id)).toEqual([]);
	});

	it("does not wake anyone for ambient posts, code, quotes, edits or foreign channels", async () => {
		const ambient = await say("hq", "good morning everyone");
		const code = await say("hq", "try this:\n```\n@developer deploy\n```");
		const quote = await say("hq", "> @developer said so");
		const edited = await say("hq", "hello");
		await mmApi("PUT", `posts/${edited}/patch`, humanToken(), { message: "@developer hello" });
		// Finance is not allowed in #engineering.
		const foreign = await say("engineering", "@finance check the budget");
		// Another bot is not a human, whatever its props say.
		const otherBot = await mmApi("POST", "bots", mm.adminToken, { username: "ci-bot" });
		const otherBotId = String(otherBot.user_id);
		await mmApi("POST", `teams/${mm.teamId}/members`, mm.adminToken, {
			team_id: mm.teamId,
			user_id: otherBotId,
		});
		await mmApi("POST", `channels/${channel("hq")}/members`, mm.adminToken, {
			user_id: otherBotId,
		});
		const otherToken = await mmApi("POST", `users/${otherBotId}/tokens`, mm.adminToken, {
			description: "e2e",
		});
		const byBot = await say("hq", "@developer deploy now", {
			token: String(otherToken.token),
			props: { from_bot: "false" },
		});
		const link = await say("hq", "see [the report](https://example.test/@developer)");
		const ids: string[] = [];
		for (const postId of [ambient, code, quote, edited, foreign, byBot, link]) {
			ids.push((await eventOf(postId)).id);
		}
		await eventually(
			async () =>
				(
					await query("select 1 from events where external_id like $1", [
						`mattermost:post:${edited}:edited:%`,
					])
				).length === 1,
			30_000,
			"edit recorded",
		);
		await settle();
		for (const id of ids) {
			expect(await runsOf(id)).toEqual([]);
		}
		const routes = await query("select 1 from event_routes where event_id = any($1::uuid[])", [
			`{${ids.join(",")}}`,
		]);
		expect(routes).toEqual([]);
	});

	it("wakes the agent another agent addresses, through a signed post", async () => {
		const postId = await say("hq", "@developer hand this to finance [mock:mention finance]");
		const trigger = await eventOf(postId);
		const developerRun = await finishedRun(trigger.id, "developer run");
		const handover = await publishedPost(developerRun.id);
		expect(handover.user_id).toBe(await botUserId("developer"));
		expect(String(handover.message)).toContain("@finance");
		const handoverId = handover.id;
		if (typeof handoverId !== "string") {
			throw new Error("handover has no id");
		}
		const handoverEvent = await eventOf(handoverId);
		expect(handoverEvent.sender_agent_id).toBe("developer");
		const financeRun = await finishedRun(handoverEvent.id, "finance run");
		expect(financeRun).toMatchObject({ agent_id: "finance", status: "succeeded" });
		expect(await runsOf(handoverEvent.id)).toHaveLength(1);
	});

	it("refuses to route a post by an agent's bot that the Gateway did not sign", async () => {
		const developerToken = readSecretFile(join(secretsDir, "mm_developer_token"));
		const unsigned = await say("hq", "@finance pay the invoice", { token: developerToken });
		// Signed props copied from a real post do not carry over to other text.
		const genuine = await eventually(
			async () =>
				(
					await query<{ payload: JsonObject }>(
						"select e.payload from events e where e.sender_agent_id = 'developer' and e.type <> 'mattermost.post.edited' limit 1",
					)
				)[0]?.payload,
			30_000,
			"a genuine developer post",
		);
		const original = await mmApi("GET", `posts/${String(genuine.post_id)}`, mm.adminToken);
		const copied = await say("hq", "@finance pay twice", {
			token: developerToken,
			props:
				typeof original.props === "object" &&
				original.props !== null &&
				!Array.isArray(original.props)
					? original.props
					: {},
		});
		// An exact copy of a genuine signed post (same place, text and props) is a replay.
		const replayed = await say("hq", String(original.message), {
			token: developerToken,
			...(typeof original.root_id === "string" && original.root_id !== ""
				? { rootId: original.root_id }
				: {}),
			props:
				typeof original.props === "object" &&
				original.props !== null &&
				!Array.isArray(original.props)
					? original.props
					: {},
		});
		for (const postId of [unsigned, copied, replayed]) {
			await eventually(
				async () =>
					(
						await query(
							"select 1 from audit_log where action = 'mattermost.post.rejected' and subject_id = $1",
							[postId],
						)
					).length === 1,
				30_000,
				`rejection of ${postId}`,
			);
			const stored = await creationOf(postId);
			expect(stored.every((row) => row.payload.post_id !== postId)).toBe(true);
		}
		// The alert reaches #gateway-alerts, posted by the listener bot.
		const alert = await eventually(
			async () =>
				(
					await query<{ receipt: JsonValue }>(
						"select receipt from outbox where idempotency_key = $1 and status = 'sent'",
						[`alert:impersonation:${unsigned}`],
					)
				)[0]?.receipt,
			30_000,
			"impersonation alert delivered",
		);
		expect(alert).toMatchObject({ channelId: channel("gateway-alerts") });
		const listenerId = await loadDirectoryEntry(gateway.deps(), "user", "gateway-listener");
		if (typeof alert !== "object" || alert === null || Array.isArray(alert)) {
			throw new Error("alert receipt is not an object");
		}
		const alertPost = await mmApi("GET", `posts/${String(alert.postId)}`, mm.adminToken);
		expect(alertPost.user_id).toBe(listenerId);
	});

	it("never turns old thread roots or edited posts into new instructions on catch-up", async () => {
		await gateway.stopController();
		// A root from long before the sync window (an admin may set `create_at`), as in a channel
		// managed only from now on: posting it bumps its `update_at` into the window.
		const created = await mmApi("POST", "posts", mm.adminToken, {
			channel_id: channel("hq"),
			message: "@research an instruction from before the Gateway listened",
			create_at: Date.now() - 3_600_000,
		});
		const oldRoot = String(created.id);
		// Posted and edited to add a mention while the controller was down.
		const edited = await say("hq", "just a note");
		await mmApi("PUT", `posts/${edited}/patch`, humanToken(), { message: "@research a note" });
		await gateway.startController();
		await eventually(
			async () => gateway.controller().listener?.status().connected,
			30_000,
			"listener connected",
		);
		// A reply bumps the old root's update_at, so the next sync reads the root again.
		const reply = await say("hq", "any news here?", { rootId: oldRoot });
		await eventOf(reply);
		await gateway.controller().listener?.sync();
		const recovered = await eventOf(edited);
		expect(recovered.type).toBe("mattermost.post.recovered");
		await settle();
		expect(await creationOf(oldRoot)).toEqual([]);
		expect(await runsOf(recovered.id)).toEqual([]);
	});

	it("does not let an edited forged reply resolve an agent's wait", async () => {
		const deps = gateway.deps();
		// Finance stays silent (paused), so only a forged reply could answer developer's wait.
		await pauseAgent(deps, "finance", "e2e");
		const root = await say("hq", "@developer ask finance and wait [mock:wait-open finance]");
		const waitFor = () =>
			query<{ status: string }>(
				"select w.status from wait_subscriptions w where w.agent_id = 'developer' and w.correlation_id = $1",
				[`thread:${root}`],
			);
		await eventually(async () => (await waitFor()).length === 1, 60_000, "developer waits");
		const financeToken = readSecretFile(join(secretsDir, "mm_finance_token"));
		const forged = await say("hq", "done, all paid", { rootId: root, token: financeToken });
		await mmApi("PUT", `posts/${forged}/patch`, financeToken, { message: "done, all paid!" });
		await Bun.sleep(1000);
		await gateway.controller().listener?.sync();
		await settle();
		expect(await waitFor()).toEqual([{ status: "active" }]);
		expect(await creationOf(forged)).toEqual([]);
		expect(
			await query("select 1 from events where subject like $1", [`channel/%/post/${forged}`]),
		).toEqual([]);
		// Leave developer and finance as the other tests expect them.
		await setAgentEnabledThroughConfig(deps, "developer", false, "e2e");
		await setAgentEnabledThroughConfig(deps, "developer", true, "e2e");
		await resumeAgent(deps, "finance", "e2e");
	});

	it("catches up after a restart without duplicating runs", async () => {
		await gateway.stopController();
		const postId = await say("hq", "@research look into topic X while I restart you");
		await gateway.startController();
		const event = await eventOf(postId);
		const run = await finishedRun(event.id, "research run after restart");
		expect(run.agent_id).toBe("research");

		await gateway.stopController();
		await gateway.startController();
		await gateway.controller().listener?.sync();
		await settle();
		expect(await runsOf(event.id)).toHaveLength(1);
	});

	it("backfills posts made while the WebSocket was down, once", async () => {
		const listener = gateway.controller().listener;
		if (listener === null) {
			throw new Error("no listener");
		}
		await eventually(async () => listener.status().connected, 30_000, "listener connected");
		const reconnects = listener.status().reconnects;
		listener.reconnect();
		// Post only once the socket is really gone, so only catch-up can find the post.
		await eventually(async () => !listener.status().connected, 10_000, "socket closed");
		const postId = await say("hq", "@director anything new while the socket was down?");
		await eventually(
			async () => listener.status().connected && listener.status().reconnects > reconnects,
			60_000,
			"listener reconnected",
		);
		const event = await eventOf(postId);
		const run = await finishedRun(event.id, "director run after reconnect");
		expect(run.agent_id).toBe("director");
		await listener.sync();
		await listener.sync();
		await settle();
		expect(await runsOf(event.id)).toHaveLength(1);
	});

	it("starts a newly managed channel without replaying its history", async () => {
		const deps = gateway.deps();
		const labs = String(
			(
				await mmApi("POST", "channels", mm.adminToken, {
					team_id: mm.teamId,
					name: "labs",
					display_name: "labs",
					type: "O",
				})
			).id,
		);
		const human = mm.users.get("human");
		await mmApi("POST", `channels/${labs}/members`, mm.adminToken, { user_id: human?.id });
		const before = await say("labs", "@developer did anyone set this up yet?", {
			channelId: labs,
		});
		const editedBefore = await say("labs", "a note", { channelId: labs });
		await Bun.sleep(50);
		await mmApi("PUT", `posts/${before}/patch`, humanToken(), {
			message: "@developer did anyone set this up yet? (edited)",
		});
		const config = exampleConfig();
		await applyConfig(
			deps,
			{
				...config,
				organization: {
					...config.organization,
					mattermost: {
						...config.organization.mattermost,
						channels: [...config.organization.mattermost.channels, "labs"],
					},
				},
				agents: config.agents.map((agent) =>
					agent.id === "developer"
						? {
								...agent,
								mattermost: {
									...agent.mattermost,
									allowed_channels: [...agent.mattermost.allowed_channels, "labs"],
								},
							}
						: agent,
				),
			},
			"e2e",
		);
		await bootstrap(deps);
		// Right away: the listener may still see the channel as unmanaged for a few seconds.
		const after = await say("labs", "@developer now it is set up", { channelId: labs });
		await Bun.sleep(6000);
		await gateway.controller().listener?.sync();
		const event = await eventOf(after);
		const run = await finishedRun(event.id, "developer run in the new channel");
		expect(run.agent_id).toBe("developer");
		expect(await runsOf(event.id)).toHaveLength(1);
		expect(await creationOf(before)).toEqual([]);
		// Nothing of the channel's earlier history is recorded, edits included.
		for (const postId of [before, editedBefore]) {
			expect(
				await query("select 1 from events where subject like $1", [`channel/%/post/${postId}`]),
			).toEqual([]);
		}
	});

	it("lets an owner give an agent a channel by adding its bot, and take it back", async () => {
		const ownerToken = mm.users.get("owner")?.token;
		const human = mm.users.get("human");
		const owner = mm.users.get("owner");
		if (ownerToken === undefined || human === undefined || owner === undefined) {
			throw new Error("no owner or human user");
		}
		const garden = String(
			(
				await mmApi("POST", "channels", mm.adminToken, {
					team_id: mm.teamId,
					name: "garden",
					display_name: "garden",
					type: "O",
				})
			).id,
		);
		for (const user of [human, owner]) {
			await mmApi("POST", `channels/${garden}/members`, mm.adminToken, { user_id: user.id });
		}
		const research = await botUserId("research");
		const finance = await botUserId("finance");
		const listener = await loadDirectoryEntry(gateway.deps(), "user", "gateway-listener");
		const before = await say("garden", "@research anything growing here?", { channelId: garden });

		// The owner adds the bot: no configuration, no command.
		await mmApi("POST", `channels/${garden}/members`, ownerToken, { user_id: research });
		await eventually(
			async () =>
				(
					await query<{ state: string }>(
						"select state from mattermost_channel_grants where agent_id = 'research' and channel_id = $1",
						[garden],
					)
				)[0]?.state === "active",
			30_000,
			"research granted the channel",
		);
		const member = (userId: string | null) =>
			mmApi("GET", `channels/${garden}/members/${userId}`, mm.adminToken).then(
				() => true,
				() => false,
			);
		expect(await member(listener)).toBe(true);
		const after = await say("garden", "@research please say hello", { channelId: garden });
		const event = await eventOf(after);
		const run = await finishedRun(event.id, "research run in the granted channel");
		expect(run).toMatchObject({ agent_id: "research", status: "succeeded" });
		const reply = await publishedPost(run.id);
		expect(reply.channel_id).toBe(garden);
		expect(reply.user_id).toBe(research);
		// Nothing from before the add reached the agent.
		expect(await creationOf(before)).toEqual([]);

		// An agent never grants: research's bot adding finance's is refused.
		const researchToken = readSecretFile(
			resolveSecretPath("/run/secrets/mm_research_token", secretsDir),
		);
		await mmApi("POST", `channels/${garden}/members`, researchToken, { user_id: finance });
		await eventually(async () => !(await member(finance)), 30_000, "finance bot left (bot add)");
		const refusedByBot = await eventually(
			async () =>
				(
					await query<{ detail: JsonObject }>(
						"select detail from audit_log where action = 'mattermost.channel.add_rejected' and detail->>'actor_user_id' = $1",
						[research ?? ""],
					)
				)[0],
			30_000,
			"the bot's add refused",
		);
		expect(refusedByBot.detail.reason).toBe("not_owner_or_admin");

		// A human who is neither an owner nor an admin grants nothing: the bot leaves.
		await mmApi("POST", `channels/${garden}/members`, humanToken(), { user_id: finance });
		await eventually(async () => !(await member(finance)), 30_000, "finance bot left");
		expect(
			await query(
				"select 1 from mattermost_channel_grants where agent_id = 'finance' and channel_id = $1",
				[garden],
			),
		).toEqual([]);
		await eventually(
			async () =>
				(
					await query(
						"select 1 from outbox where kind = 'mattermost.alert' and payload->>'message' like $1",
						[
							"%@finance was added to ~garden by someone who is neither an owner nor a system admin%",
						],
					)
				).length > 0,
			30_000,
			"alert about the refused add",
		);

		// A system admin grants as well.
		await mmApi("POST", `channels/${garden}/members`, mm.adminToken, { user_id: finance });
		await eventually(
			async () =>
				(
					await query<{ state: string }>(
						"select state from mattermost_channel_grants where agent_id = 'finance' and channel_id = $1",
						[garden],
					)
				)[0]?.state === "active",
			30_000,
			"finance granted by the admin",
		);

		// The owner takes the channel back: the grants end and the listener leaves with the last.
		await mmApi("DELETE", `channels/${garden}/members/${research}`, ownerToken);
		await eventually(
			async () =>
				(
					await query<{ state: string }>(
						"select state from mattermost_channel_grants where agent_id = 'research' and channel_id = $1",
						[garden],
					)
				)[0]?.state === "revoked",
			30_000,
			"research's grant revoked",
		);
		expect(await member(listener)).toBe(true);
		await mmApi("DELETE", `channels/${garden}/members/${finance}`, ownerToken);
		await eventually(async () => !(await member(listener)), 30_000, "listener left the channel");
		const late = await say("garden", "@research are you still here?", { channelId: garden });
		await settle();
		const lateEvents = await creationOf(late);
		for (const lateEvent of lateEvents) {
			expect(await runsOf(lateEvent.id)).toEqual([]);
		}
	});

	it("answers a mention made right after the add, in a channel already followed", async () => {
		const ownerToken = mm.users.get("owner")?.token;
		if (ownerToken === undefined) {
			throw new Error("no owner user");
		}
		// #engineering is the developer's: the listener already follows it.
		const engineering = channel("engineering");
		const research = await botUserId("research");
		await mmApi("POST", `channels/${engineering}/members`, ownerToken, { user_id: research });
		const mention = await say("engineering", "@research can you check the build log?", {
			token: ownerToken,
		});
		const event = await eventOf(mention);
		const run = await finishedRun(event.id, "research run after the add");
		expect(run).toMatchObject({ agent_id: "research", status: "succeeded" });
		expect((await publishedPost(run.id)).channel_id).toBe(engineering);
		expect(await runsOf(event.id)).toHaveLength(1);
		await mmApi("DELETE", `channels/${engineering}/members/${research}`, ownerToken);
		await eventually(
			async () =>
				(
					await query<{ state: string }>(
						"select state from mattermost_channel_grants where agent_id = 'research' and channel_id = $1",
						[engineering],
					)
				)[0]?.state === "revoked",
			30_000,
			"research's engineering grant revoked",
		);
	});

	it("developer waits for finance and resumes once on its reply in the thread", async () => {
		const root = await say("hq", "@developer ask finance about the budget [mock:wait finance]");
		const asked = await finishedRun((await eventOf(root)).id, "developer asks finance");
		expect(asked).toMatchObject({ agent_id: "developer", status: "succeeded" });
		const question = await publishedPost(asked.id);
		expect(question.root_id).toBe(root);
		expect(await waitsIn(root)).toEqual([{ agent_id: "developer", status: "active" }]);

		const financeRun = await finishedRun((await eventOf(idOf(question))).id, "finance answers");
		const answer = await publishedPost(financeRun.id);
		expect(answer).toMatchObject({ user_id: await botUserId("finance"), root_id: root });
		const answerEvent = await eventOf(idOf(answer));
		const resumed = await finishedRun(answerEvent.id, "developer resumes");
		expect(resumed).toMatchObject({ agent_id: "developer", status: "succeeded" });
		const input = await inputOf(resumed.id);
		expect(input.durableState.resolvedWaits.map((w) => w.outcome)).toEqual(["matched"]);
		expect(input.threadContext?.rootPost?.postId).toBe(root);
		expect(input.threadContext?.recentPosts.map((p) => p.postId)).toEqual([idOf(question)]);
		const closing = await publishedPost(resumed.id);
		expect(closing).toMatchObject({
			user_id: await botUserId("developer"),
			root_id: root,
			message: "Thanks, continuing.",
		});

		// The same reply delivered again (a restart catches up over it) resumes nobody.
		await gateway.stopController();
		await gateway.startController();
		await gateway.controller().listener?.sync();
		await settle();
		expect(await runsOf(answerEvent.id)).toHaveLength(1);
		expect(await waitsIn(root)).toEqual([{ agent_id: "developer", status: "matched" }]);
	});

	it("does not resume a waiting agent with a reply in another thread", async () => {
		const deps = gateway.deps();
		await pauseAgent(deps, "finance", "e2e");
		// Queued first, so finance handles it first: a handover to developer in another thread.
		const elsewhere = await say(
			"hq",
			"@finance brief developer on invoices [mock:mention developer]",
		);
		const root = await say("hq", "@developer ask finance about taxes [mock:wait finance]");
		const asked = await finishedRun((await eventOf(root)).id, "developer asks finance");
		await waitingAgent("developer");
		// The question is in finance's inbox too; finance takes both in one turn and, told to hand
		// over elsewhere, leaves the question unanswered.
		await eventOf(idOf(await publishedPost(asked.id)));
		await resumeAgent(deps, "finance", "e2e");

		const financeRun = await finishedRun((await eventOf(elsewhere)).id, "finance hands over");
		const handover = await publishedPost(financeRun.id);
		expect(handover.root_id).toBe(elsewhere);
		const handoverEvent = await eventOf(idOf(handover));
		await settle();
		expect(await agentState("developer")).toBe("waiting");
		expect(await runsOf(handoverEvent.id)).toEqual([]);
		expect(await waitsIn(root)).toEqual([{ agent_id: "developer", status: "active" }]);

		// Finance's answer in the right thread resumes developer.
		const nudge = await say("hq", "@finance answer developer here [mock:mention developer]", {
			rootId: root,
		});
		const answerRun = await finishedRun((await eventOf(nudge)).id, "finance answers in thread");
		const answer = await publishedPost(answerRun.id);
		expect(answer.root_id).toBe(root);
		const resumed = await finishedRun((await eventOf(idOf(answer))).id, "developer resumes");
		expect(resumed.agent_id).toBe("developer");
		const input = await inputOf(resumed.id);
		expect(input.durableState.resolvedWaits.map((w) => w.outcome)).toEqual(["matched"]);
		expect(input.threadContext?.rootPost?.postId).toBe(root);
		expect(await waitsIn(root)).toEqual([{ agent_id: "developer", status: "matched" }]);
	});

	it("keeps a wait across a restart and resumes once on an answer posted meanwhile", async () => {
		const root = await say("hq", "@developer confirm with me first [mock:wait-asker]");
		await finishedRun((await eventOf(root)).id, "developer asks the human");
		await waitingAgent("developer");

		await gateway.stopWorker();
		await gateway.stopController();
		const answer = await say("hq", "yes, go ahead", { rootId: root });
		expect(await creationOf(answer)).toEqual([]);
		await gateway.startController();
		await gateway.startWorker();

		const answerEvent = await eventOf(answer);
		const resumed = await finishedRun(answerEvent.id, "developer resumes after the restart");
		expect(resumed).toMatchObject({ agent_id: "developer", status: "succeeded" });
		const input = await inputOf(resumed.id);
		expect(input.durableState.resolvedWaits.map((w) => w.outcome)).toEqual(["matched"]);
		await gateway.controller().listener?.sync();
		await settle();
		expect(await runsOf(answerEvent.id)).toHaveLength(1);
		expect(await waitsIn(root)).toEqual([{ agent_id: "developer", status: "matched" }]);
	});

	it("takes an approval decision only from an owner's own reply in the card's thread", async () => {
		const ownerToken = mm.users.get("owner")?.token;
		if (ownerToken === undefined) {
			throw new Error("no owner user");
		}
		const ask = await say("hq", "@finance pay the invoice [mock:approval finance.payment.create]");
		const run = await finishedRun((await eventOf(ask)).id, "finance asks for approval");
		expect(run).toMatchObject({ agent_id: "finance", status: "succeeded" });
		const [approval] = await query<{
			id: string;
			nonce: string;
			immutable_action_hash: string;
		}>("select id, nonce, immutable_action_hash from approval_requests where run_id = $1", [
			run.id,
		]);
		if (approval === undefined) {
			throw new Error("no approval request");
		}
		const cardReceipt = await eventually(
			async () =>
				(
					await query<{ receipt: JsonValue }>(
						"select receipt from outbox where idempotency_key = $1 and status = 'sent'",
						[`approval-card:${approval.id}`],
					)
				)[0]?.receipt,
			30_000,
			"approval card delivered",
		);
		if (typeof cardReceipt !== "object" || cardReceipt === null || Array.isArray(cardReceipt)) {
			throw new Error("card receipt is not an object");
		}
		const card = String(cardReceipt.postId);
		const code = approvalCode({
			id: approval.id,
			nonce: approval.nonce,
			immutableActionHash: approval.immutable_action_hash,
		});
		const cardPost = await mmApi("GET", `posts/${card}`, mm.adminToken);
		expect(cardPost.channel_id).toBe(channel("approvals"));
		expect(String(cardPost.message)).toContain(`approve ${code}`);

		const notices = async () =>
			query<{ notice: string; user_id: string }>(
				"select notice, user_id from approval_replies where approval_id = $1 order by created_at",
				[approval.id],
			);
		// A human who is not an owner, and a webhook on the owner's account. (Agent bots are no
		// members of the approvals channel; a bot's attempt is covered by the integration tests.)
		const nonOwner = await say("approvals", `approve ${code}`, { rootId: card });
		await say("approvals", `approve ${code}`, {
			rootId: card,
			token: ownerToken,
			props: { from_webhook: "true" },
		});
		// The owner's malformed command, edited into a valid one afterwards: an edit decides
		// nothing. A valid command in another thread of the channel is no decision either.
		const typo = await say("approvals", "approve", { rootId: card, token: ownerToken });
		await eventually(async () => (await notices()).length === 3, 30_000, "malformed command");
		await mmApi("PUT", `posts/${typo}/patch`, ownerToken, { message: `approve ${code}` });
		const elsewhere = await say("approvals", "an unrelated note");
		await say("approvals", `approve ${code}`, { rootId: elsewhere, token: ownerToken });
		await gateway.controller().listener?.sync();
		await settle();
		expect((await notices()).map((n) => n.notice)).toEqual([
			"not_an_approver",
			"not_an_approver",
			"malformed",
		]);
		// A command in a card's thread belongs to the decision path only: it is no routed post.
		expect(await creationOf(nonOwner)).toEqual([]);
		const [pending] = await query<{ status: string }>(
			"select status from approval_requests where id = $1",
			[approval.id],
		);
		expect(pending?.status).toBe("pending");

		// The owner's own reply decides, and the listener bot answers in the thread.
		await say("approvals", `deny ${code.toLowerCase()}`, { rootId: card, token: ownerToken });
		await eventually(
			async () => (await notices()).some((n) => n.notice === "denied"),
			30_000,
			"owner's decision",
		);
		const resumed = await eventually(
			async () =>
				(
					await query<{ status: string }>(
						`select r.status from agent_runs r join events e on e.id = r.trigger_event_id
						  where e.external_id = $1 and r.status in ('succeeded', 'failed')`,
						[`approval-resolved:${approval.id}`],
					)
				)[0],
			60_000,
			"finance resumed",
		);
		expect(resumed).toEqual({ status: "succeeded" });
		const listenerId = await loadDirectoryEntry(gateway.deps(), "user", "gateway-listener");
		const thread = await eventually(
			async () => {
				const posts = await mmApi("GET", `posts/${card}/thread`, mm.adminToken);
				const all =
					typeof posts.posts === "object" && posts.posts !== null ? Object.values(posts.posts) : [];
				const answers = all.filter(
					(post) =>
						typeof post === "object" &&
						post !== null &&
						!Array.isArray(post) &&
						post.user_id === listenerId &&
						post.id !== card,
				);
				return answers.length >= 4 ? answers : null;
			},
			30_000,
			"thread answers",
		);
		expect(
			thread.some(
				(post) =>
					typeof post === "object" &&
					post !== null &&
					!Array.isArray(post) &&
					String(post.message).startsWith("**Denied.**"),
			),
		).toBe(true);
	});

	it("retires the bot of an agent removed from the configuration", async () => {
		const deps = gateway.deps();
		const mailBot = await botUserId("mail-follower");
		const config = exampleConfig();
		// `configBundleProblems` now refuses a `rolePrompts` entry for an agent the bundle does not
		// configure (the same shape a real config directory without `mail-follower`'s YAML file
		// would have, since `loadConfigDirectory` never has a role prompt for an agent it did not
		// read): dropped here along with the agent itself.
		const rolePrompts = { ...config.rolePrompts };
		delete rolePrompts["mail-follower"];
		await applyConfig(
			deps,
			{
				...config,
				agents: config.agents.filter((agent) => agent.id !== "mail-follower"),
				rolePrompts,
			},
			"e2e",
		);
		bootstrapReport.length = 0;
		await bootstrap(deps);
		expect(bootstrapReport).toContain(
			"mail-follower: retired agent bot (deactivated, removed from managed channels)",
		);
		const account = await mmApi("GET", `users/${mailBot}`, mm.adminToken);
		expect(Number(account.delete_at)).toBeGreaterThan(0);
		const membership = await fetch(
			`${mm.url}/api/v4/channels/${channel("hq")}/members/${mailBot}`,
			{ headers: { authorization: `Bearer ${mm.adminToken}` } },
		);
		expect(membership.status).toBe(404);
		// #labs left the configuration: the developer bot left the channel.
		expect(bootstrapReport).toContain("channel 'labs': no longer managed, Gateway bots removed");

		// A bot renamed in Mattermost is replaced, and the renamed account loses its access.
		const oldResearch = await botUserId("research");
		const oldToken = readSecretFile(join(secretsDir, "mm_research_token"));
		await mmApi("PUT", `bots/${oldResearch}`, mm.adminToken, { username: "research-renamed" });
		expect(await reconcile()).toContain(
			"research: the bot account is now 'research-renamed'; rerun bootstrap",
		);
		bootstrapReport.length = 0;
		await bootstrap(deps);
		expect(bootstrapReport).toContain(
			"research (previous account): retired replaced bot (deactivated, removed from managed channels)",
		);
		expect(await botUserId("research")).not.toBe(oldResearch);
		const stale = await fetch(`${mm.url}/api/v4/users/me`, {
			headers: { authorization: `Bearer ${oldToken}` },
		});
		expect(stale.status).toBe(401);
		expect(await reconcile()).toEqual([]);

		// A channel replaced under the same name: the new one is managed, the old one left.
		const oldResearchChannel = channel("research");
		await mmApi("PUT", `channels/${oldResearchChannel}/patch`, mm.adminToken, {
			name: "research-old",
		});
		const replacement = String(
			(
				await mmApi("POST", "channels", mm.adminToken, {
					team_id: mm.teamId,
					name: "research",
					display_name: "research",
					type: "O",
				})
			).id,
		);
		await bootstrap(deps);
		expect(await loadDirectoryEntry(deps, "channel", "research")).toBe(replacement);
		const leftOld = await fetch(
			`${mm.url}/api/v4/channels/${oldResearchChannel}/members/${await botUserId("research")}`,
			{ headers: { authorization: `Bearer ${mm.adminToken}` } },
		);
		expect(leftOld.status).toBe(404);
		expect(await reconcile()).toEqual([]);
	});
});
