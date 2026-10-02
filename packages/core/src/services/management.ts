import { randomUUID } from "node:crypto";
import {
	type AgentConfig,
	type AgentId,
	type AgentLifecycleSource,
	BOT_SECRET_FILE_PREFIX,
	type ChangeOperation,
	type ChangeSet,
	type ChangeSetInput,
	ChangeSetSchema,
	type ConfigDiff,
	type ConfigDiffAgent,
	ConfigRevisionReasonSchema,
	type ConfigRevisionSource,
	ConfigRevisionSourceSchema,
	ConfigSnapshotBundleSchema,
	IdempotencyKeySchema,
	type OrganizationConfig,
	type TextChange,
} from "@agent-gateway/contracts";
import {
	agentLifecycle,
	agentLifecycleOperations,
	agents,
	configRevisions,
	configSnapshots,
	gatewayControls,
} from "@agent-gateway/db";
import { canonicalHash } from "@agent-gateway/events";
import { desc, eq, inArray, or } from "drizzle-orm";
import {
	AdminError,
	type ConfigApplyInput,
	configBundleProblems,
	configSnapshotBundle,
	ensureConfigHistory,
	ensureConfigHistoryIn,
	inTransaction,
	writeConfigRevisionIn,
} from "./admin.ts";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import { audit, lifecycleOwnedAgentIds } from "./store.ts";

type Db = UnitOfWork["tx"]["db"];

// ---------------------------------------------------------------------------
// Draft bundles: a configuration bundle being built up by a change set, which (unlike
// `ConfigSnapshotBundle`) may not have an organization yet — nothing has `replace_bundle`d one in,
// the state a fresh database starts bootstrapping from.
// ---------------------------------------------------------------------------

export type ConfigDraftBundle = Readonly<{
	organization: OrganizationConfig | null;
	agents: Readonly<AgentConfig[]>;
	constitution: string;
	rolePrompts: Readonly<Record<string, string>>;
}>;

const EMPTY_DRAFT_BUNDLE: ConfigDraftBundle = {
	organization: null,
	agents: [],
	constitution: "",
	rolePrompts: {},
};

/** The same order `configSnapshotBundle` sorts agents in, so a hash never depends on array order. */
function byAgentId(a: AgentConfig, b: AgentConfig): number {
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The canonical hash of a draft bundle, whether or not it is valid (an organization-less draft
 * hashes too, so `prepareChange` stays deterministic even for a change set that does not
 * validate). A valid draft's hash is identical to `canonicalHash(configSnapshotBundle(...))` of
 * the same content: the same field order and the same agent sort.
 */
export function previewHash(draft: ConfigDraftBundle): string {
	return canonicalHash({
		organization: draft.organization,
		agents: [...draft.agents].sort(byAgentId),
		constitution: draft.constitution,
		rolePrompts: { ...draft.rolePrompts },
	});
}

/**
 * Snapshots are immutable and content-addressed: a validated bundle is cached by its own hash.
 * Bounded to the last {@link VALIDATED_SNAPSHOT_CACHE_LIMIT} distinct hashes read, LRU by this
 * `Map`'s own insertion order (a hit is re-inserted at the end; the oldest entry is evicted once
 * the bound is exceeded), so a long-running process reading many distinct snapshots over its
 * lifetime does not grow this cache without limit.
 */
const validatedSnapshotCache = new Map<string, ConfigDraftBundle>();
const VALIDATED_SNAPSHOT_CACHE_LIMIT = 16;

function cachedSnapshot(hash: string): ConfigDraftBundle | undefined {
	const bundle = validatedSnapshotCache.get(hash);
	if (bundle !== undefined) {
		validatedSnapshotCache.delete(hash);
		validatedSnapshotCache.set(hash, bundle);
	}
	return bundle;
}

function cacheSnapshot(hash: string, bundle: ConfigDraftBundle): void {
	validatedSnapshotCache.set(hash, bundle);
	if (validatedSnapshotCache.size > VALIDATED_SNAPSHOT_CACHE_LIMIT) {
		const oldest = validatedSnapshotCache.keys().next().value;
		if (oldest !== undefined) {
			validatedSnapshotCache.delete(oldest);
		}
	}
}

/**
 * Freezes `value` and everything inside it (objects and arrays alike), in place: a cached
 * snapshot is read by every caller of `loadActiveBundle` for as long as it stays in
 * `validatedSnapshotCache`, so one caller mutating the bundle it got back would corrupt it for
 * every other reader. `ConfigDraftBundle`'s own `Readonly` is a compile-time annotation only; this
 * is the runtime guarantee.
 */
function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const entry of Object.values(value)) {
			deepFreeze(entry);
		}
	}
	return value;
}

type LoadedBundle = Readonly<{ bundle: ConfigDraftBundle; hash: string | null }>;

/**
 * The bundle behind `revisionId` (null: no revision has ever been recorded, the empty bundle a
 * fresh database starts from), read at the validated boundary: a stored snapshot that does not
 * parse as `ConfigSnapshotBundleSchema` fails clearly here rather than corrupting a change set
 * applied on top of it.
 */
