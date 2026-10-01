import {
	type AgentConfig,
	AgentConfigSchema,
	type ChangeSet,
	type ChangeSetInput,
} from "@agent-gateway/contracts";
import {
	AdminError,
	applyConfig,
	commitChange,
	inTransaction,
	liveEnabledDiverges,
	loadActiveBundle,
	ManagementConflictError,
	prepareChange,
} from "@agent-gateway/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exampleConfig, startTestGateway, type TestGateway } from "./test-gateway.ts";

type Row = Record<string, unknown>;

/** A minimal, schema-valid agent definition for an id the active configuration does not have. */
function ghostAgent(): AgentConfig {
	return AgentConfigSchema.parse({
		schema_version: 1,
		id: "ghost",
		display_name: "ghost",
		enabled: true,
		mattermost: { username: "ghost", token_secret_file: "/run/secrets/mm_ghost_token" },
		runtime: { adapter: "mock", session_policy: "stateless", timeout_seconds: 60 },
		prompts: { role_file: "prompts/ghost.md" },
		wake_rules: [],
		concurrency: { while_running: "enqueue" },
		permissions: { tools_allow: [], tools_require_human_approval: [], tools_deny: ["finance.*"] },
		memory: { private_namespace: "agents/ghost", shared_namespaces: [] },
	});
}

