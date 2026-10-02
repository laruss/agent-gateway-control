import {
	type AgentId,
	type AgentPermissions,
	BUILT_IN_EXECUTOR_ACTIONS,
	BUILT_IN_GATEWAY_TOOLS,
	BUILT_IN_NATIVE_CAPABILITIES,
	type ChangeSet,
	type ConfigRevisionSource,
	type JsonObject,
	type RuntimeAdapterId,
	riskFloorAllows,
	type ToolAttachment,
	type ToolAttachmentMode,
	ToolCatalogConfigSchemaSchema,
	type ToolCatalogEntry,
	ToolCatalogEntryDescriptionSchema,
	type ToolCatalogEntryId,
	type ToolCatalogEntryKind,
	ToolCatalogEntryNameSchema,
	type ToolCatalogEntryVersion,
	type ToolCatalogEntryView,
	type ToolCatalogRiskFloor,
	ToolCatalogRiskFloorSchema,
	ToolCatalogSupportedAdaptersSchema,
	type ToolName,
} from "@agent-gateway/contracts";
import {
	catalogAttachments,
	catalogEntries,
	catalogEntryTombstones,
	catalogEntryVersions,
	gatewayControls,
} from "@agent-gateway/db";
import {
	compileAttachments,
	compiledAgentPermissions,
	modeSupportedByKind,
} from "@agent-gateway/policy";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { AdminError, inTransaction } from "./admin.ts";
import { loadCompilableCatalogEntries } from "./attachment-validation.ts";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import {
	knownCatalogEntries,
	type LegacyConversionResult,
	type LegacyUnresolvedPattern,
	legacyAttachmentsFromPermissions,
} from "./effective-permissions.ts";
import {
	activeConfigRevisionId,
	type CommitChangeResult,
	commitChange,
	commitChangeIn,
	loadActiveBundle,
	ManagementConflictError,
} from "./management.ts";
import type { RuntimeHealth } from "./runtime-health.ts";
import { audit } from "./store.ts";

type Db = UnitOfWork["tx"]["db"];

// ---------------------------------------------------------------------------
// Built-ins this release actually has (ADR-027)
// ---------------------------------------------------------------------------

type BuiltInSeed = Readonly<{
	id: ToolCatalogEntryId;
	kind: ToolCatalogEntryKind;
	implementationKey: ToolName;
	name: string;
	description: string;
	riskFloor: ToolCatalogRiskFloor;
	supportedAdapters: Readonly<RuntimeAdapterId[]>;
}>;

/** `native-repository-read`, `gateway-mattermost-post`, `executor-finance-payment-create`: stable
 * and deterministic, so reseeding always computes the same id for the same built-in. */
function builtInEntryId(kind: ToolCatalogEntryKind, implementationKey: string): ToolCatalogEntryId {
	return `${kind}-${implementationKey.replaceAll(".", "-")}`;
}

const NATIVE_ADAPTERS_BY_TOOL = new Map(
	BUILT_IN_NATIVE_CAPABILITIES.map((capability) => [capability.toolName, capability.adapters]),
);

function nativeSeed(toolName: ToolName, name: string, description: string): BuiltInSeed {
	return {
		id: builtInEntryId("native", toolName),
		kind: "native",
		implementationKey: toolName,
		name,
		description,
		riskFloor: "allow",
		supportedAdapters: NATIVE_ADAPTERS_BY_TOOL.get(toolName) ?? [],
	};
}

function gatewaySeed(toolName: ToolName, name: string, description: string): BuiltInSeed {
	return {
		id: builtInEntryId("gateway", toolName),
		kind: "gateway",
		implementationKey: toolName,
		name,
		description,
		riskFloor: "allow",
		supportedAdapters: [],
	};
}

function executorSeed(actionType: ToolName, name: string, description: string): BuiltInSeed {
	return {
		id: builtInEntryId("executor", actionType),
		kind: "executor",
		implementationKey: actionType,
		name,
		description,
		riskFloor: "require_approval",
		supportedAdapters: [],
	};
}

/**
 * Every built-in this release ships, computed from the same facts `BUILT_IN_NATIVE_CAPABILITIES`/
 * `BUILT_IN_GATEWAY_TOOLS`/`BUILT_IN_EXECUTOR_ACTIONS` declare — `name`/`description` are product
 * text that belongs here, in `core`, rather than in the IO-free `contracts` package.
 */