export async function loadActiveBundle(db: Db, revisionId: number | null): Promise<LoadedBundle> {
	if (revisionId === null) {
		return { bundle: EMPTY_DRAFT_BUNDLE, hash: null };
	}
	const [revision] = await db
		.select({ snapshotHash: configRevisions.snapshotHash })
		.from(configRevisions)
		.where(eq(configRevisions.id, revisionId));
	if (revision === undefined) {
		throw new AdminError(`config revision ${revisionId} does not exist`);
	}
	const cached = cachedSnapshot(revision.snapshotHash);
	if (cached !== undefined) {
		return { bundle: cached, hash: revision.snapshotHash };
	}
	const [snapshot] = await db
		.select({ bundle: configSnapshots.bundle })
		.from(configSnapshots)
		.where(eq(configSnapshots.hash, revision.snapshotHash));
	if (snapshot === undefined) {
		throw new AdminError(
			`config snapshot '${revision.snapshotHash}' referenced by revision ${revisionId} does not exist`,
		);
	}
	const parsed = ConfigSnapshotBundleSchema.safeParse(snapshot.bundle);
	if (!parsed.success) {
		throw new AdminError(
			`config snapshot '${revision.snapshotHash}' is malformed: ${parsed.error.issues
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join("; ")}`,
		);
	}
	const bundle = deepFreeze(parsed.data);
	cacheSnapshot(revision.snapshotHash, bundle);
	return { bundle, hash: revision.snapshotHash };
}

/**
 * The revision presently active (null: no configuration has ever been recorded), backfilling
 * history first exactly as `prepareChange` does, so a caller that only wants to know what is
 * active sees the same base a `prepareChange` right after it would report.
 */
export async function activeConfigRevisionId(deps: ControlPlaneDeps): Promise<number | null> {
	await ensureConfigHistory(deps, "system");
	return inTransaction(deps, async ({ tx }) => {
		const [controls] = await tx.db
			.select({ revision: gatewayControls.activeConfigRevision })
			.from(gatewayControls)
			.where(eq(gatewayControls.id, 1));
		return controls?.revision ?? null;
	});
}

/** The `limit` most recent entries of the configuration's chronological journal, newest first. */
export async function listConfigRevisions(deps: ControlPlaneDeps, limit: number) {
	return inTransaction(deps, ({ tx }) =>
		tx.db.select().from(configRevisions).orderBy(desc(configRevisions.id)).limit(limit),
	);
}

/**
 * The revision `commitChange` recorded under `idempotencyKey`, if any (null otherwise). Lets a
 * caller that refuses a request for an unrelated reason — `config import` without
 * `--expected-revision` against a database that already has an active configuration — check first
 * whether this exact request already succeeded (its response lost before the caller saw it) and
 * replay that result instead of refusing a legitimate retry.
 */
export async function findConfigRevisionByIdempotencyKey(
	deps: ControlPlaneDeps,
	idempotencyKey: string,
): Promise<Readonly<{ id: number; hash: string }> | null> {
	return inTransaction(deps, async ({ tx }) => {
		const [row] = await tx.db
			.select({ id: configRevisions.id, hash: configRevisions.snapshotHash })
			.from(configRevisions)
			.where(eq(configRevisions.idempotencyKey, idempotencyKey));
		return row ?? null;
	});
}

// ---------------------------------------------------------------------------
// Applying a change set to a draft bundle
// ---------------------------------------------------------------------------

export type OperationResult = Readonly<{ draft: ConfigDraftBundle; problems: Readonly<string[]> }>;

/**
 * Applies one operation to `draft`, producing the next draft. An operation that cannot apply
 * (e.g. `update_agent` of an agent that does not exist) leaves the draft unchanged and reports a
 * problem instead of throwing, the same way `configBundleProblems` reports whole-bundle issues:
 * every problem found is collected before `prepareChange`/`commitChange` refuses the change set.
 */
function applyOperation(draft: ConfigDraftBundle, op: ChangeOperation): OperationResult {
	switch (op.type) {
		case "replace_bundle":
			return {
				draft: {
					organization: op.bundle.organization,
					agents: op.bundle.agents,
					constitution: op.bundle.constitution,
					rolePrompts: op.bundle.rolePrompts,
				},
				problems: [],
			};
		case "set_constitution":
			return { draft: { ...draft, constitution: op.constitution }, problems: [] };
		case "update_agent": {
			const index = draft.agents.findIndex((agent) => agent.id === op.agent.id);
			if (index === -1) {
				return { draft, problems: [`update_agent: agent '${op.agent.id}' does not exist`] };
			}
			const agents = [...draft.agents];
			agents[index] = op.agent;
			return { draft: { ...draft, agents }, problems: [] };
		}
		case "add_agent": {
			if (draft.agents.some((agent) => agent.id === op.agent.id)) {
				return { draft, problems: [`add_agent: agent '${op.agent.id}' already exists`] };
			}
			return {
				draft: {
					...draft,
					agents: [...draft.agents, op.agent],
					rolePrompts: { ...draft.rolePrompts, [op.agent.id]: op.rolePrompt },
				},
				problems: [],
			};
		}
		case "remove_agent": {
			if (!draft.agents.some((agent) => agent.id === op.agentId)) {
				return { draft, problems: [`remove_agent: agent '${op.agentId}' does not exist`] };
			}
			const rolePrompts = { ...draft.rolePrompts };
			delete rolePrompts[op.agentId];
			return {
				draft: {
					...draft,
					agents: draft.agents.filter((agent) => agent.id !== op.agentId),
					rolePrompts,
				},
				problems: [],
			};
		}
		case "set_role_prompt": {
			if (!draft.agents.some((agent) => agent.id === op.agentId)) {
				return { draft, problems: [`set_role_prompt: agent '${op.agentId}' does not exist`] };
			}
			return {
				draft: { ...draft, rolePrompts: { ...draft.rolePrompts, [op.agentId]: op.rolePrompt } },
				problems: [],
			};
		}
		case "set_agent_enabled": {
			const index = draft.agents.findIndex((agent) => agent.id === op.agentId);
			const current = index === -1 ? undefined : draft.agents[index];
			if (current === undefined) {
				return { draft, problems: [`set_agent_enabled: agent '${op.agentId}' does not exist`] };
			}
			const agents = [...draft.agents];
			agents[index] = { ...current, enabled: op.enabled };
			return { draft: { ...draft, agents }, problems: [] };
		}
	}
}

