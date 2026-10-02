import {
	completeOperation,
	ingestEvent,
	markProvisioning,
	requestAgentCreate,
	requestAgentRetire,
	runtimeHealth,
} from "@agent-gateway/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventually, humanPost, startTestGateway, type TestGateway } from "./test-gateway.ts";

/**
 * End to end: a scheduling gate on an agent's Mattermost-provisioning status, not only its
 * configured `enabled` flag (ADR-026). Uses the same running controller, worker and mock runtime
 * every other durable-core scenario does (`startTestGateway`), so a mention really goes through
 * ingest, routing and the scheduler exactly as it would for any configured agent.
 */
describe("agent lifecycle scheduling gate (ADR-026)", () => {
	let gateway: TestGateway;

	beforeAll(async () => {
		gateway = await startTestGateway();
	});

	afterAll(async () => {
		await gateway?.stop();
	});

	const query = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
		(await gateway.pool.query<T>(text, values)).rows;

	const runsFor = (eventExternalId: string) =>
		query<{ id: string; status: string; error_code: string | null; outcome: string | null }>(
			`select r.id, r.status, r.error_code, r.outcome from agent_runs r
			   join events e on e.id = r.trigger_event_id
			  where e.external_id = $1 order by r.queued_at`,
			[eventExternalId],
		);

	const inboxStatus = (eventExternalId: string, agentId: string) =>
		query<{ status: string }>(
			`select i.status from agent_inbox i
			   join events e on e.id = i.event_id
			  where e.external_id = $1 and i.agent_id = $2`,
			[eventExternalId, agentId],
		);

	it("records a mention but does not run it while pending, then runs it once ready", async () => {
		const deps = gateway.deps();
		await eventually(
			async () =>
				(await runtimeHealth(deps)).some((h) => h.adapter === "mock" && h.available) || null,
			15_000,
			"mock runtime ready",
		);

		const agentId = "lifecycle-test";
		const created = await requestAgentCreate(deps, {
			agent: {
				id: agentId,
				display_name: "Lifecycle Test",
				mattermost: {
					username: agentId,
					token_secret_file: "/run/secrets/mm_lifecycle_test_token",
					allowed_channels: ["hq"],
				},
				runtime: { adapter: "mock", session_policy: "stateless", timeout_seconds: 20 },
				prompts: { role_file: "prompts/examples/agents/lifecycle-test.md" },
				wake_rules: [{ event_type: "mattermost.agent.mentioned", target_agent_id: agentId }],
				concurrency: { max_active_runs: 1, while_running: "enqueue" },
				permissions: {
					tools_allow: ["mattermost.post"],
					tools_require_human_approval: [],
					tools_deny: ["finance.*"],
				},
				memory: { private_namespace: `agents/${agentId}`, shared_namespaces: [] },
			},
			rolePrompt: "You are a lifecycle test agent.",
			actor: "test",
			source: "cli",
		});
		expect(created.agentId).toBe(agentId);

		// A mention is accepted and routed, but the agent is still `pending`: nothing runs.
		const mention = humanPost("hello", [agentId]);
		expect((await ingestEvent(deps, mention)).status).toBe("accepted");
		await eventually(
			async () => (await inboxStatus(mention.id, agentId))[0]?.status === "pending" || null,
			10_000,
			"mention recorded in the inbox",
		);
		// Given time to (not) run: still nothing, and still pending — a negative assertion, so a
		// fixed wait rather than `eventually` on an absence.
		await Bun.sleep(1_500);
		expect(await runsFor(mention.id)).toHaveLength(0);
		expect((await inboxStatus(mention.id, agentId))[0]?.status).toBe("pending");

		// Provisioning completes: the agent becomes `ready` and the held mention now runs.
		await markProvisioning(deps, created.operationId, "test");
		await completeOperation(deps, created.operationId, "test");

		const run = await eventually(
			async () => {
				const rows = await runsFor(mention.id);
				const last = rows.at(-1);
				return last !== undefined && last.status !== "queued" && last.status !== "running"
					? last
					: null;
			},
			15_000,
			"lifecycle-test run finished",
		);
		expect(run.status).toBe("succeeded");
	});

	it("does not run an agent once it is retiring", async () => {
		const deps = gateway.deps();
		const agentId = "lifecycle-retire";
		const created = await requestAgentCreate(deps, {
			agent: {
				id: agentId,
				display_name: "Lifecycle Retire",
				mattermost: {
					username: agentId,
					token_secret_file: "/run/secrets/mm_lifecycle_retire_token",
					allowed_channels: ["hq"],
				},
				runtime: { adapter: "mock", session_policy: "stateless", timeout_seconds: 20 },
				prompts: { role_file: "prompts/examples/agents/lifecycle-retire.md" },
				wake_rules: [{ event_type: "mattermost.agent.mentioned", target_agent_id: agentId }],
				concurrency: { max_active_runs: 1, while_running: "enqueue" },
				permissions: {
					tools_allow: ["mattermost.post"],
					tools_require_human_approval: [],
					tools_deny: ["finance.*"],
				},
				memory: { private_namespace: `agents/${agentId}`, shared_namespaces: [] },
			},
			rolePrompt: "You are a lifecycle test agent, about to be retired.",
			actor: "test",
			source: "cli",
		});
		await markProvisioning(deps, created.operationId, "test");
		await completeOperation(deps, created.operationId, "test");

		await requestAgentRetire(deps, { agentId, actor: "test", source: "cli" });

		// Retiring commits `remove_agent`, which also disables the agent's row: a mention addressed
		// to it is accepted (ingest never refuses an event over its target), but routing itself finds
		// no enabled agent to deliver it to — the same outcome a plain disable already has, which the
		// lifecycle gate (ADR-026) only adds to, never replaces.
		const mention = humanPost("hello again", [agentId]);
		expect((await ingestEvent(deps, mention)).status).toBe("accepted");
		await Bun.sleep(1_500);
		expect(await runsFor(mention.id)).toHaveLength(0);
	});
});
