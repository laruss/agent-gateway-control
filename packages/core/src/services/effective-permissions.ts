import {
	type AgentConfig,
	type AgentId,
	type AgentPermissions,
	type CapabilityDescription,
	type CapabilityMode,
	type ToolAttachment,
	type ToolAttachmentMode,
	type ToolCatalogEntryId,
	type ToolCatalogEntryKind,
	type ToolCatalogRiskFloor,
	type ToolName,
	type ToolPattern,
	type ToolPolicySnapshot,
	toolPatternCovers,
} from "@agent-gateway/contracts";
import { catalogAttachments, catalogEntries, catalogEntryVersions } from "@agent-gateway/db";
import { type CompiledCatalogEntry, compileAttachments } from "@agent-gateway/policy";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { UnitOfWork } from "./deps.ts";

type Db = UnitOfWork["tx"]["db"];

// ---------------------------------------------------------------------------
// Legacy conversion: a read model, never written back (ADR-027). A leaf module (contracts, db,
// policy only — no `admin.ts`/`management.ts`): `scheduler.ts` and `approvals.ts` need
// `loadEffectivePermissionsIn` on their own hot paths, and importing anything reachable from
// `admin.ts` there would cycle back through it (`admin.ts` already imports `scheduler.ts`/
// `approvals.ts`). `tool-catalog.ts` re-exports this module's legacy-conversion pieces for its own,
// bundle-based `loadAllAgentToolAttachments` (config-management surfaces: `tools adopt`, a future
// console), which still needs the full historical snapshot `management.ts` provides.
// ---------------------------------------------------------------------------

type PermissionListName = "tools_allow" | "tools_require_human_approval" | "tools_deny";

export type LegacyUnresolvedPattern = Readonly<{ list: PermissionListName; pattern: ToolPattern }>;

export type LegacyConversionResult = Readonly<{
	attachments: Readonly<ToolAttachment[]>;
	unresolved: Readonly<LegacyUnresolvedPattern[]>;
}>;

const MODE_BY_LIST: Readonly<Record<PermissionListName, ToolAttachmentMode>> = {
	tools_deny: "disabled",
	tools_require_human_approval: "require_approval",
	tools_allow: "allow",
};

/** Minimal shape `legacyAttachmentsFromPermissions` needs of a known catalog entry. */
export type KnownCatalogEntry = Readonly<{ id: ToolCatalogEntryId; implementationKey: ToolName }>;

/**
 * Maps an agent's current `permissions` lists to catalog attachments, by pattern coverage against
 * `knownEntries` alone — never anything a future entry might add. A wildcard (`finance.*`)
 * expands into one attachment per currently known entry it covers; an exact pattern becomes one
 * attachment if it names a known entry's `implementationKey`. A pattern covering none of
 * `knownEntries` is reported `unresolved`, never silently dropped. `tools_deny` maps to
 * `disabled`, `tools_require_human_approval` to `require_approval`, `tools_allow` to `allow`; a
 * valid `AgentPermissions` never has two patterns (in the same list or across lists) that overlap
 * (`AgentPermissionsSchema`'s own check), so no entry is ever produced twice. Finance rules
 * (`config-bundle.ts`'s `financeIssues`) are already baked into each agent's own `permissions`
 * before this ever runs — nothing finance-specific happens here. Pure; this is the read model, it
 * writes nothing.
 */
export function legacyAttachmentsFromPermissions(
	permissions: AgentPermissions,
	knownEntries: Readonly<KnownCatalogEntry[]>,
): LegacyConversionResult {
	const attachments: ToolAttachment[] = [];
	const unresolved: LegacyUnresolvedPattern[] = [];
	const lists: Readonly<[PermissionListName, Readonly<ToolPattern[]>][]> = [
		["tools_deny", permissions.tools_deny],
		["tools_require_human_approval", permissions.tools_require_human_approval],
		["tools_allow", permissions.tools_allow],
	];
	for (const [list, patterns] of lists) {
		for (const pattern of patterns) {
			const matches = knownEntries.filter((entry) =>
				toolPatternCovers(pattern, entry.implementationKey),
			);
			if (matches.length === 0) {
				unresolved.push({ list, pattern });
				continue;
			}
			for (const entry of matches) {
				attachments.push({
					entryId: entry.id,
					pinnedVersion: null,
					mode: MODE_BY_LIST[list],
					settings: {},
				});
			}
		}
	}
	return { attachments, unresolved };
}

/** Every entry the legacy conversion may resolve a pattern against: deleted entries are excluded,
 * the same way they are everywhere else (`loadEntry`) — a tombstoned capability's old wildcard
 * coverage reports `unresolved` from here on, never silently matching a retired entry. */