function builtInSeeds(): Readonly<BuiltInSeed[]> {
	const native = [
		nativeSeed("repository.read", "Read repository", "Read and search the run workspace's files."),
		nativeSeed("workspace.write", "Write workspace", "Create and edit files in the run workspace."),
		nativeSeed("tests.run", "Run commands", "Run commands (tests, builds) in the run workspace."),
		nativeSeed("web.search", "Web search", "Search the web."),
		nativeSeed("web.fetch", "Web fetch", "Fetch a web page or API response."),
	];
	const gateway = [
		gatewaySeed(
			"mattermost.post",
			"Post to Mattermost",
			"Reply or post in the agent's own Mattermost channels.",
		),
		gatewaySeed("memory.write", "Write memory", "Propose a memory item for review."),
	];
	const executor = [
		executorSeed(
			"finance.payment.create",
			"Create payment",
			"Issue a payment through the finance tool runner.",
		),
		executorSeed(
			"finance.subscription.create",
			"Create subscription",
			"Create a subscription through the finance tool runner.",
		),
	];
	const seeds = [...native, ...gateway, ...executor];
	const knownNative = new Set(BUILT_IN_NATIVE_CAPABILITIES.map((c) => c.toolName));
	const knownGateway = new Set(BUILT_IN_GATEWAY_TOOLS);
	const knownExecutor = new Set(BUILT_IN_EXECUTOR_ACTIONS);
	if (
		knownNative.size !== native.length ||
		knownGateway.size !== gateway.length ||
		knownExecutor.size !== executor.length
	) {
		// Defends against the two lists silently drifting apart: a capability contracts declares
		// that this file forgot to seed (or vice versa) fails loudly instead of being skipped.
		throw new Error("internal: built-in catalog seeds disagree with contracts' built-in lists");
	}
	return seeds;
}

/**
 * Idempotent: inserts every built-in this release ships that is neither already in the catalog
 * nor tombstoned (an owner who deleted a built-in never has it silently come back). Called at
 * controller startup and the start of every CLI session that touches a schema-compatible
 * database, like `ensureConfigHistory`/`ensureAgentLifecycleAdoption`.
 */
export async function ensureToolCatalogSeeded(
	deps: ControlPlaneDeps,
	actor: string,
): Promise<void> {
	const seeds = builtInSeeds();
	await inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		const ids = seeds.map((seed) => seed.id);
		const [existing, tombstoned] = await Promise.all([
			db
				.select({ id: catalogEntries.id })
				.from(catalogEntries)
				.where(inArray(catalogEntries.id, ids)),
			db
				.select({ entryId: catalogEntryTombstones.entryId })
				.from(catalogEntryTombstones)
				.where(inArray(catalogEntryTombstones.entryId, ids)),
		]);
		const skip = new Set([
			...existing.map((row) => row.id),
			...tombstoned.map((row) => row.entryId),
		]);
		const toSeed = seeds.filter((seed) => !skip.has(seed.id));
		if (toSeed.length === 0) {
			return;
		}
		const inserted = await db
			.insert(catalogEntries)
			.values(
				toSeed.map((seed) => ({
					id: seed.id,
					kind: seed.kind,
					implementationKey: seed.implementationKey,
					isBuiltin: true,
					createdAt: uow.now,
				})),
			)
			.onConflictDoNothing()
			.returning({ id: catalogEntries.id });
		const insertedIds = new Set(inserted.map((row) => row.id));
		for (const seed of toSeed.filter((entry) => insertedIds.has(entry.id))) {
			const [version] = await db
				.insert(catalogEntryVersions)
				.values({
					entryId: seed.id,
					version: 1,
					kind: seed.kind,
					implementationKey: seed.implementationKey,
					name: seed.name,
					description: seed.description,
					configSchema: {},
					riskFloor: seed.riskFloor,
					supportedAdapters: [...seed.supportedAdapters],
					createdBy: actor,
					createdAt: uow.now,
				})
				.returning({ id: catalogEntryVersions.id });
			if (version === undefined) {
				throw new AdminError(`seeding catalog entry '${seed.id}' did not return its version id`);
			}
			await db
				.update(catalogEntries)
				.set({ currentVersionId: version.id })
				.where(eq(catalogEntries.id, seed.id));
			await audit(uow, actor, "tool_catalog.seed", "catalog_entry", seed.id, { kind: seed.kind });
		}
	});
}

// ---------------------------------------------------------------------------
// Availability: computed, never stored as truth
// ---------------------------------------------------------------------------

export type ToolCatalogAvailabilityContext = Readonly<{
	/** Adapters with a fresh, ready worker right now (`runtimeHealth`'s own `available`); see
	 * `installedAdaptersFromHealth`. */
	installedAdapters: ReadonlySet<RuntimeAdapterId>;
	/** Executor action types this deployment's tool runner(s) actually registered; empty in
	 * production today (no real integration ships yet — `sandboxExecutors` is development/test
	 * only), supplied by whoever can see that live fact, never guessed here. */
	registeredExecutorActionTypes: ReadonlySet<ToolName>;
}>;

export const EMPTY_AVAILABILITY_CONTEXT: ToolCatalogAvailabilityContext = {
	installedAdapters: new Set(),
	registeredExecutorActionTypes: new Set(),
};

/** `runtimeHealth`'s own result, reduced to the set `ToolCatalogAvailabilityContext` wants. */
export function installedAdaptersFromHealth(
	health: Readonly<RuntimeHealth[]>,
): ReadonlySet<RuntimeAdapterId> {
	return new Set(health.filter((entry) => entry.available).map((entry) => entry.adapter));
}

/**
 * Whether an entry is actually usable in this release/deployment, right now — never stored:
 * `native` needs at least one supported adapter installed; `gateway` is always available (the
 * Gateway itself performs it, not an optional process); `executor` needs its action type actually
 * registered by a running tool runner; `custom_https` is reserved, never available yet.
 */
