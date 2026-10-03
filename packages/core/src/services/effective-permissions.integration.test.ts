import type {
	AgentConfig,
	CustomHttpsDefinition,
	OrganizationConfig,
} from "@agent-gateway/contracts";
import {
	AgentConfigSchema,
	CONFIG_SNAPSHOT_FORMAT,
	MAX_CAPABILITIES,
	OrganizationConfigSchema,
} from "@agent-gateway/contracts";
import { createPool, migrateSchema } from "@agent-gateway/db";
import { canonicalHash } from "@agent-gateway/events";
import { DEVELOPMENT_VERSION, silentLogger } from "@agent-gateway/logging";
import { createBoss, migrateQueues, transactionalJobSink } from "@agent-gateway/queue";
import { startTestPostgres, type TestPostgres } from "@agent-gateway/testkit";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_TURN_INPUT_BYTES } from "../turn-context.ts";
import {
	applyConfig,
	configSnapshotBundle,
	ensureToolAttachmentsReconciled,
	inTransaction,
} from "./admin.ts";
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
	createCustomHttpsTool,
	deleteCatalogEntry,
	detachTool,
	editCatalogEntry,
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
		expect(mockAdapter.missingPrerequisites).toEqual({});

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
		expect(codexAgent.missingPrerequisites).toEqual({ "repository.read": ["tests.run"] });
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

	it("bounds capability descriptions to MAX_CAPABILITIES, reporting the rest omitted rather than failing the turn", async () => {
		// `beta`'s own `tools_allow: ["custom.*"]` resolves against every one of these 129
		// `custom_https` entries (ADR-027's own legacy conversion, `legacyAttachmentsFromPermissions`)
		// — one more than `MAX_CAPABILITIES`, which a version 3 turn input's own schema bounds.
		const definition: CustomHttpsDefinition = {
			host: "api.example.test",
			pathTemplate: "/items",
			method: "GET",
			parameters: [],
			secretSlots: [],
			idempotency: null,
			responseLimits: {
				maxResponseBytes: 65_536,
				allowedContentTypes: ["application/json"],
				timeoutMs: 5000,
				includeBodyPreview: true,
			},
		};
		const entryCount = MAX_CAPABILITIES + 1;
		for (let i = 0; i < entryCount; i += 1) {
			await createCustomHttpsTool(deps, {
				entryId: `wildcard-tool-${String(i).padStart(4, "0")}`,
				name: `Wildcard tool ${i}`,
				description: `Test tool number ${i}.`,
				httpsDefinition: definition,
				actor: "test",
			});
		}
		const [betaConfig] = (await pool.query("select config from agents where id = 'beta'")).rows;
		await commitChange(deps, {
			changeSet: [
				{
					type: "update_agent",
					agent: {
						...betaConfig.config,
						permissions: {
							tools_allow: ["custom.*"],
							tools_require_human_approval: [],
							tools_deny: ["finance.*", "memory.write"],
						},
					},
				},
			],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "test",
			source: "cli_apply",
		});

		const effective = await effectiveFor("beta");
		// Never a reason to stop the agent from running at all: `toolPolicy.allow` (what enforcement
		// actually reads) stays exactly `beta`'s own, unexpanded legacy pattern — only the structured
		// description `capabilities` resolves against the catalog, and only that is bounded.
		expect(effective.toolPolicy.allow).toEqual(["custom.*"]);
		expect(effective.capabilities.length).toBe(MAX_CAPABILITIES);
		expect(effective.capabilitiesOmitted).toBe(1);
	});

	it("bounds capability descriptions to an aggregate byte budget, omitting whole capabilities rather than failing the turn (ADR-027)", async () => {
		// Ten `custom_https` tools, each with sixteen enum parameters (`MAX_CUSTOM_TOOL_PARAMS`) of
		// fifty long, multi-byte choices (`CustomEnumParamSchema`'s own bounds): serialized, each
		// capability's own parameter contract alone is a few hundred kilobytes, and all ten together
		// would be several megabytes — past `MAX_TURN_INPUT_BYTES` long before `MAX_CAPABILITIES`
		// (128) would ever trim anything.
		const longChoice = (i: number) => `${"字".repeat(97)}${String(i).padStart(2, "0")}`;
		const parameters = Array.from({ length: 16 }, (_, p) => ({
			name: `choice_${p}`,
			slot: "query" as const,
			slotName: `q${p}`,
			type: "enum" as const,
			values: Array.from({ length: 50 }, (_, i) => longChoice(i)),
		}));
		const definition: CustomHttpsDefinition = {
			host: "api.example.test",
			pathTemplate: "/items",
			method: "GET",
			parameters,
			secretSlots: [],
			idempotency: null,
			responseLimits: {
				maxResponseBytes: 65_536,
				allowedContentTypes: ["application/json"],
				timeoutMs: 5000,
				includeBodyPreview: true,
			},
		};
		const entryIds = Array.from({ length: 10 }, (_, i) => `enum-heavy-${i}`);
		for (const entryId of entryIds) {
			await createCustomHttpsTool(deps, {
				entryId,
				name: entryId,
				description: `Test tool ${entryId}.`,
				httpsDefinition: definition,
				actor: "test",
			});
			await attachTool(deps, {
				agentId: "alpha",
				entryId,
				pinnedVersion: null,
				mode: "require_approval",
				settings: {},
				actor: "test",
				source: "console",
			});
		}
		const effective = await effectiveFor("alpha");
		// `toolPolicy` (what enforcement actually reads) is never trimmed: every attached tool is
		// still there, described or not.
		for (const entryId of entryIds) {
			expect(effective.toolPolicy.requireHumanApproval).toContain(`custom.${entryId}`);
		}
		expect(effective.capabilitiesOmitted).toBeGreaterThan(0);
		expect(effective.capabilities.length).toBeLessThan(entryIds.length);
		// Never a single parameter contract truncated partway: every described capability still
		// carries its own complete set of sixteen parameters, each with all fifty choices.
		for (const capability of effective.capabilities) {
			expect(capability.parameters).toHaveLength(16);
			for (const parameter of capability.parameters ?? []) {
				expect(parameter.type === "enum" ? parameter.values : []).toHaveLength(
					parameter.type === "enum" ? 50 : 0,
				);
			}
		}
		const serializedBytes = Buffer.byteLength(JSON.stringify(effective.capabilities), "utf8");
		expect(serializedBytes).toBeLessThan(MAX_TURN_INPUT_BYTES);
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

		describe("startup: projections reconciled against the active revision (ADR-027 rollback)", () => {
			it(
				"a revision an older, pre-ADR-027 writer committed (no attachments snapshot) is never " +
					"outranked by a stale hub-managed projection: reconciliation falls back to legacy, " +
					"reading exactly the permissions that writer itself recorded",
				async () => {
					await attachTool(deps, {
						agentId: "alpha",
						entryId: "native-repository-read",
						pinnedVersion: null,
						mode: "allow",
						settings: {},
						actor: "test",
						source: "console",
					});
					const before = await effectiveFor("alpha");
					expect(before.hubManaged).toBe(true);
					expect(before.toolPolicy.allow).toContain("repository.read");

					const revisionId = await activeConfigRevisionId(deps);
					if (revisionId === null) {
						throw new Error("expected an active revision");
					}
					const [controls] = (
						await pool.query<{ config_generation: number }>(
							"select config_generation::int as config_generation from gateway_controls where id = 1",
						)
					).rows;
					const generation = controls?.config_generation ?? 0;

					// Simulates a release before ADR-027 applying a configuration change through its own,
					// older writer: it denies `repository.read` on `alpha` directly in `permissions` (its
					// only enforcement surface), and records a new snapshot/revision for it exactly as
					// `writeConfigRevisionIn` always has — but it has no `toolAttachments` to call that
					// writer with at all, so `attachments_snapshot_hash` is simply never part of its
					// insert, and it never touches `catalog_attachments`/`tool_attachments_managed`
					// (neither exists for it).
					const { bundle } = await inTransaction(deps, ({ tx }) =>
						loadActiveBundle(tx.db, revisionId),
					);
					if (bundle.organization === null) {
						throw new Error("expected an organization");
					}
					const deniedAgents = bundle.agents.map((a) =>
						a.id === "alpha"
							? {
									...a,
									permissions: {
										tools_allow: [],
										tools_require_human_approval: [],
										tools_deny: ["finance.*", "repository.read"],
									},
								}
							: a,
					);
					const oldReleaseBundle = configSnapshotBundle({
						organization: bundle.organization,
						agents: deniedAgents,
						constitution: bundle.constitution,
						rolePrompts: bundle.rolePrompts,
					});
					const oldReleaseHash = canonicalHash(oldReleaseBundle);
					await pool.query(
						"insert into config_snapshots (hash, bundle, format, origin, created_at) " +
							"values ($1, $2, $3, 'applied', now()) on conflict do nothing",
						[oldReleaseHash, JSON.stringify(oldReleaseBundle), CONFIG_SNAPSHOT_FORMAT],
					);
					const [oldRevision] = (
						await pool.query<{ id: number }>(
							"insert into config_revisions " +
								"(snapshot_hash, parent_revision_id, generation, actor, source, created_at) " +
								"values ($1, $2, $3, 'old-release', 'cli_apply', now()) returning id::int as id",
							[oldReleaseHash, revisionId, generation + 1],
						)
					).rows;
					const oldRevisionId = oldRevision?.id;
					if (oldRevisionId === undefined) {
						throw new Error("expected the simulated revision to be recorded");
					}
					await pool.query(
						"update gateway_controls set active_config_version = $1, config_generation = $2, " +
							"active_config_revision = $3, updated_at = now() where id = 1",
						[oldReleaseHash, generation + 1, oldRevisionId],
					);
					const deniedAlpha = oldReleaseBundle.agents.find((a) => a.id === "alpha");
					await pool.query("update agents set config = $1 where id = 'alpha'", [
						JSON.stringify(deniedAlpha),
					]);

					// The bug this closes: the live projections are still exactly as the earlier,
					// hub-managed commit left them — stale, and disagreeing with the revision that is
					// now active.
					const [staleManaged] = (
						await pool.query<{ tool_attachments_managed: boolean }>(
							"select tool_attachments_managed from agents where id = 'alpha'",
						)
					).rows;
					expect(staleManaged?.tool_attachments_managed).toBe(true);
					const staleAttachments = await pool.query(
						"select 1 from catalog_attachments where agent_id = 'alpha' and entry_id = 'native-repository-read'",
					);
					expect(staleAttachments.rowCount).toBe(1);

					// Startup reconciliation: the active revision carries no attachments document of its
					// own (`attachments_snapshot_hash` is null), so every agent it names is legacy —
					// `alpha` falls back to exactly the `permissions` the old release itself wrote, never
					// the stale attachment a newer release had granted before the rollback.
					await ensureToolAttachmentsReconciled(deps, "upgrade");

					const [reconciledManaged] = (
						await pool.query<{ tool_attachments_managed: boolean }>(
							"select tool_attachments_managed from agents where id = 'alpha'",
						)
					).rows;
					expect(reconciledManaged?.tool_attachments_managed).toBe(false);
					const reconciledAttachments = await pool.query(
						"select 1 from catalog_attachments where agent_id = 'alpha'",
					);
					expect(reconciledAttachments.rowCount).toBe(0);

					const after = await effectiveFor("alpha");
					expect(after.hubManaged).toBe(false);
					expect(after.toolPolicy.allow).not.toContain("repository.read");
					expect(after.toolPolicy.deny).toContain("repository.read");

					// Idempotent: nothing left to reconcile the second time, so no further audit entry.
					await ensureToolAttachmentsReconciled(deps, "upgrade");
					const [auditCount] = (
						await pool.query<{ n: string }>(
							"select count(*)::text as n from audit_log where action = 'config.tool_attachments_reconciled'",
						)
					).rows;
					expect(auditCount?.n).toBe("1");
				},
			);
		});
	});

	// Placed last: both tests create their own `custom_https` entries, and catalog tables are
	// never truncated between tests (`reset`'s own doc comment) — a new entry created here would
	// otherwise also match an earlier test's own `custom.*` wildcard and shift its exact count
	// (`bounds capability descriptions to MAX_CAPABILITIES`, above).
	it("a parameterized custom_https tool's capability carries its non-secret parameter contract, never a secret", async () => {
		const definition: CustomHttpsDefinition = {
			host: "api.example.test",
			pathTemplate: "/tickets/{id}",
			method: "POST",
			parameters: [
				{ name: "id", slot: "path", slotName: "id", type: "string", minLength: 1, maxLength: 50 },
				{
					name: "priority",
					slot: "query",
					slotName: "priority",
					type: "enum",
					values: ["low", "high"],
				},
				{
					name: "votes",
					slot: "body",
					slotName: "votes",
					type: "number",
					minimum: 0,
					maximum: 100,
				},
			],
			secretSlots: [{ alias: "ticket_api_key", slot: "header", slotName: "x-api-key" }],
			idempotency: { headerName: "idempotency-key" },
			responseLimits: {
				maxResponseBytes: 65_536,
				allowedContentTypes: ["application/json"],
				timeoutMs: 5000,
				includeBodyPreview: true,
			},
		};
		await createCustomHttpsTool(deps, {
			entryId: "zendesk",
			name: "Zendesk",
			description: "Creates a Zendesk ticket.",
			httpsDefinition: definition,
			actor: "test",
		});
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "zendesk",
			pinnedVersion: null,
			mode: "require_approval",
			settings: {},
			actor: "test",
			source: "console",
		});
		const effective = await effectiveFor("alpha");
		const capability = effective.capabilities.find((c) => c.name === "custom.zendesk");
		expect(capability?.parameters).toEqual([
			{ name: "id", type: "string", required: true, minLength: 1, maxLength: 50 },
			{ name: "priority", type: "enum", required: true, values: ["low", "high"] },
			{ name: "votes", type: "number", required: true, minimum: 0, maximum: 100 },
		]);
		// Never a secret slot's alias, its slot name, or which wire slot a value lands in.
		const serialized = JSON.stringify(effective.capabilities);
		expect(serialized).not.toContain("ticket_api_key");
		expect(serialized).not.toContain("x-api-key");
		expect(serialized).not.toContain("slotName");
	});

	it("a pinned attachment's capability parameters resolve against the pinned version, not a later edit", async () => {
		const v1: CustomHttpsDefinition = {
			host: "api.example.test",
			pathTemplate: "/tickets/{id}",
			method: "POST",
			parameters: [
				{ name: "id", slot: "path", slotName: "id", type: "string", minLength: 1, maxLength: 50 },
			],
			secretSlots: [],
			idempotency: { headerName: "idempotency-key" },
			responseLimits: {
				maxResponseBytes: 65_536,
				allowedContentTypes: ["application/json"],
				timeoutMs: 5000,
				includeBodyPreview: true,
			},
		};
		await createCustomHttpsTool(deps, {
			entryId: "zendesk-pinned",
			name: "Zendesk",
			description: "Creates a Zendesk ticket.",
			httpsDefinition: v1,
			actor: "test",
		});
		await attachTool(deps, {
			agentId: "alpha",
			entryId: "zendesk-pinned",
			pinnedVersion: 1,
			mode: "require_approval",
			settings: {},
			actor: "test",
			source: "console",
		});
		await editCatalogEntry(deps, {
			entryId: "zendesk-pinned",
			httpsDefinition: {
				...v1,
				pathTemplate: "/tickets",
				parameters: [
					{
						name: "subject",
						slot: "body",
						slotName: "subject",
						type: "string",
						minLength: 1,
						maxLength: 200,
					},
				],
			},
			actor: "test",
		});
		const effective = await effectiveFor("alpha");
		const capability = effective.capabilities.find((c) => c.name === "custom.zendesk-pinned");
		// Still version 1's own contract (`id`), never version 2's (`subject`) — the same version its
		// compiled mode and description already resolve against.
		expect(capability?.parameters).toEqual([
			{ name: "id", type: "string", required: true, minLength: 1, maxLength: 50 },
		]);
	});

	// Last in the file, deliberately: unlike every other test here, this one permanently tombstones
	// a built-in (`deleteCatalogEntry` on a built-in writes `catalog_entry_tombstones`, which
	// `reset()`'s own reseed never undoes, ADR-027) — every test above still needs
	// `native-repository-read` attachable.
	it("a prerequisite's entry deleted after rollback/restore brings back the implying attachment stays explicitly denied, never silently re-granted (ADR-027)", async () => {
		// `workspace.write` implies `repository.read`; attaching it, then detaching it again, so the
		// delete below is not itself refused as "still implicitly held" (`agentsImplicitlyHoldingTool`,
		// a narrower, separate guard this test is not about).
		const attach = await attachTool(deps, {
			agentId: "alpha",
			entryId: "native-workspace-write",
			pinnedVersion: null,
			mode: "allow",
			settings: {},
			actor: "test",
			source: "console",
		});
		await detachTool(deps, {
			agentId: "alpha",
			entryId: "native-workspace-write",
			actor: "test",
			source: "console",
		});
		await deleteCatalogEntry(deps, "native-repository-read", "test");

		// Rolling back to the attach revision restores exactly alpha's `workspace.write` attachment —
		// never one naming `repository.read` directly (it was only ever implied, never attached), so
		// "any attachment naming a deleted entry is dropped from what a rollback actually commits"
		// (ADR-027) does not apply here: that rule only drops an attachment of the deleted entry
		// itself, not one that merely implies it.
		const { bundle: attachBundle } = await inTransaction(deps, ({ tx }) =>
			loadActiveBundle(tx.db, attach.revisionId),
		);
		if (attachBundle.organization === null) {
			throw new Error("expected an organization");
		}
		const rolledBack = await commitChange(deps, {
			changeSet: [
				{
					type: "replace_bundle",
					bundle: configSnapshotBundle({
						organization: attachBundle.organization,
						agents: attachBundle.agents,
						constitution: attachBundle.constitution,
						rolePrompts: attachBundle.rolePrompts,
					}),
					toolAttachments: attachBundle.toolAttachments,
				},
			],
			baseRevisionId: await activeConfigRevisionId(deps),
			actor: "test",
			source: "rollback",
		});
		const { bundle: rolledBackBundle } = await inTransaction(deps, ({ tx }) =>
			loadActiveBundle(tx.db, rolledBack.revisionId),
		);
		expect(rolledBackBundle.toolAttachments.alpha).toEqual(
			expect.arrayContaining([
				{ entryId: "native-workspace-write", pinnedVersion: null, mode: "allow", settings: {} },
			]),
		);

		const afterRollback = await effectiveFor("alpha");
		// `workspace.write` is still directly attached `allow` (the read model never strips a direct
		// attachment, ADR-027), but its implied `repository.read` has no live entry any more: both the
		// explicit denial this compiles into, and any runtime-side inference reading only these three
		// lists (`nativeToolGrants`, `packages/runtime-sdk`, deriving `read` from a granted `write`),
		// must withhold it — never silently re-grant it just because `workspace.write` alone is still
		// in `allow`.
		expect(afterRollback.toolPolicy.allow).toContain("workspace.write");
		expect(afterRollback.toolPolicy.allow).not.toContain("repository.read");
		expect(afterRollback.toolPolicy.deny).toContain("repository.read");
		expect(afterRollback.missingPrerequisites["workspace.write"]).toEqual(["repository.read"]);
	});
});