export async function knownCatalogEntries(db: Db): Promise<Readonly<KnownCatalogEntry[]>> {
	return db
		.select({ id: catalogEntries.id, implementationKey: catalogEntries.implementationKey })
		.from(catalogEntries)
		.where(isNull(catalogEntries.deletedAt));
}

// ---------------------------------------------------------------------------
// Effective permissions: the single source of truth (ADR-027). For a hub-managed agent (the
// active revision's attachments document has an entry for it, even an empty one — mirrored live on
// `agents.tool_attachments_managed`, since `catalog_attachments` rows alone cannot tell an empty
// hub-managed list apart from "never touched"), effective permissions come only from compiling its
// recorded attachments against the catalog; for every other (legacy) agent, they are exactly its
// `permissions` lists, unchanged — today's behaviour, byte for byte. Capability descriptions
// (version 3 turn inputs, ADR-023) are compiled the same way for both, since they are a read model
// describing what the agent effectively has, never an enforcement decision of their own.
// ---------------------------------------------------------------------------

/** What the compiler and capability descriptions need of a known catalog entry, beyond its id. */
type CatalogMetadata = Readonly<{
	kind: ToolCatalogEntryKind;
	implementationKey: ToolName;
	name: string;
	description: string;
	riskFloor: ToolCatalogRiskFloor;
}>;

/** Catalog metadata of exactly the entries `attachments` names, excluding deleted ones (an
 * attachment naming a deleted entry contributes nothing, the same as an unknown one) — each
 * resolved to its own *selected* version: a pinned attachment describes the version it is pinned
 * to, even once the entry has since been edited further; an unpinned one tracks the entry's current
 * version, same as before. */
async function loadCatalogMetadata(
	db: Db,
	attachments: Readonly<ToolAttachment[]>,
): Promise<ReadonlyMap<ToolCatalogEntryId, CatalogMetadata>> {
	const entryIds = new Set(attachments.map((attachment) => attachment.entryId));
	if (entryIds.size === 0) {
		return new Map();
	}
	const pinnedVersionByEntry = new Map(
		attachments
			.filter((attachment) => attachment.pinnedVersion !== null)
			.map((attachment) => [attachment.entryId, attachment.pinnedVersion as number]),
	);
	const entries = (
		await db
			.select({
				id: catalogEntries.id,
				deletedAt: catalogEntries.deletedAt,
				kind: catalogEntries.kind,
				implementationKey: catalogEntries.implementationKey,
				currentVersionId: catalogEntries.currentVersionId,
			})
			.from(catalogEntries)
			.where(inArray(catalogEntries.id, [...entryIds]))
	).filter((entry) => entry.deletedAt === null && entry.currentVersionId !== null);
	if (entries.length === 0) {
		return new Map();
	}
	const pinnedEntryIds = entries
		.filter((entry) => pinnedVersionByEntry.has(entry.id))
		.map((entry) => entry.id);
	const pinnedVersionRows =
		pinnedEntryIds.length === 0
			? []
			: await db
					.select({
						entryId: catalogEntryVersions.entryId,
						version: catalogEntryVersions.version,
						name: catalogEntryVersions.name,
						description: catalogEntryVersions.description,
						riskFloor: catalogEntryVersions.riskFloor,
					})
					.from(catalogEntryVersions)
					.where(inArray(catalogEntryVersions.entryId, pinnedEntryIds));
	const pinnedByKey = new Map(
		pinnedVersionRows.map((row) => [`${row.entryId}\u0000${row.version}`, row]),
	);
	const currentVersionRows = await db
		.select({
			id: catalogEntryVersions.id,
			name: catalogEntryVersions.name,
			description: catalogEntryVersions.description,
			riskFloor: catalogEntryVersions.riskFloor,
		})
		.from(catalogEntryVersions)
		.where(
			inArray(
				catalogEntryVersions.id,
				entries.map((entry) => entry.currentVersionId as number),
			),
		);
	const currentById = new Map(currentVersionRows.map((row) => [row.id, row]));
	const result = new Map<ToolCatalogEntryId, CatalogMetadata>();
	for (const entry of entries) {
		const pinned = pinnedVersionByEntry.get(entry.id);
		const version =
			pinned === undefined
				? currentById.get(entry.currentVersionId as number)
				: pinnedByKey.get(`${entry.id}\u0000${pinned}`);
		if (version === undefined) {
			continue;
		}
		result.set(entry.id, {
			kind: entry.kind,
			implementationKey: entry.implementationKey,
			name: version.name,
			description: version.description,
			riskFloor: version.riskFloor,
		});
	}
	return result;
}