export function computeCatalogEntryAvailability(
	entry: Readonly<{
		kind: ToolCatalogEntryKind;
		implementationKey: ToolName;
		supportedAdapters: Readonly<RuntimeAdapterId[]>;
	}>,
	context: ToolCatalogAvailabilityContext,
): boolean {
	switch (entry.kind) {
		case "native":
			return entry.supportedAdapters.some((adapter) => context.installedAdapters.has(adapter));
		case "gateway":
			return true;
		case "executor":
			return context.registeredExecutorActionTypes.has(entry.implementationKey);
		case "custom_https":
			return false;
	}
}

/** `ToolCatalogEntry` reduced to what `computeCatalogEntryAvailability` needs of its current
 * version. */
function availabilityOf(entry: ToolCatalogEntry, context: ToolCatalogAvailabilityContext): boolean {
	return computeCatalogEntryAvailability(
		{
			kind: entry.kind,
			implementationKey: entry.implementationKey,
			supportedAdapters: entry.currentVersion.supportedAdapters,
		},
		context,
	);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function toEntry(row: {
	id: ToolCatalogEntryId;
	kind: ToolCatalogEntryKind;
	implementationKey: ToolName;
	isBuiltin: boolean;
	createdAt: Date;
	versionId: number;
	version: number;
	versionKind: ToolCatalogEntryKind;
	versionImplementationKey: ToolName;
	name: string;
	description: string;
	configSchema: JsonObject;
	riskFloor: ToolCatalogRiskFloor;
	supportedAdapters: RuntimeAdapterId[];
	versionCreatedBy: string;
	versionCreatedAt: Date;
}): ToolCatalogEntry {
	return {
		id: row.id,
		kind: row.kind,
		implementationKey: row.implementationKey,
		isBuiltin: row.isBuiltin,
		createdAt: row.createdAt.toISOString(),
		currentVersion: {
			id: row.versionId,
			entryId: row.id,
			version: row.version,
			kind: row.versionKind,
			implementationKey: row.versionImplementationKey,
			name: row.name,
			description: row.description,
			configSchema: row.configSchema,
			riskFloor: row.riskFloor,
			supportedAdapters: row.supportedAdapters,
			createdBy: row.versionCreatedBy,
			createdAt: row.versionCreatedAt.toISOString(),
		},
	};
}

const ENTRY_WITH_CURRENT_VERSION_COLUMNS = {
	id: catalogEntries.id,
	kind: catalogEntries.kind,
	implementationKey: catalogEntries.implementationKey,
	isBuiltin: catalogEntries.isBuiltin,
	createdAt: catalogEntries.createdAt,
	versionId: catalogEntryVersions.id,
	version: catalogEntryVersions.version,
	versionKind: catalogEntryVersions.kind,
	versionImplementationKey: catalogEntryVersions.implementationKey,
	name: catalogEntryVersions.name,
	description: catalogEntryVersions.description,
	configSchema: catalogEntryVersions.configSchema,
	riskFloor: catalogEntryVersions.riskFloor,
	supportedAdapters: catalogEntryVersions.supportedAdapters,
	versionCreatedBy: catalogEntryVersions.createdBy,
	versionCreatedAt: catalogEntryVersions.createdAt,
} as const;

/** `entryId`'s current version, when it exists and is not deleted (`deleteCatalogEntry`'s own
 * fix): a deleted entry's row stays, for its past versions and any historical attachment that
 * once named it to stay referenceable, but it is never again attachable, editable or listed as
 * active — this is the one place that exclusion is enforced for every reader below. */
async function loadEntry(db: Db, entryId: string): Promise<ToolCatalogEntry | null> {
	const [row] = await db
		.select(ENTRY_WITH_CURRENT_VERSION_COLUMNS)
		.from(catalogEntries)
		.innerJoin(catalogEntryVersions, eq(catalogEntries.currentVersionId, catalogEntryVersions.id))
		.where(and(eq(catalogEntries.id, entryId), isNull(catalogEntries.deletedAt)));
	return row === undefined ? null : toEntry(row);
}

/** Every active (not deleted) catalog entry with its current version, availability computed
 * fresh, sorted by id. */
export async function listCatalogEntries(
	deps: ControlPlaneDeps,
	context: ToolCatalogAvailabilityContext,
): Promise<Readonly<ToolCatalogEntryView[]>> {
	return inTransaction(deps, async ({ tx }) => {
		const rows = await tx.db
			.select(ENTRY_WITH_CURRENT_VERSION_COLUMNS)
			.from(catalogEntries)
			.innerJoin(catalogEntryVersions, eq(catalogEntries.currentVersionId, catalogEntryVersions.id))
			.where(isNull(catalogEntries.deletedAt))
			.orderBy(asc(catalogEntries.id));
		return rows.map((row) => {
			const entry = toEntry(row);
			return { ...entry, available: availabilityOf(entry, context) };
		});
	});
}

export async function getCatalogEntry(
	deps: ControlPlaneDeps,
	entryId: string,
	context: ToolCatalogAvailabilityContext,
): Promise<ToolCatalogEntryView | null> {
	const entry = await inTransaction(deps, ({ tx }) => loadEntry(tx.db, entryId));
	return entry === null ? null : { ...entry, available: availabilityOf(entry, context) };
}

/** `entryId`'s full version history, oldest first. */
export async function listCatalogEntryVersions(
	deps: ControlPlaneDeps,
	entryId: string,
): Promise<Readonly<ToolCatalogEntryVersion[]>> {
	return inTransaction(deps, async ({ tx }) => {
		const rows = await tx.db
			.select()
			.from(catalogEntryVersions)
			.where(eq(catalogEntryVersions.entryId, entryId))
			.orderBy(asc(catalogEntryVersions.version));
		return rows.map((row) => ({
			id: row.id,
			entryId: row.entryId,
			version: row.version,
			kind: row.kind,
			implementationKey: row.implementationKey,
			name: row.name,
			description: row.description,
			configSchema: row.configSchema,
			riskFloor: row.riskFloor,
			supportedAdapters: row.supportedAdapters,
			createdBy: row.createdBy,
			createdAt: row.createdAt.toISOString(),
		}));
	});
}

// ---------------------------------------------------------------------------
// Editing (a new immutable version) and deleting
// ---------------------------------------------------------------------------

export type EditCatalogEntryInput = Readonly<{
	entryId: string;
	name?: string;
	description?: string;
	configSchema?: JsonObject;
	riskFloor?: ToolCatalogRiskFloor;
	supportedAdapters?: Readonly<RuntimeAdapterId[]>;
	actor: string;
}>;

/**
 * Why `input` cannot apply to a built-in entry: `kind`/`implementationKey` are never part of an
 * edit's own input (an edit cannot repoint what an entry does) and are refused structurally
 * instead; `configSchema`/`riskFloor`/`supportedAdapters` are what a real integration fixes for a
 * built-in, so only `name`/`description` — metadata — stay owner-editable for one. Pure, so the
 * rule is directly unit-testable without a database.
 */
export function builtInEditProblems(
	input: Pick<EditCatalogEntryInput, "configSchema" | "riskFloor" | "supportedAdapters">,
): Readonly<string[]> {
	const problems: string[] = [];
	if (input.configSchema !== undefined) {
		problems.push("configSchema is immutable for a built-in entry");
	}
	if (input.riskFloor !== undefined) {
		problems.push("riskFloor is immutable for a built-in entry");
	}
	if (input.supportedAdapters !== undefined) {
		problems.push("supportedAdapters is immutable for a built-in entry");
	}
	return problems;
}

/**
 * Every field `input` actually supplies, validated against the same contract schemas a version's
 * own fields are parsed with (`ToolCatalogEntryVersionSchema`): a caller's `EditCatalogEntryInput`
 * is a plain TypeScript type, never itself runtime-checked, so without this an out-of-bounds name,
 * description, config schema, risk floor or adapter list would otherwise insert straight into
 * `catalog_entry_versions` unvalidated. Pure, so directly unit-testable without a database.
 */
export function editCatalogEntryInputProblems(input: EditCatalogEntryInput): Readonly<string[]> {
	const problems: string[] = [];
	if (input.name !== undefined) {
		const parsed = ToolCatalogEntryNameSchema.safeParse(input.name);
		if (!parsed.success) {
			problems.push(...parsed.error.issues.map((issue) => `name: ${issue.message}`));
		}
	}
	if (input.description !== undefined) {
		const parsed = ToolCatalogEntryDescriptionSchema.safeParse(input.description);
		if (!parsed.success) {
			problems.push(...parsed.error.issues.map((issue) => `description: ${issue.message}`));
		}
	}
	if (input.configSchema !== undefined) {
		const parsed = ToolCatalogConfigSchemaSchema.safeParse(input.configSchema);
		if (!parsed.success) {
			problems.push(...parsed.error.issues.map((issue) => `configSchema: ${issue.message}`));
		}
	}
	if (input.riskFloor !== undefined) {
		const parsed = ToolCatalogRiskFloorSchema.safeParse(input.riskFloor);
		if (!parsed.success) {
			problems.push(...parsed.error.issues.map((issue) => `riskFloor: ${issue.message}`));
		}
	}
	if (input.supportedAdapters !== undefined) {
		const parsed = ToolCatalogSupportedAdaptersSchema.safeParse(input.supportedAdapters);
		if (!parsed.success) {
			problems.push(...parsed.error.issues.map((issue) => `supportedAdapters: ${issue.message}`));
		}
	}
	return problems;
}

/**
 * Publishes a new, immutable version of `entryId`, copying forward whatever `input` leaves unset.
 * Refused for a built-in entry whose patch touches `configSchema`/`riskFloor`/`supportedAdapters`
 * (`builtInEditProblems`); its `name`/`description` may still change. The entry's own
 * `currentVersion` advances to the new version in the same transaction.
 */
export async function editCatalogEntry(
	deps: ControlPlaneDeps,
	input: EditCatalogEntryInput,
): Promise<ToolCatalogEntry> {
	const inputProblems = editCatalogEntryInputProblems(input);
	if (inputProblems.length > 0) {
		throw new AdminError(
			`editing catalog entry '${input.entryId}':\n- ${inputProblems.join("\n- ")}`,
		);
	}
	return inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		const [entryRow] = await db
			.select({
				id: catalogEntries.id,
				isBuiltin: catalogEntries.isBuiltin,
				deletedAt: catalogEntries.deletedAt,
			})
			.from(catalogEntries)
			.where(eq(catalogEntries.id, input.entryId))
			.for("update");
		if (entryRow === undefined || entryRow.deletedAt !== null) {
			throw new AdminError(`catalog entry '${input.entryId}' does not exist`);
		}
		if (entryRow.isBuiltin) {
			const problems = builtInEditProblems(input);
			if (problems.length > 0) {
				throw new AdminError(
					`editing built-in catalog entry '${input.entryId}':\n- ${problems.join("\n- ")}`,
				);
			}
		}
		const current = await loadEntry(db, input.entryId);
		if (current === null) {
			throw new AdminError(`internal: catalog entry '${input.entryId}' has no current version`);
		}
		const [inserted] = await db
			.insert(catalogEntryVersions)
			.values({
				entryId: input.entryId,
				version: current.currentVersion.version + 1,
				kind: current.kind,
				implementationKey: current.implementationKey,
				name: input.name ?? current.currentVersion.name,
				description: input.description ?? current.currentVersion.description,
				configSchema: input.configSchema ?? current.currentVersion.configSchema,
				riskFloor: input.riskFloor ?? current.currentVersion.riskFloor,
				supportedAdapters: [
					...(input.supportedAdapters ?? current.currentVersion.supportedAdapters),
				],
				createdBy: input.actor,
				createdAt: uow.now,
			})
			.returning({ id: catalogEntryVersions.id });
		if (inserted === undefined) {
			throw new AdminError("creating a new catalog entry version did not return its id");
		}
		await db
			.update(catalogEntries)
			.set({ currentVersionId: inserted.id })
			.where(eq(catalogEntries.id, input.entryId));
		await audit(uow, input.actor, "tool_catalog.edit", "catalog_entry", input.entryId, {
			version: current.currentVersion.version + 1,
		});
		const updated = await loadEntry(db, input.entryId);
		if (updated === null) {
			throw new AdminError("internal: edited catalog entry vanished within its own transaction");
		}
		return updated;
	});
}

