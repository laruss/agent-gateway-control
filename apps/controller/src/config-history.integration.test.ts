import {
	type AgentConfig,
	AgentConfigSchema,
	type ConfigSnapshotBundle,
} from "@agent-gateway/contracts";
import {
	applyConfig,
	type ConfigApplyInput,
	type ControlPlaneDeps,
	configHistoryNeedsBackfill,
	ensureConfigHistory,
	inTransaction,
	loadActiveBundle,
	setAgentEnabled,
} from "@agent-gateway/core";
import { canonicalHash } from "@agent-gateway/events";
import type { LogFields, Logger } from "@agent-gateway/logging";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventually, exampleConfig, startTestGateway, type TestGateway } from "./test-gateway.ts";

type Row = Record<string, unknown>;

/**
 * `input` with `id` removed from `agents` and its `rolePrompts` entry along with it — the same
 * shape a real config directory without that agent's YAML file would produce (`loadConfigDirectory`
 * never has a role prompt for an agent it did not read), since `configBundleProblems` now refuses a
 * `rolePrompts` entry for an agent the bundle does not configure.
 */
function withoutAgent(input: ConfigApplyInput, id: string): ConfigApplyInput {
	const rolePrompts = { ...input.rolePrompts };
	delete rolePrompts[id];
	return { ...input, agents: input.agents.filter((agent) => agent.id !== id), rolePrompts };
}

/** A minimal, schema-valid agent for ids that exercise edge cases (e.g. `aa`, `a-z`). */
function minimalAgent(id: string): AgentConfig {
	return AgentConfigSchema.parse({
		schema_version: 1,
		id,
		display_name: id,
		enabled: true,
		mattermost: {
			username: id,
			token_secret_file: `/run/secrets/mm_${id.replace(/-/g, "_")}_token`,
			allowed_channels: [],
		},
		runtime: { adapter: "mock", session_policy: "stateless", timeout_seconds: 60 },
		prompts: { role_file: `prompts/${id}.md` },
		wake_rules: [],
		concurrency: { while_running: "enqueue" },
		permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: ["finance.*"] },
		memory: { private_namespace: `agents/${id}`, shared_namespaces: [] },
	});
}

