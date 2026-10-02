import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@agent-gateway/contracts";
import {
	type ControlPlaneDeps,
	loadConfigGeneration,
	loadLifecycleOwnedAgentIds,
	loadMattermostIdentity,
	loadMattermostPlanSource,
	mattermostBootstrapStore,
	requestAgentCreate,
	runtimeHealth,
} from "@agent-gateway/core";
import { bootstrapMattermost, MattermostClient, mattermostPlan } from "@agent-gateway/mattermost";
import {
	readSecretFile,
	resolveSecretPath,
	secretFileState,
	writeSecretFile,
} from "@agent-gateway/service";
import { startTestMattermost, type TestMattermost } from "@agent-gateway/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
