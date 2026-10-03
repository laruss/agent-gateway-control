import type {
	ActionParam,
	AgentConfig,
	AgentId,
	CustomHttpsDefinition,
	OrganizationConfig,
} from "@agent-gateway/contracts";
import {
	AgentConfigSchema,
	CUSTOM_DEFINITION_VERSION_PARAM,
	CUSTOM_REQUEST_PREVIEW_MAX,
	OrganizationConfigSchema,
} from "@agent-gateway/contracts";
import { createPool, migrateSchema } from "@agent-gateway/db";
import { DEVELOPMENT_VERSION, silentLogger } from "@agent-gateway/logging";
import { createBoss, migrateQueues, transactionalJobSink } from "@agent-gateway/queue";
import { startTestPostgres, type TestPostgres } from "@agent-gateway/testkit";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyConfig, inTransaction } from "./admin.ts";
import {
	customApprovalRequestPreview,
	customGrantTimeIssues,
	prepareCustomApprovalDraft,
} from "./custom-tools.ts";
import type { ControlPlaneDeps } from "./deps.ts";
import {
	attachTool,
	createCustomHttpsTool,
	editCatalogEntry,
	ensureToolCatalogSeeded,
} from "./tool-catalog.ts";

const FINANCE: AgentId = "finance" as AgentId;

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

/** `parameterlessDefinition`, but with `pathTemplate` as its one varying field — so publishing a
 * new version with a different path is a minimal, unambiguous way to tell "v1's content" and "v2's
 * content" apart in a test, without any typed parameter machinery getting in the way. */
function versionedDefinition(pathTemplate: string): CustomHttpsDefinition {
	return { ...parameterlessDefinition(), pathTemplate };
}

/** One string path parameter, wide enough that a CJK-heavy value (each character three UTF-8 bytes,
 * nine characters once percent-encoded) makes the resolved preview exceed 4000 characters on its
 * own — the exact shape of case the model's own `id` value, percent-encoded into the path, pushes
 * `customRequestSummary`'s rendering past `CUSTOM_REQUEST_PREVIEW_MAX`. */
