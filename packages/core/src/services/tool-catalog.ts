import { createHash } from "node:crypto";
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
	IdempotencyKeySchema,
	type JsonObject,
	MAX_ATTACHMENTS_PER_AGENT,
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
	toolPatternCovers,
} from "@agent-gateway/contracts";
import {
	agents,
	catalogAttachments,
	catalogEntries,
	catalogEntryTombstones,
	catalogEntryVersions,
	gatewayControls,
} from "@agent-gateway/db";
import { canonicalHash } from "@agent-gateway/events";
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
	/** The entry's own `currentVersion.version` as the caller last read it (the console's own
	 * entry-detail load, typically): refused (`StaleCatalogEntryVersionError`) once it no longer
	 * matches the version this edit would actually publish over, rather than silently merging this
	 * edit's own fields forward over a version the caller never saw — an edit this old could
	 * otherwise overwrite someone else's very recent change to the same field with stale data from
	 * before it, last-writer-wins, with no warning either edit ever happened. Absent for the CLI,
	 * which keeps the ordinary "edit over whatever is current" behaviour unchanged. */
	expectedVersion?: number;
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

/** Thrown by {@link editCatalogEntry} when a caller's `expectedVersion` no longer names the
 * entry's actual current version — someone else published a new one since the caller last read
 * it. Mapped to a `409` by the console, distinct from `ManagementConflictError` (a config revision
 * conflict): a catalog entry's own version advances independently of any config revision. */
export class StaleCatalogEntryVersionError extends Error {
	constructor(
		readonly entryId: string,
		readonly currentVersion: number,
	) {
		super(
			`catalog entry '${entryId}' is now at version ${currentVersion}, not the version this edit expected; reload and try again`,
		);
	}
}

/**
 * Publishes a new, immutable version of `entryId`, copying forward whatever `input` leaves unset.
 * Refused for a built-in entry whose patch touches `configSchema`/`riskFloor`/`supportedAdapters`
 * (`builtInEditProblems`); its `name`/`description` may still change. The entry's own
 * `currentVersion` advances to the new version in the same transaction. Refused
 * (`StaleCatalogEntryVersionError`) when `input.expectedVersion` no longer names the version this
 * edit would actually publish over (checked fresh, inside this same transaction, right where
 * `current` is read — never a caller's own, separately-read "is it still version N" moments
 * earlier).
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
		if (
			input.expectedVersion !== undefined &&
			input.expectedVersion !== current.currentVersion.version
		) {
			throw new StaleCatalogEntryVersionError(input.entryId, current.currentVersion.version);
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
 * Every currently enabled, legacy (not hub-managed) agent whose own `permissions` actually grants
 * `implementationKey` outright or with approval (`tools_allow`/`tools_require_human_approval`,
 * never `tools_deny` — denying it is not "holding" it) — read straight from the live `agents`
 * projection, never the catalog: a legacy agent's enforcement (`loadEffectivePermissionsIn`)
 * consults its `permissions` lists alone and never the catalog at all, so deleting a catalog entry
 * can revoke a hub-managed agent's access (its attachment is cleared) but has no effect whatsoever
 * on a legacy agent whose own pattern happens to cover the same tool. `enabled = false` is excluded:
 * a disabled (retired, or simply removed from the active configuration) agent's `config` column is
 * only its last-known projection, never actually enforced any more, and a retired agent that was
 * never hub-managed also reports `tool_attachments_managed = false` once it leaves the active
 * configuration, which would otherwise flag it here for a tool it can no longer use at all. Shared
 * by `deleteCatalogEntry` (refuses while this is non-empty) and the console's own entry-detail read
 * (shows it as part of the deletion's impact, alongside `attachedAgents`).
 */
