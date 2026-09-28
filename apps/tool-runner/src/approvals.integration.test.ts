import type { ApprovalReply, JsonObject } from "@agent-gateway/contracts";
import {
	ToolActionJobSchema,
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
	ApprovalCardPendingError,
	applyConfig,
	handleApprovalReply,
	handleRunReport,
	ingestEvent,
	killAll,
	releaseKillSwitch,
	resumeAgent,
	setAgentEnabled,
	sweepApprovals,
	TOOL_BEGIN_WINDOW_MS,
	TOOL_RUN_GRACE_MS,
} from "@agent-gateway/core";
import { grantToolRunnerRole } from "@agent-gateway/db";
import { silentLogger } from "@agent-gateway/logging";
import { approvalCode } from "@agent-gateway/policy";
import { executorRegistry, type ToolExecutor } from "@agent-gateway/tool-broker";
import {
	blockingExecutor,
	type RecordingExecutor,
	recordingExecutor,
	throwingExecutor,
} from "@agent-gateway/tool-broker/testing";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type RunningToolRunner, startToolRunner } from "./runner.ts";

const RUNNER_ROLE = "gateway_tool_runner";
/** Throwaway credential of a throwaway test database. */
const RUNNER_PASSWORD = "tool-runner-test";
const APPROVALS = IDS.channel("approvals");
const BOT = "somebot00000000000000000aa";

let gateway: TestGateway;
let runnerUrl: string;
let runner: RunningToolRunner | null = null;
let payments: RecordingExecutor;
let postCounter = 0;

async function startRunner(executors: Readonly<ToolExecutor[]> = [payments]) {
	runner = await startToolRunner({
		connectionString: runnerUrl,
		namespaces: ["finance"],
		executors: executorRegistry(executors),
		log: silentLogger,
		pollingIntervalSeconds: 0.5,
	});
}

async function stopRunner() {
	await runner?.stop();
	runner = null;
}

const query = async <T extends object>(text: string, values: Readonly<string[]> = []) =>
	(await gateway.pool.query<T>(text, [...values])).rows;

type ApprovalRow = {
	id: string;
	status: string;
	nonce: string;
	immutable_action_hash: string;
	resolved_at: Date | null;
};