/**
 * Applies an ordered change set to `base`, in order, collecting every operation's problems (an
 * operation that cannot apply leaves the draft it was given unchanged). Exported for direct unit
 * testing of operation semantics; `prepareChange`/`commitChange` are its only production callers.
 */
export function applyChangeSet(base: ConfigDraftBundle, changeSet: ChangeSet): OperationResult {
	let draft = base;
	const problems: string[] = [];
	for (const operation of changeSet) {
		const result = applyOperation(draft, operation);
		draft = result.draft;
		problems.push(...result.problems);
	}
	return { draft, problems };
}

/** Whole-bundle validation of a draft, the same `configBundleProblems` `applyConfig` uses. */
export function draftBundleProblems(draft: ConfigDraftBundle): string[] {
	if (draft.organization === null) {
		return ["organization: configuration is missing; the first change must replace_bundle"];
	}
	return [
		...configBundleProblems({
			organization: draft.organization,
			agents: draft.agents,
			constitution: draft.constitution,
			rolePrompts: draft.rolePrompts,
		}),
	];
}

// ---------------------------------------------------------------------------
// Structural diff
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((value, index) => deepEqual(value, b[index]))
		);
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
			if (!deepEqual(a[key], b[key])) {
				return false;
			}
		}
		return true;
	}
	return false;
}

/**
 * Dotted paths of the fields that differ between `before` and `after`, recursing into plain
 * objects up to `maxDepth` levels (1: only the given object's own fields). Arrays, and anything
 * past `maxDepth`, are compared whole: a difference anywhere inside one is reported at the path
 * of the whole value, not per element. Deterministic: keys are visited in sorted order.
 */
export function structuralFieldPaths(
	before: unknown,
	after: unknown,
	maxDepth: number,
	prefix = "",
): string[] {
	if (deepEqual(before, after)) {
		return [];
	}
	if (maxDepth <= 0 || !isPlainObject(before) || !isPlainObject(after)) {
		return prefix === "" ? [] : [prefix];
	}
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
	return keys.flatMap((key) =>
		structuralFieldPaths(
			before[key],
			after[key],
			maxDepth - 1,
			prefix === "" ? key : `${prefix}.${key}`,
		),
	);
}

function textChange(before: string, after: string): TextChange {
	return { changed: before !== after, beforeSize: before.length, afterSize: after.length };
}

/**
 * A deterministic structural diff between two draft bundles: every agent added, removed or
 * changed (an unchanged agent — same fields, same role prompt — is left out entirely), the
 * organization's changed field paths, and the constitution's change. An agent's own fields are
 * compared one level deep (`fieldPaths` names top-level `AgentConfig` keys, e.g. `"runtime"`);
 * the organization is compared all the way down, since its fields are the operator-facing detail
 * a console or reviewing agent needs.
 */
export function configDiff(before: ConfigDraftBundle, after: ConfigDraftBundle): ConfigDiff {
	const beforeAgents = new Map(before.agents.map((agent) => [agent.id, agent]));
	const afterAgents = new Map(after.agents.map((agent) => [agent.id, agent]));
	const ids = [...new Set([...beforeAgents.keys(), ...afterAgents.keys()])].sort();
	const agents: ConfigDiffAgent[] = [];
	for (const id of ids) {
		const beforeAgent = beforeAgents.get(id);
		const afterAgent = afterAgents.get(id);
		if (beforeAgent === undefined) {
			agents.push({ kind: "added", agentId: id });
			continue;
		}
		if (afterAgent === undefined) {
			agents.push({ kind: "removed", agentId: id });
			continue;
		}
		const fieldPaths = structuralFieldPaths(beforeAgent, afterAgent, 1);
		const rolePrompt = textChange(before.rolePrompts[id] ?? "", after.rolePrompts[id] ?? "");
		if (fieldPaths.length === 0 && !rolePrompt.changed) {
			continue;
		}
		agents.push({ kind: "changed", agentId: id, fieldPaths, rolePrompt });
	}
	return {
		agents,
		organizationFieldPaths: structuralFieldPaths(
			before.organization ?? {},
			after.organization ?? {},
			Number.POSITIVE_INFINITY,
		),
		constitution: textChange(before.constitution, after.constitution),
	};
}