/**
 * Deletes `entryId`, removing every agent's attachment of it atomically in the same transaction
 * (one `clear_tool_attachments` change, committed through `commitChangeIn` exactly like any other
 * managed-configuration change — a conflict is retried once against the revision it names, the
 * same bounded retry `requestAgentCreate`/`requestAgentRetire` use); for a built-in entry, a
 * tombstone is written too, so `ensureToolCatalogSeeded` never re-adds it. A failure anywhere
 * rolls back everything: the change set and the attachment-clearing commit, the entry's own
 * `deleted_at`/`deleted_by`, and the tombstone.
 *
 * The entry row itself is never removed — only marked deleted (`deleted_at`/`deleted_by`), its
 * `current_version_id` left exactly as it was: deleting the row outright would FK-fail the very
 * next commit that reinserts a `catalog_attachments` row for it (a rollback, or
 * `requestAgentRestore`, reviving a historical revision that once attached it), making that
 * history permanently unrestorable. A deleted entry stays excluded from every active read
 * (`loadEntry`, so `listCatalogEntries`/`getCatalogEntry`/`checkAttachable` all already treat it
 * as gone) and can never be attached again or un-deleted; its past versions stay exactly as
 * recorded, inspectable (`listCatalogEntryVersions` reads them unfiltered).
 */