/** Catalog metadata of every active entry whose `implementationKey` names one of `toolNames`, by
 * its own *current* version — an implied tool (e.g. `repository.read` implied by `tests.run`,
 * ADR-027) has no attachment of its own to pin a version against. The fallback
 * `buildCapabilityDescriptions` needs to describe a tool only present because another implies it,
 * which {@link loadCatalogMetadata} (keyed, and resolved, by the attached entries alone) does not
 * cover. */
async function loadCatalogMetadataByImplementationKey(
	db: Db,
	toolNames: ReadonlySet<ToolName>,
): Promise<ReadonlyMap<ToolCatalogEntryId, CatalogMetadata>> {
	if (toolNames.size === 0) {
		return new Map();
	}
	const rows = await db
		.select({
			id: catalogEntries.id,
			kind: catalogEntries.kind,
			implementationKey: catalogEntries.implementationKey,
			name: catalogEntryVersions.name,
			description: catalogEntryVersions.description,
			riskFloor: catalogEntryVersions.riskFloor,
		})
		.from(catalogEntries)
		.innerJoin(catalogEntryVersions, eq(catalogEntries.currentVersionId, catalogEntryVersions.id))
		.where(
			and(
				inArray(catalogEntries.implementationKey, [...toolNames]),
				isNull(catalogEntries.deletedAt),
			),
		);
	return new Map(
		rows.map((row) => [
			row.id,
			{
				kind: row.kind,
				implementationKey: row.implementationKey,
				name: row.name,
				description: row.description,
				riskFloor: row.riskFloor,
			},
		]),
	);
}

/** `metadata`, reduced to what the pure compiler needs (`kind`/`implementationKey` alone). */
function catalogForCompile(
	metadata: ReadonlyMap<ToolCatalogEntryId, CatalogMetadata>,
): ReadonlyMap<ToolCatalogEntryId, CompiledCatalogEntry> {
	return new Map(
		[...metadata.entries()].map(([id, entry]) => [
			id,
			{ kind: entry.kind, implementationKey: entry.implementationKey },
		]),
	);
}

const CAPABILITY_DESCRIPTION_MAX = 200;

/**
 * Bounded capability descriptions (name, short description, mode) of every tool `compiled` grants
 * outright or with approval, for a version 3 turn input: the catalog entry an attachment named
 * when one exists, or (for a tool only present because another implies it, e.g. `repository.read`
 * implied by `tests.run`) whichever known entry names that implementation key. A tool with no
 * known entry at all (an unresolved legacy pattern has none) is left out: there is nothing to
 * describe it with.
 */