// ---------------------------------------------------------------------------
// Prepare / commit
// ---------------------------------------------------------------------------

/**
 * Whether the live `agents.enabled` column disagrees with `expected` for any of these agents, or
 * there is a live agent enabled that `expected` does not even name at all — evidence that an
 * operational toggle ran since whatever recorded `expected` (a snapshot's own `enabled` flags, or
 * a resolved bundle's). A database upgraded from before this service existed could have been
 * toggled that way, and a release before `gateway agent enable|disable` went through configuration
 * history could have been too (including one re-enabling a row after its agent had already left
 * the bundle `expected` comes from: still actually running — `loadAgents` reads every row — but
 * absent from `expected` precisely because it is absent from the bundle); either leaves the
 * projection the one source of truth, since nothing else recorded the change. A missing row for an
 * agent `expected` does name counts as divergent too (there is nothing to compare, so the
 * projection cannot be trusted to agree). Exported for direct testing of the "an enabled row
 * `expected` does not name" case: reaching it through `prepareChange`/`commitChange` themselves is
 * difficult in practice, since both call `ensureConfigHistory` first, which backfills the very
 * same drift into `expected` before this function ever runs — this check is the second,
 * independent place the same invariant is enforced, not the usual path it is caught by.
 */
export async function liveEnabledDiverges(
	db: Db,
	expected: ReadonlyMap<string, boolean>,
): Promise<boolean> {
	const rows = await db
		.select({ id: agents.id, enabled: agents.enabled })
		.from(agents)
		.where(
			expected.size === 0
				? eq(agents.enabled, true)
				: or(inArray(agents.id, [...expected.keys()]), eq(agents.enabled, true)),
		);
	const byId = new Map(rows.map((row) => [row.id, row.enabled]));
	for (const [id, enabled] of expected) {
		if (byId.get(id) !== enabled) {
			return true;
		}
	}
	return rows.some((row) => row.enabled && !expected.has(row.id));
}

function enabledById(bundleAgents: Readonly<AgentConfig[]>): ReadonlyMap<string, boolean> {
	return new Map(bundleAgents.map((agent) => [agent.id, agent.enabled]));
}

/**
 * A read-only preview of applying `changeSet` to the active configuration, except for the history
 * backfill: a database whose revision is missing or stale (an upgrade, or an operational toggle
 * that bypassed configuration history — see `liveEnabledDiverges`) is backfilled first, in its own
 * committed transaction, exactly as `commitChange` and the controller's own startup do — so the
 * base this preview reports, and the one `commitChange` will actually compare against, agree.
 * Deterministic for the same inputs once that backfill has happened; never writes anything beyond
 * it.
 */
export type ChangePreview = Readonly<{
	baseRevisionId: number | null;
	baseHash: string | null;
	newHash: string;
	/** `newHash === baseHash`: committing this change set would write nothing (see `commitChange`). */
	noop: boolean;
	diff: ConfigDiff;
	/** Empty when the resulting bundle is valid; otherwise `commitChange` would refuse it too. */
	problems: Readonly<string[]>;
}>;

export async function prepareChange(
	deps: ControlPlaneDeps,
	changeSet: ChangeSetInput,
): Promise<ChangePreview> {
	// Its own committed transaction: a stale or missing revision must not be rediscovered, and
	// re-rolled-back, every time a conflicting commit is attempted afterward (see `commitChange`).
	await ensureConfigHistory(deps, "system");
	// A console or an agent hands this a value it parsed from JSON, not necessarily one a
	// `ChangeOperationSchema` would accept; shape problems are reported here, never thrown, so
	// prepare always returns a preview.
	const shape = ChangeSetSchema.safeParse(changeSet);
	return inTransaction(deps, async ({ tx }) => {
		const { db } = tx;
		const [controls] = await db
			.select({ revision: gatewayControls.activeConfigRevision })
			.from(gatewayControls)
			.where(eq(gatewayControls.id, 1));
		const baseRevisionId = controls?.revision ?? null;
		const { bundle: base, hash: baseHash } = await loadActiveBundle(db, baseRevisionId);
		if (!shape.success) {
			return {
				baseRevisionId,
				baseHash,
				newHash: baseHash ?? previewHash(base),
				noop: false,
				diff: configDiff(base, base),
				problems: shape.error.issues.map(
					(issue) => `changeSet: ${issue.path.join(".")}: ${issue.message}`,
				),
			};
		}
		const { draft, problems: opProblems } = applyChangeSet(base, shape.data);
		const problems = [...opProblems, ...draftBundleProblems(draft)];
		const newHash = previewHash(draft);
		const noop =
			problems.length === 0 &&
			baseHash !== null &&
			baseHash === newHash &&
			!(await liveEnabledDiverges(db, enabledById(draft.agents)));
		return {
			baseRevisionId,
			baseHash,
			newHash,
			noop,
			diff: configDiff(base, draft),
			problems,
		};
	});
}

