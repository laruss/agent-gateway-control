import type { JsonValue } from "@agent-gateway/contracts";
import {
	adoptAgentToolAttachments,
	attachTool,
	detachTool,
	ingestEvent,
} from "@agent-gateway/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventually, humanPost, startTestGateway, type TestGateway } from "./test-gateway.ts";

/**
 * End-to-end enforcement of compiled attachments (ADR-027), through the real scheduler, a real
 * mock-runtime turn and the real approval machinery — not only the direct-function coverage in
 * `packages/core/src/services/effective-permissions.integration.test.ts`.
 */
describe("tool catalog enforcement, end to end (ADR-027)", () => {
	let gateway: TestGateway;

	beforeAll(async () => {
		gateway = await startTestGateway();
	});

	afterAll(async () => {
		await gateway?.stop();
	});

	type Row = Record<string, JsonValue>;
	const query = async <T extends Row>(text: string, values: Readonly<(string | number)[]> = []) =>
		(await gateway.pool.query<T>(text, [...values])).rows;

	const agentState = async (id: string) =>
		(await query<{ state: string }>("select state from agents where id = $1", [id]))[0]?.state;

	const idle = (agentId: string) =>
		eventually(async () => (await agentState(agentId)) === "idle", 30_000, `${agentId} idle`);

	const runsFor = (eventExternalId: string) =>
		query<{ id: string; status: string; outcome: string | null; error_code: string | null }>(
			`select r.id, r.status, r.outcome, r.error_code
			   from agent_runs r join events e on e.id = r.trigger_event_id
			  where e.external_id = $1 order by r.queued_at`,
			[eventExternalId],
		);

	const finishedRun = (eventExternalId: string, what: string) =>
		eventually(
			async () => {
				const runs = await runsFor(eventExternalId);
				const last = runs.at(-1);
				return last !== undefined && last.status !== "queued" && last.status !== "running"
					? last
					: null;
			},
			30_000,
			what,
		);

	it("a broker action needs approval once attached; detaching it revokes the still-pending approval, with an audit entry", async () => {
		// `finance`'s own example permissions carry patterns (`deploy.*`, `mail.*`) no catalog entry
		// resolves yet; adopting it first (the explicit, reviewed path, which already tolerates an
		// unresolved pattern by dropping and reporting it) makes it hub-managed before the first
		// `attachTool` call below, which would otherwise refuse to auto-convert an unresolved
		// pattern on its own (ADR-027).
		await adoptAgentToolAttachments(gateway.deps(), {
			agentIds: ["finance"],
			dryRun: false,
			actor: "test",
		});
		// `mattermost.post` too: the mock runtime's own reply once the wait resumes (after the
		// approval is cancelled) needs it, same as any other turn.
		await attachTool(gateway.deps(), {
			agentId: "finance",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "console",
		});
		await attachTool(gateway.deps(), {
			agentId: "finance",
			entryId: "executor-finance-payment-create",
			pinnedVersion: null,
			mode: "require_approval",
			settings: {},
			actor: "test",
			source: "console",
		});

		const event = humanPost("@finance pay it [mock:approval finance.payment.create]", ["finance"]);
		await ingestEvent(gateway.deps(), event);
		const run = await finishedRun(event.id, "finance approval run");
		expect(run).toMatchObject({ status: "succeeded", outcome: "needs_human" });
		await eventually(async () => (await agentState("finance")) === "waiting", 30_000, "waiting");

		const [approval] = await query<{ id: string; status: string }>(
			"select id, status from approval_requests where run_id = $1",
			[run.id],
		);
		expect(approval?.status).toBe("pending");

		await detachTool(gateway.deps(), {
			agentId: "finance",
			entryId: "executor-finance-payment-create",
			actor: "test",
			source: "console",
		});

		await eventually(
			async () =>
				(
					await query<{ status: string }>("select status from approval_requests where id = $1", [
						approval?.id ?? "",
					])
				)[0]?.status === "cancelled",
			30_000,
			"approval cancelled after detach",
		);
		const [audited] = await query<{ detail: { approval_ids: string[] } }>(
			"select detail from audit_log where action = 'approvals.revoked' order by id desc limit 1",
		);
		expect(audited?.detail.approval_ids).toContain(approval?.id);

		// The agent's own wait resolves once `sweepApprovals` notices and emits `approval.resolved`,
		// and its resumed turn (a plain reply) completes normally.
		await idle("finance");
	});

	it("detaching memory.write (never attaching it at all) leaves no writable namespace: a memory proposal is rejected by the turn's own authority", async () => {
		// Same as above: `research`'s own example permissions carry unresolved patterns
		// (`deploy.*`, `mail.*`), so it is adopted first to make it hub-managed before the first
		// `attachTool` call below.
		await adoptAgentToolAttachments(gateway.deps(), {
			agentIds: ["research"],
			dryRun: false,
			actor: "test",
		});
		await attachTool(gateway.deps(), {
			agentId: "research",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "console",
		});

		const event = humanPost("@research [mock:remember]", ["research"]);
		await ingestEvent(gateway.deps(), event);
		const run = await finishedRun(event.id, "research remember run");
		expect(run).toMatchObject({ status: "failed", error_code: "invalid_output" });
		// A non-retryable authority failure moves the agent to `failed`, not back to `idle`
		// (matching `operator-turns.integration.test.ts`'s own such runs).
		await eventually(async () => (await agentState("research")) === "failed", 30_000, "failed");

		// No memory item was ever accepted for this run's proposal.
		const [accepted] = await query<{ n: string }>(
			"select count(*)::text as n from memory_items where source_run_id = $1",
			[run.id],
		);
		expect(accepted?.n).toBe("0");
	});
});
