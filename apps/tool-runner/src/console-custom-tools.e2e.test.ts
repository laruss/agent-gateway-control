import { randomUUID } from "node:crypto";
import type { ApprovalReply, CustomHttpsDefinition } from "@agent-gateway/contracts";
import {
	customToolActionType,
	toolDeadLetterQueue,
	toolExecuteQueue,
	toolReportQueue,
} from "@agent-gateway/contracts";
import {
	type ConsoleServerOptions,
	collectConsoleStatus,
	createConsoleStatusCache,
	startConsoleServer,
} from "@agent-gateway/controller";
import {
	eventually,
	humanPost,
	IDS,
	startTestGateway,
	type TestGateway,
} from "@agent-gateway/controller/testing";
import { adoptAgentToolAttachments, handleApprovalReply, ingestEvent } from "@agent-gateway/core";
import { grantToolRunnerRole } from "@agent-gateway/db";
import { silentLogger } from "@agent-gateway/logging";
import { approvalCode } from "@agent-gateway/policy";
import { hashConsolePassword } from "@agent-gateway/service";
import { type DnsResolver, executorRegistry } from "@agent-gateway/tool-broker";
import {
	generateTestTls,
	type RunningTestServer,
	startTestHttpsServer,
	TEST_CUSTOM_TOOL_HOST,
	type TestTls,
} from "@agent-gateway/tool-broker/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type RunningToolRunner, startToolRunner } from "./runner.ts";

/**
 * The Instruments & Utils hub's own custom-tool flow, end to end, driven entirely through the
 * console's HTTP routes (ADR-025/ADR-027) rather than core functions called directly — the one
 * thing `apps/tool-runner/src/custom-tools.integration.test.ts` does not cover, since it predates
 * this console surface. Create → attach → a real mock-runtime turn requests it → approval →
 * grant → a real tool runner resolves and attempts it → detach → the same request again is never
 * even offered an approval, because the agent no longer holds it.
 *
 * Like the file above, this deliberately never weakens the egress guard to make the destination
 * call itself succeed: the guard correctly refuses the (necessarily loopback) address a test
 * server can actually offer with no external network, which is what "a real tool runner really
 * attempted it" looks like here. Request-building and response-handling correctness against a
 * reachable destination is `packages/tool-broker/src/custom-https-executor.test.ts`'s job.
 */

const PASSWORD = "console custom tools e2e test password";
const ORIGIN = "https://gateway.local";
const CSRF_KEY = "a-test-only-csrf-derivation-key-at-least-32-chars";
const RUNNER_ROLE = "gateway_console_custom_tool_runner";
const RUNNER_PASSWORD = "console-custom-tool-runner-test";
const SECRET_ALIAS = "echo_secret";
const AGENT_ID = "finance";
const ENTRY_ID = "console-echo-tool";

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