function buildCapabilityDescriptions(
	attachments: Readonly<ToolAttachment[]>,
	metadata: ReadonlyMap<ToolCatalogEntryId, CatalogMetadata>,
	compiled: ReturnType<typeof compileAttachments>,
): Readonly<CapabilityDescription[]> {
	const modeByTool = new Map<ToolName, CapabilityMode>();
	for (const tool of compiled.allow) {
		modeByTool.set(tool, "allow");
	}
	for (const tool of compiled.requireApproval) {
		modeByTool.set(tool, "require_approval");
	}
	const byImplementationKey = new Map(
		[...metadata.values()].map((entry) => [entry.implementationKey, entry]),
	);
	const descriptions = new Map<ToolName, CapabilityDescription>();
	const describe = (tool: ToolName): void => {
		if (descriptions.has(tool)) {
			return;
		}
		const mode = modeByTool.get(tool);
		const entry = byImplementationKey.get(tool);
		if (mode === undefined || entry === undefined) {
			return;
		}
		const impliedBy = compiled.impliedBy[tool];
		descriptions.set(tool, {
			name: tool,
			description: entry.description.slice(0, CAPABILITY_DESCRIPTION_MAX),
			mode,
			...(impliedBy === undefined ? {} : { impliedBy: [...impliedBy] }),
		});
	};
	for (const attachment of attachments) {
		const entry = metadata.get(attachment.entryId);
		if (entry !== undefined) {
			describe(entry.implementationKey);
		}
	}
	for (const tool of [...compiled.allow, ...compiled.requireApproval]) {
		describe(tool);
	}
	return [...descriptions.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Every attachment `agentId` currently holds, read from the live projection table
 * (`catalog_attachments`, ADR-027) rather than a historical bundle snapshot — the cheap path
 * `agents.tool_attachments_managed` exists precisely so the caller already knows this agent is
 * hub-managed before ever needing to read this. */
async function loadAgentAttachmentsFromProjection(
	db: Db,
	agentId: AgentId,
): Promise<Readonly<ToolAttachment[]>> {
	return db
		.select({
			entryId: catalogAttachments.entryId,
			pinnedVersion: catalogAttachments.pinnedVersion,
			mode: catalogAttachments.mode,
			settings: catalogAttachments.settings,
		})
		.from(catalogAttachments)
		.where(eq(catalogAttachments.agentId, agentId));
}

export type EffectiveAgentPermissions = Readonly<{
	/** Whether this agent's effective permissions came from compiled attachments (`true`) or its
	 * own `permissions` lists, unchanged (`false`) — ADR-027's single source of truth. */
	hubManaged: boolean;
	toolPolicy: Pick<ToolPolicySnapshot, "allow" | "requireHumanApproval" | "deny">;
	memoryWriteAllowed: boolean;
	capabilities: Readonly<CapabilityDescription[]>;
	/** Legacy patterns that resolved to no known catalog entry; always empty when `hubManaged`. */
	unresolved: Readonly<LegacyUnresolvedPattern[]>;
	/** A tool in `toolPolicy.allow` whose adapter-specific prerequisite is not itself granted
	 * (`compileAttachments`'s own `missingPrerequisites`, ADR-027) — informational only, never
	 * removes anything from `allow`. Always empty for a legacy agent: its `permissions` lists carry
	 * no such inference. */
	missingPrerequisites: Readonly<Record<string, Readonly<ToolName[]>>>;
}>;

/**
 * The agent's effective permissions right now, within `tx`: compiled from its recorded
 * attachments when it is hub-managed, or its `permissions` lists unchanged when it is legacy
 * (ADR-027's single source of truth). The one function every enforcement point — the turn
 * scheduler, policy checks on a queued tool action, memory write authority — reads instead of
 * `agent.config.permissions` directly, so none of them can drift from what the hub shows. A leaf
 * module on purpose (see the file's own doc comment): reads the live `catalog_attachments`
 * projection directly rather than a historical bundle snapshot, so it never needs `management.ts`.
 */
export async function loadEffectivePermissionsIn(
	tx: UnitOfWork["tx"],
	agent: Readonly<{ id: AgentId; config: AgentConfig; toolAttachmentsManaged: boolean }>,
	financeAgentId: AgentId,
): Promise<EffectiveAgentPermissions> {
	const { db } = tx;
	const hubManaged = agent.toolAttachmentsManaged;
	const read: LegacyConversionResult = hubManaged
		? { attachments: await loadAgentAttachmentsFromProjection(db, agent.id), unresolved: [] }
		: legacyAttachmentsFromPermissions(agent.config.permissions, await knownCatalogEntries(db));
	const attachedMetadata = await loadCatalogMetadata(db, read.attachments);
	const compiled = compileAttachments({
		agentId: agent.id,
		financeAgentId,
		adapter: agent.config.runtime.adapter,
		attachments: read.attachments,
		catalog: catalogForCompile(attachedMetadata),
	});
	// Every tool the compiled result actually grants, beyond the entries `attachedMetadata` already
	// covers: a tool only present because another implies it (e.g. `repository.read` implied by
	// `tests.run`) has no attachment of its own, so its own catalog entry (by implementation key,
	// its current version) is loaded separately — otherwise `buildCapabilityDescriptions` has
	// nothing to describe it with at all.
	const describedKeys = new Set(
		[...attachedMetadata.values()].map((entry) => entry.implementationKey),
	);
	const impliedToolNames = new Set(
		[...compiled.allow, ...compiled.requireApproval].filter((tool) => !describedKeys.has(tool)),
	);
	const impliedMetadata = await loadCatalogMetadataByImplementationKey(db, impliedToolNames);
	const metadata = new Map([...attachedMetadata, ...impliedMetadata]);
	const capabilities = buildCapabilityDescriptions(read.attachments, metadata, compiled);
	if (hubManaged) {
		return {
			hubManaged: true,
			toolPolicy: {
				allow: [...compiled.allow],
				requireHumanApproval: [...compiled.requireApproval],
				deny: [...compiled.deny],
			},
			memoryWriteAllowed: compiled.memoryWriteAllowed,
			capabilities,
			unresolved: [],
			missingPrerequisites: compiled.missingPrerequisites,
		};
	}
	const { tools_allow, tools_require_human_approval, tools_deny } = agent.config.permissions;
	const memoryWriteAllowed = !tools_deny.some((pattern) =>
		toolPatternCovers(pattern, "memory.write"),
	);
	return {
		hubManaged: false,
		toolPolicy: {
			allow: tools_allow,
			requireHumanApproval: tools_require_human_approval,
			deny: tools_deny,
		},
		memoryWriteAllowed,
		capabilities,
		unresolved: read.unresolved,
		missingPrerequisites: {},
	};
}