/**
 * The same preview `prepareChange` computes, against a base bundle the caller has already loaded
 * (its own `baseRevisionId`/hash) instead of re-reading whatever is live right now. A caller that
 * has already confirmed its own base is still the active revision — and so must keep validating
 * against exactly that snapshot, never a live state that may have moved on since — uses this
 * instead of `prepareChange`: the console's disable-with-fallback-to-`remove_agent` resolution
 * (`resolveEnabledChangeSet`) and its plain change-set validation both rely on this to keep a
 * change set's validity a pure function of (`baseRevisionId`, the patch), which is what lets an
 * idempotent retry replay safely rather than recomputing a plan that could disagree with its own
 * first attempt purely because an unrelated, intervening change had moved live state on by the
 * time the retry ran (see `commitChange`'s own idempotency check). The one DB read this still
 * performs — `liveEnabledDiverges`, for `noop` — is advisory only (whether anything would actually
 * need writing), never load-bearing for `problems`, so a race against it threatens nothing this
 * determinism depends on.
 */
export async function previewChangeSetAgainst(
	deps: ControlPlaneDeps,
	baseRevisionId: number | null,
	base: ConfigDraftBundle,
	baseHash: string | null,
	changeSet: ChangeSetInput,
): Promise<ChangePreview> {
	const shape = ChangeSetSchema.safeParse(changeSet);
	if (!shape.success) {
		return {
			baseRevisionId,
			baseHash,
			newHash: baseHash ?? previewHash(base),
			noop: false,
			diff: configDiff(base, base),
			problems: shape.error.issues.map(
				(issue) => `changeSet: ${issue.path.join(".")}: ${issue.message}`,
			),
		};
	}
	const { draft, problems: opProblems } = applyChangeSet(base, shape.data);
	const problems = [...opProblems, ...draftBundleProblems(draft)];
	const newHash = previewHash(draft);
	const noop =
		problems.length === 0 &&
		baseHash !== null &&
		baseHash === newHash &&
		!(await inTransaction(deps, ({ tx }) => liveEnabledDiverges(tx.db, enabledById(draft.agents))));
	return { baseRevisionId, baseHash, newHash, noop, diff: configDiff(base, draft), problems };
}

/** The active configuration changed since `baseRevisionId`; retry against `currentRevisionId`. */
export class ManagementConflictError extends Error {
	constructor(readonly currentRevisionId: number | null) {
		super(
			currentRevisionId === null
				? "the base revision is stale: there is no active configuration anymore"
				: `the base revision is stale: the active revision is now ${currentRevisionId}`,
		);
		this.name = "ManagementConflictError";
	}
}

/** What the commit transaction settled on; a conflict is thrown only once it has committed. */
export type CommitOutcome =
	| Readonly<{ kind: "committed"; result: CommitChangeResult }>
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>;

export type CommitChangeInput = Readonly<{
	changeSet: ChangeSetInput;
	/** The revision `changeSet` was prepared against (`prepareChange`'s `baseRevisionId`). */
	baseRevisionId: number | null;
	/** A repeated commit with the same key returns the first commit's result; see `commitChange`. */
	idempotencyKey?: string;
	actor: string;
	source: ConfigRevisionSource;
	reason?: string;
}>;

export type CommitChangeResult = Readonly<{
	revisionId: number;
	hash: string;
	/** The change set resolved to the same content already active; nothing was written. */
	noop: boolean;
	/**
	 * This result came from an earlier commit under the same idempotency key, not from writing
	 * (or evaluating a no-op against) the active configuration just now: `revisionId` may no
	 * longer be the active revision — something else may have committed since — which
	 * `activeRevisionId` names.
	 */
	replayed: boolean;
	/** The revision active right now; equal to `revisionId` unless `replayed` and superseded. */
	activeRevisionId: number | null;
}>;

/**
 * Shape-checks everything a caller supplies, beyond what the `CommitChangeInput`/`ChangeSet`
 * TypeScript types alone guarantee: a console or an agent hands this service data it parsed from
 * JSON, not necessarily values a `ChangeOperationSchema` would accept.
 */
function checkCommitChangeInput(
	input: CommitChangeInput,
): Readonly<{ problems: Readonly<string[]>; changeSet: ChangeSet | null }> {
	const problems: string[] = [];
	const changeSet = ChangeSetSchema.safeParse(input.changeSet);
	if (!changeSet.success) {
		problems.push(
			...changeSet.error.issues.map(
				(issue) => `changeSet: ${issue.path.join(".")}: ${issue.message}`,
			),
		);
	}
	const source = ConfigRevisionSourceSchema.safeParse(input.source);
	if (!source.success) {
		problems.push(...source.error.issues.map((issue) => `source: ${issue.message}`));
	}
	if (input.reason !== undefined) {
		const reason = ConfigRevisionReasonSchema.safeParse(input.reason);
		if (!reason.success) {
			problems.push(...reason.error.issues.map((issue) => `reason: ${issue.message}`));
		}
	}
	if (input.idempotencyKey !== undefined) {
		const key = IdempotencyKeySchema.safeParse(input.idempotencyKey);
		if (!key.success) {
			problems.push(...key.error.issues.map((issue) => `idempotencyKey: ${issue.message}`));
		}
	}
	return { problems, changeSet: changeSet.success ? changeSet.data : null };
}

