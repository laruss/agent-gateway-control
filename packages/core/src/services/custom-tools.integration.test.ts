import type {
	ActionParam,
	AgentConfig,
	CustomHttpsDefinition,
	OrganizationConfig,
} from "@agent-gateway/contracts";
import {
	AgentConfigSchema,
	CUSTOM_DEFINITION_VERSION_PARAM,
	OrganizationConfigSchema,
} from "@agent-gateway/contracts";
import { createPool, migrateSchema } from "@agent-gateway/db";
import { DEVELOPMENT_VERSION, silentLogger } from "@agent-gateway/logging";
import { createBoss, migrateQueues, transactionalJobSink } from "@agent-gateway/queue";
import { startTestPostgres, type TestPostgres } from "@agent-gateway/testkit";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyConfig, inTransaction } from "./admin.ts";
import { customGrantTimeIssues, prepareCustomApprovalDraft } from "./custom-tools.ts";
import type { ControlPlaneDeps } from "./deps.ts";
import { createCustomHttpsTool, ensureToolCatalogSeeded } from "./tool-catalog.ts";

/**
 * `prepareCustomApprovalDraft`/`customGrantTimeIssues` against a real, migrated database: the
 * version-pinning machinery ADR-027 describes (a `needs_human` draft naming a `custom_https`
 * action gets exactly one controller-added `custom_tool_definition_version` parameter, and a
 * grant re-checks it against the entry's current version). Two regressions this covers that a
 * pure-function test of `customToolParamIssues`/`resolveCustomHttpRequest` alone cannot: a
 * parameterless definition (a fixed `GET` with only a secret) must still be approvable at all,
 * and a model-supplied copy of the reserved parameter must never survive alongside the
 * controller's own.
 */

function organization(): OrganizationConfig {
	return OrganizationConfigSchema.parse({
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
		},
		mattermost: {
			team: "lab",
			channels: ["hq"],
			approvals_channel: "hq",
			alerts_channel: "hq",
			listener: {
				username: "gateway-listener",
				token_secret_file: "/run/secrets/mm_listener_token",
			},
		},
	});
}

function financeAgent(): AgentConfig {
	return AgentConfigSchema.parse({
		schema_version: 1,
		id: "finance",
		display_name: "finance",
		enabled: true,
		mattermost: { username: "finance", token_secret_file: "/run/secrets/mm_finance_token" },
		runtime: { adapter: "mock", session_policy: "stateless", timeout_seconds: 60 },
		prompts: { role_file: "prompts/finance.md" },
		wake_rules: [],
		concurrency: { while_running: "enqueue" },
		permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: [] },
		memory: { private_namespace: "agents/finance", shared_namespaces: [] },
	});
}

/** A fixed `GET` whose only moving part is a secret the runner alone resolves — no parameters of
 * its own at all (item 14's own example). */
function parameterlessDefinition(): CustomHttpsDefinition {
	return {
		host: "api.example.com",
		pathTemplate: "/status",
		method: "GET",
		parameters: [],
		secretSlots: [{ alias: "status_api_key", slot: "header", slotName: "x-api-key" }],
		idempotency: null,
		responseLimits: {
			maxResponseBytes: 65_536,
			allowedContentTypes: ["application/json"],
			timeoutMs: 5000,
			includeBodyPreview: true,
		},
	};
}

describe("prepareCustomApprovalDraft / customGrantTimeIssues (ADR-027)", () => {
	let postgres: TestPostgres;
	let pool: pg.Pool;
	let boss: Awaited<ReturnType<typeof createBoss>>;
	let deps: ControlPlaneDeps;

	beforeAll(async () => {
		postgres = await startTestPostgres();
		pool = createPool(postgres.connectionString, 4);
		await migrateSchema({
			pool,
			connectionString: postgres.connectionString,
			release: DEVELOPMENT_VERSION,
			migrateQueues: () => migrateQueues(postgres.connectionString),
		});
		boss = createBoss(postgres.connectionString, "client");
		await boss.start();
		deps = {
			pool,
			jobs: (tx) => transactionalJobSink(boss, tx.client),
			clock: () => new Date(),
			random: Math.random,
			log: silentLogger,
		};
		await applyConfig(
			deps,
			{
				organization: organization(),
				agents: [financeAgent()],
				constitution: "Be helpful.",
				rolePrompts: { finance: "Role prompt." },
			},
			"test",
		);
		await ensureToolCatalogSeeded(deps, "test");
	});

	afterAll(async () => {
		await boss?.stop({ graceful: false });
		await pool?.end();
		await postgres?.stop();
	});

	async function createEntry(entryId: string, definition: CustomHttpsDefinition): Promise<void> {
		await createCustomHttpsTool(deps, {
			entryId,
			name: "Test tool",
			description: "A test custom HTTPS tool.",
			httpsDefinition: definition,
			actor: "test",
		});
	}

	it("allows a parameterless custom_https draft (a fixed GET with only a secret)", async () => {
		await createEntry("status-check", parameterlessDefinition());
		const result = await inTransaction(deps, (uow) =>
			prepareCustomApprovalDraft(uow.tx.db, {
				actionType: "custom.status-check",
				actionParams: [],
				actionSummary: "Checks the status endpoint.",
			}),
		);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") {
			return;
		}
		// Exactly the controller's own version parameter — nothing else, and the draft is still
		// grantable (the same check a grant re-runs live).
		expect(result.draft.actionParams).toEqual([
			{ name: CUSTOM_DEFINITION_VERSION_PARAM, value: "1" },
		]);
		const issues = await inTransaction(deps, (uow) =>
			customGrantTimeIssues(uow.tx.db, {
				actionType: "custom.status-check",
				actionParams: result.draft.actionParams,
			}),
		);
		expect(issues).toEqual([]);
	});

	it("strips a model-supplied definition-version parameter, keeping exactly one — the controller's own", async () => {
		await createEntry(
			"ticket-tool",
			parameterlessDefinition(), // host/secret details do not matter for this check
		);
		const forged: ActionParam[] = [
			// A model (or a forged draft) naming the reserved parameter itself, with a value this
			// call must never trust.
			{ name: CUSTOM_DEFINITION_VERSION_PARAM, value: "999" },
		];
		const result = await inTransaction(deps, (uow) =>
			prepareCustomApprovalDraft(uow.tx.db, {
				actionType: "custom.ticket-tool",
				actionParams: forged,
				actionSummary: "Attempts to forge the pinned version.",
			}),
		);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") {
			return;
		}
		const versionParams = result.draft.actionParams.filter(
			(param) => param.name === CUSTOM_DEFINITION_VERSION_PARAM,
		);
		// Exactly one copy, and it is the real current version — never the model's forged one, and
		// never two entries a later `.find()` could pick either of.
		expect(versionParams).toHaveLength(1);
		expect(versionParams[0]?.value).toBe("1");
		expect(versionParams[0]?.value).not.toBe("999");
	});

	it("refuses a draft naming an entry that does not exist, unaffected by the above", async () => {
		const result = await inTransaction(deps, (uow) =>
			prepareCustomApprovalDraft(uow.tx.db, {
				actionType: "custom.does-not-exist",
				actionParams: [],
				actionSummary: "x",
			}),
		);
		expect(result.kind).toBe("refused");
	});
});
