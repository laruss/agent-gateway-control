import type { ApprovalReply, CustomHttpsDefinition } from "@agent-gateway/contracts";
import {
	customToolActionType,
	toolDeadLetterQueue,
	toolExecuteQueue,
	toolReportQueue,
} from "@agent-gateway/contracts";
import {
	eventually,
	exampleConfig,
	humanPost,
	IDS,
	startTestGateway,
	type TestGateway,
} from "@agent-gateway/controller/testing";
import {
	adoptAgentToolAttachments,
	applyConfig,
	attachTool,
	createCustomHttpsTool,
	handleApprovalReply,
	ingestEvent,
} from "@agent-gateway/core";
import { grantToolRunnerRole } from "@agent-gateway/db";
import { silentLogger } from "@agent-gateway/logging";
import { approvalCode } from "@agent-gateway/policy";
import { type DnsResolver, executorRegistry } from "@agent-gateway/tool-broker";
import {
	generateTestTls,
	type RunningTestServer,
	startTestHttpsServer,
	TEST_CUSTOM_TOOL_HOST,
	type TestTls,
} from "@agent-gateway/tool-broker/testing";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type RunningToolRunner, startToolRunner } from "./runner.ts";

/**
 * Proves the `custom` namespace's real, database-backed wiring end to end: a `custom_https` entry
 * created through the hub's own service function, attached and approval-gated like any other
 * broker action, its approval card driven by the mock runtime's existing "approval" scenario (its
 * hardcoded params happen to match this suite's own definition, so no change to the mock runtime
 * is needed), granted through the real decision path, and picked up by a real `startToolRunner`
 * that resolves its definition through the real `gateway_custom_tool_definition` function.
 *
 * It deliberately does not try to make the destination call itself succeed: the egress guard
 * (`resolvePinnedAddress`) rightly refuses any address a real resolver could ever hand back for a
 * server this test can actually stand up (loopback), on purpose — weakening that guard just to
 * reach a local test server would test a pipeline this release does not ship. What a loopback
 * destination's own request-building, secret-substitution and response-handling correctness looks
 * like is `packages/tool-broker/src/custom-https-executor.test.ts`'s job, which calls the sender
 * directly rather than through the guard. This file instead proves the two things only a real
 * database and a real runner process can: the definition the runner actually resolves comes from
 * `catalog_entry_versions` by (entry id, pinned version), and a runner outside the `custom`
 * namespace can read none of it and cannot begin its action either.
 */

const RUNNER_ROLE = "gateway_custom_tool_runner";
const RUNNER_PASSWORD = "custom-tool-runner-test";
const SECRET_ALIAS = "echo_secret";

let gateway: TestGateway;
let runnerUrl: string;
let runner: RunningToolRunner | null = null;
let tls: TestTls;
let server: RunningTestServer;
let postCounter = 0;
let entryCounter = 0;

const resolveLoopback: DnsResolver = async () => [{ address: "127.0.0.1", family: 4 }];

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

async function stopRunner() {
	await runner?.stop();
	runner = null;
}

const query = async <T extends object>(text: string, values: Readonly<string[]> = []) =>
	(await gateway.pool.query<T>(text, [...values])).rows;

function definition(overrides: Partial<CustomHttpsDefinition> = {}): CustomHttpsDefinition {
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
		...overrides,
	};
}

async function createEntry(): Promise<string> {
	entryCounter += 1;
	const entryId = `echo-tool-${entryCounter}`;
	await createCustomHttpsTool(gateway.deps(), {
		entryId,
		name: "Echo tool",
		description: "A test custom HTTPS tool.",
		httpsDefinition: definition(),
		actor: "test",
	});
	await attachTool(gateway.deps(), {
		agentId: "finance",
		entryId,
		pinnedVersion: null,
		mode: "require_approval",
		actor: "test",
		source: "cli_apply",
	});
	return entryId;
}

/**
 * Asks @finance for the named custom action and returns its approval once the card is delivered
 * — mirroring `approvals.integration.test.ts`'s own `requestPayment`, but for a custom tool: the
 * mock's hardcoded "approval" scenario params (amount/currency/recipient/purpose/recurring)
 * happen to be exactly what `definition()` above declares.
 */