/**
 * `/run/bot-secrets/` is the lifecycle provisioner's own directory (ADR-026): naming it in
 * `token_secret_file` is refused for any agent that is not lifecycle-owned (its operation journal
 * names a `create` or `restore`) or one `trustedAgentIds` names (the lifecycle's own commit of the
 * very `create` that is about to own it, whose own `agent_lifecycle_operations` row this same
 * transaction has not written yet). Every other agent naming it — a plain console edit, a CLI
 * import, a YAML `config apply` — is refused: an operator or a model configuring a token path
 * under the controller's own read-write directory could otherwise collide with, or silently steal,
 * a token the provisioner manages.
 */
async function rejectUnownedBotSecretPaths(
	db: Db,
	draftAgents: Readonly<AgentConfig[]>,
	trustedAgentIds: ReadonlySet<AgentId>,
): Promise<Readonly<string[]>> {
	const candidates = draftAgents.filter((agent) =>
		agent.mattermost.token_secret_file.startsWith(BOT_SECRET_FILE_PREFIX),
	);
	if (candidates.length === 0) {
		return [];
	}
	const owned = await lifecycleOwnedAgentIds(
		db,
		candidates.map((agent) => agent.id),
	);
	return candidates
		.filter((agent) => !trustedAgentIds.has(agent.id) && !owned.has(agent.id))
		.map(
			(agent) =>
				`agent ${agent.id}: token_secret_file '${agent.mattermost.token_secret_file}' is under ` +
				"the lifecycle provisioner's own directory, but this agent was not created or restored " +
				"through the lifecycle",
		);
}

/** The nearest `AgentLifecycleSource` for a configuration commit's own `ConfigRevisionSource`: a
 * console edit stays `console`, an agent's own proposal stays `agent`, and every CLI-driven source
 * this journal has (`cli_apply`, `import`, `rollback`, `backfill`) maps to the lifecycle's own,
 * narrower `cli` — the reverse of `configRevisionSourceOf` (`agent-lifecycle.ts`), kept local here
 * since only this module's own auto-queued `reprovision` operations need it. */
function agentLifecycleSourceOf(source: ConfigRevisionSource): AgentLifecycleSource {
	return source === "console" || source === "agent" ? source : "cli";
}

/** Whether `a` and `b` name the same channels, regardless of order. */
function sameChannels(a: Readonly<string[]>, b: Readonly<string[]>): boolean {
	const setA = new Set(a);
	const setB = new Set(b);
	return setA.size === setB.size && [...setA].every((name) => setB.has(name));
}

/**
 * Queues a `reprovision` operation for every lifecycle-owned, `ready` agent whose committed
 * `allowed_channels` just changed (console patch, CLI import — any path `commitChangeIn` commits):
 * the provisioner picks it up like any other pending operation, joining newly configured channels
 * and leaving channels no longer configured (ADR-026). Deduped: an agent whose current operation is
 * already a `pending` `reprovision` keeps it rather than queuing a second one — the provisioner
 * reads the agent's live configuration when it finally runs, so one pending operation already
 * covers every edit made before it starts. An agent not lifecycle-owned, or not currently `ready`
 * (still being created or restored, already retiring or retired, or failed), is left alone: its own
 * operation already owns reconciling its membership, or nothing here should touch it.
 */
async function queueMembershipReprovisioning(
	uow: UnitOfWork,
	base: ConfigDraftBundle,
	draft: ConfigDraftBundle,
	revisionId: number,
	actor: string,
	source: ConfigRevisionSource,
): Promise<void> {
	const { db } = uow.tx;
	const beforeById = new Map(base.agents.map((agent) => [agent.id, agent]));
	for (const after of draft.agents) {
		const before = beforeById.get(after.id);
		if (
			before === undefined ||
			sameChannels(before.mattermost.allowed_channels, after.mattermost.allowed_channels)
		) {
			continue;
		}
		const [lifecycle] = await db
			.select()
			.from(agentLifecycle)
			.where(eq(agentLifecycle.agentId, after.id))
			.for("update");
		if (lifecycle === undefined || lifecycle.status !== "ready") {
			continue;
		}
		const owned = await lifecycleOwnedAgentIds(db, [after.id]);
		if (!owned.has(after.id)) {
			continue;
		}
		if (lifecycle.operationId !== null) {
			const [current] = await db
				.select({ kind: agentLifecycleOperations.kind, state: agentLifecycleOperations.state })
				.from(agentLifecycleOperations)
				.where(eq(agentLifecycleOperations.id, lifecycle.operationId));
			if (current?.kind === "reprovision" && current.state === "pending") {
				continue;
			}
		}
		const operationId = randomUUID();
		const generation = lifecycle.generation + 1;
		await db.insert(agentLifecycleOperations).values({
			id: operationId,
			agentId: after.id,
			kind: "reprovision",
			requestedBy: actor,
			source: agentLifecycleSourceOf(source),
			configRevisionId: revisionId,
			generation,
			state: "pending",
			checkpoints: {},
			createdAt: uow.now,
			updatedAt: uow.now,
		});
		await db
			.update(agentLifecycle)
			.set({ operationId, generation })
			.where(eq(agentLifecycle.agentId, after.id));
		await audit(uow, actor, "agent_lifecycle.reprovision", "agent", after.id, {
			operation_id: operationId,
			revision_id: revisionId,
		});
	}
}