export async function legacyAgentsGrantingTool(
	db: Db,
	implementationKey: ToolName,
): Promise<Readonly<{ agentId: AgentId; displayName: string }[]>> {
	// Every agent of the active configuration, enabled or not: a disabled legacy agent re-enabled
	// later would otherwise get a deleted tool back. Rows kept only for history (retired, removed)
	// belong to an older configuration version and are left out.
	const [controls] = await db
		.select({ activeConfigVersion: gatewayControls.activeConfigVersion })
		.from(gatewayControls);
	const activeConfigVersion = controls?.activeConfigVersion ?? null;
	const rows = await db
		.select({ id: agents.id, displayName: agents.displayName, config: agents.config })
		.from(agents)
		.where(
			and(
				eq(agents.toolAttachmentsManaged, false),
				activeConfigVersion === null
					? eq(agents.enabled, true)
					: eq(agents.configVersion, activeConfigVersion),
			),
		);
	const granting = rows
		.filter(({ config }) =>
			[...config.permissions.tools_allow, ...config.permissions.tools_require_human_approval].some(
				(pattern) => toolPatternCovers(pattern, implementationKey),
			),
		)
		.map((row) => ({ agentId: row.id, displayName: row.displayName }));
	return granting.sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
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
 * Refused outright, nothing committed, while {@link legacyAgentsGrantingTool} finds any agent still
 * holding this entry's `implementationKey` through its own legacy `permissions` — deleting the
 * entry would make the hub show it as gone everywhere while that agent goes on using the exact same
 * tool, unaffected (see {@link legacyAgentsGrantingTool}'s own doc comment); the message points at
 * `gateway tools adopt <agent-id>` (or the console's own Adopt), which converts that coverage into a
 * real attachment this delete would then also clear.
 *
 * Returns the agent ids actually affected, read fresh inside this same transaction right before
 * committing — never a caller's own, separately-read "impact preview" from moments earlier, which a
 * concurrent attach or detach could have already made stale. `expectedAffectedAgentIds`, when given
 * (the console's own last-shown impact), binds the delete to that exact set: refused
 * (`ManagementConflictError`, the same `409` every other stale-preview conflict already is) the
 * moment it no longer matches what this fresh read finds, rather than silently deleting a
 * different — wider or narrower — set of agents than the one the owner actually confirmed.
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
	/** `cli_apply` (the default, unchanged — `gateway tools delete`) or `console`, for the hub's own
	 * delete action — threaded into the `clear_tool_attachments` commit this writes, the same
	 * convention every other catalog-mutating call already carries its own source with. */
	source: ConfigRevisionSource = "cli_apply",
	/** Binds the delete to an impact preview a caller already showed: refused (`409`) once the
	 * agents this fresh read actually finds differ from this set (as sets, order-independent).
	 * Absent for the CLI and every test, which both skip this check entirely. */
	expectedAffectedAgentIds?: Readonly<AgentId[]>,
): Promise<Readonly<{ affected: Readonly<AgentId[]> }>> {
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
					implementationKey: catalogEntries.implementationKey,
					isBuiltin: catalogEntries.isBuiltin,
					deletedAt: catalogEntries.deletedAt,
				})
				.from(catalogEntries)
				.where(eq(catalogEntries.id, entryId))
				.for("update");
			if (entryRow === undefined || entryRow.deletedAt !== null) {
				throw new AdminError(`catalog entry '${entryId}' does not exist`);
			}
			const legacyGrantingAgents = await legacyAgentsGrantingTool(db, entryRow.implementationKey);
			if (legacyGrantingAgents.length > 0) {
				throw new AdminError(
					`catalog entry '${entryId}' is still granted by legacy permissions of: ` +
						`${legacyGrantingAgents.map((agent) => agent.agentId).join(", ")}; run ` +
						"'gateway tools adopt <agent-id>' (or the console's Adopt) for each first",
				);
			}
			const affectedRows = await db
				.selectDistinct({ agentId: catalogAttachments.agentId })
				.from(catalogAttachments)
				.where(eq(catalogAttachments.entryId, entryId));
			const affected = affectedRows.map((row) => row.agentId);
			if (expectedAffectedAgentIds !== undefined) {
				const actualSet = new Set(affected);
				const expectedSet = new Set(expectedAffectedAgentIds);
				const same =
					actualSet.size === expectedSet.size && [...actualSet].every((id) => expectedSet.has(id));
				if (!same) {
					return {
						kind: "conflict" as const,
						currentRevisionId: controls?.revision ?? null,
					};
				}
			}
			if (affected.length > 0) {
				const changeSet: ChangeSet = [{ type: "clear_tool_attachments", entryId }];
				const baseRevisionId = controls?.revision ?? null;
				const commit = await commitChangeIn(
					uow,
					{ changeSet, baseRevisionId, actor, source },
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
			return { kind: "committed" as const, affected };
		});
		if (outcome.kind === "committed") {
			return { affected: outcome.affected };
		}
		if (attempt === MAX_ATTEMPTS) {
			throw new ManagementConflictError(outcome.currentRevisionId);
		}
	}
	// Unreachable: the loop above always returns or throws by the last attempt.
	throw new ManagementConflictError(null);
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

/**
 * The one hash a console confirm binds itself to, alongside `baseRevisionId`: a config revision
 * change is not the only thing that can move what a legacy pattern resolves to — a catalog entry
 * created, edited or deleted between the preview and the confirm changes it too, with no config
 * revision of its own at all (catalog entries are not part of a config revision, ADR-027). Sorted
 * by `entryId` first, the same canonicalization `canonicalizeAttachments` already gives a
 * committed attachments document, so two resolutions that differ only in the order their
 * attachments happened to be produced in still hash identically.
 */
export function attachmentsConversionHash(attachments: Readonly<ToolAttachment[]>): string {
	return canonicalHash(
		[...attachments].sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0)),
	);
}