/** Asks @finance for a payment and returns its approval once the card is delivered. */
async function requestPayment(): Promise<ApprovalRow & { card: string }> {
	const event = humanPost("@finance pay the invoice [mock:approval finance.payment.create]", [
		"finance",
	]);
	await ingestEvent(gateway.deps(), event);
	return eventually(
		async () => {
			const [row] = await query<ApprovalRow & { card: string | null }>(
				`select a.*, o.receipt ->> 'postId' as card
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

function codeOf(approval: ApprovalRow): string {
	return approvalCode({
		id: approval.id,
		nonce: approval.nonce,
		immutableActionHash: approval.immutable_action_hash,
	});
}

function reply(
	card: string,
	message: string,
	overrides: Partial<Omit<ApprovalReply, "author">> & {
		author?: Partial<ApprovalReply["author"]>;
	} = {},
): ApprovalReply {
	postCounter += 1;
	return {
		postId: `rep1y${String(postCounter).padStart(21, "0")}`,
		rootPostId: card,
		rootCardKey: null,
		channelId: APPROVALS,
		userId: IDS.owner,
		message,
		...overrides,
		author: { isBot: false, active: true, automated: false, ...overrides.author },
	};
}

async function status(approvalId: string) {
	const [row] = await query<{ status: string; action: string | null }>(
		`select a.status, t.status as action from approval_requests a
		   left join tool_actions t on t.approval_id = a.id where a.id = $1`,
		[approvalId],
	);
	return row;
}

async function resolution(approvalId: string) {
	return eventually(
		async () => {
			const [row] = await query<{ payload: JsonObject }>(
				"select payload from events where external_id = $1",
				[`approval-resolved:${approvalId}`],
			);
			return row?.payload;
		},
		30_000,
		"approval.resolved",
	);
}

/** The run of @finance that `approval.resolved` resumed. */
async function resumedRun(approvalId: string) {
	return eventually(
		async () => {
			const [row] = await query<{ status: string }>(
				`select r.status from agent_runs r join events e on e.id = r.trigger_event_id
				  where e.external_id = $1 and r.status in ('succeeded', 'failed')`,
				[`approval-resolved:${approvalId}`],
			);
			return row;
		},
		30_000,
		"resumed run",
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
			run: toolExecuteQueue("finance"),
			report: toolReportQueue("finance"),
			deadLetter: toolDeadLetterQueue("finance"),
		},
	]);
	const url = new URL(gateway.postgres.connectionString);
	url.username = RUNNER_ROLE;
	url.password = RUNNER_PASSWORD;
	runnerUrl = url.toString();
});

afterEach(async () => {
	await stopRunner();
});

afterAll(async () => {
	await gateway?.stop();
});

describe("approvals and the tool broker", () => {
	it("runs a payment only after an owner approves it, once, and resumes the agent", async () => {
		payments = recordingExecutor("finance.payment.create");
		await startRunner();
		await idle("finance");
		const approval = await requestPayment();
		const code = codeOf(approval);
		const decide = (r: ApprovalReply) => handleApprovalReply(gateway.deps(), r);

		// Forged decisions: another bot, a human who is not an owner, an integration on the
		// owner's account, a deactivated owner, the wrong code, text that is not a command.
		expect(
			await decide(
				reply(approval.card, `approve ${code}`, { userId: BOT, author: { isBot: true } }),
			),
		).toBe("not_an_approver");
		expect(await decide(reply(approval.card, `approve ${code}`, { userId: IDS.human }))).toBe(
			"not_an_approver",
		);
		expect(
			await decide(reply(approval.card, `approve ${code}`, { author: { automated: true } })),
		).toBe("not_an_approver");
		expect(
			await decide(reply(approval.card, `approve ${code}`, { author: { active: false } })),
		).toBe("not_an_approver");
		expect(await decide(reply(approval.card, "approve AAAA-BBBB-CCCC"))).toBe("wrong_code");
		expect(await decide(reply(approval.card, "APPROVED"))).toBe("ignored");
		expect(await decide(reply(approval.card, `approve ${code} now`))).toBe("malformed");
		expect(
			await decide(reply(approval.card, `approve ${code}`, { channelId: IDS.channel("hq") })),
		).toBe("not_a_card");
		expect(await status(approval.id)).toEqual({ status: "pending", action: null });
		const forgeries = await query("select 1 from outbox where idempotency_key like $1", [
			`alert:approval-forgery:${approval.id}:%`,
		]);
		// One alert per author: the bot, the other human, and the owner (integration, deactivated).
		expect(forgeries).toHaveLength(3);

		const approve = reply(approval.card, `approve ${code.toLowerCase().replaceAll("-", "")}`);
		expect(await decide(approve)).toBe("granted");
		expect(await resolution(approval.id)).toMatchObject({
			outcome: "succeeded",
			receipt: { provider_id: "sandbox-1" },
		});
		expect(await resumedRun(approval.id)).toEqual({ status: "succeeded" });
		expect(payments.effects()).toHaveLength(1);
		expect(payments.effects()[0]?.params).toMatchObject({ amount: "10.00", currency: "EUR" });
		expect(await status(approval.id)).toEqual({ status: "granted", action: "succeeded" });
		// The execution is a span of the requesting run's trace, and so is its job.
		const [traces] = await query<{ run: string; action: string; job: string | null }>(
			`select r.traceparent as run, t.traceparent as action,
			        (select data->>'traceparent' from pgboss.job j
			          where j.name = 'tool.execute.finance' and j.data->>'actionId' = t.id::text
			          limit 1) as job
			   from tool_actions t join approval_requests a on a.id = t.approval_id
			   join agent_runs r on r.id = a.run_id where a.id = $1`,
			[approval.id],
		);
		const traceId = (value: string | null | undefined) => value?.split("-")[1] ?? null;
		expect(traceId(traces?.run)).toMatch(/^[0-9a-f]{32}$/u);
		expect(traceId(traces?.action)).toBe(traceId(traces?.run));
		expect(traceId(traces?.job)).toBe(traceId(traces?.run));
		expect(traces?.action).not.toBe(traces?.run);

		// The same post again, and a second decision: nothing more happens.
		expect(await decide(approve)).toBe("replayed");
		expect(await decide(reply(approval.card, `deny ${code}`))).toBe("already_decided");
		const notices = await query<{ key: string }>(
			"select idempotency_key as key from outbox where kind = 'mattermost.approval.reply' and payload ->> 'approvalId' = $1 order by created_at",
			[approval.id],
		);
		expect(notices.map((n) => n.key)).toContain(`approval-executed:${approval.id}:succeeded`);
		await idle("finance");
		expect(payments.effects()).toHaveLength(1);
	});

	it("denies without running anything, and tells the agent", async () => {
		payments = recordingExecutor("finance.payment.create");
		await startRunner();
		await idle("finance");
		const approval = await requestPayment();
		expect(
			await handleApprovalReply(gateway.deps(), reply(approval.card, `deny ${codeOf(approval)}`)),
		).toBe("denied");
		expect(await resolution(approval.id)).toMatchObject({ outcome: "denied", receipt: null });
		expect(await resumedRun(approval.id)).toEqual({ status: "succeeded" });
		expect(payments.calls()).toEqual([]);
		await idle("finance");
	});

	it("never lets another agent ask for a finance action", async () => {
		await idle("developer");
		const event = humanPost("@developer pay it [mock:approval finance.payment.create]", [
			"developer",
		]);
		await ingestEvent(gateway.deps(), event);
		const run = await eventually(
			async () => {
				const [row] = await query<{ id: string; status: string; error_code: string }>(
					`select r.id, r.status, r.error_code from agent_runs r
					   join events e on e.id = r.trigger_event_id
					  where e.external_id = $1 and r.status = 'failed'`,
					[event.id],
				);
				return row;
			},
			30_000,
			"refused run",
		);
		expect(run.error_code).toBe("invalid_output");
		expect(await query("select 1 from approval_requests where run_id = $1", [run.id])).toEqual([]);
		const decisions = await query<{ decision: string }>(
			"select decision from policy_decisions where run_id = $1",
			[run.id],
		);
		expect(decisions.map((d) => d.decision)).toContain("deny");
		await gateway.pool.query(
			"update agents set state = 'idle' where id = 'developer' and state = 'failed'",
		);
	});

	it("refuses a changed amount: the request is immutable and a tampered job never runs", async () => {
		payments = recordingExecutor("finance.payment.create");
		await idle("finance");
		const approval = await requestPayment();
		await expect(
			gateway.pool.query(
				`update approval_requests set action_params = jsonb_set(action_params, '{0,value}', '"9999.00"') where id = $1`,
				[approval.id],
			),
		).rejects.toThrow(/immutable/);

		// Granted while no runner runs; then a forged job with another amount joins the queue.
		expect(
			await handleApprovalReply(
				gateway.deps(),
				reply(approval.card, `approve ${codeOf(approval)}`),
			),
		).toBe("granted");
		const [action] = await query<{ id: string }>(
			"select id from tool_actions where approval_id = $1",
			[approval.id],
		);
		if (action === undefined) {
			throw new Error("no tool action");
		}
		const [legit] = await gateway.controller().boss.findJobs(toolExecuteQueue("finance"), {
			data: { actionId: action.id },
		});
		const job = ToolActionJobSchema.parse(legit?.data);
		await gateway.controller().boss.deleteJob(toolExecuteQueue("finance"), legit?.id ?? "");
		await gateway.controller().boss.send(toolExecuteQueue("finance"), {
			...job,
			actionParams: job.actionParams.map((p) =>
				p.name === "amount" ? { ...p, value: "9999.00" } : p,
			),
		});
		await startRunner();
		await eventually(
			async () =>
				(
					await query(
						"select 1 from audit_log where action = 'tool_action.refused' and subject_id = $1",
						[action.id],
					)
				).length > 0,
			30_000,
			"refused tampered job",
		);
		expect(payments.calls()).toEqual([]);
		expect(await status(approval.id)).toEqual({ status: "granted", action: "queued" });

		// The untampered job still runs, with the approved amount.
		await gateway.controller().boss.send(toolExecuteQueue("finance"), job);
		expect(await resolution(approval.id)).toMatchObject({ outcome: "succeeded" });
		expect(payments.effects().map((e) => e.params.amount)).toEqual(["10.00"]);
		await idle("finance");
	});

	it("records an executor that dies mid-call as unknown and never retries it", async () => {
		await startRunner([throwingExecutor("finance.payment.create")]);
		await idle("finance");
		const approval = await requestPayment();
		expect(
			await handleApprovalReply(
				gateway.deps(),
				reply(approval.card, `approve ${codeOf(approval)}`),
			),
		).toBe("granted");
		expect(await resolution(approval.id)).toMatchObject({ outcome: "unknown" });
		expect(await status(approval.id)).toEqual({ status: "granted", action: "unknown" });
		const alerts = await query(
			"select 1 from outbox where idempotency_key like 'alert:tool-unknown:%'",
		);
		expect(alerts.length).toBeGreaterThan(0);
		await idle("finance");
	});

	it("does not accept a decision after the request expired", async () => {
		await idle("finance");
		const approval = await requestPayment();
		const later = { ...gateway.deps(), clock: () => new Date(Date.now() + 25 * 3600_000) };
		expect(
			await handleApprovalReply(later, reply(approval.card, `approve ${codeOf(approval)}`)),
		).toBe("expired");
		expect(await status(approval.id)).toEqual({ status: "pending", action: null });
		expect(
			await handleApprovalReply(gateway.deps(), reply(approval.card, `deny ${codeOf(approval)}`)),
		).toBe("denied");
		await idle("finance");
	});

	it("kill-all withdraws pending approvals and queued actions, and begin refuses", async () => {
		payments = recordingExecutor("finance.payment.create");
		const release = async () => {
			await releaseKillSwitch(gateway.deps(), "test");
			for (const agent of ["director", "developer", "finance", "research", "mail-follower"]) {
				await resumeAgent(gateway.deps(), agent, "test").catch(() => undefined);
			}
		};

		// A pending request is cancelled; the agent learns it once it is resumed.
		await idle("finance");
		const pending = await requestPayment();
		await killAll(gateway.deps(), "test");
		try {
			expect(await status(pending.id)).toEqual({ status: "cancelled", action: null });
			expect(await resolution(pending.id)).toMatchObject({ outcome: "cancelled" });
			expect(
				await handleApprovalReply(
					gateway.deps(),
					reply(pending.card, `approve ${codeOf(pending)}`),
				),
			).toBe("already_decided");
		} finally {
			await release();
		}
		await idle("finance");

		// A granted action that has not begun is cancelled, and begin refuses under the switch.
		const granted = await requestPayment();
		expect(
			await handleApprovalReply(gateway.deps(), reply(granted.card, `approve ${codeOf(granted)}`)),
		).toBe("granted");
		const [action] = await query<{ id: string; immutable_action_hash: string }>(
			"select id, immutable_action_hash from tool_actions where approval_id = $1",
			[granted.id],
		);
		if (action === undefined) {
			throw new Error("no tool action");
		}
		await killAll(gateway.deps(), "test");
		try {
			expect(await status(granted.id)).toEqual({ status: "granted", action: "cancelled" });
			expect(await resolution(granted.id)).toMatchObject({ outcome: "cancelled" });
			const [begin] = await query<{ verdict: string }>(
				"select verdict from gateway_begin_tool_action($1, 1, $2)",
				[action.id, action.immutable_action_hash],
			);
			expect(begin?.verdict).toBe("kill_switch");
			await startRunner();
			await eventually(
				async () =>
					(
						await query(
							"select 1 from audit_log where action = 'tool_action.refused' and subject_id = $1",
							[action.id],
						)
					).length > 0,
				30_000,
				"refused job",
			);
			expect(payments.calls()).toEqual([]);
		} finally {
			await release();
		}
		await idle("finance");
	});

	it("kill-all stops an executor that already began", async () => {
		await startRunner([blockingExecutor("finance.payment.create")]);
		await idle("finance");
		const approval = await requestPayment();
		expect(
			await handleApprovalReply(
				gateway.deps(),
				reply(approval.card, `approve ${codeOf(approval)}`),
			),
		).toBe("granted");
		await eventually(
			async () => (await status(approval.id))?.action === "running",
			30_000,
			"action running",
		);
		await killAll(gateway.deps(), "test");
		try {
			expect(await resolution(approval.id)).toMatchObject({
				outcome: "failed",
				detail: "aborted before anything was sent",
			});
			expect(await status(approval.id)).toEqual({ status: "granted", action: "failed" });
		} finally {
			await releaseKillSwitch(gateway.deps(), "test");
			for (const agent of ["director", "developer", "finance", "research", "mail-follower"]) {
				await resumeAgent(gateway.deps(), agent, "test").catch(() => undefined);
			}
		}
		await idle("finance");
	});

	it("waits for the receipt of the very card a reply's root claims to be, and no other", async () => {
		// A card still being delivered: claimed by a delivery in flight, no receipt yet.
		const key = "approval-card:0b6f0b7e-8a36-4a45-9d9c-2ad1f1c0a0ff";
		await gateway.pool.query(
			`insert into outbox (kind, destination, payload, idempotency_key, status, attempts, max_attempts, locked_until)
			 values ('mattermost.approval', 'channel/approvals', '{}', $1, 'sending', 1, 8, now() + interval '1 hour')`,
			[key],
		);
		const root = "cardr00t000000000000000000";
		await expect(
			handleApprovalReply(gateway.deps(), {
				...reply(root, "approve AAAA-BBBB-CCCC"),
				rootCardKey: key,
			}),
		).rejects.toThrow(ApprovalCardPendingError);
		// Any other thread in the approvals channel is simply no card.
		expect(await handleApprovalReply(gateway.deps(), reply(root, "approve AAAA-BBBB-CCCC"))).toBe(
			"not_a_card",
		);
	});

	it("keeps the runner's role to its namespace, and workers out of the broker", async () => {
		const asRole = async (url: string, sql: string, values: Readonly<string[]> = []) => {
			const client = new pg.Client({ connectionString: url });
			await client.connect();
			try {
				return (await client.query<{ verdict?: string }>(sql, [...values])).rows;
			} finally {
				await client.end();
			}
		};
		await expect(asRole(runnerUrl, "select 1 from approval_requests")).rejects.toThrow(
			/permission denied/,
		);
		await expect(asRole(runnerUrl, "select 1 from tool_actions")).rejects.toThrow(
			/permission denied/,
		);
		// A runner of another namespace cannot begin a finance action.
		await gateway.pool.query("create role gateway_mail_runner login password 'mail-test'");
		await grantToolRunnerRole(gateway.pool, "gateway_mail_runner", [
			{
				run: toolExecuteQueue("mail"),
				report: toolReportQueue("mail"),
				deadLetter: toolDeadLetterQueue("mail"),
			},
		]);
		const mailUrl = new URL(gateway.postgres.connectionString);
		mailUrl.username = "gateway_mail_runner";
		mailUrl.password = "mail-test";
		const [action] = await query<{ id: string; hash: string }>(
			"select id, immutable_action_hash as hash from tool_actions order by created_at limit 1",
		);
		if (action === undefined) {
			throw new Error("no tool action yet");
		}
		expect(
			await asRole(mailUrl.toString(), "select verdict from gateway_begin_tool_action($1, 1, $2)", [
				action.id,
				action.hash,
			]),
		).toEqual([{ verdict: "wrong_namespace" }]);
		// A runtime worker can neither begin an action nor queue one.
		await expect(
			asRole(gateway.workerConnectionString, "select * from gateway_begin_tool_action($1, 1, $2)", [
				action.id,
				action.hash,
			]),
		).rejects.toThrow(/permission denied/);
		await expect(
			asRole(
				gateway.workerConnectionString,
				"insert into pgboss.job (name, data) values ('tool.execute.finance', '{}')",
			),
		).rejects.toThrow(/row-level security|permission denied/);
	});

	it("settles overdue actions: cancelled before they began, unknown when silent", async () => {
		await idle("finance");
		const unstarted = await requestPayment();
		await handleApprovalReply(
			gateway.deps(),
			reply(unstarted.card, `approve ${codeOf(unstarted)}`),
		);
		const later = (ms: number) => ({ ...gateway.deps(), clock: () => new Date(Date.now() + ms) });
		await sweepApprovals(later(TOOL_BEGIN_WINDOW_MS + 60_000));
		expect(await status(unstarted.id)).toEqual({ status: "granted", action: "cancelled" });
		expect(await resolution(unstarted.id)).toMatchObject({ outcome: "cancelled" });
		await idle("finance");

		// Began, then silent past its grace: unknown. The runner's late word is still recorded,
		// and the agent is not resumed a second time.
		await startRunner([blockingExecutor("finance.payment.create")]);
		const silent = await requestPayment();
		await handleApprovalReply(gateway.deps(), reply(silent.card, `approve ${codeOf(silent)}`));
		await eventually(
			async () => (await status(silent.id))?.action === "running",
			30_000,
			"running",
		);
		await sweepApprovals(later(TOOL_BEGIN_WINDOW_MS + TOOL_RUN_GRACE_MS + 60_000));
		expect(await resolution(silent.id)).toMatchObject({ outcome: "unknown" });
		// The executor finally gives up (asked to stop) and reports a known failure, late.
		await gateway.pool.query(
			"update tool_actions set cancel_requested_at = now() where approval_id = $1",
			[silent.id],
		);
		await eventually(
			async () => (await status(silent.id))?.action === "failed",
			30_000,
			"late report",
		);
		const resolutions = await query("select 1 from events where external_id = $1", [
			`approval-resolved:${silent.id}`,
		]);
		expect(resolutions).toHaveLength(1);
		await idle("finance");
	});

	it("cancels a queued action the new configuration no longer permits, and withdraws on disable", async () => {
		await idle("finance");
		const approval = await requestPayment();
		await handleApprovalReply(gateway.deps(), reply(approval.card, `approve ${codeOf(approval)}`));
		const config = exampleConfig();
		const revoked = {
			...config,
			agents: config.agents.map((agent) =>
				agent.id === "finance"
					? {
							...agent,
							permissions: {
								...agent.permissions,
								tools_require_human_approval: ["finance.subscription.create"],
							},
						}
					: agent,
			),
		};
		await applyConfig(gateway.deps(), revoked, "test");
		expect(await status(approval.id)).toEqual({ status: "granted", action: "cancelled" });
		await applyConfig(gateway.deps(), config, "test");
		await sweepApprovals(gateway.deps());
		expect(await resolution(approval.id)).toMatchObject({ outcome: "cancelled" });
		await idle("finance");

		const pending = await requestPayment();
		await setAgentEnabled(gateway.deps(), "finance", false, "test");
		await setAgentEnabled(gateway.deps(), "finance", true, "test");
		expect(await status(pending.id)).toEqual({ status: "cancelled", action: null });
		await sweepApprovals(gateway.deps());
		const withdrawn = await query("select 1 from outbox where idempotency_key = $1", [
			`approval-final:${pending.id}`,
		]);
		expect(withdrawn).toHaveLength(1);
		await idle("finance");
	});

	it("withdraws pending requests when the approvals channel moves", async () => {
		await idle("finance");
		const approval = await requestPayment();
		const config = exampleConfig();
		await applyConfig(
			gateway.deps(),
			{
				...config,
				organization: {
					...config.organization,
					mattermost: { ...config.organization.mattermost, approvals_channel: "finance" },
				},
			},
			"test",
		);
		expect(await status(approval.id)).toEqual({ status: "cancelled", action: null });
		await applyConfig(gateway.deps(), config, "test");
		await sweepApprovals(gateway.deps());
		expect(await resolution(approval.id)).toMatchObject({ outcome: "cancelled" });
		await idle("finance");
	});

	it("defers a retry the budget holds, and runs the work once the limit is raised", async () => {
		await idle("director");
		const config = exampleConfig();
		const withBudget = (tokens: number) => ({
			...config,
			organization: {
				...config.organization,
				organization: {
					...config.organization.organization,
					default_limits: {
						...config.organization.organization.default_limits,
						max_runs_per_agent_per_hour: 1000,
					},
					budgets: { per_agent_daily: { tokens }, unmetered: "allow" as const },
				},
			},
		});
		await applyConfig(gateway.deps(), withBudget(1000), "test");
		await gateway.stopWorker();
		let workerUp = false;
		try {
			const event = humanPost("@director deferred work", ["director"]);
			await ingestEvent(gateway.deps(), event);
			const [run] = await query<{ id: string }>(
				`select r.id from agent_runs r join events e on e.id = r.trigger_event_id
				  where e.external_id = $1`,
				[event.id],
			);
			if (run === undefined) {
				throw new Error("no run was scheduled");
			}
			// The attempt spends the budget and fails retryably.
			const outcome = await handleRunReport(
				gateway.deps(),
				{
					kind: "failed",
					runId: run.id,
					attempt: 1,
					agentId: "director",
					runtimeVersion: "test",
					error: { code: "runtime_retryable", retryable: true, detail: "provider overloaded" },
					usage: {
						inputTokens: 900,
						outputTokens: 200,
						cachedInputTokens: null,
						costUsd: null,
						durationMs: 10,
						model: null,
					},
					session: null,
				},
				"mock",
			);
			expect(outcome).toBe("deferred");
			const [deferred] = await query<{ status: string; state: string }>(
				"select r.status, a.state from agent_runs r join agents a on a.id = r.agent_id where r.id = $1",
				[run.id],
			);
			expect(deferred).toEqual({ status: "cancelled", state: "idle" });
			await gateway.startWorker();
			workerUp = true;
			await applyConfig(gateway.deps(), withBudget(1_000_000), "test");
			await eventually(
				async () =>
					(
						await query(
							`select 1 from agent_runs r join events e on e.id = r.trigger_event_id
							  where e.external_id = $1 and r.status = 'succeeded'`,
							[event.id],
						)
					).length > 0,
				30_000,
				"the deferred work, run once the limit was raised",
			);
		} finally {
			if (!workerUp) {
				await gateway.startWorker();
			}
			await applyConfig(gateway.deps(), config, "test");
		}
	});

	it("holds every agent over the global budget", async () => {
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
						budgets: { global_daily: { cost_usd: 1 }, unmetered: "allow" },
					},
				},
			},
			"test",
		);
		const [run] = await query<{ id: string }>(
			"select id from agent_runs order by queued_at desc limit 1",
		);
		const day = new Date().toISOString().slice(0, 10);
		await gateway.pool.query(
			`insert into run_usage (run_id, attempt, agent_id, day, cost_usd, tokens, recorded_at)
			 values ($1, 98, 'finance', $2, 2, null, now())`,
			[run?.id ?? "", day],
		);
		await idle("director");
		const event = humanPost("@director status?", ["director"]);
		await ingestEvent(gateway.deps(), event);
		await eventually(
			async () =>
				(
					await query("select 1 from outbox where idempotency_key = $1", [
						`alert:budget:global:${day}`,
					])
				).length > 0,
			30_000,
			"global budget alert",
		);
		await gateway.pool.query("delete from run_usage where attempt = 98");
		await applyConfig(gateway.deps(), config, "test");
	});

	it("holds an agent over its daily budget until the limit is raised", async () => {
		await idle("research");
		const config = exampleConfig();
		const withBudget = (tokens: number) => ({
			...config,
			organization: {
				...config.organization,
				organization: {
					...config.organization.organization,
					default_limits: {
						...config.organization.organization.default_limits,
						max_runs_per_agent_per_hour: 1000,
					},
					budgets: { per_agent_daily: { tokens }, unmetered: "allow" as const },
				},
			},
		});
		await applyConfig(gateway.deps(), withBudget(1000), "test");
		// Usage booked earlier today (on any run) that spends the agent's limit.
		const [run] = await query<{ id: string }>(
			"select id from agent_runs order by queued_at desc limit 1",
		);
		if (run === undefined) {
			throw new Error("no run yet");
		}
		const day = new Date().toISOString().slice(0, 10);
		await gateway.pool.query(
			`insert into run_usage (run_id, attempt, agent_id, day, cost_usd, tokens, recorded_at)
			 values ($1, 99, 'research', $2, null, 5000, now())`,
			[run.id, day],
		);
		const event = humanPost("@research look this up", ["research"]);
		await ingestEvent(gateway.deps(), event);
		await eventually(
			async () =>
				(
					await query("select 1 from outbox where idempotency_key = $1", [
						`alert:budget:agent:research:${day}`,
					])
				).length > 0,
			30_000,
			"budget alert",
		);
		expect(
			await query(
				"select 1 from agent_runs r join events e on e.id = r.trigger_event_id where e.external_id = $1",
				[event.id],
			),
		).toEqual([]);
		// Raising the limit releases the held work.
		await applyConfig(gateway.deps(), withBudget(1_000_000), "test");
		await eventually(
			async () =>
				(
					await query(
						"select 1 from agent_runs r join events e on e.id = r.trigger_event_id where e.external_id = $1 and r.status = 'succeeded'",
						[event.id],
					)
				).length > 0,
			30_000,
			"run after the limit was raised",
		);
		// Every attempt books its usage in the ledger.
		const booked = await query(
			"select 1 from run_usage u join agent_runs r on r.id = u.run_id join events e on e.id = r.trigger_event_id where e.external_id = $1",
			[event.id],
		);
		expect(booked).toHaveLength(1);
	});
});