/**
 * {@link commitChange}'s own transactional body, taking an already-open `uow` instead of opening
 * one of its own: `requestAgentCreate`/`requestAgentRetire` (`agent-lifecycle.ts`) call this
 * directly so their own lifecycle rows commit or roll back in the exact same transaction as the
 * configuration change they carry, something the public `commitChange` — which always opens and
 * commits its own transaction — cannot give a caller. `changeSet` is the already-parsed value (see
 * `checkCommitChangeInput`); a caller building its own change set internally (never raw, unparsed
 * request input) passes it directly, skipping a redundant re-parse.
 */
export async function commitChangeIn(
	uow: UnitOfWork,
	input: CommitChangeInput,
	changeSet: ChangeSet,
	/**
	 * Agent ids this commit itself is about to make lifecycle-owned (a `create`'s own agent id),
	 * trusted to claim `/run/bot-secrets/` even though no `agent_lifecycle_operations` row for them
	 * exists yet this same transaction — it is written right after this commit returns
	 * (`requestAgentCreate`). Never set by `commitChange`, the public entry point every untrusted
	 * caller (a console patch, a CLI import) uses: only `agent-lifecycle.ts`'s own internal
	 * `commitWithinLock` may pass this.
	 */
	trustedBotSecretAgentIds: ReadonlySet<AgentId> = new Set(),
): Promise<CommitOutcome> {
	const { db } = uow.tx;
	await db.insert(gatewayControls).values({ id: 1 }).onConflictDoNothing();
	const [controls] = await db
		.select({
			version: gatewayControls.activeConfigVersion,
			generation: gatewayControls.configGeneration,
			revision: gatewayControls.activeConfigRevision,
		})
		.from(gatewayControls)
		.where(eq(gatewayControls.id, 1))
		.for("update");
	const generation = (controls?.generation ?? 0) + 1;

	// Idempotent replay, checked under the lock: by the time a concurrent commit of the same key
	// gets here, an earlier one that already wrote a row has committed and become visible (the
	// lock serializes them), so this never races a conflict it should instead have replayed.
	if (input.idempotencyKey !== undefined) {
		const [existing] = await db
			.select({
				id: configRevisions.id,
				snapshotHash: configRevisions.snapshotHash,
				changeHash: configRevisions.changeHash,
			})
			.from(configRevisions)
			.where(eq(configRevisions.idempotencyKey, input.idempotencyKey));
		if (existing !== undefined) {
			const changeHash = canonicalHash(changeSet);
			if (existing.changeHash !== changeHash) {
				throw new AdminError(
					`idempotency key '${input.idempotencyKey}' was already used with a different change set`,
				);
			}
			return {
				kind: "committed",
				result: {
					revisionId: existing.id,
					hash: existing.snapshotHash,
					noop: false,
					replayed: true,
					activeRevisionId: controls?.revision ?? null,
				},
			};
		}
	}

	const currentRevisionId = await ensureConfigHistoryIn(
		uow,
		{
			version: controls?.version ?? null,
			generation: controls?.generation ?? 0,
			revision: controls?.revision ?? null,
		},
		input.actor,
	);
	if (input.baseRevisionId !== currentRevisionId) {
		if (currentRevisionId !== (controls?.revision ?? null)) {
			// A backfill this transaction just recorded (an older release changed the configuration
			// since `ensureConfigHistory` above): committed with its active pointer, so the conflict
			// names a revision that exists.
			await db
				.update(gatewayControls)
				.set({ activeConfigRevision: currentRevisionId, updatedAt: uow.now })
				.where(eq(gatewayControls.id, 1));
		}
		return { kind: "conflict", currentRevisionId };
	}

	const { bundle: base, hash: baseHash } = await loadActiveBundle(db, currentRevisionId);
	const { draft, problems: opProblems } = applyChangeSet(base, changeSet);
	const problems = [...opProblems, ...draftBundleProblems(draft)];
	if (problems.length > 0) {
		throw new AdminError(`configuration is invalid:\n- ${problems.join("\n- ")}`);
	}
	if (draft.organization === null) {
		throw new AdminError("internal: a validated configuration always has an organization");
	}
	const botSecretProblems = await rejectUnownedBotSecretPaths(
		db,
		draft.agents,
		trustedBotSecretAgentIds,
	);
	if (botSecretProblems.length > 0) {
		throw new AdminError(`configuration is invalid:\n- ${botSecretProblems.join("\n- ")}`);
	}
	const resolvedInput: ConfigApplyInput = {
		organization: draft.organization,
		agents: draft.agents,
		constitution: draft.constitution,
		rolePrompts: draft.rolePrompts,
	};
	const bundle = configSnapshotBundle(resolvedInput);
	const version = canonicalHash(bundle);

	if (
		currentRevisionId !== null &&
		baseHash === version &&
		!(await liveEnabledDiverges(db, enabledById(draft.agents)))
	) {
		return {
			kind: "committed",
			result: {
				revisionId: currentRevisionId,
				hash: version,
				noop: true,
				replayed: false,
				activeRevisionId: currentRevisionId,
			},
		};
	}

	const result = await writeConfigRevisionIn(uow, {
		input: resolvedInput,
		bundle,
		version,
		generation,
		parentRevisionId: currentRevisionId,
		actor: input.actor,
		source: input.source,
		reason: input.reason ?? null,
		idempotencyKey: input.idempotencyKey ?? null,
		changeHash: input.idempotencyKey === undefined ? null : canonicalHash(changeSet),
	});
	await queueMembershipReprovisioning(
		uow,
		base,
		draft,
		result.revisionId,
		input.actor,
		input.source,
	);
	return {
		kind: "committed",
		result: {
			revisionId: result.revisionId,
			hash: result.version,
			noop: false,
			replayed: false,
			activeRevisionId: result.revisionId,
		},
	};
}

