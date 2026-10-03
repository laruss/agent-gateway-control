import type { AgentConfig, OrganizationConfig } from "@agent-gateway/contracts";
import { AgentConfigSchema, OrganizationConfigSchema } from "@agent-gateway/contracts";
import { createPool, migrateSchema } from "@agent-gateway/db";
import { DEVELOPMENT_VERSION, silentLogger } from "@agent-gateway/logging";
import { createBoss, migrateQueues, transactionalJobSink } from "@agent-gateway/queue";
import { startTestPostgres, type TestPostgres } from "@agent-gateway/testkit";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyConfig, inTransaction } from "./admin.ts";
import type { ControlPlaneDeps } from "./deps.ts";
import { loadEffectivePermissionsIn } from "./effective-permissions.ts";
import {
	activeConfigRevisionId,
	commitChange,
	loadActiveBundle,
	ManagementConflictError,
} from "./management.ts";
import { loadAgents } from "./store.ts";
import {
	adoptAgentToolAttachments,
	attachTool,
	detachTool,
	ensureToolCatalogSeeded,
	updateAttachment,
} from "./tool-catalog.ts";

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

/** `organization()`, naming a different finance agent — every non-finance agent must explicitly
 * deny `finance.*` (`config-bundle.ts`'s own `financeIssues`), which always resolves to the two
 * seeded finance executor entries; the *finance* agent itself has no such requirement, so it is the
 * only agent whose legacy conversion can ever resolve to truly zero attachments. */
function organizationWithFinanceAgent(financeAgentId: string): OrganizationConfig {
	const base = organization();
	return { ...base, organization: { ...base.organization, finance_agent_id: financeAgentId } };
}

function agent(id: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return AgentConfigSchema.parse({
		schema_version: 1,
		id,
		display_name: id,
		enabled: true,
		mattermost: { username: id, token_secret_file: `/run/secrets/mm_${id}_token` },
		runtime: { adapter: "mock", session_policy: "stateless", timeout_seconds: 60 },
		prompts: { role_file: `prompts/${id}.md` },
		wake_rules: [],
		concurrency: { while_running: "enqueue" },
		permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: ["finance.*"] },
		memory: { private_namespace: `agents/${id}`, shared_namespaces: [] },
		...overrides,
	});
}

/**
 * ADR-027's compiler, as a source of truth for enforcement: a dedicated, isolated database (not
 * `tool-catalog.integration.test.ts`'s shared one, whose own tests permanently tombstone several
 * built-ins across the whole file) so every test here can attach, detach and disable any built-in
 * freely.
 */