/**
 * Thrown by {@link adoptOneAgent} when a caller's `expectedAttachmentsHash` no longer matches what
 * `agentId`'s legacy `permissions` resolve to right now — the catalog moved on since whatever
 * conversion the caller reviewed (a console preview, typically), never silently committed against
 * the newer resolution instead. Mapped to a `409`, the same as `ManagementConflictError`, by
 * `consoleAdoptCommit`; never thrown at all for a caller that gives no `expectedAttachmentsHash`
 * (the CLI, and every preview, console included).
 */
export class StaleConversionError extends Error {
	constructor(readonly agentId: AgentId) {
		super(
			`agent '${agentId}': the catalog changed since this conversion was last previewed; reload the preview and try again`,
		);
	}
}

export type AdoptAgentResult = Readonly<{
	agentId: AgentId;
	/** The revision this result was read against (`AdoptToolAttachmentsInput.baseRevisionId` when
	 * given, else whatever was live at read time) — a console preview echoes this back so its own
	 * commit can be refused as a conflict once it no longer names the active revision, instead of
	 * silently recomputing (and committing) against newer, live state the preview never showed. */
	revisionId: number | null;
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
	/** `attachmentsConversionHash(attachments)` — a console preview echoes this back as
	 * `expectedAttachmentsHash` on its own confirm, refused (`StaleConversionError`) once the
	 * catalog has changed what the same legacy patterns resolve to. */
	conversionHash: string;
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
	/** `cli_apply` (the default, unchanged — `gateway tools adopt`) or `console`, for the hub's own
	 * "Adopt into the tools hub" action (ADR-025: every console-made commit carries this source). */
	source?: ConfigRevisionSource;
	/** A caller-supplied retry token, forwarded to `commitChange` exactly like every other console
	 * mutation's own idempotency key; absent for the CLI, which has none of its own to give. */
	idempotencyKey?: string;
	/** Pins the read (and, if anything commits, the commit's own base) to this exact revision
	 * instead of whatever is live when this call runs — the console's own confirm step, echoing
	 * back the revision its preview already showed, so a configuration change landing in between is
	 * a conflict (`ManagementConflictError`) rather than a commit silently built from newer state the
	 * preview never displayed. Absent for the CLI (and for a preview, console included), which both
	 * want the ordinary "read whatever is live, commit against exactly that" behaviour unchanged. */
	baseRevisionId?: number | null;
	/** Binds a real commit (`dryRun: false`) to the exact conversion a caller already reviewed
	 * (`attachmentsConversionHash` of a prior preview's own `attachments`): refused
	 * (`StaleConversionError`) when the catalog has changed what this agent's legacy patterns
	 * resolve to since. Absent for the CLI and every preview, which both skip this check entirely. */
	expectedAttachmentsHash?: string;
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
	// Validated once, up front: each agent's revision uses a key derived from it, which would
	// otherwise accept a caller key the writer itself refuses.
	if (input.idempotencyKey !== undefined) {
		IdempotencyKeySchema.parse(input.idempotencyKey);
	}
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
	} = await loadAllAgentToolAttachmentsWithRevision(deps, input.baseRevisionId);
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
	const conversionHash = attachmentsConversionHash(read.attachments);
	if (read.hubManaged) {
		return {
			agentId,
			revisionId,
			alreadyHubManaged: true,
			unresolved: [],
			before: compiledPermissions,
			after: compiledPermissions,
			attachments: read.attachments,
			conversionHash,
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
	// A wide legacy pattern (`custom.*` covering dozens of owner-created tools) can resolve to more
	// attachments than one agent may ever hold (`MAX_ATTACHMENTS_PER_AGENT`) even though every one
	// of them individually resolves cleanly — found and reported here, in both the dry-run preview
	// and the real commit below, rather than only discovered as an opaque schema refusal once
	// `set_tool_attachments` actually tries to commit a list this long.
	if (read.attachments.length > MAX_ATTACHMENTS_PER_AGENT) {
		problems.push(
			`resolves to ${read.attachments.length} attachments, more than the ` +
				`${MAX_ATTACHMENTS_PER_AGENT} a single agent may hold`,
		);
	}
	if (problems.length > 0) {
		return {
			agentId,
			revisionId,
			alreadyHubManaged: false,
			unresolved: read.unresolved,
			before: agent.permissions,
			after: agent.permissions,
			attachments: read.attachments,
			conversionHash,
			problems,
			commit: null,
		};
	}
	if (input.dryRun) {
		return {
			agentId,
			revisionId,
			alreadyHubManaged: false,
			unresolved: read.unresolved,
			before: agent.permissions,
			after: compiledPermissions,
			attachments: read.attachments,
			conversionHash,
			problems: [],
			commit: null,
		};
	}
	// The console's own confirm step binds itself to the exact conversion its preview showed
	// (`attachmentsConversionHash`): a catalog entry created, edited or deleted since changes what
	// these same legacy patterns resolve to without moving the config revision at all (catalog
	// entries carry no config revision of their own), which `baseRevisionId` alone cannot catch.
	// Checked here, before anything commits — never after, which would already be too late.
	if (
		input.expectedAttachmentsHash !== undefined &&
		input.expectedAttachmentsHash !== conversionHash
	) {
		throw new StaleConversionError(agentId);
	}
	// One bounded operation regardless of how many attachments resolved (`MAX_CHANGE_SET_OPERATIONS`
	// could not bound one `attach_tool` per attachment for a wide legacy pattern; the check above
	// already refused anything past `MAX_ATTACHMENTS_PER_AGENT`, the limit that still applies to a
	// single `set_tool_attachments`) — and the only operation that can mark an agent hub-managed
	// with an explicitly empty list at all, the zero-attachments case (ADR-027).
	const changeSet: ChangeSet = [
		{ type: "set_tool_attachments", agentId, attachments: [...read.attachments] },
	];
	const commit = await commitChange(deps, {
		changeSet,
		baseRevisionId: revisionId,
		actor: input.actor,
		source: input.source ?? "cli_apply",
		// One revision per adopted agent: each needs a key of its own, or the second agent's
		// different change set would be refused as a reuse of the first one's.
		...(input.idempotencyKey === undefined
			? {}
			: { idempotencyKey: derivedIdempotencyKey(input.idempotencyKey, `adopt:${agentId}`) }),
		...(input.reason === undefined ? {} : { reason: input.reason }),
	});
	return {
		agentId,
		revisionId,
		alreadyHubManaged: false,
		unresolved: read.unresolved,
		before: agent.permissions,
		after: compiledPermissions,
		attachments: read.attachments,
		conversionHash,
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
	/** Pins the read (and the commit's own base) to this exact revision instead of whatever is live
	 * when this call runs — the console's own agent-tools read, echoing back the revision it already
	 * showed, so a configuration change landing in between is a conflict
	 * (`ManagementConflictError`) rather than committing (for a still-legacy agent, converting its
	 * `permissions`) against newer state the owner never saw on that page. Absent for the CLI, which
	 * wants the ordinary "read whatever is live, commit against exactly that" behaviour unchanged. */
	baseRevisionId?: number | null;
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
 * The attachments {@link legacyAttachmentsFromPermissions} resolves for `agentId`'s current
 * `permissions` — its legacy coverage, carried forward into the same revision that attaches a new
 * entry on top (`attachTool`, which merges in the entry actually requested before committing).
 * `null` only when a resolved attachment's mode its own catalog entry's `kind` does not support
 * (`modeSupportedByKind`) — the same refusal `adoptOneAgent` gives, surfaced here instead of
 * silently dropping coverage or guessing a mode that was never actually configured.
 */
async function legacyConversionAttachments(
	db: Db,
	agentId: AgentId,
	permissions: AgentPermissions,
): Promise<Readonly<ToolAttachment[]> | null> {
	const known = await knownCatalogEntries(db);
	// Every legacy pattern converts, the entry about to be attached included: leaving one out could
	// drop an explicit denial that another attachment's implied capabilities would then grant
	// (`tests.run` implies `repository.read`).
	const { attachments } = legacyAttachmentsFromPermissions(permissions, known);
	if (attachments.length === 0) {
		return [];
	}
	const toolAttachments: ToolAttachmentsBundle = { [agentId]: [...attachments] };
	const catalog = await loadCompilableCatalogEntries(db, toolAttachments);
	for (const attachment of attachments) {
		const entry = catalog.get(attachment.entryId);
		if (entry === undefined || !modeSupportedByKind(entry.kind, attachment.mode)) {
			return null;
		}
	}
	return attachments;
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
	// A retry is matched against this request, not against the change set it led to: the first
	// attachment to a legacy agent also carried a conversion that depended on the agent's
	// permissions and the catalog at that moment, which a retry need not reproduce.
	const commit = (changeSet: ChangeSet, baseRevisionId: number | null) =>
		commitChange(deps, {
			changeSet,
			baseRevisionId,
			actor: input.actor,
			source: input.source,
			// `[attach]`, the exact change set a hub-managed agent's attachment commits: its replay hash is
			// the same either way.
			requestIdentity: [attach],
			...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
			...(input.reason === undefined ? {} : { reason: input.reason }),
		});
	// A key that already committed is answered by `commitChange` itself — replayed when it names
	// this very request, refused otherwise — before anything about the current catalog or agent
	// is checked: a since-deleted entry must not turn a successful retry into an error.
	if (
		input.idempotencyKey !== undefined &&
		(await findConfigRevisionByIdempotencyKey(deps, input.idempotencyKey)) !== null
	) {
		return {
			...(await commit([attach], await activeConfigRevisionId(deps))),
			legacyConversion: [],
		};
	}
	await checkAttachable(deps, input.entryId, input.pinnedVersion, input.mode);
	const { revisionId, bundle, attachments } = await loadAllAgentToolAttachmentsWithRevision(
		deps,
		input.baseRevisionId,
	);
	const read = attachments[input.agentId];
	if (read === undefined) {
		throw new AdminError(`agent '${input.agentId}' does not exist`);
	}
	if (read.hubManaged) {
		return { ...(await commit([attach], revisionId)), legacyConversion: [] };
	}
	// Still legacy: its permissions are converted in this same revision, every pattern included
	// (an explicit denial too), ahead of the attachment — one revision, so no turn ever sees the
	// agent half converted, and the caller's key is always recorded with it.
	const agent = bundle.agents.find((a) => a.id === input.agentId);
	if (agent === undefined) {
		throw new AdminError(`agent '${input.agentId}' does not exist`);
	}
	const conversion = await inTransaction(deps, ({ tx }) =>
		legacyConversionAttachments(tx.db, input.agentId, agent.permissions),
	);
	if (conversion === null) {
		throw new AdminError(
			`agent '${input.agentId}' is not yet managed in the tools hub and its legacy ` +
				`permissions cannot be converted automatically here; run ` +
				`'gateway tools adopt ${input.agentId}' first`,
		);
	}
	// The entry actually requested wins over whatever the legacy conversion resolved for the same
	// one, same as `attach_tool`'s own per-op semantics (replace any existing attachment of the same
	// `entryId`) — carried forward here as a plain merge, now that both land in a single
	// `set_tool_attachments` operation rather than one `attach_tool` per converted entry
	// (`MAX_CHANGE_SET_OPERATIONS` could not bound a wide legacy `tools_allow`/`tools_deny`, e.g. a
	// `custom.*` wildcard resolving to dozens of entries; `MAX_ATTACHMENTS_PER_AGENT`, checked next,
	// is the only limit that still applies).
	const newAttachment: ToolAttachment = {
		entryId: input.entryId,
		pinnedVersion: input.pinnedVersion,
		mode: input.mode,
		settings: input.settings ?? {},
	};
	const merged = [...conversion.filter((a) => a.entryId !== input.entryId), newAttachment];
	if (merged.length > MAX_ATTACHMENTS_PER_AGENT) {
		throw new AdminError(
			`agent '${input.agentId}' is not yet managed in the tools hub and its legacy ` +
				`permissions resolve to ${merged.length} attachments, more than the ` +
				`${MAX_ATTACHMENTS_PER_AGENT} a single agent may hold; run ` +
				`'gateway tools adopt ${input.agentId}' first`,
		);
	}
	const changeSet: ChangeSet = [
		{ type: "set_tool_attachments", agentId: input.agentId, attachments: merged },
	];
	return {
		...(await commit(changeSet, revisionId)),
		legacyConversion: conversion,
	};
}

/** A bounded idempotency key for one of several revisions a single keyed request writes:
 * distinct per `scope`, stable for the same caller key, never longer than the caller's own. */
function derivedIdempotencyKey(idempotencyKey: string, scope: string): string {
	const digest = createHash("sha256").update(`${scope}\0${idempotencyKey}`).digest("hex");
	return `derived:${digest}`;
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
	const commit = (baseRevisionId: number | null) =>
		commitChange(deps, {
			changeSet,
			baseRevisionId,
			actor: input.actor,
			source: input.source,
			...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
			...(input.reason === undefined ? {} : { reason: input.reason }),
		});
	// A key that already committed is answered by `commitChange` itself — replayed when it names
	// this very request (the change set here never varies with catalog/agent state, so the default
	// replay hash, the change set itself, already matches a retry exactly — no `requestIdentity`
	// override needed, unlike `attachTool`'s own conversion-dependent change set), refused otherwise
	// — before anything about the current catalog is checked: a retry after `input.entryId` was
	// deleted since the first, successful commit must not turn into an error (`attachTool`'s own
	// ordering, for the same reason).
	if (
		input.idempotencyKey !== undefined &&
		(await findConfigRevisionByIdempotencyKey(deps, input.idempotencyKey)) !== null
	) {
		return commit(await activeConfigRevisionId(deps));
	}
	if (input.mode !== undefined) {
		await checkAttachable(deps, input.entryId, input.pinnedVersion ?? null, input.mode);
	}
	return commit(await activeConfigRevisionId(deps));
}
