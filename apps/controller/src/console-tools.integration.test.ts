import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ConsoleAgentToolsResponseSchema,
	type CustomHttpsDefinition,
} from "@agent-gateway/contracts";
import { ensureAgentLifecycleAdoption } from "@agent-gateway/core";
import { silentLogger } from "@agent-gateway/logging";
import { hashConsolePassword, writeSecretFile } from "@agent-gateway/service";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ConsoleServerOptions, startConsoleServer } from "./console-server.ts";
import { collectConsoleStatus, createConsoleStatusCache } from "./console-status.ts";
import { startTestGateway, type TestGateway } from "./test-gateway.ts";

const PASSWORD = "console tools integration test password";
const ORIGIN = "https://gateway.local";
const FOREIGN_ORIGIN = "https://attacker.example";
const CSRF_KEY = "a-test-only-csrf-derivation-key-at-least-32-chars";

/**
 * Every test below that mutates an agent's attachments uses its own, dedicated example agent
 * (ADR-027's legacy conversion runs once per agent and then sticks, hub-managed forever — reusing
 * one agent across tests that depend on different before-states would make them order-dependent).
 * `research`'s own example `permissions` (`tools_deny: [finance.*, deploy.*, mail.*, workspace.write]`)
 * has no known entry for `deploy.*`/`mail.*` to expand against, so those report `unresolved`; it is
 * never otherwise mutated here, so its read-only tests stay accurate regardless of run order.
 */
const READ_ONLY_LEGACY_AGENT_ID = "research";
/** Dedicated to the attach/replay/detach/update tests: never read for its own unresolved-pattern
 * content, only for whether a just-made change actually landed. */
const ATTACH_AGENT_ID = "mail-follower";
/** Dedicated to "Adopt into the tools hub": never touched by anything else, so its own
 * `alreadyHubManaged: false` starting state is guaranteed. */
const ADOPT_AGENT_ID = "operator";
/** Dedicated to the adopt-commit `baseRevisionId` conflict test: never otherwise previewed or
 * adopted, so its own `alreadyHubManaged: false` starting state is guaranteed independently of
 * `ADOPT_AGENT_ID`'s own adoption above. Its own `tools_require_human_approval`
 * (`finance.payment.create`/`finance.subscription.create`) resolves cleanly against the seeded
 * finance executor entries, so adopting it never reports a `problems` entry. */
const ADOPT_CONFLICT_AGENT_ID = "finance";
/** An unrelated agent, attached to only to bump the active revision on in the conflict test below
 * — never otherwise read or asserted on. */
const BUMP_AGENT_ID = "director";

const NATIVE_REPOSITORY_READ = "native-repository-read";
const GATEWAY_MATTERMOST_POST = "gateway-mattermost-post";

type JsonBody = Record<string, unknown>;

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

async function maybeJson(res: Response): Promise<JsonBody> {
	const text = await res.text();
	if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
		return { text };
	}
	return JSON.parse(text) as JsonBody;
}