export async function deleteCatalogEntry(
	deps: ControlPlaneDeps,
	entryId: string,
	actor: string,
): Promise<void> {
	const MAX_ATTEMPTS = 3;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		const outcome = await inTransaction(deps, async (uow) => {
			const { db } = uow.tx;
			// `gateway_controls` locked first, before `catalog_entries`: the global lock order every
			// configuration writer keeps (`commitChangeIn`'s own first statement locks this row, and
			// `management.ts`'s own `lockLifecycleRows` documents the same convention for its own
			// tables). Locking `catalog_entries` first — as an earlier version of this function did —
			// could deadlock (40P01) against a concurrent `attach_tool`/`update_attachment` commit,
			// which always takes `gateway_controls` first through `commitChangeIn`; this order can
			// only ever serialize against it instead. Read here and reused below, rather than a
			// second, later read: this transaction already holds the lock, so nothing it reads under
			// it can move again before this transaction ends.
			await db.insert(gatewayControls).values({ id: 1 }).onConflictDoNothing();
			const [controls] = await db
				.select({ revision: gatewayControls.activeConfigRevision })
				.from(gatewayControls)
				.where(eq(gatewayControls.id, 1))
				.for("update");
			const [entryRow] = await db
				.select({
					id: catalogEntries.id,
					kind: catalogEntries.kind,
					isBuiltin: catalogEntries.isBuiltin,
					deletedAt: catalogEntries.deletedAt,
				})
				.from(catalogEntries)
				.where(eq(catalogEntries.id, entryId))
				.for("update");
			if (entryRow === undefined || entryRow.deletedAt !== null) {
				throw new AdminError(`catalog entry '${entryId}' does not exist`);
			}
			const affected = await db
				.selectDistinct({ agentId: catalogAttachments.agentId })
				.from(catalogAttachments)
				.where(eq(catalogAttachments.entryId, entryId));
			if (affected.length > 0) {
				const changeSet: ChangeSet = [{ type: "clear_tool_attachments", entryId }];
				const baseRevisionId = controls?.revision ?? null;
				const commit = await commitChangeIn(
					uow,
					{ changeSet, baseRevisionId, actor, source: "cli_apply" },
					changeSet,
				);
				if (commit.kind === "conflict") {
					return { kind: "conflict" as const, currentRevisionId: commit.currentRevisionId };
				}
			}
			await db
				.update(catalogEntries)
				.set({ deletedAt: uow.now, deletedBy: actor })
				.where(eq(catalogEntries.id, entryId));
			// Defensive: the `clear_tool_attachments` commit above already reconciled every live
			// attachment of `entryId` away (when `affected.length > 0`); nothing should be left to
			// delete, but a stale read racing a concurrent attach is cheaper to clean up here than to
			// leave dangling.
			await db.delete(catalogAttachments).where(eq(catalogAttachments.entryId, entryId));
			if (entryRow.isBuiltin) {
				await db.insert(catalogEntryTombstones).values({
					entryId,
					kind: entryRow.kind,
					deletedBy: actor,
					deletedAt: uow.now,
				});
			}
			await audit(uow, actor, "tool_catalog.delete", "catalog_entry", entryId, {
				builtin: entryRow.isBuiltin,
				affectedAgents: affected.length,
			});
			return { kind: "committed" as const };
		});
		if (outcome.kind === "committed") {
			return;
		}
		if (attempt === MAX_ATTEMPTS) {
			throw new ManagementConflictError(outcome.currentRevisionId);
		}
	}
}