async function requestCustomAction(entryId: string) {
	const event = humanPost(`@finance do it [mock:approval ${customToolActionType(entryId)}]`, [
		"finance",
	]);
	await ingestEvent(gateway.deps(), event);
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
				[event.id],
			);
			return row !== undefined && row.card !== null ? { ...row, card: row.card } : null;
		},
		30_000,
		"approval card",
	);
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

async function idle(agentId: string) {
	await eventually(
		async () => {
			const [row] = await query<{ state: string }>("select state from agents where id = $1", [
				agentId,
			]);
			return row?.state === "idle";
		},
		30_000,
		`${agentId} idle`,
	);
}

beforeAll(async () => {
	gateway = await startTestGateway();
	tls = generateTestTls();
	const config = exampleConfig();
	await applyConfig(
		gateway.deps(),
		{
			...config,
			organization: {
				...config.organization,
				organization: {
					...config.organization.organization,
					default_limits: {
						...config.organization.organization.default_limits,
						max_runs_per_agent_per_hour: 1000,
					},
				},
			},
		},
		"test",
	);
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
	// Hub-managed attachments are an agent's *only* source of effective permissions (ADR-027): make
	// "finance" hub-managed by converting its existing legacy permissions first, so attaching a
	// custom tool on top adds to what it can already do (mattermost.post, its finance tools, ...)
	// rather than silently replacing all of it.
	await adoptAgentToolAttachments(gateway.deps(), {
		agentIds: ["finance"],
		dryRun: false,
		actor: "test",
	});
});

afterEach(async () => {
	await stopRunner();
	await server?.close();
});

afterAll(async () => {
	await gateway?.stop();
});

describe("custom HTTPS tools: the real, database-backed wiring", () => {
	it("resolves the exact approved definition from the database and the egress guard refuses its loopback destination, never touching the destination", async () => {
		let hits = 0;
		server = await startTestHttpsServer(tls, (_req, res) => {
			hits += 1;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
		await idle("finance");
		const entryId = await createEntry();
		const approval = await requestCustomAction(entryId);
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
		expect(resolved).toMatchObject({
			outcome: "failed",
			detail: expect.stringContaining("loopback"),
		});
		// The guard ran before any connection was attempted; the server never saw a request.
		expect(hits).toBe(0);
		await idle("finance");
	});

	it("keeps a custom-tool action's definition and execution out of reach of a runner serving a different namespace", async () => {
		await idle("finance");
		const entryId = await createEntry();
		const approval = await requestCustomAction(entryId);
		const code = approvalCode({
			id: approval.id,
			nonce: approval.nonce,
			immutableActionHash: approval.immutable_action_hash,
		});
		expect(await handleApprovalReply(gateway.deps(), reply(approval.card, `approve ${code}`))).toBe(
			"granted",
		);
		const [action] = await query<{ id: string; hash: string }>(
			"select id, immutable_action_hash as hash from tool_actions where approval_id = $1",
			[approval.id],
		);
		if (action === undefined) {
			throw new Error("no tool action");
		}
		await gateway.pool.query("create role gateway_mail_runner_ct login password 'mail-ct-test'");
		await grantToolRunnerRole(gateway.pool, "gateway_mail_runner_ct", [
			{
				run: toolExecuteQueue("mail"),
				report: toolReportQueue("mail"),
				deadLetter: toolDeadLetterQueue("mail"),
			},
		]);
		const mailUrl = new URL(gateway.postgres.connectionString);
		mailUrl.username = "gateway_mail_runner_ct";
		mailUrl.password = "mail-ct-test";
		const client = new pg.Client({ connectionString: mailUrl.toString() });
		await client.connect();
		try {
			const begin = await client.query<{ verdict: string }>(
				"select verdict from gateway_begin_tool_action($1, 1, $2)",
				[action.id, action.hash],
			);
			expect(begin.rows[0]?.verdict).toBe("wrong_namespace");
			const read = await client.query<{ definition: unknown }>(
				"select gateway_custom_tool_definition($1, 1) as definition",
				[entryId],
			);
			// A runner outside the `custom` namespace reads nothing of the catalog either.
			expect(read.rows[0]?.definition).toBeNull();
		} finally {
			await client.end();
		}
		await gateway.pool.query("update tool_actions set status = 'cancelled' where id = $1", [
			action.id,
		]);
		await idle("finance");
	});
});