async function getJson(
	base: string,
	path: string,
	cookie: string,
): Promise<{ status: number; body: JsonBody; text: string }> {
	const res = await fetch(`${base}${path}`, { headers: { cookie } });
	const text = await res.clone().text();
	return { status: res.status, body: await maybeJson(res), text };
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

function customDefinition(overrides: Partial<CustomHttpsDefinition> = {}): CustomHttpsDefinition {
	return {
		host: "api.example.test",
		pathTemplate: "/items/{id}",
		method: "GET",
		parameters: [
			{ name: "id", slot: "path", slotName: "id", type: "string", minLength: 1, maxLength: 20 },
		],
		secretSlots: [{ alias: "demo_secret", slot: "header", slotName: "x-api-key" }],
		idempotency: null,
		responseLimits: {
			maxResponseBytes: 65_536,
			allowedContentTypes: ["application/json"],
			timeoutMs: 5000,
			includeBodyPreview: true,
		},
		...overrides,
	};
}

describe("the Instruments & Utils hub's own management API (ADR-025/ADR-027)", () => {
	let gateway: TestGateway;
	let passwordHash: string;
	let secretsDir: string;

	beforeAll(async () => {
		gateway = await startTestGateway();
		passwordHash = await hashConsolePassword(PASSWORD);
		await ensureAgentLifecycleAdoption(gateway.deps(), "test");
		secretsDir = mkdtempSync(join(tmpdir(), "custom-tool-secrets-"));
	});

	afterAll(async () => {
		await gateway?.stop();
		rmSync(secretsDir, { recursive: true, force: true });
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
			customToolSecretsDir: secretsDir,
			...overrides,
		});
		servers.push(server);
		return { base: `http://127.0.0.1:${server.port}` };
	}

	let entryCounter = 0;
	async function createCustomTool(
		base: string,
		session: { cookie: string; csrfToken: string },
		overrides: Partial<CustomHttpsDefinition> = {},
	): Promise<{ entryId: string; res: { status: number; body: JsonBody } }> {
		entryCounter += 1;
		const entryId = `demo-tool-${entryCounter}`;
		const res = await postJson(base, "/api/tools", session, {
			entryId,
			name: "Demo tool",
			description: "A test custom HTTPS tool.",
			httpsDefinition: customDefinition(overrides),
		});
		return { entryId, res };
	}

	// -----------------------------------------------------------------------
	// The catalog itself
	// -----------------------------------------------------------------------

	it("lists every built-in entry with its kind, availability, risk floor and attached-agent count", async () => {
		const { base } = await withServer();
		const { cookie } = await signIn(base);
		const res = await getJson(base, "/api/tools", cookie);
		expect(res.status).toBe(200);
		const entries = res.body.entries as JsonBody[];
		const repositoryRead = entries.find((e) => e.id === NATIVE_REPOSITORY_READ);
		expect(repositoryRead).toMatchObject({
			kind: "native",
			isBuiltin: true,
			riskFloor: "allow",
			deleted: false,
		});
		expect(typeof repositoryRead?.attachedAgentCount).toBe("number");
		const mattermostPost = entries.find((e) => e.id === GATEWAY_MATTERMOST_POST);
		expect(mattermostPost).toMatchObject({ kind: "gateway", available: true });
	});

	it("shows an entry's own detail: version history and attached agents", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const res = await getJson(base, `/api/tools/${NATIVE_REPOSITORY_READ}`, session.cookie);
		expect(res.status).toBe(200);
		expect((res.body.entry as JsonBody).id).toBe(NATIVE_REPOSITORY_READ);
		expect(Array.isArray(res.body.versions)).toBe(true);
		expect((res.body.versions as JsonBody[]).length).toBeGreaterThan(0);
		expect(Array.isArray(res.body.attachedAgents)).toBe(true);
		expect(res.body.secretAliases).toEqual([]);
	});

	it("404s a catalog entry that does not exist", async () => {
		const { base } = await withServer();
		const { cookie } = await signIn(base);
		expect((await getJson(base, "/api/tools/no-such-entry", cookie)).status).toBe(404);
	});

	// -----------------------------------------------------------------------
	// Custom HTTPS tools: create, edit, delete, secret-alias status (never a value)
	// -----------------------------------------------------------------------

	it("creates a custom HTTPS tool, refuses an invalid definition with 422", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const { entryId, res } = await createCustomTool(base, session);
		expect(res.status).toBe(200);
		expect((res.body.entry as JsonBody).id).toBe(entryId);

		// A write (POST) with no idempotency header is refused by `customHttpsDefinitionProblems`.
		const invalid = await postJson(base, "/api/tools", session, {
			entryId: `${entryId}-invalid`,
			name: "Invalid",
			description: "Missing idempotency header for a write.",
			httpsDefinition: customDefinition({ method: "POST", idempotency: null }),
		});
		expect(invalid.status).toBe(422);
		expect((invalid.body.problems as string[]).length).toBeGreaterThan(0);
	});

	it("edits a custom tool, publishing a new version readable in its history", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const { entryId } = await createCustomTool(base, session);
		const edit = await postJson(base, `/api/tools/${entryId}/edit`, session, {
			description: "An updated description.",
		});
		expect(edit.status).toBe(200);
		const detail = await getJson(base, `/api/tools/${entryId}`, session.cookie);
		expect((detail.body.entry as JsonBody).currentVersion).toMatchObject({
			version: 2,
			description: "An updated description.",
		});
		expect((detail.body.versions as JsonBody[]).length).toBe(2);
	});

	it("refuses a built-in's edit beyond name/description with 422", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const edit = await postJson(base, `/api/tools/${NATIVE_REPOSITORY_READ}/edit`, session, {
			httpsDefinition: customDefinition(),
		});
		expect(edit.status).toBe(422);
	});

	it(
		"shows which secret aliases a custom tool needs and whether each is set — a boolean only, " +
			"the response body never contains the secret's own value",
		async () => {
			const { base } = await withServer();
			const session = await signIn(base);
			const { entryId } = await createCustomTool(base, session);
			const before = await getJson(base, `/api/tools/${entryId}`, session.cookie);
			expect(before.body.secretAliases).toEqual([{ alias: "demo_secret", set: false }]);

			const secretValue = "super-secret-value-never-in-a-response";
			writeSecretFile(join(secretsDir, "demo_secret"), secretValue);
			const after = await getJson(base, `/api/tools/${entryId}`, session.cookie);
			expect(after.body.secretAliases).toEqual([{ alias: "demo_secret", set: true }]);
			expect(after.text).not.toContain(secretValue);
		},
	);

	it("deletes a custom tool, reporting which agents lost it, and 404s it afterward", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const deleteImpactAgentId = "developer";
		const { entryId } = await createCustomTool(base, session);
		await postJson(base, `/api/agents/${deleteImpactAgentId}/tools/attach`, session, {
			idempotencyKey: randomUUID(),
			entryId,
			pinnedVersion: null,
			mode: "require_approval",
		});
		const del = await postJson(base, `/api/tools/${entryId}/delete`, session, {});
		expect(del.status).toBe(200);
		expect(del.body.affectedAgentIds).toEqual([deleteImpactAgentId]);
		expect((await getJson(base, `/api/tools/${entryId}`, session.cookie)).status).toBe(404);
	});

	// -----------------------------------------------------------------------
	// The agent capability editor
	// -----------------------------------------------------------------------

	it("reads a legacy agent's requested (converted) vs effective permissions, with unresolved patterns", async () => {
		const { base } = await withServer();
		const { cookie } = await signIn(base);
		const res = await getJson(base, `/api/agents/${READ_ONLY_LEGACY_AGENT_ID}/tools`, cookie);
		expect(res.status).toBe(200);
		expect(res.body.hubManaged).toBe(false);
		expect(res.body.effective).toMatchObject({
			allow: expect.arrayContaining(["mattermost.post"]),
		});
		const unresolved = res.body.unresolved as JsonBody[];
		expect(unresolved.some((u) => u.pattern === "deploy.*")).toBe(true);

		// `research`'s own `tools_deny` (`finance.*`, `deploy.*`) carries forward unresolved into
		// `effective.deny` unchanged, for a legacy agent: the console's own client-side parse (the
		// exact schema `fetchAgentTools` runs the response through) must accept the wildcard, not
		// just the raw HTTP call above — a concrete-name-only schema here is what actually broke the
		// Tools tab for any legacy agent whose `permissions` still name a wildcard.
		expect(res.body.effective).toMatchObject({ deny: expect.arrayContaining(["finance.*"]) });
		expect(() => ConsoleAgentToolsResponseSchema.parse(res.body)).not.toThrow();
	});

	it("404s the agent-tools route for an agent that does not exist", async () => {
		const { base } = await withServer();
		const { cookie } = await signIn(base);
		expect((await getJson(base, "/api/agents/no-such-agent/tools", cookie)).status).toBe(404);
	});

	it(
		"attaches a tool to a still-legacy agent, converting its permissions in the same revision " +
			"(legacyConversion), making it hub-managed",
		async () => {
			const { base } = await withServer();
			const session = await signIn(base);
			const attach = await postJson(base, `/api/agents/${ATTACH_AGENT_ID}/tools/attach`, session, {
				idempotencyKey: randomUUID(),
				entryId: GATEWAY_MATTERMOST_POST,
				pinnedVersion: null,
				mode: "allow",
			});
			expect(attach.status).toBe(200);
			expect((attach.body.legacyConversion as JsonBody[]).length).toBeGreaterThan(0);

			const after = await getJson(base, `/api/agents/${ATTACH_AGENT_ID}/tools`, session.cookie);
			expect(after.body.hubManaged).toBe(true);
			expect(after.body.unresolved).toEqual([]);
			const requested = after.body.requested as JsonBody[];
			expect(requested.some((a) => a.entryId === GATEWAY_MATTERMOST_POST)).toBe(true);
		},
	);

	it("replays an attach made again with the same idempotency key, without writing a second revision", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const key = randomUUID();
		// A genuinely new attachment (never otherwise touched for this agent in this file): a replay
		// of a change that resolved to a no-op would itself record nothing to replay from, which is
		// not what this test is about.
		const body = {
			idempotencyKey: key,
			entryId: "native-web-search",
			pinnedVersion: null,
			mode: "allow" as const,
		};
		const first = await postJson(
			base,
			`/api/agents/${ATTACH_AGENT_ID}/tools/attach`,
			session,
			body,
		);
		expect(first.status).toBe(200);
		const replay = await postJson(
			base,
			`/api/agents/${ATTACH_AGENT_ID}/tools/attach`,
			session,
			body,
		);
		expect(replay.status).toBe(200);
		expect(replay.body.revisionId).toBe(first.body.revisionId);
		expect(replay.body.replayed).toBe(true);
		const count = await gateway.pool.query<{ count: string }>(
			"select count(*)::text as count from config_revisions where idempotency_key = $1",
			[key],
		);
		expect(count.rows[0]?.count).toBe("1");
	});

	it("detaches a tool (a no-op when nothing was attached) and updates an existing attachment's mode", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		// `mail-follower`'s own example permissions never cover `repository.read`, so — whether or
		// not an earlier test has already adopted it into the hub for other entries — this one is
		// guaranteed never attached.
		const noop = await postJson(base, `/api/agents/${ATTACH_AGENT_ID}/tools/detach`, session, {
			idempotencyKey: randomUUID(),
			entryId: NATIVE_REPOSITORY_READ,
		});
		expect(noop.status).toBe(200);
		expect(noop.body.noop).toBe(true);

		await postJson(base, `/api/agents/${ATTACH_AGENT_ID}/tools/attach`, session, {
			idempotencyKey: randomUUID(),
			entryId: GATEWAY_MATTERMOST_POST,
			pinnedVersion: null,
			mode: "allow",
		});
		const update = await postJson(base, `/api/agents/${ATTACH_AGENT_ID}/tools/update`, session, {
			idempotencyKey: randomUUID(),
			entryId: GATEWAY_MATTERMOST_POST,
			mode: "disabled",
		});
		expect(update.status).toBe(200);
		const after = await getJson(base, `/api/agents/${ATTACH_AGENT_ID}/tools`, session.cookie);
		const requested = after.body.requested as JsonBody[];
		expect(requested.find((a) => a.entryId === GATEWAY_MATTERMOST_POST)?.mode).toBe("disabled");

		const detach = await postJson(base, `/api/agents/${ATTACH_AGENT_ID}/tools/detach`, session, {
			idempotencyKey: randomUUID(),
			entryId: GATEWAY_MATTERMOST_POST,
		});
		expect(detach.status).toBe(200);
		expect(detach.body.noop).toBe(false);
	});

	it("previews (dry-run) and commits 'Adopt into the tools hub' for a legacy agent", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const preview = await getJson(
			base,
			`/api/agents/${ADOPT_AGENT_ID}/tools/adopt`,
			session.cookie,
		);
		expect(preview.status).toBe(200);
		expect(preview.body.alreadyHubManaged).toBe(false);
		expect(preview.body.problems).toEqual([]);
		expect((preview.body.unresolved as JsonBody[]).length).toBeGreaterThan(0);
		expect(typeof preview.body.baseRevisionId).toBe("number");

		const commit = await postJson(base, `/api/agents/${ADOPT_AGENT_ID}/tools/adopt`, session, {
			idempotencyKey: randomUUID(),
			baseRevisionId: preview.body.baseRevisionId,
		});
		expect(commit.status).toBe(200);
		expect(commit.body.commit).not.toBeNull();
		// `before` is `operator`'s raw, hand-authored `permissions` — `deploy.*`/`mail.*` included,
		// even though neither names any entry the catalog actually knows; `after` is compiled from
		// only the attachments that resolved, so an unresolved wildcard (never backing a real
		// capability to begin with) is simply absent from it rather than reproduced verbatim. Every
		// pattern that *did* resolve compiles to the same effect either way — the two lists disagree
		// in content, never in what the agent may actually do.
		expect(commit.body.before).toMatchObject({
			tools_allow: ["mattermost.post"],
			tools_deny: expect.arrayContaining(["deploy.*", "mail.*", "finance.*", "workspace.write"]),
		});
		expect(commit.body.after).toEqual({
			tools_allow: ["mattermost.post"],
			tools_require_human_approval: [],
			tools_deny: ["finance.*", "memory.write", "workspace.write"],
			observe_system: true,
		});

		const again = await getJson(base, `/api/agents/${ADOPT_AGENT_ID}/tools/adopt`, session.cookie);
		expect(again.body.alreadyHubManaged).toBe(true);
	});

	it("404s adopting an agent that does not exist", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		expect(
			(await getJson(base, "/api/agents/no-such-agent/tools/adopt", session.cookie)).status,
		).toBe(404);
		expect(
			(
				await postJson(base, "/api/agents/no-such-agent/tools/adopt", session, {
					idempotencyKey: randomUUID(),
					baseRevisionId: null,
				})
			).status,
		).toBe(404);
	});

	it(
		"a stale baseRevisionId on the adopt commit is refused with 409, never silently committed " +
			"against newer state the preview never showed",
		async () => {
			const { base } = await withServer();
			const session = await signIn(base);
			const preview = await getJson(
				base,
				`/api/agents/${ADOPT_CONFLICT_AGENT_ID}/tools/adopt`,
				session.cookie,
			);
			expect(preview.status).toBe(200);
			const staleBase = preview.body.baseRevisionId;
			expect(typeof staleBase).toBe("number");

			// Moves the active revision on, unrelated to the agent being adopted — exactly like a
			// second browser tab (or another operator entirely) committing something else while this
			// preview sits open. `native-repository-read`, not `director`'s own
			// `gateway-mattermost-post` (already covered by its `mattermost.post` permission): its
			// legacy conversion would otherwise attach that same entry in the same revision as this
			// explicit request.
			const bump = await postJson(base, `/api/agents/${BUMP_AGENT_ID}/tools/attach`, session, {
				idempotencyKey: randomUUID(),
				entryId: NATIVE_REPOSITORY_READ,
				pinnedVersion: null,
				mode: "allow",
			});
			expect(bump.status).toBe(200);

			const stale = await postJson(
				base,
				`/api/agents/${ADOPT_CONFLICT_AGENT_ID}/tools/adopt`,
				session,
				{ idempotencyKey: randomUUID(), baseRevisionId: staleBase },
			);
			expect(stale.status).toBe(409);
			expect(stale.body.currentRevisionId).toBe(bump.body.revisionId);

			// The happy path still works once the client reloads: a fresh preview's own
			// `baseRevisionId` commits cleanly.
			const freshPreview = await getJson(
				base,
				`/api/agents/${ADOPT_CONFLICT_AGENT_ID}/tools/adopt`,
				session.cookie,
			);
			expect(freshPreview.body.baseRevisionId).toBe(bump.body.revisionId);
			const commit = await postJson(
				base,
				`/api/agents/${ADOPT_CONFLICT_AGENT_ID}/tools/adopt`,
				session,
				{ idempotencyKey: randomUUID(), baseRevisionId: freshPreview.body.baseRevisionId },
			);
			expect(commit.status).toBe(200);
			expect(commit.body.commit).not.toBeNull();
		},
	);

	// -----------------------------------------------------------------------
	// Auth, CSRF, wrong Origin. (A genuine 409 conflict for every *other* mutation on this surface is
	// not forced here: every one of `attach`/`detach`/`update` reads its own base revision internally
	// right before committing (ADR-027's own attach/detach/update path, not a client-supplied one) —
	// the editor's exact-base, reload-and-retry pattern (a client-supplied `baseRevisionId`) is for
	// `/preview`/`/commit` and, as of the adopt test above, `/tools/adopt` too. The shared
	// `ManagementConflictError` → 409 mapping every one of these routes reuses is already proven,
	// deterministically, for `/preview`/`/commit` in `console-management.integration.test.ts` and for
	// `/tools/adopt` right above; reproducing it again for `attach`/`detach`/`update` here would only
	// be a timing-dependent race on the same, already-tested wiring.)
	// -----------------------------------------------------------------------

	it("401s the hub's own routes without a session", async () => {
		const { base } = await withServer();
		expect((await fetch(`${base}/api/tools`)).status).toBe(401);
		expect((await fetch(`${base}/api/tools/${NATIVE_REPOSITORY_READ}`)).status).toBe(401);
		expect((await fetch(`${base}/api/agents/${READ_ONLY_LEGACY_AGENT_ID}/tools`)).status).toBe(401);
	});

	it("403s a mutation missing the CSRF header or carrying a foreign Origin", async () => {
		const { base } = await withServer();
		const session = await signIn(base);
		const missingCsrf = await fetch(
			`${base}/api/agents/${READ_ONLY_LEGACY_AGENT_ID}/tools/attach`,
			{
				method: "POST",
				headers: { cookie: session.cookie, origin: ORIGIN, "content-type": "application/json" },
				body: JSON.stringify({
					idempotencyKey: randomUUID(),
					entryId: GATEWAY_MATTERMOST_POST,
					pinnedVersion: null,
					mode: "allow",
				}),
			},
		);
		expect(missingCsrf.status).toBe(403);

		const foreignOrigin = await postJson(
			base,
			`/api/agents/${READ_ONLY_LEGACY_AGENT_ID}/tools/attach`,
			session,
			{
				idempotencyKey: randomUUID(),
				entryId: GATEWAY_MATTERMOST_POST,
				pinnedVersion: null,
				mode: "allow",
			},
			{ origin: FOREIGN_ORIGIN },
		);
		expect(foreignOrigin.status).toBe(403);
	});
});
