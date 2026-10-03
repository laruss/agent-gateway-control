import { isDeepStrictEqual } from "node:util";
import {
	type AgentId,
	type AgentPermissions,
	BUILT_IN_EXECUTOR_ACTIONS,
	BUILT_IN_GATEWAY_TOOLS,
	BUILT_IN_NATIVE_CAPABILITIES,
	BUILT_IN_UTILITY_ACTIONS,
	type ChangeOperation,
	type ChangeSet,
	type ConfigRevisionSource,
	type CustomHttpsDefinition,
	CustomHttpsDefinitionSchema,
	customHttpsDefinitionProblems,
	customToolActionType,
	type JsonObject,
	MAX_CHANGE_SET_OPERATIONS,
	type RuntimeAdapterId,
	riskFloorAllows,
	type ToolAttachment,
	type ToolAttachmentMode,
	type ToolAttachmentsBundle,
	ToolCatalogConfigSchemaSchema,
	type ToolCatalogEntry,
	ToolCatalogEntryDescriptionSchema,
	type ToolCatalogEntryId,
	ToolCatalogEntryIdSchema,
	type ToolCatalogEntryKind,
	ToolCatalogEntryNameSchema,
	type ToolCatalogEntryVersion,
	type ToolCatalogEntryView,
	type ToolCatalogRiskFloor,
	ToolCatalogRiskFloorSchema,
	ToolCatalogSupportedAdaptersSchema,
	type ToolName,
	type ToolNamespace,
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
	type ConfigDraftBundle,
	commitChange,
	commitChangeIn,
	findConfigRevisionByIdempotencyKey,
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

/** A packaged utility: image-shipped, never owner-defined, always approval-gated like every other
 * broker-executed action (ADR-027's `custom_https`/`utility` section). */
function utilitySeed(actionType: ToolName, name: string, description: string): BuiltInSeed {
	return {
		id: builtInEntryId("utility", actionType),
		kind: "utility",
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
	const utility = [
		utilitySeed(
			"utility.text-transform",
			"Text transform",
			"Apply a fixed, deterministic transform (upper/lower/trim/pretty-print JSON) to text.",
		),
	];
	const seeds = [...native, ...gateway, ...executor, ...utility];
	const knownNative = new Set(BUILT_IN_NATIVE_CAPABILITIES.map((c) => c.toolName));
	const knownGateway = new Set(BUILT_IN_GATEWAY_TOOLS);
	const knownExecutor = new Set(BUILT_IN_EXECUTOR_ACTIONS);
	const knownUtility = new Set(BUILT_IN_UTILITY_ACTIONS);
	if (
		knownNative.size !== native.length ||
		knownGateway.size !== gateway.length ||
		knownExecutor.size !== executor.length ||
		knownUtility.size !== utility.length
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
	/** Executor and utility action types this deployment's tool runner(s) actually registered;
	 * empty in production today (no real integration ships yet — `sandboxExecutors` is
	 * development/test only), supplied by whoever can see that live fact, never guessed here. Both
	 * kinds are static, enumerable lists of concrete action types known at code level, exactly like
	 * `sandboxExecutors`' own registry, so one set serves both. */
	registeredExecutorActionTypes: ReadonlySet<ToolName>;
	/** Namespaces a currently healthy tool runner serves; the live fact `custom_https`
	 * availability needs instead of a per-entry registered action type, since a `custom_https`
	 * entry's `implementationKey` (`custom.<entry-id>`) is owner-created and dynamic, never a fixed
	 * list a runner's code could enumerate the way `registeredExecutorActionTypes` does. */
	registeredNamespaces: ReadonlySet<ToolNamespace>;
}>;

export const EMPTY_AVAILABILITY_CONTEXT: ToolCatalogAvailabilityContext = {
	installedAdapters: new Set(),
	registeredExecutorActionTypes: new Set(),
	registeredNamespaces: new Set(),
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
 * Gateway itself performs it, not an optional process); `executor` and `utility` need their action
 * type actually registered by a running tool runner; `custom_https` needs a tool runner currently
 * serving the `custom` namespace (every owner-defined entry in it, dynamic and not individually
 * enumerable the way a static executor or utility action type is).
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
		case "utility":
			return context.registeredExecutorActionTypes.has(entry.implementationKey);
		case "custom_https":
			return context.registeredNamespaces.has("custom");
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
	httpsDefinition: CustomHttpsDefinition | null;
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
			httpsDefinition: row.httpsDefinition,
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
	httpsDefinition: catalogEntryVersions.httpsDefinition,
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
			httpsDefinition: row.httpsDefinition,
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
	/** A `custom_https` entry's own fixed destination/parameters/secrets/limits; refused for any
	 * other kind (`editCatalogEntry`'s own kind check — never a built-in, since no `custom_https`
	 * entry ever is). Replaces the whole definition: there is no partial field update, the same way
	 * `supportedAdapters` replaces the whole list. */
	httpsDefinition?: CustomHttpsDefinition;
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
	if (input.httpsDefinition !== undefined) {
		const parsed = CustomHttpsDefinitionSchema.safeParse(input.httpsDefinition);
		if (!parsed.success) {
			problems.push(...parsed.error.issues.map((issue) => `httpsDefinition: ${issue.message}`));
		} else {
			problems.push(
				...customHttpsDefinitionProblems(parsed.data).map(
					(problem) => `httpsDefinition: ${problem}`,
				),
			);
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
				kind: catalogEntries.kind,
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
		if (input.httpsDefinition !== undefined && entryRow.kind !== "custom_https") {
			throw new AdminError(
				`catalog entry '${input.entryId}' is not a custom_https entry; httpsDefinition cannot be set`,
			);
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
				httpsDefinition: input.httpsDefinition ?? current.currentVersion.httpsDefinition,
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

// ---------------------------------------------------------------------------
// Creating a `custom_https` entry: the one non-built-in kind with a creation path
// ---------------------------------------------------------------------------

export type CreateCustomHttpsToolInput = Readonly<{
	/** The entry's own stable id (`ToolCatalogEntryIdSchema`); its action type is
	 * `custom.<entryId>` (`customToolActionType`). Chosen once, by the owner, never changed. */
	entryId: string;
	name: string;
	description: string;
	httpsDefinition: CustomHttpsDefinition;
	actor: string;
}>;

/** Everything wrong with `input` on its own terms, before any database access: the id's own
 * shape, `name`/`description` against the same bounds every version's fields keep, and the
 * definition's structural and cross-field rules (`customHttpsDefinitionProblems`) — a write
 * without a declared idempotency mechanism among them. Pure. */
export function createCustomHttpsToolInputProblems(
	input: CreateCustomHttpsToolInput,
): Readonly<string[]> {
	const problems: string[] = [];
	const id = ToolCatalogEntryIdSchema.safeParse(input.entryId);
	if (!id.success) {
		problems.push(...id.error.issues.map((issue) => `entryId: ${issue.message}`));
	}
	const name = ToolCatalogEntryNameSchema.safeParse(input.name);
	if (!name.success) {
		problems.push(...name.error.issues.map((issue) => `name: ${issue.message}`));
	}
	const description = ToolCatalogEntryDescriptionSchema.safeParse(input.description);
	if (!description.success) {
		problems.push(...description.error.issues.map((issue) => `description: ${issue.message}`));
	}
	const definition = CustomHttpsDefinitionSchema.safeParse(input.httpsDefinition);
	if (!definition.success) {
		problems.push(...definition.error.issues.map((issue) => `httpsDefinition: ${issue.message}`));
	} else {
		problems.push(
			...customHttpsDefinitionProblems(definition.data).map(
				(problem) => `httpsDefinition: ${problem}`,
			),
		);
	}
	return problems;
}

/**
 * Creates a new, owner-defined `custom_https` catalog entry (ADR-027): the one non-built-in kind
 * with a creation path at all, since `custom_https` was reserved, not defined, until this step.
 * Its action type (`custom.<entryId>`) is immutable from here on, like a built-in's own
 * `implementationKey`; unlike a built-in, every field of its first version — including the
 * definition itself — is owner-chosen from the start. `riskFloor` is always `require_approval`
 * (ADR-027's `MODES_BY_KIND`: `custom_https` supports no looser mode) and `supportedAdapters` is
 * always empty (not adapter-scoped, like `gateway`/`executor`); neither is ever part of this
 * input, so there is nothing to validate or carry forward for them.
 */
export async function createCustomHttpsTool(
	deps: ControlPlaneDeps,
	input: CreateCustomHttpsToolInput,
): Promise<ToolCatalogEntry> {
	const problems = createCustomHttpsToolInputProblems(input);
	if (problems.length > 0) {
		throw new AdminError(
			`creating custom HTTPS tool '${input.entryId}':\n- ${problems.join("\n- ")}`,
		);
	}
	return inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		const [existing] = await db
			.select({ id: catalogEntries.id })
			.from(catalogEntries)
			.where(eq(catalogEntries.id, input.entryId));
		if (existing !== undefined) {
			throw new AdminError(`catalog entry '${input.entryId}' already exists`);
		}
		const [tombstoned] = await db
			.select({ entryId: catalogEntryTombstones.entryId })
			.from(catalogEntryTombstones)
			.where(eq(catalogEntryTombstones.entryId, input.entryId));
		if (tombstoned !== undefined) {
			throw new AdminError(
				`catalog entry id '${input.entryId}' was deleted before; choose another`,
			);
		}
		const implementationKey = customToolActionType(input.entryId) as ToolName;
		await db.insert(catalogEntries).values({
			id: input.entryId,
			kind: "custom_https",
			implementationKey,
			isBuiltin: false,
			createdAt: uow.now,
		});
		const [version] = await db
			.insert(catalogEntryVersions)
			.values({
				entryId: input.entryId,
				version: 1,
				kind: "custom_https",
				implementationKey,
				name: input.name,
				description: input.description,
				configSchema: {},
				riskFloor: "require_approval",
				supportedAdapters: [],
				httpsDefinition: input.httpsDefinition,
				createdBy: input.actor,
				createdAt: uow.now,
			})
			.returning({ id: catalogEntryVersions.id });
		if (version === undefined) {
			throw new AdminError(
				`creating custom HTTPS tool '${input.entryId}' did not return its version id`,
			);
		}
		await db
			.update(catalogEntries)
			.set({ currentVersionId: version.id })
			.where(eq(catalogEntries.id, input.entryId));
		await audit(uow, input.actor, "tool_catalog.create", "catalog_entry", input.entryId, {
			kind: "custom_https",
		});
		const created = await loadEntry(db, input.entryId);
		if (created === null) {
			throw new AdminError("internal: created catalog entry vanished within its own transaction");
		}
		return created;
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

/** {@link loadAllAgentToolAttachments}'s own revision and bundle, alongside the per-agent read —
 * `adoptAgentToolAttachments` needs the exact revision the read came from (as the commit's own
 * base revision, so a concurrent change is a conflict, never silently rebased onto), which the
 * public function below has no reason to expose. */
type AllAgentToolAttachmentsRead = Readonly<{
	revisionId: number | null;
	bundle: ConfigDraftBundle;
	attachments: Readonly<Record<AgentId, AgentToolAttachmentsRead>>;
}>;

async function loadAllAgentToolAttachmentsWithRevision(
	deps: ControlPlaneDeps,
	atRevisionId?: number | null,
): Promise<AllAgentToolAttachmentsRead> {
	return inTransaction(deps, async ({ tx }) => {
		const revisionId = atRevisionId === undefined ? await currentRevisionIdIn(tx.db) : atRevisionId;
		const { bundle } = await loadActiveBundle(tx.db, revisionId);
		const known = await knownCatalogEntries(tx.db);
		const attachments: Record<string, AgentToolAttachmentsRead> = {};
		for (const agent of bundle.agents) {
			const recorded = bundle.toolAttachments[agent.id];
			if (recorded !== undefined) {
				attachments[agent.id] = { attachments: recorded, unresolved: [], hubManaged: true };
				continue;
			}
			attachments[agent.id] = {
				...legacyAttachmentsFromPermissions(agent.permissions, known),
				hubManaged: false,
			};
		}
		return { revisionId, bundle, attachments };
	});
}

/** Per agent, its current attachments and any unresolved legacy pattern (ADR-027): hub-managed
 * agents read their recorded attachments; every other agent is converted from its `permissions`
 * on the fly, against every catalog entry known right now. */
export async function loadAllAgentToolAttachments(
	deps: ControlPlaneDeps,
): Promise<Readonly<Record<AgentId, AgentToolAttachmentsRead>>> {
	return (await loadAllAgentToolAttachmentsWithRevision(deps)).attachments;
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
	const results: AdoptAgentResult[] = [];
	for (const agentId of input.agentIds) {
		results.push(await adoptOneAgent(deps, agentId, input));
	}
	return results;
}

/**
 * Reads this one agent's own attachments/permissions and the revision they came from *together*,
 * right before resolving what to commit, and commits against that exact revision
 * (`baseRevisionId`) — never a separately re-read "current" one. A `--all` batch still commits one
 * agent at a time, each against whatever is active when its own turn comes (an earlier agent's own
 * commit in the same batch has already moved the revision on by the time this runs for the next
 * one, same as always); what this closes is the gap *within* one agent's own adoption, where the
 * attachments resolved from `permissions` and the revision committed against used to come from two
 * different reads — a concurrent change landing in between (a revoke, another attach) was silently
 * undone by a commit that still succeeded against the newer, unrelated base. Committing against the
 * revision this read actually came from makes that same concurrent change a conflict
 * (`ManagementConflictError`, from `commitChange`) instead.
 */
async function adoptOneAgent(
	deps: ControlPlaneDeps,
	agentId: AgentId,
	input: AdoptToolAttachmentsInput,
): Promise<AdoptAgentResult> {
	const {
		revisionId,
		bundle,
		attachments: all,
	} = await loadAllAgentToolAttachmentsWithRevision(deps);
	const read = all[agentId];
	if (read === undefined) {
		throw new AdminError(`agent '${agentId}' does not exist`);
	}
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
	if (input.dryRun) {
		return {
			agentId,
			alreadyHubManaged: false,
			unresolved: read.unresolved,
			before: agent.permissions,
			after: compiledPermissions,
			attachments: read.attachments,
			problems: [],
			commit: null,
		};
	}
	// An agent whose legacy conversion resolves to zero attachments (every pattern unresolved, or
	// no `permissions` at all) still needs to become hub-managed with that explicitly empty list —
	// `attach_tool` cannot express "no attachments at all", so this is the one case
	// `set_tool_attachments` exists for (ADR-027); every other agent keeps the targeted,
	// per-attachment `attach_tool` changeset it always has.
	const changeSet: ChangeSet =
		read.attachments.length === 0
			? [{ type: "set_tool_attachments", agentId, attachments: [] }]
			: read.attachments.map((attachment) => ({
					type: "attach_tool",
					agentId,
					entryId: attachment.entryId,
					pinnedVersion: attachment.pinnedVersion,
					mode: attachment.mode,
					settings: attachment.settings,
				}));
	const commit = await commitChange(deps, {
		changeSet,
		baseRevisionId: revisionId,
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

export type AttachToolResult = CommitChangeResult &
	Readonly<{
		/** The legacy `permissions` attachments this call converted and carried forward, in the
		 * same revision, because `agentId` was not yet hub-managed (ADR-027: the same conversion
		 * `gateway tools adopt` performs) — empty when the agent was already hub-managed, so this
		 * attachment is the only thing that changed. */
		legacyConversion: Readonly<ToolAttachment[]>;
	}>;

/**
 * The exact `attach_tool` operations {@link legacyAttachmentsFromPermissions} resolves for
 * `agentId`'s current `permissions`, carrying its legacy coverage forward into the same revision
 * that attaches a new entry on top — `attach_tool`'s own semantics (replace any existing
 * attachment of the same `entryId`) mean the new attachment wins regardless of order, should it
 * name one of these. `null` only when a resolved attachment's mode its own catalog entry's `kind`
 * does not support (`modeSupportedByKind`) — the same refusal `adoptOneAgent` gives, surfaced here
 * instead of silently dropping coverage or guessing a mode that was never actually configured.
 */
async function legacyConversionChangeSet(
	db: Db,
	agentId: AgentId,
	permissions: AgentPermissions,
): Promise<Readonly<{
	ops: Readonly<ChangeOperation[]>;
	attachments: Readonly<ToolAttachment[]>;
}> | null> {
	const known = await knownCatalogEntries(db);
	const { attachments } = legacyAttachmentsFromPermissions(permissions, known);
	if (attachments.length === 0) {
		return { ops: [], attachments: [] };
	}
	const toolAttachments: ToolAttachmentsBundle = { [agentId]: [...attachments] };
	const catalog = await loadCompilableCatalogEntries(db, toolAttachments);
	for (const attachment of attachments) {
		const entry = catalog.get(attachment.entryId);
		if (entry === undefined || !modeSupportedByKind(entry.kind, attachment.mode)) {
			return null;
		}
	}
	const ops: ChangeOperation[] = attachments.map((attachment) => ({
		type: "attach_tool",
		agentId,
		entryId: attachment.entryId,
		pinnedVersion: attachment.pinnedVersion,
		mode: attachment.mode,
		settings: attachment.settings,
	}));
	return { ops, attachments };
}

/** The result of the commit made under `idempotencyKey`, when it carried exactly this attachment;
 * a key reused for anything else is refused, as `commitChange` refuses it. `legacyConversion` is
 * empty: it described the first call, not this replay. */
async function replayAttachment(
	deps: ControlPlaneDeps,
	committed: Readonly<{ id: number; hash: string }>,
	attach: Extract<ChangeOperation, { type: "attach_tool" }>,
	idempotencyKey: string,
): Promise<AttachToolResult> {
	const { attachments } = await loadAllAgentToolAttachmentsWithRevision(deps, committed.id);
	const read = attachments[attach.agentId];
	const recorded = read?.hubManaged
		? read.attachments.find((attachment) => attachment.entryId === attach.entryId)
		: undefined;
	const same =
		recorded !== undefined &&
		recorded.pinnedVersion === attach.pinnedVersion &&
		recorded.mode === attach.mode &&
		isDeepStrictEqual(recorded.settings, attach.settings);
	if (!same) {
		throw new AdminError(
			`idempotency key '${idempotencyKey}' was already used with a different change set`,
		);
	}
	return {
		revisionId: committed.id,
		hash: committed.hash,
		noop: false,
		replayed: true,
		activeRevisionId: await activeConfigRevisionId(deps),
		legacyConversion: [],
	};
}

/** Binds (or rebinds) `input.entryId` to `input.agentId`, through the managed-configuration
 * writer: a config revision records it, and rollback/export/import cover it (ADR-027).
 *
 * `input.agentId` not yet hub-managed (no attachments document of its own at all): its current
 * `permissions` lists are converted the same way `gateway tools adopt` does and committed in this
 * exact revision, ahead of the new attachment — never a plain `attach_tool` on its own, which
 * would otherwise make the agent hub-managed with only this one attachment and silently drop
 * everything its legacy `permissions` used to cover (ADR-027's bundle-mirror invariant replaces
 * `permissions` outright on the very commit that first gives an agent an attachments document).
 * Refused instead — nothing committed — when that conversion cannot resolve cleanly (a legacy
 * pattern's mode its own catalog entry does not support) or would need more operations than one
 * change set may ever hold: either way, `gateway tools adopt <agentId>` is the explicit, reviewed
 * path for an agent whose legacy permissions need a closer look before this hub ever touches them.
 */
export async function attachTool(
	deps: ControlPlaneDeps,
	input: AttachToolInput,
): Promise<AttachToolResult> {
	const attach: ChangeOperation = {
		type: "attach_tool",
		agentId: input.agentId,
		entryId: input.entryId,
		pinnedVersion: input.pinnedVersion,
		mode: input.mode,
		settings: input.settings ?? {},
	};
	// A retry under an idempotency key that already committed is answered from that commit, never
	// by rebuilding its change set: the first attachment to a legacy agent also carried a
	// conversion that depended on the agent's permissions and the catalog at that moment, which
	// neither now reproduces.
	if (input.idempotencyKey !== undefined) {
		const committed = await findConfigRevisionByIdempotencyKey(deps, input.idempotencyKey);
		if (committed !== null) {
			return replayAttachment(deps, committed, attach, input.idempotencyKey);
		}
	}
	await checkAttachable(deps, input.entryId, input.pinnedVersion, input.mode);
	const { revisionId, bundle, attachments } = await loadAllAgentToolAttachmentsWithRevision(deps);
	const read = attachments[input.agentId];
	if (read === undefined) {
		throw new AdminError(`agent '${input.agentId}' does not exist`);
	}
	let legacyConversion: Readonly<ToolAttachment[]> = [];
	let changeSet: ChangeSet = [attach];
	if (!read.hubManaged) {
		const agent = bundle.agents.find((a) => a.id === input.agentId);
		if (agent === undefined) {
			throw new AdminError(`agent '${input.agentId}' does not exist`);
		}
		const conversion = await inTransaction(deps, ({ tx }) =>
			legacyConversionChangeSet(tx.db, input.agentId, agent.permissions),
		);
		if (conversion === null || conversion.ops.length + 1 > MAX_CHANGE_SET_OPERATIONS) {
			throw new AdminError(
				`agent '${input.agentId}' is not yet managed in the tools hub and its legacy ` +
					`permissions cannot be converted automatically here; run ` +
					`'gateway tools adopt ${input.agentId}' first`,
			);
		}
		legacyConversion = conversion.attachments;
		changeSet = [...conversion.ops, attach];
	}
	const result = await commitChange(deps, {
		changeSet,
		baseRevisionId: revisionId,
		actor: input.actor,
		source: input.source,
		...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
		...(input.reason === undefined ? {} : { reason: input.reason }),
	});
	return { ...result, legacyConversion };
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