describe("configuration history", () => {
	let gateway: TestGateway;

	beforeAll(async () => {
		gateway = await startTestGateway();
	});

	afterAll(async () => {
		await gateway?.stop();
	});

	const query = async <T extends Row>(text: string, values: Readonly<unknown[]> = []) =>
		(await gateway.pool.query<T>(text, [...values])).rows;

	const counts = async () => {
		const [snapshots] = await query<{ n: number }>(
			"select count(*)::int as n from config_snapshots",
		);
		const [revisions] = await query<{ n: number }>(
			"select count(*)::int as n from config_revisions",
		);
		return { snapshots: snapshots?.n ?? 0, revisions: revisions?.n ?? 0 };
	};

	// bigint/bigserial columns come back from node-pg as strings (int8 may exceed JS number
	// precision); cast to int32 here, well within range for these small, test-scale values, so
	// they compare directly against the JS numbers `applyConfig`/`ensureConfigHistory` return
	// (drizzle maps their "number"-mode bigint columns for us, raw `pool.query` does not).
	const controlsRow = async () =>
		(
			await query<{
				active_config_version: string | null;
				active_config_revision: number | null;
				config_generation: number;
			}>(
				"select active_config_version, active_config_revision::int as active_config_revision, config_generation::int as config_generation from gateway_controls where id = 1",
			)
		)[0];

	const revisionRow = async (id: number) =>
		(
			await query<{
				id: number;
				snapshot_hash: string;
				parent_revision_id: number | null;
				generation: number;
				actor: string;
				source: string;
			}>(
				"select id::int as id, snapshot_hash, parent_revision_id::int as parent_revision_id, generation::int as generation, actor, source from config_revisions where id = $1",
				[id],
			)
		)[0];

	/**
	 * Control plane deps on the test pool, jobs going nowhere, with a logger that records its
	 * `warn` calls instead of discarding them — so a test can assert on the structured warning
	 * `ensureConfigHistoryIn` logs when it finds configuration changed outside revision history.
	 */
	const withCapturedWarnings = (): Readonly<{
		deps: ControlPlaneDeps;
		warnings: Readonly<{ message: string; fields: LogFields | undefined }[]>;
	}> => {
		const warnings: { message: string; fields: LogFields | undefined }[] = [];
		const inert: Logger = {
			debug: () => undefined,
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
			child: () => inert,
		};
		const log: Logger = {
			...inert,
			warn: (message, fields) => {
				warnings.push({ message, fields });
			},
		};
		return {
			deps: {
				pool: gateway.pool,
				clock: () => new Date(),
				random: () => 0,
				log,
				jobs: () => ({ send: async () => "job" }),
			},
			warnings,
		};
	};

	it("recorded one snapshot and one revision for the gateway's initial apply", async () => {
		expect(await counts()).toEqual({ snapshots: 1, revisions: 1 });
		const controls = await controlsRow();
		expect(controls?.active_config_revision).not.toBeNull();
		const revision = await revisionRow(controls?.active_config_revision as number);
		expect(revision).toMatchObject({
			snapshot_hash: controls?.active_config_version,
			parent_revision_id: null,
			source: "cli_apply",
			actor: "test",
		});
	});

	it("gives a re-apply of identical content a new revision over the same snapshot", async () => {
		const before = await controlsRow();
		const result = await applyConfig(gateway.deps(), exampleConfig(), "test");
		expect(result.version).toBe(before?.active_config_version);
		expect(result.revisionId).not.toBe(before?.active_config_revision);
		expect((await counts()).revisions).toBe(2);
		expect((await counts()).snapshots).toBe(1);
		expect(await revisionRow(result.revisionId)).toMatchObject({
			snapshot_hash: result.version,
			parent_revision_id: before?.active_config_revision,
			generation: (before?.config_generation ?? 0) + 1,
			source: "cli_apply",
		});
		const after = await controlsRow();
		expect(after?.active_config_revision).toBe(result.revisionId);
		expect(after?.config_generation).toBe((before?.config_generation ?? 0) + 1);
	});

	it("records three revisions over two distinct snapshots for applying A, B, A", async () => {
		const a = exampleConfig();
		const b = withoutAgent(a, "research");
		const first = await applyConfig(gateway.deps(), a, "test");
		const second = await applyConfig(gateway.deps(), b, "test");
		const third = await applyConfig(gateway.deps(), a, "test");

		expect(new Set([first.revisionId, second.revisionId, third.revisionId]).size).toBe(3);
		expect(third.version).toBe(first.version);
		expect(second.version).not.toBe(first.version);
		expect(new Set([first.version, second.version, third.version]).size).toBe(2);

		expect((await revisionRow(second.revisionId))?.parent_revision_id).toBe(first.revisionId);
		expect((await revisionRow(third.revisionId))?.parent_revision_id).toBe(second.revisionId);

		const [research] = await query<{ enabled: boolean }>(
			"select enabled from agents where id = 'research'",
		);
		expect(research?.enabled).toBe(true);
	});

	it("backfills history for a database upgraded from a release before it existed", async () => {
		const base = exampleConfig();
		const withoutResearch = withoutAgent(base, "research");
		const applied = await applyConfig(gateway.deps(), withoutResearch, "test");
		// Simulates the pre-upgrade (0.3.0) state this release migrates from: an active
		// configuration whose revision was never recorded, because the column did not exist yet.
		await gateway.pool.query(
			"update gateway_controls set active_config_revision = null where id = 1",
		);
		const before = await counts();

		await ensureConfigHistory(gateway.deps(), "upgrade");

		const after = await counts();
		expect(after.revisions).toBe(before.revisions + 1);
		const controls = await controlsRow();
		expect(controls?.active_config_version).toBe(applied.version);
		expect(controls?.active_config_revision).not.toBeNull();
		const revision = await revisionRow(controls?.active_config_revision as number);
		expect(revision).toMatchObject({ source: "backfill", actor: "upgrade" });

		// The backfilled bundle is reassembled from the `agents` rows alone, which never held the
		// original apply's exact `rolePrompts` object (e.g. a stray key for an agent no longer in
		// the bundle); its hash is honestly its own, not assumed to equal `applied.version`.
		const [snapshot] = await query<{ hash: string; bundle: ConfigSnapshotBundle }>(
			"select hash, bundle from config_snapshots where hash = $1",
			[revision?.snapshot_hash],
		);
		if (snapshot === undefined) {
			throw new Error("expected a config_snapshots row for the backfilled revision");
		}
		expect(canonicalHash(snapshot.bundle)).toBe(snapshot.hash);
		const ids = snapshot.bundle.agents.map((candidate) => candidate.id).sort();
		expect(ids).not.toContain("research");
		expect(ids).toEqual(withoutResearch.agents.map((candidate) => candidate.id).sort());

		// Idempotent: a second call changes nothing further.
		await ensureConfigHistory(gateway.deps(), "upgrade");
		expect(await counts()).toEqual(after);
		expect((await controlsRow())?.active_config_revision).toBe(controls?.active_config_revision);
	});

	it("backfills a stale revision when an older release changed the active configuration directly", async () => {
		// Directly rewrites config_versions/agents/gateway_controls the way a 0.3.0 CLI (which
		// knows nothing of config_snapshots/config_revisions) would have: the active version and
		// generation move on, but the revision pointer — and `research`'s own stale row from the
		// test above — are left exactly where they were.
		const before = await controlsRow();
		const [versionBefore] = await query<{ organization: object }>(
			"select organization from config_versions where version = $1",
			[before?.active_config_version],
		);
		const nextVersion = `${before?.active_config_version}-old-release`;
		const newConstitution = "Updated by a release that predates configuration history.";
		await gateway.pool.query(
			"insert into config_versions (version, organization, constitution, applied_at) values ($1, $2, $3, now())",
			[nextVersion, JSON.stringify(versionBefore?.organization), newConstitution],
		);
		await gateway.pool.query("update agents set config_version = $1 where config_version = $2", [
			nextVersion,
			before?.active_config_version,
		]);
		await gateway.pool.query(
			"update gateway_controls set active_config_version = $1, config_generation = config_generation + 1 where id = 1",
			[nextVersion],
		);

		// A logger that records its warnings, so the structured warning `ensureConfigHistoryIn`
		// logs for exactly this case — a revision was already recorded and is now stale — can be
		// asserted on below, alongside the database state the backfill itself produces.
		const { deps: loggedDeps, warnings } = withCapturedWarnings();
		await ensureConfigHistory(loggedDeps, "upgrade");

		const afterUpgrade = await controlsRow();
		expect(afterUpgrade?.active_config_version).toBe(nextVersion);
		expect(afterUpgrade?.config_generation).toBe((before?.config_generation ?? 0) + 1);
		expect(afterUpgrade?.active_config_revision).not.toBe(before?.active_config_revision);
		const backfilled = await revisionRow(afterUpgrade?.active_config_revision as number);
		expect(backfilled).toMatchObject({
			parent_revision_id: before?.active_config_revision,
			generation: afterUpgrade?.config_generation,
			source: "backfill",
			actor: "upgrade",
		});
		const [snapshot] = await query<{ hash: string; bundle: ConfigSnapshotBundle }>(
			"select hash, bundle from config_snapshots where hash = $1",
			[backfilled?.snapshot_hash],
		);
		if (snapshot === undefined) {
			throw new Error("expected a config_snapshots row for the backfilled revision");
		}
		expect(canonicalHash(snapshot.bundle)).toBe(snapshot.hash);

		// Never silently prefers the stale snapshot over the changed projections: the active
		// version is `nextVersion` (what the projections now hold), not reverted to `before`'s.
		expect(afterUpgrade?.active_config_version).not.toBe(before?.active_config_version);

		// A clear structured warning: a revision existed and is now stale, naming the generation,
		// the new (backfilled) revision and the stale one it replaces.
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toContain("configuration changed outside revision history");
		expect(warnings[0]?.message).toContain(`generation ${afterUpgrade?.config_generation}`);
		expect(warnings[0]?.fields).toMatchObject({
			generation: afterUpgrade?.config_generation,
			revision_id: afterUpgrade?.active_config_revision,
			parent_revision_id: before?.active_config_revision,
		});

		// The same condition also fires as a gateway alert (the controller sweeps it in the
		// background): `gateway doctor`'s `config_history` check reads the same database state.
		const firing = await eventually(
			async () => {
				const [row] = await query<{ state: string; message: string }>(
					"select state, message from alert_states where key = 'config:backfill'",
				);
				return row?.state === "firing" ? row : null;
			},
			10_000,
			"the config:backfill alert to fire",
		);
		expect(firing.message).toContain(`revision ${afterUpgrade?.active_config_revision}`);

		// Idempotent: the generation already matches, so calling it again changes nothing.
		await ensureConfigHistory(gateway.deps(), "upgrade");
		expect((await controlsRow())?.active_config_revision).toBe(
			afterUpgrade?.active_config_revision,
		);

		// The chain continues: a normal apply's new revision names the backfilled one as its
		// parent (A -> backfill(B) -> new). `research` stays excluded (and thus stale), as the
		// later projection-compatibility test below relies on.
		const stillWithoutResearch = withoutAgent(exampleConfig(), "research");
		const next = await applyConfig(gateway.deps(), stillWithoutResearch, "test");
		expect((await revisionRow(next.revisionId))?.parent_revision_id).toBe(
			afterUpgrade?.active_config_revision,
		);
	});

	it("sorts backfilled agents by code-unit id, not database collation", async () => {
		// `research` stays excluded here too, for the same reason as the test above.
		const base = withoutAgent(exampleConfig(), "research");
		const extra: ConfigApplyInput = {
			...base,
			agents: [...base.agents, minimalAgent("aa"), minimalAgent("a-z")],
			rolePrompts: {
				...base.rolePrompts,
				aa: "Role prompt for aa.",
				"a-z": "Role prompt for a-z.",
			},
		};
		await applyConfig(gateway.deps(), extra, "test");
		await gateway.pool.query(
			"update gateway_controls set active_config_revision = null where id = 1",
		);

		await ensureConfigHistory(gateway.deps(), "upgrade");

		const controls = await controlsRow();
		const revision = await revisionRow(controls?.active_config_revision as number);
		expect(revision?.source).toBe("backfill");
		const [snapshot] = await query<{ hash: string; bundle: ConfigSnapshotBundle }>(
			"select hash, bundle from config_snapshots where hash = $1",
			[revision?.snapshot_hash],
		);
		if (snapshot === undefined) {
			throw new Error("expected a config_snapshots row for the backfilled revision");
		}
		expect(canonicalHash(snapshot.bundle)).toBe(snapshot.hash);
		const ids = snapshot.bundle.agents.map((candidate) => candidate.id);
		expect(ids).toContain("aa");
		expect(ids).toContain("a-z");
		expect(ids).toEqual([...ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
	});

	it("leaves the agents and config_versions projections unchanged for existing readers", async () => {
		const controls = await controlsRow();
		const [versionRow] = await query<{ organization: object; constitution: string }>(
			"select organization, constitution from config_versions where version = $1",
			[controls?.active_config_version],
		);
		expect(typeof versionRow?.organization).toBe("object");
		expect(versionRow?.constitution.length).toBeGreaterThan(0);

		// `research` was removed from the active configuration by the backfill test above: its row
		// is disabled and kept at its own, now-stale, config version rather than deleted.
		const [research] = await query<{
			config_version: string;
			enabled: boolean;
			config: { id: string };
			role_prompt: string;
		}>("select config_version, enabled, config, role_prompt from agents where id = 'research'");
		expect(research?.enabled).toBe(false);
		expect(research?.config_version).not.toBe(controls?.active_config_version);
		expect(research?.config.id).toBe("research");
		expect(research?.role_prompt.length).toBeGreaterThan(0);
	});

	it("stores every snapshot, applied or backfilled, under the canonical hash of its own bundle", async () => {
		const rows = await query<{ hash: string; bundle: ConfigSnapshotBundle; origin: string }>(
			"select hash, bundle, origin from config_snapshots",
		);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.some((row) => row.origin === "backfill")).toBe(true);
		for (const row of rows) {
			expect(canonicalHash(row.bundle)).toBe(row.hash);
		}
	});
});

describe("configuration history: an agent retained enabled outside the active snapshot", () => {
	let gateway: TestGateway;

	beforeAll(async () => {
		gateway = await startTestGateway();
	});

	afterAll(async () => {
		await gateway?.stop();
	});

	const query = async <T extends Row>(text: string, values: Readonly<unknown[]> = []) =>
		(await gateway.pool.query<T>(text, [...values])).rows;

	const controlsRow = async () =>
		(
			await query<{
				active_config_version: string | null;
				active_config_revision: number | null;
				config_generation: number;
			}>(
				"select active_config_version, active_config_revision::int as active_config_revision, " +
					"config_generation::int as config_generation from gateway_controls where id = 1",
			)
		)[0];

	const bundleOf = async (revisionId: number | null) =>
		(await inTransaction(gateway.deps(), ({ tx }) => loadActiveBundle(tx.db, revisionId))).bundle;

	it(
		"includes a row re-enabled outside the active config_version in the backfill, lets it be " +
			"disabled through the normal path, and the predicate is idempotent",
		async () => {
			// `research` leaves the active configuration: disabled by the apply, the same as any
			// agent dropped from YAML, its `config_version` left exactly where the apply found it.
			await applyConfig(gateway.deps(), withoutAgent(exampleConfig(), "research"), "test");
			const afterRemoval = await controlsRow();

			// A release before configuration history existed then re-enables the row directly
			// (`gateway agent enable research` under 0.3.0): still actually running (`loadAgents`
			// reads every row, not only those at the active version) despite its own stale
			// `config_version`.
			await gateway.pool.query(
				"update agents set enabled = true, state = 'idle', state_changed_at = now() where id = 'research'",
			);

			// `gateway doctor` (read-only; never runs `ensureConfigHistory` itself) must report this
			// drift truthfully even before anything has backfilled it.
			expect(await configHistoryNeedsBackfill(gateway.deps())).toBe(true);
			await ensureConfigHistory(gateway.deps(), "upgrade");
			expect(await configHistoryNeedsBackfill(gateway.deps())).toBe(false);

			const controls = await controlsRow();
			expect(controls?.active_config_revision).not.toBe(afterRemoval?.active_config_revision);
			const bundle = await bundleOf(controls?.active_config_revision ?? null);
			const research = bundle.agents.find((agent) => agent.id === "research");
			if (research === undefined) {
				throw new Error("expected the backfill to retain 'research'");
			}
			expect(research.enabled).toBe(true);
			expect(bundle.rolePrompts.research?.length).toBeGreaterThan(0);

			// Idempotent: nothing has drifted further, so calling it again writes nothing new.
			const before = await controlsRow();
			await ensureConfigHistory(gateway.deps(), "upgrade");
			expect((await controlsRow())?.active_config_revision).toBe(before?.active_config_revision);

			// `gateway agent disable research` now works through the normal path — it exists in the
			// bundle — instead of failing "does not exist".
			const disable = await setAgentEnabled(gateway.deps(), "research", false, "test");
			expect(disable.removed).toBe(false);
			expect(disable.result.noop).toBe(false);
			const disabledResearch = (await bundleOf(disable.result.revisionId)).agents.find(
				(agent) => agent.id === "research",
			);
			expect(disabledResearch?.enabled).toBe(false);
		},
	);

	it("removes an agent instead of merely disabling it when its retained configuration no longer validates", async () => {
		await applyConfig(gateway.deps(), withoutAgent(exampleConfig(), "research"), "test");
		// Re-enabled directly, the same as the test above, but its own stored configuration is also
		// no longer valid on its own — plausible for a row retained from a release or two back,
		// whole-bundle rules having moved on since. `max_active_runs` stands in for any such rule.
		await gateway.pool.query(
			"update agents set enabled = true, state = 'idle', state_changed_at = now() where id = 'research'",
		);
		await gateway.pool.query(
			"update agents set config = jsonb_set(config, '{concurrency,max_active_runs}', '2') " +
				"where id = 'research'",
		);
		await ensureConfigHistory(gateway.deps(), "upgrade");

		// Disabling alone would still fail whole-bundle validation (the agent's own retained
		// configuration, unchanged, fails it on its own): removed from the configuration instead,
		// which is what actually resolves the problem.
		const disable = await setAgentEnabled(gateway.deps(), "research", false, "test");
		expect(disable.removed).toBe(true);
		const bundle = await bundleOf(disable.result.revisionId);
		expect(bundle.agents.some((agent) => agent.id === "research")).toBe(false);

		// Never deleted: the projection row stays, disabled, its history intact.
		const [row] = await query<{ enabled: boolean; state: string }>(
			"select enabled, state from agents where id = 'research'",
		);
		expect(row?.enabled).toBe(false);
		expect(row?.state).toBe("disabled");
	});
});