function cjkPathDefinition(): CustomHttpsDefinition {
	return {
		host: "api.example.com",
		pathTemplate: "/items/{id}",
		method: "GET",
		parameters: [
			{ name: "id", slot: "path", slotName: "id", type: "string", minLength: 1, maxLength: 2000 },
		],
		secretSlots: [],
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
			prepareCustomApprovalDraft(uow.tx.db, FINANCE, {
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
			customGrantTimeIssues(uow.tx.db, FINANCE, {
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
			prepareCustomApprovalDraft(uow.tx.db, FINANCE, {
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
			prepareCustomApprovalDraft(uow.tx.db, FINANCE, {
				actionType: "custom.does-not-exist",
				actionParams: [],
				actionSummary: "x",
			}),
		);
		expect(result.kind).toBe("refused");
	});

	it("pins the approval to the agent's own attached version, unaffected by the entry moving on (pin v1 -> edit to v2 -> call -> approval/execution use v1)", async () => {
		const entryId = "versioned-tool";
		await createEntry(entryId, versionedDefinition("/v1/status"));
		await attachTool(deps, {
			agentId: FINANCE,
			entryId,
			pinnedVersion: 1,
			mode: "require_approval",
			actor: "test",
			source: "cli_apply",
		});
		// The entry moves on to v2 — a different `pathTemplate` — after the agent was pinned to v1.
		await editCatalogEntry(deps, {
			entryId,
			httpsDefinition: versionedDefinition("/v2/status"),
			actor: "test",
		});
		const result = await inTransaction(deps, (uow) =>
			prepareCustomApprovalDraft(uow.tx.db, FINANCE, {
				actionType: `custom.${entryId}`,
				actionParams: [],
				actionSummary: "Checks the versioned status endpoint.",
			}),
		);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") {
			return;
		}
		// Pinned to v1 — the agent's own attached version — never the entry's current v2.
		expect(result.draft.actionParams).toEqual([
			{ name: CUSTOM_DEFINITION_VERSION_PARAM, value: "1" },
		]);
		const preview = await inTransaction(deps, (uow) =>
			customApprovalRequestPreview(uow.tx.db, result.draft.actionType, result.draft.actionParams),
		);
		// The preview is built from v1's own definition content, not v2's.
		expect(preview.kind).toBe("ok");
		if (preview.kind === "ok") {
			expect(preview.preview).toContain("/v1/status");
			expect(preview.preview).not.toContain("/v2/status");
		}
		const issues = await inTransaction(deps, (uow) =>
			customGrantTimeIssues(uow.tx.db, FINANCE, {
				actionType: result.draft.actionType,
				actionParams: result.draft.actionParams,
			}),
		);
		// The grant succeeds against v1 — the version the agent is actually pinned to — even though
		// the entry itself is now at v2.
		expect(issues).toEqual([]);
	});

	it("refuses the grant once the entry moves on and the agent is NOT pinned (tracks current)", async () => {
		const entryId = "unpinned-tool";
		await createEntry(entryId, versionedDefinition("/v1/unpinned"));
		await attachTool(deps, {
			agentId: FINANCE,
			entryId,
			pinnedVersion: null,
			mode: "require_approval",
			actor: "test",
			source: "cli_apply",
		});
		const result = await inTransaction(deps, (uow) =>
			prepareCustomApprovalDraft(uow.tx.db, FINANCE, {
				actionType: `custom.${entryId}`,
				actionParams: [],
				actionSummary: "Checks the unpinned endpoint.",
			}),
		);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") {
			return;
		}
		expect(result.draft.actionParams).toEqual([
			{ name: CUSTOM_DEFINITION_VERSION_PARAM, value: "1" },
		]);
		// The entry moves on to v2 after the draft was prepared but before the grant: an unpinned
		// attachment always tracks current, so the stale v1 pin the stored action carries is now a
		// mismatch and the grant is refused — the same protection a pinned attachment gets from
		// `customDefinitionVersionIssues`, just triggered by the entry moving instead of by a stale
		// re-pin.
		await editCatalogEntry(deps, {
			entryId,
			httpsDefinition: versionedDefinition("/v2/unpinned"),
			actor: "test",
		});
		const issues = await inTransaction(deps, (uow) =>
			customGrantTimeIssues(uow.tx.db, FINANCE, {
				actionType: result.draft.actionType,
				actionParams: result.draft.actionParams,
			}),
		);
		expect(issues.length).toBeGreaterThan(0);
	});

	it("customApprovalRequestPreview: an authoritative, secret-free preview naming the secret slot but never a value", async () => {
		const entryId = "preview-tool";
		await createEntry(entryId, parameterlessDefinition());
		const result = await inTransaction(deps, (uow) =>
			prepareCustomApprovalDraft(uow.tx.db, FINANCE, {
				actionType: `custom.${entryId}`,
				actionParams: [],
				actionSummary: "Checks the status endpoint.",
			}),
		);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") {
			return;
		}
		const preview = await inTransaction(deps, (uow) =>
			customApprovalRequestPreview(uow.tx.db, result.draft.actionType, result.draft.actionParams),
		);
		expect(preview.kind).toBe("ok");
		if (preview.kind !== "ok") {
			return;
		}
		expect(preview.preview).toContain("GET https://api.example.com/status");
		// The secret's own slot name, marked as a secret — never a value, since none is resolved
		// until the tool runner executes.
		expect(preview.preview).toContain("x-api-key(secret)");
		expect(preview.preview).not.toMatch(/x-api-key=/);
	});

	it("customApprovalRequestPreview: 'none' for a non-custom action type", async () => {
		const preview = await inTransaction(deps, (uow) =>
			customApprovalRequestPreview(uow.tx.db, "repository.read", []),
		);
		expect(preview).toEqual({ kind: "none" });
	});

	it("customApprovalRequestPreview: a percent-encoded CJK path whose preview exceeds CUSTOM_REQUEST_PREVIEW_MAX is refused, never truncated", async () => {
		const entryId = "cjk-preview-tool";
		await createEntry(entryId, cjkPathDefinition());
		// 500 CJK characters, each 9 characters once percent-encoded (plus the fixed host/path
		// prefix), lands around 4534 characters — comfortably over the 4000-character bound on its
		// own, the exact case a long path value can create (ADR-027). The owner must always see the
		// complete request, never a cut one: this draft is refused outright, not stored with a
		// preview shorter than what would actually run.
		const result = await inTransaction(deps, (uow) =>
			prepareCustomApprovalDraft(uow.tx.db, FINANCE, {
				actionType: `custom.${entryId}`,
				actionParams: [{ name: "id", value: "中".repeat(500) }],
				actionSummary: "Looks up an item by its (very long) id.",
			}),
		);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") {
			return;
		}
		const preview = await inTransaction(deps, (uow) =>
			customApprovalRequestPreview(uow.tx.db, result.draft.actionType, result.draft.actionParams),
		);
		expect(preview.kind).toBe("refused");
		if (preview.kind !== "refused") {
			return;
		}
		expect(preview.issues.join(" ")).toMatch(/too large/);
		expect(preview.issues.join(" ")).toContain(String(CUSTOM_REQUEST_PREVIEW_MAX));
	});
});