// ---------------------------------------------------------------------------
// Legacy conversion and effective permissions (ADR-027) live in `effective-permissions.ts`, a leaf
// module `scheduler.ts`/`approvals.ts` can import without cycling back through `admin.ts`; the
// pieces this file's own bundle-based reads still need are re-exported here so every existing
// import path keeps working.
// ---------------------------------------------------------------------------

export {
	type EffectiveAgentPermissions,
	type KnownCatalogEntry,
	type LegacyConversionResult,
	type LegacyUnresolvedPattern,
	legacyAttachmentsFromPermissions,
	loadEffectivePermissionsIn,
} from "./effective-permissions.ts";

export type AgentToolAttachmentsRead = LegacyConversionResult &
	Readonly<{
		/** `true`: `entryId`'s own attachments were read from the bundle (the owner has attached,
		 * detached or edited at least one for this agent through the hub); `false`: never touched —
		 * `attachments`/`unresolved` are the legacy conversion of its `permissions` lists instead. */
		hubManaged: boolean;
	}>;

/** Per agent, its current attachments and any unresolved legacy pattern (ADR-027): hub-managed
 * agents read their recorded attachments; every other agent is converted from its `permissions`
 * on the fly, against every catalog entry known right now. */
export async function loadAllAgentToolAttachments(
	deps: ControlPlaneDeps,
): Promise<Readonly<Record<AgentId, AgentToolAttachmentsRead>>> {
	return inTransaction(deps, async ({ tx }) => {
		const revisionId = await currentRevisionIdIn(tx.db);
		const { bundle } = await loadActiveBundle(tx.db, revisionId);
		const known = await knownCatalogEntries(tx.db);
		const result: Record<string, AgentToolAttachmentsRead> = {};
		for (const agent of bundle.agents) {
			const recorded = bundle.toolAttachments[agent.id];
			if (recorded !== undefined) {
				result[agent.id] = { attachments: recorded, unresolved: [], hubManaged: true };
				continue;
			}
			result[agent.id] = {
				...legacyAttachmentsFromPermissions(agent.permissions, known),
				hubManaged: false,
			};
		}
		return result;
	});
}

/** `loadAllAgentToolAttachments`, for one agent; throws if the agent does not exist. */
export async function loadAgentToolAttachments(
	deps: ControlPlaneDeps,
	agentId: AgentId,
): Promise<AgentToolAttachmentsRead> {
	const all = await loadAllAgentToolAttachments(deps);
	const entry = all[agentId];
	if (entry === undefined) {
		throw new AdminError(`agent '${agentId}' does not exist`);
	}
	return entry;
}

async function currentRevisionIdIn(db: Db): Promise<number | null> {
	const [controls] = await db
		.select({ revision: gatewayControls.activeConfigRevision })
		.from(gatewayControls)
		.where(eq(gatewayControls.id, 1));
	return controls?.revision ?? null;
}

// ---------------------------------------------------------------------------
// Explicit migration: converting a legacy agent's `permissions` into real, recorded attachments
// (`gateway tools adopt`). Never automatic — ADR-027 requires an owner to ask for this agent by
// name, or `--all`, every time.
// ---------------------------------------------------------------------------

export type AdoptAgentResult = Readonly<{
	agentId: AgentId;
	/** Already hub-managed before this call: left untouched, nothing to adopt. */
	alreadyHubManaged: boolean;
	unresolved: Readonly<LegacyUnresolvedPattern[]>;
	/** The agent's effective permissions before adoption (its `permissions` lists, or — for an
	 * agent already hub-managed — its current compiled attachments, unchanged by this call). */
	before: AgentPermissions;
	/** The agent's effective permissions once its resolved attachments are compiled: identical in
	 * effect to `before` whenever every pattern resolved, the whole point of a safe migration. */
	after: AgentPermissions;
	/** The attachments this call resolved (and, unless `dryRun` or `problems` is non-empty,
	 * committed) for this agent; empty when there was nothing to resolve. */
	attachments: Readonly<ToolAttachment[]>;
	/** A resolved pattern's mode its own catalog entry's `kind` does not support
	 * (`modeSupportedByKind`): a legacy `permissions` list naming a pattern in a way the catalog
	 * model cannot express (e.g. a native tool in `tools_require_human_approval`, which has no
	 * enforcement point that can pause a turn for a human). Non-empty: nothing is committed, even
	 * when `dryRun` is false — the same refusal `attachTool`/the commit boundary would give, found
	 * before attempting it. */
	problems: Readonly<string[]>;
	/** `null` when nothing was committed (`dryRun`, already hub-managed, `problems` non-empty, or
	 * nothing resolved). */
	commit: CommitChangeResult | null;
}>;