/**
 * Applies `changeSet` to the active configuration and commits the result, in one transaction with
 * the same lock order `applyConfig` uses (the `gateway_controls` row first). Conflict: the active
 * revision has moved past `baseRevisionId` — {@link ManagementConflictError} names the revision it
 * moved to, for the caller to re-`prepareChange` against. No-op: the resolved bundle hashes to the
 * same content the base revision already has, and the live `agents.enabled` projection already
 * agrees with it (see `liveEnabledDiverges`) — nothing is written, and the base revision is
 * returned as-is. Idempotency: a commit that actually wrote a revision under `idempotencyKey`
 * returns that same revision on a repeat, even once the base has since moved on (it already
 * succeeded); the same key with a different change set is rejected. A no-op commits nothing and so
 * never stores a key — replaying it just re-evaluates the (still deterministic) no-op outcome.
 */
export async function commitChange(
	deps: ControlPlaneDeps,
	input: CommitChangeInput,
): Promise<CommitChangeResult> {
	// The parsed change set, not the caller's: schema defaults must resolve exactly as they did
	// for `prepareChange`, or a preview could commit as different content (or fail to commit).
	const { problems: inputProblems, changeSet } = checkCommitChangeInput(input);
	if (inputProblems.length > 0 || changeSet === null) {
		throw new AdminError(`change set is invalid:\n- ${inputProblems.join("\n- ")}`);
	}
	// Its own committed transaction, before the one below ever takes the `gateway_controls` lock:
	// a backfill this commit's own attempt discovers it needs must survive even when the commit
	// itself goes on to conflict and roll back (see `prepareChange`).
	await ensureConfigHistory(deps, input.actor);
	const outcome = await inTransaction(deps, (uow) => commitChangeIn(uow, input, changeSet));
	if (outcome.kind === "conflict") {
		throw new ManagementConflictError(outcome.currentRevisionId);
	}
	return outcome.result;
}

export type SetAgentEnabledResult = Readonly<{
	result: CommitChangeResult;
	/**
	 * Disabling this agent while leaving its own stored configuration in the bundle was refused by
	 * whole-bundle validation — an agent retained enabled outside the active snapshot (see
	 * `ensureConfigHistoryIn`), backfilled with its own now-invalid stale configuration — so
	 * `remove_agent` was committed instead. Always false when enabling (there is nothing to remove
	 * a bundle member for) or when a plain disable already validates.
	 */
	removed: boolean;
}>;

/**
 * Enables or disables one agent through the shared change-set path (`gateway agent
 * enable`/`disable`), source `cli_apply`. Disabling an agent whose own configuration no longer
 * validates under the active bundle's current rules cannot be satisfied by `set_agent_enabled`
 * alone: its invalid configuration still fails whole-bundle validation with only its `enabled`
 * flag flipped, which would otherwise make the agent permanently un-disableable. `remove_agent` is
 * committed instead in that case — it was already effectively outside today's configuration, and
 * removing it is what actually resolves the validation problem; its projection row still only
 * becomes disabled, never deleted, the same way `config apply` dropping an agent from YAML always
 * has. A disable that fails for an unrelated reason (the agent does not exist at all, a conflict)
 * is not retried as a removal: the original commit runs and its own refusal is what the caller
 * sees.
 */
export async function setAgentEnabled(
	deps: ControlPlaneDeps,
	agentId: string,
	enabled: boolean,
	actor: string,
): Promise<SetAgentEnabledResult> {
	const disableChangeSet: ChangeSet = [{ type: "set_agent_enabled", agentId, enabled }];
	const preview = await prepareChange(deps, disableChangeSet);
	const commit = (changeSet: ChangeSet, baseRevisionId: number | null) =>
		commitChange(deps, { changeSet, baseRevisionId, actor, source: "cli_apply" });
	if (enabled || preview.problems.length === 0) {
		return { result: await commit(disableChangeSet, preview.baseRevisionId), removed: false };
	}
	const removeChangeSet: ChangeSet = [{ type: "remove_agent", agentId }];
	const removePreview = await prepareChange(deps, removeChangeSet);
	if (removePreview.problems.length > 0) {
		// Not fixable by removal (e.g. the agent does not exist at all): commit the original
		// disable, whose own refusal names the real problem.
		return { result: await commit(disableChangeSet, preview.baseRevisionId), removed: false };
	}
	return { result: await commit(removeChangeSet, removePreview.baseRevisionId), removed: true };
}