describe("effective permissions: compiled attachments as the single source of truth (ADR-027)", () => {
	let postgres: TestPostgres;
	let pool: pg.Pool;
	let boss: Awaited<ReturnType<typeof createBoss>>;
	let deps: ControlPlaneDeps;

	beforeAll(async () => {
		postgres = await startTestPostgres();
		pool = createPool(postgres.connectionString, 8);
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
	});

	afterAll(async () => {
		await boss?.stop({ graceful: false });
		await pool?.end();
		await postgres?.stop();
	});

	/** Catalog tables are never truncated: built-in ids are stable and idempotently reseeded, and
	 * `catalog_entry_versions`/`config_attachment_snapshots` refuse truncation outright (append-only
	 * guard triggers, migrations 0029/0031) — exactly as production never resets them either.
	 * Truncating `agents` still clears `catalog_attachments` (its own FK cascades), so a stale
	 * attachment from an earlier test never leaks into the next one's assertions. */
	async function reset(): Promise<void> {
		await pool.query(
			"truncate agent_lifecycle_operations, agent_lifecycle, agent_runs, agent_inbox, mattermost_identities, agents, config_versions, gateway_controls, runtime_workers, runtime_availability restart identity cascade",
		);
		const configured = [
			agent("finance"),
			agent("alpha"),
			agent("beta", {
				permissions: {
					tools_allow: [],
					tools_require_human_approval: [],
					tools_deny: ["finance.*", "memory.write"],
				},
			}),
		];
		await applyConfig(
			deps,
			{
				organization: organization(),
				agents: configured,
				constitution: "Be helpful.",
				rolePrompts: Object.fromEntries(configured.map((a) => [a.id, `Role prompt for ${a.id}.`])),
			},
			"test",
		);
		await ensureToolCatalogSeeded(deps, "test");
	}

	beforeEach(async () => {
		await reset();
	});

	async function effectiveFor(agentId: string) {
		const record = (await inTransaction(deps, ({ tx }) => loadAgents(tx.db))).find(
			(a) => a.id === agentId,
		);
		if (record === undefined) {
			throw new Error(`agent '${agentId}' does not exist`);
		}
		return inTransaction(deps, ({ tx }) => loadEffectivePermissionsIn(tx, record, "finance"));
	}

	it("attach allow -> permitted; disabled -> denied", async () => {
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "native-web-search",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "console",
		});
		const allowed = await effectiveFor("alpha");
		expect(allowed.hubManaged).toBe(true);
		expect(allowed.toolPolicy.allow).toContain("web.search");

		await updateAttachment(deps, {
			agentId: "alpha",
			entryId: "native-web-search",
			mode: "disabled",
			actor: "test",
			source: "console",
		});
		const disabled = await effectiveFor("alpha");
		expect(disabled.toolPolicy.allow).not.toContain("web.search");
		expect(disabled.toolPolicy.deny).toContain("web.search");
	});

	it("a broker action (executor) needs approval once attached, and is refused as an 'allow'", async () => {
		await expect(
			attachTool(deps, {
				agentId: "finance",
				entryId: "executor-finance-payment-create",
				pinnedVersion: null,
				mode: "allow",
				settings: {},
				actor: "test",
				source: "console",
			}),
		).rejects.toThrow(/requires at least 'require_approval'/);
		await attachTool(deps, {
			agentId: "finance",
			entryId: "executor-finance-payment-create",
			pinnedVersion: null,
			mode: "require_approval",
			settings: {},
			actor: "test",
			source: "console",
		});
		const effective = await effectiveFor("finance");
		expect(effective.toolPolicy.requireHumanApproval).toContain("finance.payment.create");
		expect(effective.toolPolicy.allow).not.toContain("finance.payment.create");
	});

	it("tests.run implies repository.read and workspace.write, in both the compiled result and the mirrored bundle permissions", async () => {
		const commit = await attachTool(deps, {
			agentId: "alpha",
			entryId: "native-tests-run",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "console",
		});
		const effective = await effectiveFor("alpha");
		expect(effective.toolPolicy.allow.slice().sort()).toEqual(
			["repository.read", "tests.run", "workspace.write"].sort(),
		);

		// The bundle-mirror invariant: `permissions` equals the compiled result of this very
		// revision's attachments, so an older release enforces the same thing after a rollback.
		const { bundle } = await inTransaction(deps, ({ tx }) =>
			loadActiveBundle(tx.db, commit.revisionId),
		);
		const mirrored = bundle.agents.find((a) => a.id === "alpha")?.permissions;
		expect(mirrored?.tools_allow.slice().sort()).toEqual(
			["repository.read", "tests.run", "workspace.write"].sort(),
		);
		expect(mirrored?.tools_deny).toContain("finance.*");
		expect(mirrored?.tools_deny).toContain("memory.write");

		const [row] = (
			await pool.query<{ config: { permissions: AgentConfig["permissions"] } }>(
				"select config from agents where id = 'alpha'",
			)
		).rows;
		expect(row?.config.permissions).toEqual(mirrored);
	});

	it("an adapter-specific prerequisite (Codex: repository.read needs tests.run) is surfaced, not silently granted or revoked", async () => {
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "native-repository-read",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "console",
		});
		const mockAdapter = await effectiveFor("alpha");
		expect(mockAdapter.toolPolicy.allow).toContain("repository.read");

		await applyConfig(
			deps,
			{
				organization: organization(),
				agents: [
					agent("finance"),
					agent("alpha", {
						runtime: {
							adapter: "codex",
							profile: "default",
							session_policy: "stateless",
							timeout_seconds: 60,
						},
					}),
					agent("beta"),
				],
				constitution: "Be helpful.",
				rolePrompts: { finance: "x", alpha: "x", beta: "x" },
			},
			"test",
		);
		const codexAgent = await effectiveFor("alpha");
		// Still granted — the adapter itself (not this compiler) is what makes it inert for Codex.
		expect(codexAgent.toolPolicy.allow).toContain("repository.read");
	});

	it("detaching memory.write (or never attaching it) removes implicit memory authority", async () => {
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "gateway-mattermost-post",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "console",
		});
		const neverAttached = await effectiveFor("alpha");
		expect(neverAttached.hubManaged).toBe(true);
		expect(neverAttached.memoryWriteAllowed).toBe(false);
		expect(neverAttached.toolPolicy.deny).toContain("memory.write");

		await attachTool(deps, {
			agentId: "alpha",
			entryId: "gateway-memory-write",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "console",
		});
		expect((await effectiveFor("alpha")).memoryWriteAllowed).toBe(true);

		await detachTool(deps, {
			agentId: "alpha",
			entryId: "gateway-memory-write",
			actor: "test",
			source: "console",
		});
		expect((await effectiveFor("alpha")).memoryWriteAllowed).toBe(false);
	});

	it("a finance executor attached to a non-finance agent grants nothing at all", async () => {
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "executor-finance-payment-create",
			pinnedVersion: null,
			mode: "require_approval",
			settings: {},
			actor: "test",
			source: "console",
		});
		const effective = await effectiveFor("alpha");
		expect(effective.toolPolicy.requireHumanApproval).not.toContain("finance.payment.create");
		expect(effective.toolPolicy.allow).not.toContain("finance.payment.create");
	});

	it("a legacy agent's effective permissions are exactly its permissions lists, unchanged", async () => {
		const effective = await effectiveFor("beta");
		expect(effective.hubManaged).toBe(false);
		expect(effective.toolPolicy).toEqual({
			allow: [],
			requireHumanApproval: [],
			deny: ["finance.*", "memory.write"],
		});
	});

	describe("gateway tools adopt: explicit migration", () => {
		it("dry-run previews unresolved patterns and the before/after effective permissions without committing", async () => {
			const [result] = await adoptAgentToolAttachments(deps, {
				agentIds: ["beta"],
				dryRun: true,
				actor: "test",
			});
			expect(result).toMatchObject({ agentId: "beta", alreadyHubManaged: false, commit: null });
			expect(result?.before).toEqual({
				tools_allow: [],
				tools_require_human_approval: [],
				tools_deny: ["finance.*", "memory.write"],
			});
			expect(result?.unresolved).toEqual([]);
			expect((await effectiveFor("beta")).hubManaged).toBe(false);
		});

		it("committing produces identical effective permissions for an agent whose patterns all resolve, and is a no-op the second time", async () => {
			const [committed] = await adoptAgentToolAttachments(deps, {
				agentIds: ["beta"],
				dryRun: false,
				actor: "test",
			});
			expect(committed?.commit).not.toBeNull();
			expect(committed?.before).toEqual(committed?.after);
			expect((await effectiveFor("beta")).hubManaged).toBe(true);

			const [again] = await adoptAgentToolAttachments(deps, {
				agentIds: ["beta"],
				dryRun: false,
				actor: "test",
			});
			expect(again).toMatchObject({ alreadyHubManaged: true, commit: null });
			expect(again?.before).toEqual(again?.after);
		});

		it("an agent that never explicitly denied memory.write gains an explicit denial once adopted (a safe narrowing, visible before committing)", async () => {
			const [result] = await adoptAgentToolAttachments(deps, {
				agentIds: ["alpha"],
				dryRun: true,
				actor: "test",
			});
			expect(result?.before.tools_deny).not.toContain("memory.write");
			expect(result?.after.tools_deny).toContain("memory.write");
		});

		it("--all adopts every currently legacy agent, one revision each", async () => {
			const results = await adoptAgentToolAttachments(deps, {
				agentIds: ["alpha", "beta", "finance"],
				dryRun: false,
				actor: "test",
			});
			expect(results.every((r) => r.commit !== null || r.alreadyHubManaged)).toBe(true);
		});

		/** The *finance* agent is the only one a bare `permissions` list can ever resolve to zero
		 * attachments for (see `organizationWithFinanceAgent`): every other agent's own forced
		 * `finance.*` deny always resolves to the two seeded finance entries. */
		async function resetWithEmptyFinanceAgent(): Promise<void> {
			await applyConfig(
				deps,
				{
					organization: organizationWithFinanceAgent("gamma"),
					agents: [
						agent("gamma", {
							permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: [] },
						}),
					],
					constitution: "Be helpful.",
					rolePrompts: { gamma: "Role prompt for gamma." },
				},
				"test",
			);
		}

		async function effectiveForGamma() {
			const record = (await inTransaction(deps, ({ tx }) => loadAgents(tx.db))).find(
				(a) => a.id === "gamma",
			);
			if (record === undefined) {
				throw new Error("agent 'gamma' does not exist");
			}
			return inTransaction(deps, ({ tx }) => loadEffectivePermissionsIn(tx, record, "gamma"));
		}

		it("adopts an agent whose legacy permissions resolve to zero attachments, marking it hub-managed with an explicitly empty list", async () => {
			await resetWithEmptyFinanceAgent();
			const [result] = await adoptAgentToolAttachments(deps, {
				agentIds: ["gamma"],
				dryRun: false,
				actor: "test",
			});
			expect(result).toMatchObject({ agentId: "gamma", alreadyHubManaged: false });
			expect(result?.attachments).toEqual([]);
			expect(result?.unresolved).toEqual([]);
			expect(result?.commit).not.toBeNull();
			const effective = await effectiveForGamma();
			expect(effective.hubManaged).toBe(true);
			expect(effective.toolPolicy).toEqual({
				allow: [],
				requireHumanApproval: [],
				deny: ["memory.write"],
			});

			// Idempotent: adopting it again is a no-op, same as any other already hub-managed agent.
			const [again] = await adoptAgentToolAttachments(deps, {
				agentIds: ["gamma"],
				dryRun: false,
				actor: "test",
			});
			expect(again).toMatchObject({ alreadyHubManaged: true, commit: null });
		});

		it("dry-run previews the zero-attachments case too, without committing", async () => {
			await resetWithEmptyFinanceAgent();
			const [result] = await adoptAgentToolAttachments(deps, {
				agentIds: ["gamma"],
				dryRun: true,
				actor: "test",
			});
			expect(result?.commit).toBeNull();
			expect(result?.after).toEqual({
				tools_allow: [],
				tools_require_human_approval: [],
				tools_deny: ["memory.write"],
			});
			expect((await effectiveForGamma()).hubManaged).toBe(false);
		});

		it(
			"a concurrent revoke of a resolved capability between the read and the commit is never " +
				"silently undone: the adoption conflicts, or its own read already reflects the revoke",
			async () => {
				const configured = [
					agent("finance"),
					agent("alpha", {
						permissions: {
							tools_allow: ["web.search"],
							tools_require_human_approval: [],
							tools_deny: ["finance.*"],
						},
					}),
					agent("beta"),
				];
				await applyConfig(
					deps,
					{
						organization: organization(),
						agents: configured,
						constitution: "Be helpful.",
						rolePrompts: Object.fromEntries(
							configured.map((a) => [a.id, `Role prompt for ${a.id}.`]),
						),
					},
					"test",
				);

				// The "concurrent" change: an operator's own `config apply`/console edit revokes
				// `web.search` from alpha's legacy `permissions`, directly (never through the hub —
				// alpha is not adopted yet).
				const revoke = async () => {
					const baseRevisionId = await activeConfigRevisionId(deps);
					return commitChange(deps, {
						changeSet: [
							{
								type: "update_agent",
								agent: agent("alpha", {
									permissions: {
										tools_allow: [],
										tools_require_human_approval: [],
										tools_deny: ["finance.*"],
									},
								}),
							},
						],
						baseRevisionId,
						actor: "test",
						source: "cli_apply",
					});
				};

				const [adoptOutcome, revokeOutcome] = await Promise.allSettled([
					adoptAgentToolAttachments(deps, { agentIds: ["alpha"], dryRun: false, actor: "test" }),
					revoke(),
				]);

				// Either race loser is refused as a conflict (its own base revision went stale while it
				// was still reading or about to commit) — never silently applied on top of data the
				// other side already moved past.
				for (const outcome of [adoptOutcome, revokeOutcome]) {
					if (outcome.status === "rejected") {
						expect(outcome.reason).toBeInstanceOf(ManagementConflictError);
					}
				}
				// If the adoption committed `web.search` as an `allow` attachment, that is only ever
				// legitimate when its own commit landed *before* the revoke's (so the revoke simply
				// hadn't happened yet when the adoption's read — and base revision — were taken);
				// never when the revoke's commit came first, which is exactly the bug this closes: the
				// old code could commit a changeset built from a read taken before the revoke against a
				// base revision taken after it, silently resurrecting what the revoke had just removed.
				if (adoptOutcome.status === "fulfilled" && revokeOutcome.status === "fulfilled") {
					const [adoptResult] = adoptOutcome.value;
					const adoptedWebSearch = adoptResult?.attachments.some(
						(a) => a.entryId === "native-web-search" && a.mode === "allow",
					);
					if (adoptedWebSearch === true) {
						expect(adoptResult?.commit?.revisionId ?? 0).toBeLessThan(
							revokeOutcome.value.revisionId,
						);
					}
				}
			},
		);
	});
});
