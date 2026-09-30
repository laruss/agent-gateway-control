import type {
	AgentConfig,
	AgentPermissions,
	OrganizationConfig,
	SystemStatus,
} from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import type { ChannelAccess } from "./channel-access.ts";
import { CHANNEL, postEvent } from "./test-events.ts";
import { type AgentRecord, buildTurnContext, type TurnContextSources } from "./turn-context.ts";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const RUN_ID = "0b6f5d8e-3f1c-4c2a-9a57-6f1d2c3b4a5e";

function organization(): OrganizationConfig {
	return {
		schema_version: 1,
		organization: {
			id: "lab",
			display_name: "Lab",
			global_goal: "goal",
			constitution_file: "prompts/constitution.md",
			owner_mattermost_usernames: ["owner"],
			finance_agent_id: "finance",
			rules: [],
			default_limits: {
				max_agent_hops: 8,
				max_turns_per_cascade: 20,
				max_runs_per_agent_per_hour: 30,
				default_run_timeout_seconds: 1800,
			},
			retention: {
				event_content_days: 30,
				run_content_days: 30,
				outbox_sent_days: 8,
				outbox_dead_days: 30,
				policy_input_days: 30,
				thread_summary_days: 90,
				inactive_memory_days: 30,
				usage_days: 400,
			},
		},
		mattermost: {
			team: "lab",
			channels: ["hq"],
			approvals_channel: "hq",
			alerts_channel: "hq",
			listener: {
				username: "gateway-listener",
				token_secret_file: "/run/secrets/mm_gateway_listener_token",
			},
		},
	};
}

function agentConfig(id: string, permissions: Partial<AgentPermissions> = {}): AgentConfig {
	return {
		schema_version: 1,
		id,
		display_name: id,
		enabled: true,
		mattermost: {
			username: id,
			token_secret_file: `/run/secrets/mm_${id}_token`,
			allowed_channels: ["hq"],
		},
		runtime: {
			adapter: "mock",
			profile: "default",
			session_policy: "stateless",
			timeout_seconds: 60,
		},
		prompts: { role_file: `prompts/${id}.md` },
		wake_rules: [],
		concurrency: { max_active_runs: 1, while_running: "enqueue" },
		permissions: {
			tools_allow: [],
			tools_require_human_approval: [],
			tools_deny: [],
			...permissions,
		},
		memory: { private_namespace: `agents/${id}`, shared_namespaces: [] },
	};
}

function agentRecord(id: string, permissions: Partial<AgentPermissions> = {}): AgentRecord {
	return {
		id,
		displayName: id,
		state: "idle",
		config: agentConfig(id, permissions),
		rolePrompt: `You are ${id}.`,
		configVersion: "v1",
	};
}

const ACCESS: ChannelAccess = { named: new Map([["hq", CHANNEL]]), granted: new Map() };

/** A minimal but schema-valid `SystemStatus` (ADR-023): every list defaults to none. */
function status(overrides: Partial<SystemStatus> = {}): SystemStatus {
	return {
		asOf: NOW.toISOString(),
		killSwitch: false,
		agents: [],
		omittedAgents: 0,
		runtimes: [],
		queues: [],
		outbox: { pending: 0, dead: 0 },
		approvalsPending: 0,
		toolActionsUnknown: 0,
		alerts: [],
		maintenance: [],
		...overrides,
	};
}

function sources(overrides: Partial<TurnContextSources> = {}): TurnContextSources {
	const agent = agentRecord("developer");
	return {
		runId: RUN_ID,
		agent,
		organization: organization(),
		constitution: "Be helpful.",
		agents: [agent],
		access: ACCESS,
		trigger: postEvent(),
		pendingInbox: [],
		previousRun: null,
		resolvedWaits: [],
		threadContext: null,
		memories: [],
		waitableUserIds: [],
		systemStatus: null,
		now: NOW,
		...overrides,
	};
}

describe("buildTurnContext and the system status (ADR-023)", () => {
	it("builds a version 1 input with no systemStatus for an ordinary agent", () => {
		const result = buildTurnContext(sources());
		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error(result.reason);
		}
		expect(result.context.input.schemaVersion).toBe(1);
		expect(result.context.input.systemStatus).toBeUndefined();
	});

	it("builds a version 2 input carrying the given status for an observing agent", () => {
		const operator = agentRecord("operator", { observe_system: true });
		const given = status({ killSwitch: true });
		const result = buildTurnContext(
			sources({ agent: operator, agents: [operator], systemStatus: given }),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error(result.reason);
		}
		expect(result.context.input.schemaVersion).toBe(2);
		expect(result.context.input.systemStatus).toEqual(given);
	});

	it("refuses rather than silently downgrading when an observing agent is handed no status", () => {
		const operator = agentRecord("operator", { observe_system: true });
		const result = buildTurnContext(
			sources({ agent: operator, agents: [operator], systemStatus: null }),
		);
		expect(result).toMatchObject({ ok: false });
	});

	it("refuses rather than silently attaching a status to a non-observing agent", () => {
		const result = buildTurnContext(sources({ systemStatus: status() }));
		expect(result).toMatchObject({ ok: false });
	});

	it("the status enlarges the serialized turn input, never shrinks it away", () => {
		const operator = agentRecord("operator", { observe_system: true });
		const given = status({
			agents: [
				{
					agentId: "developer",
					state: "idle",
					enabled: true,
					stateSince: NOW.toISOString(),
					runtimeAdapter: "mock",
					model: null,
					activeRuns: [],
					lastRun: null,
					activeWaits: 0,
					nextWaitTimeoutAt: null,
					pendingInbox: 0,
					tokensToday: 0,
					costTodayUsd: 0,
				},
			],
		});
		const v1 = buildTurnContext(sources());
		const v2 = buildTurnContext(
			sources({ agent: operator, agents: [operator], systemStatus: given }),
		);
		if (!v1.ok || !v2.ok) {
			throw new Error("expected both turn contexts to build");
		}
		const v1Bytes = Buffer.byteLength(JSON.stringify(v1.context.input), "utf8");
		const v2Bytes = Buffer.byteLength(JSON.stringify(v2.context.input), "utf8");
		expect(v2Bytes).toBeGreaterThan(v1Bytes);
	});
});