describe("managed configuration: prepare and commit", () => {
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

	/** The revision currently active, read directly (what `prepareChange` would report as its base). */
	const currentRevisionId = async () => (await controlsRow())?.active_config_revision ?? null;

	const revisionRow = async (id: number) =>
		(
			await query<{
				id: number;
				snapshot_hash: string;
				parent_revision_id: number | null;
				generation: number;
				actor: string;
				source: string;
				idempotency_key: string | null;
				change_hash: string | null;
			}>(
				`select id::int as id, snapshot_hash, parent_revision_id::int as parent_revision_id,
				   generation::int as generation, actor, source, idempotency_key, change_hash
				 from config_revisions where id = $1`,
				[id],
			)
		)[0];

	const agentRow = async (id: string) =>
		(
			await query<{ enabled: boolean; config_version: string }>(
				"select enabled, config_version from agents where id = $1",
				[id],
			)
		)[0];

	it("prepare is read-only: it writes nothing, even for a change that would apply cleanly", async () => {
		const before = await counts();
		const controlsBefore = await controlsRow();
		const preview = await prepareChange(gateway.deps(), [
			{ type: "set_constitution", constitution: "A constitution prepare never commits." },
		]);
		expect(preview.problems).toEqual([]);
		expect(preview.noop).toBe(false);
		expect(await counts()).toEqual(before);
		expect(await controlsRow()).toEqual(controlsBefore);
	});

	it("commits a revision whose parent is the prepared base, and advances the active pointer", async () => {
		const before = await controlsRow();
		const changeSet: ChangeSet = [
			{ type: "set_constitution", constitution: "Updated constitution, revision two." },
		];
		const preview = await prepareChange(gateway.deps(), changeSet);
		expect(preview.baseRevisionId).toBe(before?.active_config_revision);
		const result = await commitChange(gateway.deps(), {
			changeSet,
			baseRevisionId: preview.baseRevisionId,
			actor: "test",
			source: "cli_apply",
		});
		expect(result.noop).toBe(false);
		expect(result.hash).toBe(preview.newHash);
		const revision = await revisionRow(result.revisionId);
		expect(revision).toMatchObject({
			parent_revision_id: before?.active_config_revision,
			source: "cli_apply",
			actor: "test",
		});
		const after = await controlsRow();
		expect(after?.active_config_revision).toBe(result.revisionId);
		expect(after?.config_generation).toBe((before?.config_generation ?? 0) + 1);
	});

	it("a stale base conflicts, naming the revision that is now current", async () => {
		const staleBase = await currentRevisionId();
		// Someone else commits first, moving the active revision past the stale base.
		const mover = await commitChange(gateway.deps(), {
			changeSet: [{ type: "set_constitution", constitution: "Committed ahead of the stale one." }],
			baseRevisionId: staleBase,
			actor: "test",
			source: "cli_apply",
		});

		const attempt = commitChange(gateway.deps(), {
			changeSet: [{ type: "set_constitution", constitution: "This base is stale now." }],
			baseRevisionId: staleBase,
			actor: "test",
			source: "cli_apply",
		});
		await expect(attempt).rejects.toThrow(ManagementConflictError);
		await expect(attempt).rejects.toMatchObject({ currentRevisionId: mover.revisionId });
	});

	it("of two concurrent commits on the same base, exactly one wins and the other conflicts", async () => {
		const base = await currentRevisionId();
		const [first, second] = await Promise.allSettled([
			commitChange(gateway.deps(), {
				changeSet: [{ type: "set_constitution", constitution: "Racer A." }],
				baseRevisionId: base,
				actor: "test",
				source: "cli_apply",
			}),
			commitChange(gateway.deps(), {
				changeSet: [{ type: "set_constitution", constitution: "Racer B." }],
				baseRevisionId: base,
				actor: "test",
				source: "cli_apply",
			}),
		]);
		const results = [first, second];
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		const rejection = (rejected as PromiseRejectedResult[])[0];
		expect(rejection?.reason).toBeInstanceOf(ManagementConflictError);
	});

	it("the same idempotency key twice returns the same revision, writing only one row", async () => {
		const base = await currentRevisionId();
		const changeSet: ChangeSet = [
			{ type: "set_constitution", constitution: "Idempotent commit, once." },
		];
		const idempotencyKey = "replay-key-1";
		const first = await commitChange(gateway.deps(), {
			changeSet,
			baseRevisionId: base,
			actor: "test",
			source: "cli_apply",
			idempotencyKey,
		});
		const second = await commitChange(gateway.deps(), {
			changeSet,
			baseRevisionId: base,
			actor: "test",
			source: "cli_apply",
			idempotencyKey,
		});
		// Same revision and hash, but the second call is a replay of the first's result, not a
		// fresh write: `replayed` is the only field that differs.
		expect(first.replayed).toBe(false);
		expect(second).toEqual({ ...first, replayed: true });
		const rows = await query<{ n: number }>(
			"select count(*)::int as n from config_revisions where idempotency_key = $1",
			[idempotencyKey],
		);
		expect(rows[0]?.n).toBe(1);
	});

	it("a replayed commit reports the active revision, even once something else has superseded it", async () => {
		const base = await currentRevisionId();
		const idempotencyKey = "replay-key-superseded";
		const first = await commitChange(gateway.deps(), {
			changeSet: [{ type: "set_constitution", constitution: "Committed once, under a key." }],
			baseRevisionId: base,
			actor: "test",
			source: "cli_apply",
			idempotencyKey,
		});
		expect(first.replayed).toBe(false);
		expect(first.activeRevisionId).toBe(first.revisionId);

		// Something else changes the configuration again, moving the active revision past `first`.
		const superseding = await commitChange(gateway.deps(), {
			changeSet: [{ type: "set_constitution", constitution: "A later, unrelated change." }],
			baseRevisionId: first.revisionId,
			actor: "test",
			source: "cli_apply",
		});
		expect(superseding.revisionId).not.toBe(first.revisionId);

		// A retry under the same key (as if the first commit's own response never reached its
		// caller) replays `first`'s result rather than conflicting or writing again — but now
		// reports that a later revision is the one actually active.
		const replay = await commitChange(gateway.deps(), {
			changeSet: [{ type: "set_constitution", constitution: "Committed once, under a key." }],
			baseRevisionId: base,
			actor: "test",
			source: "cli_apply",
			idempotencyKey,
		});
		expect(replay).toEqual({
			revisionId: first.revisionId,
			hash: first.hash,
			noop: false,
			replayed: true,
			activeRevisionId: superseding.revisionId,
		});
		expect(replay.activeRevisionId).not.toBe(replay.revisionId);
	});

	it("the same idempotency key with a different change set is rejected", async () => {
		const base = await currentRevisionId();
		const idempotencyKey = "replay-key-2";
		await commitChange(gateway.deps(), {
			changeSet: [{ type: "set_constitution", constitution: "Original change under the key." }],
			baseRevisionId: base,
			actor: "test",
			source: "cli_apply",
			idempotencyKey,
		});
		await expect(
			commitChange(gateway.deps(), {
				changeSet: [{ type: "set_constitution", constitution: "A different change, same key." }],
				baseRevisionId: base,
				actor: "test",
				source: "cli_apply",
				idempotencyKey,
			}),
		).rejects.toThrow(AdminError);
	});

	it("a no-op change set commits nothing and returns the base revision", async () => {
		const research = await agentRow("research");
		const changeSet: ChangeSet = [
			{ type: "set_agent_enabled", agentId: "research", enabled: research?.enabled ?? true },
		];
		const preview = await prepareChange(gateway.deps(), changeSet);
		expect(preview.noop).toBe(true);
		const before = await counts();
		const controlsBefore = await controlsRow();
		const result = await commitChange(gateway.deps(), {
			changeSet,
			baseRevisionId: preview.baseRevisionId,
			actor: "test",
			source: "cli_apply",
		});
		expect(result).toEqual({
			revisionId: preview.baseRevisionId,
			hash: preview.newHash,
			noop: true,
			replayed: false,
			activeRevisionId: preview.baseRevisionId,
		});
		expect(await counts()).toEqual(before);
		expect(await controlsRow()).toEqual(controlsBefore);
	});

	it("liveEnabledDiverges also catches a live enabled agent that `expected` does not name at all", async () => {
		const liveEnabled = await query<{ id: string }>("select id from agents where enabled = true");
		if (liveEnabled.length === 0) {
			throw new Error("expected at least one enabled agent");
		}
		const everyEnabledNamed = new Map(liveEnabled.map((row) => [row.id, true]));
		const omittedId = liveEnabled[0]?.id;
		if (omittedId === undefined) {
			throw new Error("expected an enabled agent id");
		}
		// The same map, minus one agent that is actually enabled live: a true disagreement even
		// though every agent still *named* agrees — an enabled agent `expected` never mentions at
		// all must diverge too (the fix), the same way a retained-enabled row outside a bundle
		// would; the pre-existing check alone only ever looked at agents `expected` already names.
		const missingOneEnabled = new Map(everyEnabledNamed);
		missingOneEnabled.delete(omittedId);
		// A named agent whose live value differs: the pre-existing check, unaffected by the fix.
		const flipped = new Map(everyEnabledNamed);
		flipped.set(omittedId, false);

		await inTransaction(gateway.deps(), async ({ tx }) => {
			expect(await liveEnabledDiverges(tx.db, everyEnabledNamed)).toBe(false);
			expect(await liveEnabledDiverges(tx.db, missingOneEnabled)).toBe(true);
			expect(await liveEnabledDiverges(tx.db, flipped)).toBe(true);
		});
	});

	it("a commit that fails validation leaves no snapshot, revision or projection change", async () => {
		const before = await counts();
		const controlsBefore = await controlsRow();
		const changeSet: ChangeSet = [{ type: "update_agent", agent: ghostAgent() }];
		const preview = await prepareChange(gateway.deps(), changeSet);
		expect(preview.problems).toEqual(["update_agent: agent 'ghost' does not exist"]);
		await expect(
			commitChange(gateway.deps(), {
				changeSet,
				baseRevisionId: preview.baseRevisionId,
				actor: "test",
				source: "cli_apply",
			}),
		).rejects.toThrow(AdminError);
		expect(await counts()).toEqual(before);
		expect(await controlsRow()).toEqual(controlsBefore);
	});

	it("disables an agent through commitChange, recording it in configuration history, and a later re-apply of the original YAML re-enables it", async () => {
		const changeSet: ChangeSet = [
			{ type: "set_agent_enabled", agentId: "research", enabled: false },
		];
		const preview = await prepareChange(gateway.deps(), changeSet);
		expect(preview.noop).toBe(false);
		const result = await commitChange(gateway.deps(), {
			changeSet,
			baseRevisionId: preview.baseRevisionId,
			actor: "cli:owner",
			source: "cli_apply",
		});
		expect((await agentRow("research"))?.enabled).toBe(false);
		const revision = await revisionRow(result.revisionId);
		expect(revision).toMatchObject({ source: "cli_apply", actor: "cli:owner" });

		// The YAML directory still has `research` enabled: re-applying it is itself an operator
		// action that re-asserts the file's content, enabled flag included — correct and expected,
		// since the directory is the import source, not a diff against managed state.
		await applyConfig(gateway.deps(), exampleConfig(), "test");
		expect((await agentRow("research"))?.enabled).toBe(true);
	});

	it("backfills a fresh revision when the live enabled projection drifts, even though the generation has not moved", async () => {
		const before = await counts();
		const controlsBefore = await controlsRow();
		// An operational bypass outside the service (an old release's direct toggle): the live
		// projection moves, `config_generation` does not.
		await gateway.pool.query(
			"update agents set enabled = false, state = 'disabled' where id = 'mail-follower'",
		);

		const preview = await prepareChange(gateway.deps(), [
			{ type: "set_constitution", constitution: "Read right after a bypassed toggle." },
		]);

		const after = await counts();
		expect(after.revisions).toBe(before.revisions + 1);
		expect(after.snapshots).toBe(before.snapshots + 1);
		const controlsAfter = await controlsRow();
		expect(controlsAfter?.active_config_revision).not.toBe(controlsBefore?.active_config_revision);
		expect(controlsAfter?.config_generation).toBe(controlsBefore?.config_generation);
		expect(preview.baseRevisionId).toBe(controlsAfter?.active_config_revision);
		if (preview.baseRevisionId === null) {
			throw new Error("expected prepareChange to report a backfilled base revision");
		}
		const revision = await revisionRow(preview.baseRevisionId);
		expect(revision?.source).toBe("backfill");
		const [snapshot] = await query<{ bundle: { agents: { id: string; enabled: boolean }[] } }>(
			"select bundle from config_snapshots where hash = $1",
			[revision?.snapshot_hash],
		);
		const mailFollower = snapshot?.bundle.agents.find(
			(candidate) => candidate.id === "mail-follower",
		);
		expect(mailFollower?.enabled).toBe(false);

		// Restored to enabled through the service, so its projection and history agree again.
		const changeSet: ChangeSet = [
			{ type: "set_agent_enabled", agentId: "mail-follower", enabled: true },
		];
		const reenable = await prepareChange(gateway.deps(), changeSet);
		await commitChange(gateway.deps(), {
			changeSet,
			baseRevisionId: reenable.baseRevisionId,
			actor: "test",
			source: "cli_apply",
		});
		expect((await agentRow("mail-follower"))?.enabled).toBe(true);
	});

	it("an upgraded database's missing revision is backfilled once, surviving into the first commit", async () => {
		const before = await controlsRow();
		await gateway.pool.query(
			"update gateway_controls set active_config_revision = null where id = 1",
		);

		const changeSet: ChangeSet = [
			{ type: "set_constitution", constitution: "Committed right after an upgrade." },
		];
		const preview = await prepareChange(gateway.deps(), changeSet);
		expect(preview.baseRevisionId).not.toBeNull();
		expect(preview.baseRevisionId).not.toBe(before?.active_config_revision);
		// The backfill is already committed on its own: a fresh read agrees with what prepare
		// reported, before any commit is even attempted — it was not rolled back by a conflict a
		// commit attempt might otherwise have hit (see `commitChange`'s own doc comment).
		expect(await currentRevisionId()).toBe(preview.baseRevisionId);

		const result = await commitChange(gateway.deps(), {
			changeSet,
			baseRevisionId: preview.baseRevisionId,
			actor: "test",
			source: "cli_apply",
		});
		expect(result.noop).toBe(false);
		const revision = await revisionRow(result.revisionId);
		expect(revision?.parent_revision_id).toBe(preview.baseRevisionId);
	});

	it("re-enables an agent a bypassed toggle had disabled, instead of reporting a no-op", async () => {
		await gateway.pool.query(
			"update agents set enabled = false, state = 'disabled' where id = 'director'",
		);
		const changeSet: ChangeSet = [
			{ type: "set_agent_enabled", agentId: "director", enabled: true },
		];
		const preview = await prepareChange(gateway.deps(), changeSet);
		expect(preview.noop).toBe(false);
		const result = await commitChange(gateway.deps(), {
			changeSet,
			baseRevisionId: preview.baseRevisionId,
			actor: "test",
			source: "cli_apply",
		});
		expect(result.noop).toBe(false);
		expect((await agentRow("director"))?.enabled).toBe(true);
	});

	it("re-disables an agent a bypassed toggle had enabled, instead of reporting a no-op", async () => {
		// `operator` is first disabled through the service, so its recorded snapshot says `false`.
		const disableChangeSet: ChangeSet = [
			{ type: "set_agent_enabled", agentId: "operator", enabled: false },
		];
		const disablePreview = await prepareChange(gateway.deps(), disableChangeSet);
		await commitChange(gateway.deps(), {
			changeSet: disableChangeSet,
			baseRevisionId: disablePreview.baseRevisionId,
			actor: "test",
			source: "cli_apply",
		});
		expect((await agentRow("operator"))?.enabled).toBe(false);

		// A bypass re-enables it directly, without recording anything.
		await gateway.pool.query(
			"update agents set enabled = true, state = 'idle' where id = 'operator'",
		);

		const changeSet: ChangeSet = [
			{ type: "set_agent_enabled", agentId: "operator", enabled: false },
		];
		const preview = await prepareChange(gateway.deps(), changeSet);
		expect(preview.noop).toBe(false);
		const result = await commitChange(gateway.deps(), {
			changeSet,
			baseRevisionId: preview.baseRevisionId,
			actor: "test",
			source: "cli_apply",
		});
		expect(result.noop).toBe(false);
		expect((await agentRow("operator"))?.enabled).toBe(false);
	});

	it("commits exactly the content it previewed when the change set omits schema-defaulted fields", async () => {
		const [row] = await query<{ config: AgentConfig }>(
			"select config from agents where id = 'research'",
		);
		if (row === undefined) {
			throw new Error("research agent is missing");
		}
		const { max_active_runs: _omitted, ...concurrency } = row.config.concurrency;
		const changeSet: ChangeSetInput = [
			{
				type: "update_agent",
				agent: { ...row.config, display_name: "Research (defaults)", concurrency },
			},
		];
		const preview = await prepareChange(gateway.deps(), changeSet);
		expect(preview.problems).toEqual([]);
		const result = await commitChange(gateway.deps(), {
			changeSet,
			baseRevisionId: preview.baseRevisionId,
			actor: "test",
			source: "cli_apply",
		});
		expect(result.hash).toBe(preview.newHash);
	});

	it("a role prompt over the bound is rejected by both prepare and commit", async () => {
		const changeSet: ChangeSet = [
			{ type: "set_role_prompt", agentId: "research", rolePrompt: "a".repeat(50_001) },
		];
		const preview = await prepareChange(gateway.deps(), changeSet);
		expect(preview.problems.length).toBeGreaterThan(0);
		expect(preview.problems.some((problem) => problem.startsWith("changeSet:"))).toBe(true);
		await expect(
			commitChange(gateway.deps(), {
				changeSet,
				baseRevisionId: preview.baseRevisionId,
				actor: "test",
				source: "cli_apply",
			}),
		).rejects.toThrow(AdminError);
	});

	it("commit rejects an invalid source, an over-bound reason, and a blank idempotency key", async () => {
		const changeSet: ChangeSet = [
			{ type: "set_constitution", constitution: "Validated commit inputs." },
		];
		const base = await currentRevisionId();
		// A console or an agent hands `commitChange` a `source` it parsed from JSON, not necessarily
		// one `ConfigRevisionSourceSchema` would accept: parsed from a JSON string, not asserted to
		// the type, the same boundary a real caller crosses.
		const invalidSource = JSON.parse('"not-a-real-source"');
		await expect(
			commitChange(gateway.deps(), {
				changeSet,
				baseRevisionId: base,
				actor: "test",
				source: invalidSource,
			}),
		).rejects.toThrow(AdminError);
		await expect(
			commitChange(gateway.deps(), {
				changeSet,
				baseRevisionId: base,
				actor: "test",
				source: "cli_apply",
				reason: "a".repeat(501),
			}),
		).rejects.toThrow(AdminError);
		await expect(
			commitChange(gateway.deps(), {
				changeSet,
				baseRevisionId: base,
				actor: "test",
				source: "cli_apply",
				idempotencyKey: "",
			}),
		).rejects.toThrow(AdminError);
	});

	it("deep-freezes a validated snapshot and bounds its cache to the last 16 entries (LRU)", async () => {
		const loadBundle = (id: number) =>
			inTransaction(gateway.deps(), ({ tx }) => loadActiveBundle(tx.db, id));

		const base = await currentRevisionId();
		const first = await commitChange(gateway.deps(), {
			changeSet: [{ type: "set_constitution", constitution: "LRU/freeze probe: first." }],
			baseRevisionId: base,
			actor: "test",
			source: "cli_apply",
		});
		const firstLoad = await loadBundle(first.revisionId);
		const agent = firstLoad.bundle.agents[0];
		if (agent === undefined) {
			throw new Error("expected at least one configured agent");
		}
		// The top-level bundle, its agents array, one agent inside it, and the role-prompts
		// record are all frozen: a caller holding this object cannot mutate the shared cache.
		expect(Object.isFrozen(firstLoad.bundle)).toBe(true);
		expect(Object.isFrozen(firstLoad.bundle.agents)).toBe(true);
		expect(Object.isFrozen(agent)).toBe(true);
		expect(Object.isFrozen(firstLoad.bundle.rolePrompts)).toBe(true);

		// A cache hit returns the exact same object, not a freshly re-parsed copy.
		expect((await loadBundle(first.revisionId)).bundle).toBe(firstLoad.bundle);

		// A commit against `first.revisionId` itself still reads (and so still touches) its hash as
		// its own base: spent here, once, so the 16 commits below are the ones that actually count
		// toward evicting it (each reads only its own immediate predecessor's hash as its base).
		const warmup = await commitChange(gateway.deps(), {
			changeSet: [{ type: "set_constitution", constitution: "LRU/freeze probe: warmup." }],
			baseRevisionId: first.revisionId,
			actor: "test",
			source: "cli_apply",
		});

		// 16 more distinct snapshots, none of them re-reading `first`'s hash: it cannot be among the
		// last 16 distinct hashes the bounded cache still holds.
		let chain = warmup.revisionId;
		for (let i = 0; i < 16; i += 1) {
			const commit = await commitChange(gateway.deps(), {
				changeSet: [{ type: "set_constitution", constitution: `LRU/freeze probe: evict ${i}.` }],
				baseRevisionId: chain,
				actor: "test",
				source: "cli_apply",
			});
			chain = commit.revisionId;
		}
		const reloaded = await loadBundle(first.revisionId);
		expect(reloaded.bundle).not.toBe(firstLoad.bundle);
		expect(reloaded.bundle).toEqual(firstLoad.bundle);
	});

	it("a malformed stored snapshot gives a clear error from prepare, not a crash", async () => {
		const controls = await controlsRow();
		const fakeHash = "f".repeat(64);
		// Its agents' `enabled` must agree with the live projection, or `ensureConfigHistoryIn`
		// would treat this revision as stale on drift and quietly replace it with a fresh backfill
		// before `prepareChange` ever gets to load (and fail to parse) this one.
		const live = await query<{ id: string; enabled: boolean }>(
			"select id, enabled from agents where config_version = $1",
			[controls?.active_config_version],
		);
		const malformed = {
			organization: null,
			agents: live.map((row) => ({ id: row.id, enabled: row.enabled })),
			constitution: "x",
			rolePrompts: {},
		};
		await gateway.pool.query(
			"insert into config_snapshots (hash, bundle, format, origin, created_at) values ($1, $2::jsonb, 1, 'applied', now())",
			[fakeHash, JSON.stringify(malformed)],
		);
		const inserted = await gateway.pool.query<{ id: number }>(
			`insert into config_revisions (snapshot_hash, parent_revision_id, generation, actor, source, created_at)
			 values ($1, $2, $3, 'test', 'backfill', now()) returning id::int as id`,
			[fakeHash, controls?.active_config_revision, controls?.config_generation ?? 0],
		);
		const revisionId = inserted.rows[0]?.id;
		await gateway.pool.query(
			"update gateway_controls set active_config_revision = $1 where id = 1",
			[revisionId],
		);

		await expect(
			prepareChange(gateway.deps(), [{ type: "set_constitution", constitution: "x" }]),
		).rejects.toThrow(/malformed/);
	});
});