export type AdoptToolAttachmentsInput = Readonly<{
	/** Explicit agent ids, or every currently configured agent (`--all`). */
	agentIds: Readonly<AgentId[]>;
	dryRun: boolean;
	actor: string;
	reason?: string;
}>;

/**
 * Converts each named agent's current `permissions` lists into real, recorded attachments
 * (`legacyAttachmentsFromPermissions`), one committed revision per agent (never combined: a batch
 * of many agents' attachments could exceed `MAX_CHANGE_SET_OPERATIONS`, and one agent's adoption
 * failing must never block another's). An agent already hub-managed is left alone and reported as
 * such — adopting it again would silently overwrite real, deliberate attachments with a legacy
 * reconstruction of a `permissions` list the hub may have long since stopped reflecting.
 * `dryRun` resolves and previews every agent (including the catalog-constraint check every other
 * write path shares) without committing anything.
 */
export async function adoptAgentToolAttachments(
	deps: ControlPlaneDeps,
	input: AdoptToolAttachmentsInput,
): Promise<Readonly<AdoptAgentResult[]>> {
	const all = await loadAllAgentToolAttachments(deps);
	const results: AdoptAgentResult[] = [];
	for (const agentId of input.agentIds) {
		const read = all[agentId];
		if (read === undefined) {
			throw new AdminError(`agent '${agentId}' does not exist`);
		}
		results.push(await adoptOneAgent(deps, agentId, read, input));
	}
	return results;
}

async function adoptOneAgent(
	deps: ControlPlaneDeps,
	agentId: AgentId,
	read: AgentToolAttachmentsRead,
	input: AdoptToolAttachmentsInput,
): Promise<AdoptAgentResult> {
	const { bundle } = await inTransaction(deps, async ({ tx }) => {
		const revisionId = await currentRevisionIdIn(tx.db);
		return loadActiveBundle(tx.db, revisionId);
	});
	const agent = bundle.agents.find((a) => a.id === agentId);
	if (agent === undefined) {
		throw new AdminError(`agent '${agentId}' does not exist`);
	}
	const financeAgentId = bundle.organization?.organization.finance_agent_id ?? "";
	const catalog = await inTransaction(deps, ({ tx }) =>
		loadCompilableCatalogEntries(tx.db, { [agentId]: [...read.attachments] }),
	);
	const compiled = compileAttachments({
		agentId,
		financeAgentId,
		adapter: agent.runtime.adapter,
		attachments: read.attachments,
		catalog,
	});
	const compiledPermissions = compiledAgentPermissions(compiled, {
		agentId,
		financeAgentId,
		observeSystem: agent.permissions.observe_system === true,
	});
	if (read.hubManaged) {
		return {
			agentId,
			alreadyHubManaged: true,
			unresolved: [],
			before: compiledPermissions,
			after: compiledPermissions,
			attachments: read.attachments,
			problems: [],
			commit: null,
		};
	}
	const problems = read.attachments.flatMap((attachment) => {
		const entry = catalog.get(attachment.entryId);
		if (entry === undefined) {
			return [`catalog entry '${attachment.entryId}' does not exist`];
		}
		return modeSupportedByKind(entry.kind, attachment.mode)
			? []
			: [
					`catalog entry '${attachment.entryId}' (kind '${entry.kind}') does not support mode ` +
						`'${attachment.mode}'`,
				];
	});
	if (problems.length > 0) {
		return {
			agentId,
			alreadyHubManaged: false,
			unresolved: read.unresolved,
			before: agent.permissions,
			after: agent.permissions,
			attachments: read.attachments,
			problems,
			commit: null,
		};
	}
	if (read.attachments.length === 0 || input.dryRun) {
		return {
			agentId,
			alreadyHubManaged: false,
			unresolved: read.unresolved,
			before: agent.permissions,
			after: read.attachments.length === 0 ? agent.permissions : compiledPermissions,
			attachments: read.attachments,
			problems: [],
			commit: null,
		};
	}
	const changeSet: ChangeSet = read.attachments.map((attachment) => ({
		type: "attach_tool",
		agentId,
		entryId: attachment.entryId,
		pinnedVersion: attachment.pinnedVersion,
		mode: attachment.mode,
		settings: attachment.settings,
	}));
	const baseRevisionId = await activeConfigRevisionId(deps);
	const commit = await commitChange(deps, {
		changeSet,
		baseRevisionId,
		actor: input.actor,
		source: "cli_apply",
		...(input.reason === undefined ? {} : { reason: input.reason }),
	});
	return {
		agentId,
		alreadyHubManaged: false,
		unresolved: read.unresolved,
		before: agent.permissions,
		after: compiledPermissions,
		attachments: read.attachments,
		problems: [],
		commit,
	};
}