async function postJson(
	base: string,
	path: string,
	session: { cookie: string; csrfToken: string },
	body: unknown,
): Promise<{ status: number; body: JsonBody }> {
	const res = await fetch(`${base}${path}`, {
		method: "POST",
		headers: {
			cookie: session.cookie,
			origin: ORIGIN,
			"content-type": "application/json",
			"x-csrf-token": session.csrfToken,
		},
		body: JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as JsonBody };
}

function definition(): CustomHttpsDefinition {
	return {
		host: TEST_CUSTOM_TOOL_HOST,
		pathTemplate: "/pay/{amount}",
		method: "POST",
		parameters: [
			{
				name: "amount",
				slot: "path",
				slotName: "amount",
				type: "string",
				minLength: 1,
				maxLength: 20,
			},
			{
				name: "currency",
				slot: "query",
				slotName: "currency",
				type: "string",
				minLength: 1,
				maxLength: 10,
			},
			{
				name: "recipient",
				slot: "header",
				slotName: "x-recipient",
				type: "string",
				minLength: 1,
				maxLength: 64,
			},
			{
				name: "purpose",
				slot: "body",
				slotName: "purpose",
				type: "string",
				minLength: 1,
				maxLength: 200,
			},
			{
				name: "recurring",
				slot: "body",
				slotName: "recurring",
				type: "string",
				minLength: 1,
				maxLength: 10,
			},
		],
		secretSlots: [{ alias: SECRET_ALIAS, slot: "header", slotName: "x-api-key" }],
		idempotency: { headerName: "idempotency-key" },
		responseLimits: {
			maxResponseBytes: 65_536,
			allowedContentTypes: ["application/json"],
			timeoutMs: 5000,
			includeBodyPreview: true,
		},
	};
}

const resolveLoopback: DnsResolver = async () => [{ address: "127.0.0.1", family: 4 }];

describe("the Instruments & Utils hub's custom-tool flow, driven through the console's own routes", () => {
	let gateway: TestGateway;
	let passwordHash: string;
	let console_: { base: string; stop: () => Promise<void> };
	let runnerUrl: string;
	let runner: RunningToolRunner | null = null;
	let tls: TestTls;
	let server: RunningTestServer | null = null;
	let postCounter = 0;

	const query = async <T extends object>(text: string, values: Readonly<string[]> = []) =>
		(await gateway.pool.query<T>(text, [...values])).rows;

	async function startRunner() {
		runner = await startToolRunner({
			connectionString: runnerUrl,
			namespaces: ["custom"],
			executors: executorRegistry([]),
			log: silentLogger,
			pollingIntervalSeconds: 0.5,
			customToolSecrets: async (alias) => {
				if (alias !== SECRET_ALIAS) {
					throw new Error(`no secret for alias '${alias}'`);
				}
				return "unused-in-this-suite";
			},
			customToolDnsResolver: resolveLoopback,
			customToolCa: [tls.caCert],
		});
	}

	async function agentState(agentId: string) {
		return (await query<{ state: string }>("select state from agents where id = $1", [agentId]))[0]
			?.state;
	}

	async function idle(agentId: string) {
		await eventually(async () => (await agentState(agentId)) === "idle", 30_000, `${agentId} idle`);
	}

	function reply(card: string, message: string): ApprovalReply {
		postCounter += 1;
		return {
			postId: `rep1y${String(postCounter).padStart(21, "0")}`,
			rootPostId: card,
			rootCardKey: null,
			channelId: IDS.channel("approvals"),
			userId: IDS.owner,
			message,
			author: { isBot: false, active: true, automated: false },
		};
	}

	async function requestCustomAction(trigger: string) {
		const event = humanPost(`@finance do it [mock:approval ${trigger}]`, ["finance"]);
		await ingestEvent(gateway.deps(), event);
		return event;
	}

	async function cardFor(eventExternalId: string) {
		return eventually(
			async () => {
				const [row] = await query<{
					id: string;
					nonce: string;
					immutable_action_hash: string;
					card: string | null;
				}>(
					`select a.id, a.nonce, a.immutable_action_hash,
					        o.receipt ->> 'postId' as card
					   from approval_requests a
					   join agent_runs r on r.id = a.run_id
					   join events e on e.id = r.trigger_event_id
					   left join outbox o on o.idempotency_key = 'approval-card:' || a.id
					  where e.external_id = $1`,
					[eventExternalId],
				);
				return row !== undefined && row.card !== null ? { ...row, card: row.card } : null;
			},
			30_000,
			"approval card",
		);
	}

	async function resolution(approvalId: string) {
		return eventually(
			async () => {
				const [row] = await query<{ payload: Record<string, unknown> }>(
					"select payload from events where external_id = $1",
					[`approval-resolved:${approvalId}`],
				);
				return row?.payload;
			},
			30_000,
			"approval.resolved",
		);
	}

	beforeAll(async () => {
		gateway = await startTestGateway();
		passwordHash = await hashConsolePassword(PASSWORD);
		tls = generateTestTls();

		const options: ConsoleServerOptions = {
			port: 0,
			hostname: "127.0.0.1",
			passwordHash,
			origin: ORIGIN,
			csrfKey: CSRF_KEY,
			deps: gateway.deps(),
			cache: createConsoleStatusCache((now) => collectConsoleStatus(gateway.pool, now)),
			log: silentLogger,
		};
		const started = startConsoleServer(options);
		console_ = { base: `http://127.0.0.1:${started.port}`, stop: started.stop };

		await gateway.pool.query(`create role ${RUNNER_ROLE} login password '${RUNNER_PASSWORD}'`);
		await grantToolRunnerRole(gateway.pool, RUNNER_ROLE, [
			{
				run: toolExecuteQueue("custom"),
				report: toolReportQueue("custom"),
				deadLetter: toolDeadLetterQueue("custom"),
			},
		]);
		const url = new URL(gateway.postgres.connectionString);
		url.username = RUNNER_ROLE;
		url.password = RUNNER_PASSWORD;
		runnerUrl = url.toString();

		// Setup, not the scenario under test: hub-managed attachments are an agent's *only* source
		// of effective permissions (ADR-027), so `finance` is converted first, the same bootstrap
		// `custom-tools.integration.test.ts` performs, so attaching the console-created tool on top
		// adds to what it can already do rather than silently replacing all of it.
		await adoptAgentToolAttachments(gateway.deps(), {
			agentIds: [AGENT_ID],
			dryRun: false,
			actor: "test",
		});
	});

	afterEach(async () => {
		await runner?.stop();
		runner = null;
		await server?.close();
		server = null;
	});

	afterAll(async () => {
		await console_?.stop();
		await gateway?.stop();
	});

	it("creates a custom HTTPS tool via the console, attaches it, a real turn requests it, grants " +
		"and a real tool runner attempts it against a local test server; detaching it then " +
		"refuses the same request outright, with no approval ever created", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
		await idle(AGENT_ID);
		const session = await signIn(console_.base);

		const created = await postJson(console_.base, "/api/tools", session, {
			entryId: ENTRY_ID,
			name: "Console echo tool",
			description: "A console-created test custom HTTPS tool.",
			httpsDefinition: definition(),
		});
		expect(created.status).toBe(200);

		const attached = await postJson(
			console_.base,
			`/api/agents/${AGENT_ID}/tools/attach`,
			session,
			{
				idempotencyKey: randomUUID(),
				entryId: ENTRY_ID,
				pinnedVersion: null,
				mode: "require_approval",
			},
		);
		expect(attached.status).toBe(200);

		const trigger = customToolActionType(ENTRY_ID);
		const firstEvent = await requestCustomAction(trigger);
		const approval = await cardFor(firstEvent.id);
		const code = approvalCode({
			id: approval.id,
			nonce: approval.nonce,
			immutableActionHash: approval.immutable_action_hash,
		});
		await startRunner();
		expect(await handleApprovalReply(gateway.deps(), reply(approval.card, `approve ${code}`))).toBe(
			"granted",
		);
		const resolved = await resolution(approval.id);
		// The egress guard refuses the (necessarily loopback) destination before any connection
		// is attempted — a real, security-correct outcome, not a pipeline this test weakens to
		// force a success. The server never actually saw a request.
		expect(resolved).toMatchObject({
			outcome: "failed",
			detail: expect.stringContaining("loopback"),
		});
		await idle(AGENT_ID);

		const detached = await postJson(
			console_.base,
			`/api/agents/${AGENT_ID}/tools/detach`,
			session,
			{ idempotencyKey: randomUUID(), entryId: ENTRY_ID },
		);
		expect(detached.status).toBe(200);
		expect(detached.body.noop).toBe(false);

		const secondEvent = await requestCustomAction(trigger);
		const secondRun = await eventually(
			async () => {
				const [row] = await query<{
					id: string;
					status: string;
					outcome: string | null;
					error_code: string | null;
				}>(
					`select r.id, r.status, r.outcome, r.error_code
						   from agent_runs r join events e on e.id = r.trigger_event_id
						  where e.external_id = $1`,
					[secondEvent.id],
				);
				return row !== undefined && row.status !== "queued" && row.status !== "running"
					? row
					: null;
			},
			30_000,
			"second run finished",
		);
		// The agent no longer holds this attachment at all (detached, not merely denied), so the
		// compiled policy never offers the model's call to a human in the first place: refused
		// outright by the turn's own authority, the same non-retryable rejection
		// `tool-catalog-enforcement.integration.test.ts` already proves for a denied memory write
		// — never a queued or pending approval of any kind.
		expect(secondRun).toMatchObject({ status: "failed", error_code: "invalid_output" });
		const [secondApproval] = await query<{ id: string }>(
			`select a.id
				   from approval_requests a
				   join agent_runs r on r.id = a.run_id
				   join events e on e.id = r.trigger_event_id
				  where e.external_id = $1`,
			[secondEvent.id],
		);
		expect(secondApproval).toBeUndefined();
		await eventually(
			async () => (await agentState(AGENT_ID)) === "failed",
			30_000,
			`${AGENT_ID} failed (the non-retryable rejection above)`,
		);
	}, 60_000);
});
