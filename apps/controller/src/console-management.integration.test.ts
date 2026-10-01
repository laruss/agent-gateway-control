import { randomUUID } from "node:crypto";
import type { ConfigApplyInput } from "@agent-gateway/core";
import { applyConfig, commitChange, ensureConfigHistory } from "@agent-gateway/core";
import { withTransaction } from "@agent-gateway/db";
import { silentLogger } from "@agent-gateway/logging";
import { hashConsolePassword } from "@agent-gateway/service";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ConsoleServerOptions, startConsoleServer } from "./console-server.ts";
import { collectConsoleStatus, createConsoleStatusCache } from "./console-status.ts";
import { exampleConfig, startTestGateway, type TestGateway } from "./test-gateway.ts";

const PASSWORD = "console management integration test password";
const ORIGIN = "https://gateway.local";
const FOREIGN_ORIGIN = "https://attacker.example";
const CSRF_KEY = "a-test-only-csrf-derivation-key-at-least-32-chars";
const AGENT_ID = "director";
/** Dropped from the active configuration and re-enabled directly, outside it, by some of the
 * tests below (the same recipe `config-history.integration.test.ts` uses) — never touched by any
 * other test in this file, so mutating it is safe this late. */
const RETAINED_AGENT_ID = "research";

/** `input` with `id` removed from `agents` and its `rolePrompts` entry along with it — the same
 * shape a real config directory without that agent's YAML file would produce. */
function withoutAgent(input: ConfigApplyInput, id: string): ConfigApplyInput {
	const rolePrompts = { ...input.rolePrompts };
	delete rolePrompts[id];
	return { ...input, agents: input.agents.filter((agent) => agent.id !== id), rolePrompts };
}

type JsonBody = Record<string, unknown>;

/** A signed-in session: its cookie and derived CSRF token, usable directly on every further
 * request this test makes. */
async function signIn(base: string): Promise<{ cookie: string; csrfToken: string }> {
	const res = await fetch(`${base}/api/session`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: ORIGIN },
		body: JSON.stringify({ password: PASSWORD }),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as { csrfToken: string };
	const setCookie = res.headers.get("set-cookie") ?? "";
	return { cookie: setCookie.split(";")[0] ?? "", csrfToken: body.csrfToken };
}

async function getJson(
	base: string,
	path: string,
	cookie: string,
): Promise<{ status: number; body: JsonBody }> {
	const res = await fetch(`${base}${path}`, { headers: { cookie } });
	return { status: res.status, body: await maybeJson(res) };
}

/** `console-http.ts`'s own Origin/CSRF/session refusals are plain text (matching every other
 * route's refusal, e.g. `DELETE /api/session`'s); every route this module routes to returns JSON.
 * Parsing whichever one actually came back lets a single helper cover both. */
async function maybeJson(res: Response): Promise<JsonBody> {
	const text = await res.text();
	if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
		return { text };
	}
	return JSON.parse(text) as JsonBody;
}

async function postJson(
	base: string,
	path: string,
	session: { cookie: string; csrfToken: string },
	body: unknown,
	headerOverrides: Readonly<Record<string, string>> = {},
): Promise<{ status: number; body: JsonBody }> {
	const res = await fetch(`${base}${path}`, {
		method: "POST",
		headers: {
			cookie: session.cookie,
			origin: ORIGIN,
			"content-type": "application/json",
			"x-csrf-token": session.csrfToken,
			...headerOverrides,
		},
		body: JSON.stringify(body),
	});
	return { status: res.status, body: await maybeJson(res) };
}