// ---------------------------------------------------------------------------
// Attach / detach / update an agent's binding
// ---------------------------------------------------------------------------

/** Re-exported for direct unit testing from this module, the same way it always has been; the
 * rule itself now lives in `@agent-gateway/contracts` (`riskFloorAllows`), shared with
 * `management.ts`'s own catalog-constraint check so neither copy can drift from the other. */
export { riskFloorAllows };

async function checkAttachable(
	deps: ControlPlaneDeps,
	entryId: string,
	pinnedVersion: number | null,
	mode: ToolAttachmentMode,
): Promise<void> {
	const entry = await inTransaction(deps, ({ tx }) => loadEntry(tx.db, entryId));
	if (entry === null) {
		throw new AdminError(`catalog entry '${entryId}' does not exist`);
	}
	if (!riskFloorAllows(mode, entry.currentVersion.riskFloor)) {
		throw new AdminError(
			`catalog entry '${entryId}' requires at least 'require_approval' (its risk floor)`,
		);
	}
	if (!modeSupportedByKind(entry.kind, mode)) {
		throw new AdminError(
			`catalog entry '${entryId}' (kind '${entry.kind}') does not support mode '${mode}'`,
		);
	}
	if (pinnedVersion !== null) {
		const versions = await listCatalogEntryVersions(deps, entryId);
		if (!versions.some((version) => version.version === pinnedVersion)) {
			throw new AdminError(`catalog entry '${entryId}' has no version ${pinnedVersion}`);
		}
	}
}

export type AttachToolInput = Readonly<{
	agentId: AgentId;
	entryId: string;
	/** `null` tracks the entry's current version; a positive integer pins it. */
	pinnedVersion: number | null;
	mode: ToolAttachmentMode;
	settings?: JsonObject;
	actor: string;
	source: ConfigRevisionSource;
	idempotencyKey?: string;
	reason?: string;
}>;

/** Binds (or rebinds) `input.entryId` to `input.agentId`, through the managed-configuration
 * writer: a config revision records it, and rollback/export/import cover it (ADR-027). */
export async function attachTool(
	deps: ControlPlaneDeps,
	input: AttachToolInput,
): Promise<CommitChangeResult> {
	await checkAttachable(deps, input.entryId, input.pinnedVersion, input.mode);
	const changeSet: ChangeSet = [
		{
			type: "attach_tool",
			agentId: input.agentId,
			entryId: input.entryId,
			pinnedVersion: input.pinnedVersion,
			mode: input.mode,
			settings: input.settings ?? {},
		},
	];
	const baseRevisionId = await activeConfigRevisionId(deps);
	return commitChange(deps, {
		changeSet,
		baseRevisionId,
		actor: input.actor,
		source: input.source,
		...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
		...(input.reason === undefined ? {} : { reason: input.reason }),
	});
}

export type DetachToolInput = Readonly<{
	agentId: AgentId;
	entryId: string;
	actor: string;
	source: ConfigRevisionSource;
	idempotencyKey?: string;
	reason?: string;
}>;

/** Removes `input.agentId`'s attachment of `input.entryId`; a no-op (still a fresh revision, per
 * `commitChange`'s own convention) when it has none. */
export async function detachTool(
	deps: ControlPlaneDeps,
	input: DetachToolInput,
): Promise<CommitChangeResult> {
	const changeSet: ChangeSet = [
		{ type: "detach_tool", agentId: input.agentId, entryId: input.entryId },
	];
	const baseRevisionId = await activeConfigRevisionId(deps);
	return commitChange(deps, {
		changeSet,
		baseRevisionId,
		actor: input.actor,
		source: input.source,
		...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
		...(input.reason === undefined ? {} : { reason: input.reason }),
	});
}

export type UpdateAttachmentInput = Readonly<{
	agentId: AgentId;
	entryId: string;
	pinnedVersion?: number | null;
	mode?: ToolAttachmentMode;
	settings?: JsonObject;
	actor: string;
	source: ConfigRevisionSource;
	idempotencyKey?: string;
	reason?: string;
}>;

/** Patches an existing attachment's own fields, leaving the rest unchanged; refused when
 * `input.agentId` has no attachment of `input.entryId` yet (`attachTool` first). */
export async function updateAttachment(
	deps: ControlPlaneDeps,
	input: UpdateAttachmentInput,
): Promise<CommitChangeResult> {
	if (input.mode !== undefined) {
		await checkAttachable(deps, input.entryId, input.pinnedVersion ?? null, input.mode);
	}
	const changeSet: ChangeSet = [
		{
			type: "update_attachment",
			agentId: input.agentId,
			entryId: input.entryId,
			...(input.pinnedVersion === undefined ? {} : { pinnedVersion: input.pinnedVersion }),
			...(input.mode === undefined ? {} : { mode: input.mode }),
			...(input.settings === undefined ? {} : { settings: input.settings }),
		},
	];
	const baseRevisionId = await activeConfigRevisionId(deps);
	return commitChange(deps, {
		changeSet,
		baseRevisionId,
		actor: input.actor,
		source: input.source,
		...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
		...(input.reason === undefined ? {} : { reason: input.reason }),
	});
}