describe("the Agents hub's management API (ADR-024/ADR-025)", () => {
	let gateway: TestGateway;
	let passwordHash: string;

	beforeAll(async () => {
		gateway = await startTestGateway();
		passwordHash = await hashConsolePassword(PASSWORD);
	});

	afterAll(async () => {
		await gateway?.stop();
	});

	beforeEach(async () => {
		await gateway.pool.query("delete from console_sessions");
	});

	const servers: Array<{ stop: () => Promise<void> }> = [];
	afterEach(async () => {
		await Promise.all(servers.splice(0).map((s) => s.stop()));
	});

	async function withServer(
		overrides: Partial<ConsoleServerOptions> = {},
	): Promise<{ base: string }> {
		const server = startConsoleServer({
			port: 0,
			hostname: "127.0.0.1",
			passwordHash,
			origin: ORIGIN,
			csrfKey: CSRF_KEY,
			deps: gateway.deps(),
			cache: createConsoleStatusCache((now) => collectConsoleStatus(gateway.pool, now)),
			log: silentLogger,
			...overrides,
		});
		servers.push(server);
		return { base: `http://127.0.0.1:${server.port}` };
	}

	async function activeRevisionId(base: string, cookie: string): Promise<number> {
		const detail = await getJson(base, `/api/agents/${AGENT_ID}`, cookie);
		expect(detail.status).toBe(200);
		const revisionId = (detail.body.agent as JsonBody).activeRevisionId as number;
		expect(revisionId).toBeGreaterThan(0);
		return revisionId;
	}

	it("lists every agent with its runtime, channel count, last run and active revision", async () => {
		const { base } = await withServer();
		const { cookie } = await signIn(base);
		const res = await getJson(base, "/api/agents", cookie);
		expect(res.status).toBe(200);
		const agents = res.body.agents as JsonBody[];
		const director = agents.find((a) => a.id === AGENT_ID);
		expect(director).toBeDefined();
		expect(director?.runtimeAdapter).toBe("mock");
		expect(director?.enabled).toBe(true);
		expect(typeof director?.channelCount).toBe("number");
		expect(director?.activeRevisionId).toBeGreaterThan(0);
	});

	it("shows one agent's full editable configuration, with known channels and runtime adapters", async () => {
		const { base } = await withServer();
		const { cookie } = await signIn(base);
		const res = await getJson(base, `/api/agents/${AGENT_ID}`, cookie);
		expect(res.status).toBe(200);
		const agent = res.body.agent as JsonBody;
		expect(agent.id).toBe(AGENT_ID);
		expect(agent.rolePrompt).toEqual(expect.any(String));
		expect((agent.mattermost as JsonBody).tokenSecretFile).toEqual(expect.any(String));
		expect(Array.isArray(res.body.knownChannels)).toBe(true);
		expect(res.body.knownRuntimeAdapters).toEqual(
			expect.arrayContaining(["mock", "codex", "claude-code"]),
		);
	});

	it("returns 404 for an agent that does not exist", async () => {
		const { base } = await withServer();
		const { cookie } = await signIn(base);
		const res = await getJson(base, "/api/agents/no-such-agent", cookie);
		expect(res.status).toBe(404);
	});

	it("previews a role prompt change: a diff, no impact, no problems", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const baseRevisionId = await activeRevisionId(base, session.cookie);
		const res = await postJson(base, `/api/agents/${AGENT_ID}/preview`, session, {
			baseRevisionId,
			changes: { rolePrompt: "Updated role prompt for preview." },
		});
		expect(res.status).toBe(200);
		expect(res.body.noop).toBe(false);
		expect(res.body.problems).toEqual([]);
		expect(res.body.impact).toEqual([]);
		const diffAgents = (res.body.diff as JsonBody).agents as JsonBody[];
		expect(diffAgents.some((a) => a.agentId === AGENT_ID)).toBe(true);
	});

	it("previews a disabling edit with 'disables the agent' in impact", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const baseRevisionId = await activeRevisionId(base, session.cookie);
		const res = await postJson(base, `/api/agents/${AGENT_ID}/preview`, session, {
			baseRevisionId,
			changes: { enabled: false },
		});
		expect(res.status).toBe(200);
		expect(res.body.impact).toContain("disables the agent");
	});

	it("commits a role prompt change with source 'console', visible in config history, and updates the stored projection", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const baseRevisionId = await activeRevisionId(base, session.cookie);
		const newPrompt = "The director's freshly committed role prompt.";
		const commit = await postJson(base, `/api/agents/${AGENT_ID}/commit`, session, {
			baseRevisionId,
			changes: { rolePrompt: newPrompt },
			idempotencyKey: randomUUID(),
		});
		expect(commit.status).toBe(200);
		expect(commit.body.noop).toBe(false);
		expect(commit.body.revisionId).toBeGreaterThan(baseRevisionId);

		const history = await gateway.pool.query<{ actor: string; source: string }>(
			"select actor, source from config_revisions where id = $1",
			[commit.body.revisionId],
		);
		expect(history.rows[0]?.source).toBe("console");
		expect(history.rows[0]?.actor).toBe("console:owner");

		// The projection the scheduler's next turn reads from (`loadAgents`/`buildTurnContext`,
		// `packages/core/src/services/store.ts`) carries the new prompt immediately.
		const projection = await gateway.pool.query<{ role_prompt: string }>(
			"select role_prompt from agents where id = $1",
			[AGENT_ID],
		);
		expect(projection.rows[0]?.role_prompt).toBe(newPrompt);
	});

	it("a stale base revision is refused with 409 and the current revision id", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const staleBase = await activeRevisionId(base, session.cookie);
		// Move the active revision on first, so `staleBase` is no longer current.
		const first = await postJson(base, `/api/agents/${AGENT_ID}/commit`, session, {
			baseRevisionId: staleBase,
			changes: { rolePrompt: "First commit, to move the revision on." },
			idempotencyKey: randomUUID(),
		});
		expect(first.status).toBe(200);

		const stale = await postJson(base, `/api/agents/${AGENT_ID}/commit`, session, {
			baseRevisionId: staleBase,
			changes: { rolePrompt: "Second commit, against the now-stale base." },
			idempotencyKey: randomUUID(),
		});
		expect(stale.status).toBe(409);
		expect(stale.body.currentRevisionId).toBe(first.body.revisionId);
	});

	it("two browser tabs editing concurrently: the second tab's commit gets 409", async () => {
		const { base } = await withServer();
		// Both tabs sign in and load the editor before either one applies.
		const tabA = await signIn(base);
		const tabB = await signIn(base);
		const sharedBase = await activeRevisionId(base, tabA.cookie);

		const applyA = await postJson(base, `/api/agents/${AGENT_ID}/commit`, tabA, {
			baseRevisionId: sharedBase,
			changes: { displayName: "Director (tab A)" },
			idempotencyKey: randomUUID(),
		});
		expect(applyA.status).toBe(200);

		const applyB = await postJson(base, `/api/agents/${AGENT_ID}/commit`, tabB, {
			baseRevisionId: sharedBase,
			changes: { displayName: "Director (tab B)" },
			idempotencyKey: randomUUID(),
		});
		expect(applyB.status).toBe(409);
		expect(applyB.body.currentRevisionId).toBe(applyA.body.revisionId);
	});

	it("replays a commit made again with the same idempotency key, without writing a second revision", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const baseRevisionId = await activeRevisionId(base, session.cookie);
		const key = randomUUID();
		const body = {
			baseRevisionId,
			changes: { rolePrompt: "Idempotent role prompt." },
			idempotencyKey: key,
		};
		const first = await postJson(base, `/api/agents/${AGENT_ID}/commit`, session, body);
		expect(first.status).toBe(200);
		const replay = await postJson(base, `/api/agents/${AGENT_ID}/commit`, session, body);
		expect(replay.status).toBe(200);
		expect(replay.body.revisionId).toBe(first.body.revisionId);
		expect(replay.body.replayed).toBe(true);

		const count = await gateway.pool.query<{ count: string }>(
			"select count(*)::text as count from config_revisions where idempotency_key = $1",
			[key],
		);
		expect(count.rows[0]?.count).toBe("1");
	});

	it(
		"replays a retried commit whose agent a later CLI change removed entirely, rather than " +
			"revalidating the stale-base plan against live state and reporting it invalid",
		async () => {
			const { base } = await withServer();
			const session = await signIn(base);
			const removedAgentId = "developer";
			const baseRevisionId = await activeRevisionId(base, session.cookie);
			const key = randomUUID();
			const body = {
				baseRevisionId,
				changes: { rolePrompt: "The developer's freshly committed role prompt." },
				idempotencyKey: key,
			};
			const first = await postJson(base, `/api/agents/${removedAgentId}/commit`, session, body);
			expect(first.status).toBe(200);

			// A CLI apply removes the agent entirely, through `commitChange` directly — the same path
			// `gateway config apply` uses, never the console's own HTTP surface.
			const cliRemoval = await commitChange(gateway.deps(), {
				changeSet: [{ type: "remove_agent", agentId: removedAgentId }],
				baseRevisionId: first.body.revisionId as number,
				actor: "test-cli",
				source: "cli_apply",
			});
			expect(cliRemoval.revisionId).toBeGreaterThan(first.body.revisionId as number);

			// The exact same request again (as if the first response had been lost in transit):
			// replayed from the recorded idempotency key, never recomputed against live state (where
			// the agent is now gone) and reported as an invalid patch.
			const retry = await postJson(base, `/api/agents/${removedAgentId}/commit`, session, body);
			expect(retry.status).toBe(200);
			expect(retry.body.replayed).toBe(true);
			expect(retry.body.revisionId).toBe(first.body.revisionId);
		},
	);

	it(
		"refuses a stale base with 409 rather than 422 when the intervening change removed the " +
			"agent entirely (the plan is not actually invalid — the base is simply stale)",
		async () => {
			const { base } = await withServer();
			const session = await signIn(base);
			const removedAgentId = "operator";
			const staleBase = await activeRevisionId(base, session.cookie);

			const cliRemoval = await commitChange(gateway.deps(), {
				changeSet: [{ type: "remove_agent", agentId: removedAgentId }],
				baseRevisionId: staleBase,
				actor: "test-cli",
				source: "cli_apply",
			});

			const commit = await postJson(base, `/api/agents/${removedAgentId}/commit`, session, {
				baseRevisionId: staleBase,
				changes: { rolePrompt: "Computed against a base that is no longer live." },
				idempotencyKey: randomUUID(),
			});
			expect(commit.status).toBe(409);
			expect(commit.body.currentRevisionId).toBe(cliRemoval.revisionId);
		},
	);

	it("rejects an unknown field in the patch with 400", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const baseRevisionId = await activeRevisionId(base, session.cookie);
		const res = await postJson(base, `/api/agents/${AGENT_ID}/preview`, session, {
			baseRevisionId,
			changes: { bogusField: true },
		});
		expect(res.status).toBe(400);
	});

	it("rejects a role prompt over the 50,000-character bound with 400", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const baseRevisionId = await activeRevisionId(base, session.cookie);
		const res = await postJson(base, `/api/agents/${AGENT_ID}/preview`, session, {
			baseRevisionId,
			changes: { rolePrompt: "x".repeat(50_001) },
		});
		expect(res.status).toBe(400);
	});

	it("rejects a protected field (mattermost.token_secret_file) with 400: it is not part of the patch DTO at all", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const baseRevisionId = await activeRevisionId(base, session.cookie);
		const res = await postJson(base, `/api/agents/${AGENT_ID}/preview`, session, {
			baseRevisionId,
			changes: { mattermost: { token_secret_file: "/run/secrets/attacker" } },
		});
		expect(res.status).toBe(400);
	});

	it("401s every management route without a session", async () => {
		const { base } = await withServer();
		expect((await fetch(`${base}/api/agents`)).status).toBe(401);
		expect((await fetch(`${base}/api/agents/${AGENT_ID}`)).status).toBe(401);
		expect(
			(
				await fetch(`${base}/api/agents/${AGENT_ID}/preview`, {
					method: "POST",
					headers: { "content-type": "application/json", origin: ORIGIN },
					body: JSON.stringify({ baseRevisionId: 1, changes: { rolePrompt: "x" } }),
				})
			).status,
		).toBe(401);
	});

	it("403s a commit missing the CSRF header or carrying a foreign Origin", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const baseRevisionId = await activeRevisionId(base, session.cookie);
		const missingCsrf = await fetch(`${base}/api/agents/${AGENT_ID}/commit`, {
			method: "POST",
			headers: { cookie: session.cookie, origin: ORIGIN, "content-type": "application/json" },
			body: JSON.stringify({
				baseRevisionId,
				changes: { rolePrompt: "x" },
				idempotencyKey: randomUUID(),
			}),
		});
		expect(missingCsrf.status).toBe(403);

		const foreignOrigin = await postJson(
			base,
			`/api/agents/${AGENT_ID}/commit`,
			session,
			{ baseRevisionId, changes: { rolePrompt: "x" }, idempotencyKey: randomUUID() },
			{ origin: FOREIGN_ORIGIN },
		);
		expect(foreignOrigin.status).toBe(403);
	});

	it("disabling a running agent surfaces the protection error as 422", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const baseRevisionId = await activeRevisionId(base, session.cookie);
		await withTransaction(gateway.pool, (tx) =>
			tx.client.query("update agents set state = 'running' where id = $1", [AGENT_ID]),
		);
		try {
			const res = await postJson(base, `/api/agents/${AGENT_ID}/commit`, session, {
				baseRevisionId,
				changes: { enabled: false },
				idempotencyKey: randomUUID(),
			});
			expect(res.status).toBe(422);
			expect(res.body.problems).toEqual(
				expect.arrayContaining([expect.stringContaining("pause it before disabling")]),
			);
		} finally {
			await withTransaction(gateway.pool, (tx) =>
				tx.client.query("update agents set state = 'idle' where id = $1", [AGENT_ID]),
			);
		}
	});

	it("lists and diffs configuration revisions", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const list = await getJson(base, "/api/config/revisions?limit=5", session.cookie);
		expect(list.status).toBe(200);
		const revisions = list.body.revisions as JsonBody[];
		expect(revisions.length).toBeGreaterThan(0);
		const latest = revisions[0] as JsonBody;
		expect(typeof latest.snapshotHashPrefix).toBe("string");

		const diff = await getJson(base, `/api/config/revisions/${latest.id}/diff`, session.cookie);
		expect(diff.status).toBe(200);
		expect(diff.body.revisionId).toBe(latest.id);
		expect(diff.body.diff).toBeDefined();
	});

	it("a preview computed against a stale base is refused with 409, never silently computed against the live state instead", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const staleBase = await activeRevisionId(base, session.cookie);
		const moveOn = await postJson(base, `/api/agents/${AGENT_ID}/commit`, session, {
			baseRevisionId: staleBase,
			changes: { rolePrompt: "Moves the revision on, so the base below is stale." },
			idempotencyKey: randomUUID(),
		});
		expect(moveOn.status).toBe(200);

		const preview = await postJson(base, `/api/agents/${AGENT_ID}/preview`, session, {
			baseRevisionId: staleBase,
			changes: { rolePrompt: "Computed against a base that is no longer live." },
		});
		expect(preview.status).toBe(409);
		expect(preview.body.currentRevisionId).toBe(moveOn.body.revisionId);
	});

	it(
		"the full optimistic-concurrency scenario: load, a CLI commit to the same agent, then the " +
			"console's own preview and commit both refuse the stale base with 409 — nothing it carried is overwritten",
		async () => {
			const { base } = await withServer();
			const session = await signIn(base);
			// "Load": the editor reads the agent at its currently active revision.
			const loadedRevisionId = await activeRevisionId(base, session.cookie);
			const loadedDetail = await getJson(base, `/api/agents/${AGENT_ID}`, session.cookie);
			const originalDisplayName = (loadedDetail.body.agent as JsonBody).displayName as string;

			// A CLI apply changes the very same agent while the console's draft is still open —
			// through `commitChange` directly (`source: "cli_apply"`, never the console's own HTTP
			// surface), the same path `gateway config apply`/`import` use.
			const cliResult = await commitChange(gateway.deps(), {
				changeSet: [
					{ type: "set_role_prompt", agentId: AGENT_ID, rolePrompt: "Changed by the CLI." },
				],
				baseRevisionId: loadedRevisionId,
				actor: "test-cli",
				source: "cli_apply",
			});
			expect(cliResult.revisionId).toBeGreaterThan(loadedRevisionId ?? 0);

			// The console's own preview, still built against the stale loaded revision, refuses
			// instead of quietly previewing the live (already-moved-on) state as if it were current.
			const preview = await postJson(base, `/api/agents/${AGENT_ID}/preview`, session, {
				baseRevisionId: loadedRevisionId,
				changes: { displayName: "Renamed by the console, from a stale view" },
			});
			expect(preview.status).toBe(409);
			expect(preview.body.currentRevisionId).toBe(cliResult.revisionId);

			// Even a direct commit attempt against that same stale base is refused the same way —
			// the editor's own loaded revision, carried through unchanged, is what makes this safe
			// regardless of whether the preview step above ran first.
			const commit = await postJson(base, `/api/agents/${AGENT_ID}/commit`, session, {
				baseRevisionId: loadedRevisionId,
				changes: { displayName: "Renamed by the console, from a stale view" },
				idempotencyKey: randomUUID(),
			});
			expect(commit.status).toBe(409);
			expect(commit.body.currentRevisionId).toBe(cliResult.revisionId);

			// Nothing was overwritten: the CLI's role prompt change survived, and the display name
			// the stale console attempt tried to write never landed.
			const after = await getJson(base, `/api/agents/${AGENT_ID}`, session.cookie);
			const afterAgent = after.body.agent as JsonBody;
			expect(afterAgent.rolePrompt).toBe("Changed by the CLI.");
			expect(afterAgent.displayName).toBe(originalDisplayName);
		},
	);

	it("replays a commit retried after an intervening, unrelated change under the same idempotency key, instead of refusing it as 'a different change set'", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const baseRevisionId = await activeRevisionId(base, session.cookie);
		const key = randomUUID();
		const body = {
			baseRevisionId,
			changes: { displayName: "Renamed, retried later" },
			idempotencyKey: key,
		};

		const first = await postJson(base, `/api/agents/${AGENT_ID}/commit`, session, body);
		expect(first.status).toBe(200);

		// An unrelated change to the same agent, through a fresh request with its own idempotency
		// key — moving the revision on and changing a field the retried patch below never
		// mentions (so recomputing that patch's plan against this new live state, rather than
		// replaying the first attempt's own recorded result, would resolve to a different `after`
		// and so a different change hash).
		const unrelated = await postJson(base, `/api/agents/${AGENT_ID}/commit`, session, {
			baseRevisionId: first.body.revisionId,
			changes: { runtime: { timeout_seconds: 999 } },
			idempotencyKey: randomUUID(),
		});
		expect(unrelated.status).toBe(200);

		// The retry: the exact same request as the first commit (same stale `baseRevisionId`, same
		// patch, same idempotency key) — as if the first response had been lost and the client
		// resubmitted it.
		const retry = await postJson(base, `/api/agents/${AGENT_ID}/commit`, session, body);
		expect(retry.status).toBe(200);
		expect(retry.body.replayed).toBe(true);
		expect(retry.body.revisionId).toBe(first.body.revisionId);
		expect(retry.body.activeRevisionId).toBe(unrelated.body.revisionId);

		// Nothing was overwritten by the replay: the unrelated, intervening change is still there.
		const after = await getJson(base, `/api/agents/${AGENT_ID}`, session.cookie);
		expect((after.body.agent as JsonBody).displayName).toBe("Renamed, retried later");
		expect(((after.body.agent as JsonBody).runtime as JsonBody).timeout_seconds).toBe(999);
	});

	it("clears the runtime model override when the patch sets it to null", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const setBaseRevisionId = await activeRevisionId(base, session.cookie);
		const setModel = await postJson(base, `/api/agents/${AGENT_ID}/commit`, session, {
			baseRevisionId: setBaseRevisionId,
			changes: { runtime: { model: "gpt-5" } },
			idempotencyKey: randomUUID(),
		});
		expect(setModel.status).toBe(200);
		const withModel = await getJson(base, `/api/agents/${AGENT_ID}`, session.cookie);
		expect(((withModel.body.agent as JsonBody).runtime as JsonBody).model).toBe("gpt-5");

		const clearBaseRevisionId = await activeRevisionId(base, session.cookie);
		const clearModel = await postJson(base, `/api/agents/${AGENT_ID}/commit`, session, {
			baseRevisionId: clearBaseRevisionId,
			changes: { runtime: { model: null } },
			idempotencyKey: randomUUID(),
		});
		expect(clearModel.status).toBe(200);
		const withoutModel = await getJson(base, `/api/agents/${AGENT_ID}`, session.cookie);
		expect(((withoutModel.body.agent as JsonBody).runtime as JsonBody).model).toBeUndefined();
	});

	describe("an agent retained outside the active configuration", () => {
		it(
			"falls back to remove_agent — reflected in preview's impact and executed by commit — " +
				"for a disable that a plain set_agent_enabled cannot satisfy on its own",
			async () => {
				const { base } = await withServer();
				const session = await signIn(base);

				await applyConfig(gateway.deps(), withoutAgent(exampleConfig(), RETAINED_AGENT_ID), "test");
				await gateway.pool.query(
					"update agents set enabled = true, state = 'idle', state_changed_at = now() where id = $1",
					[RETAINED_AGENT_ID],
				);
				// Its own retained configuration no longer validates on its own (`max_active_runs`
				// stands in for any whole-bundle rule that has moved on since this row was last
				// written; see `config-history.integration.test.ts`'s own version of this recipe).
				await gateway.pool.query(
					"update agents set config = jsonb_set(config, '{concurrency,max_active_runs}', '2') where id = $1",
					[RETAINED_AGENT_ID],
				);
				await ensureConfigHistory(gateway.deps(), "upgrade");

				const baseRevisionId = await activeRevisionId(base, session.cookie);
				const preview = await postJson(base, `/api/agents/${RETAINED_AGENT_ID}/preview`, session, {
					baseRevisionId,
					changes: { enabled: false },
				});
				expect(preview.status).toBe(200);
				expect(preview.body.problems).toEqual([]);
				expect(preview.body.impact).toEqual(
					expect.arrayContaining(["removes the agent from the configuration"]),
				);

				const commitKey = randomUUID();
				const commitBody = {
					baseRevisionId,
					changes: { enabled: false },
					idempotencyKey: commitKey,
				};
				const commit = await postJson(
					base,
					`/api/agents/${RETAINED_AGENT_ID}/commit`,
					session,
					commitBody,
				);
				expect(commit.status).toBe(200);

				const detail = await getJson(base, `/api/agents/${RETAINED_AGENT_ID}`, session.cookie);
				expect(detail.status).toBe(404);
				const [row] = (
					await gateway.pool.query<{ enabled: boolean }>(
						"select enabled from agents where id = $1",
						[RETAINED_AGENT_ID],
					)
				).rows;
				expect(row?.enabled).toBe(false);

				// An identical retry (the same stale base, the same idempotency key) must replay the
				// first commit's result, never recompute the disable-with-fallback resolution against
				// live state (where the agent is now gone entirely) and refuse it as "a different
				// change set" under the same key.
				const retry = await postJson(
					base,
					`/api/agents/${RETAINED_AGENT_ID}/commit`,
					session,
					commitBody,
				);
				expect(retry.status).toBe(200);
				expect(retry.body.replayed).toBe(true);
				expect(retry.body.revisionId).toBe(commit.body.revisionId);
			},
		);

		it("is excluded from the agents list, consistent with its own 404 on detail", async () => {
			const { base } = await withServer();
			const session = await signIn(base);
			const list = await getJson(base, "/api/agents", session.cookie);
			expect(list.status).toBe(200);
			const agents = list.body.agents as JsonBody[];
			expect(agents.some((a) => a.id === RETAINED_AGENT_ID)).toBe(false);
		});
	});
});
