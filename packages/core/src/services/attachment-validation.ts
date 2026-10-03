import {
	type AgentConfig,
	type AgentId,
	riskFloorAllows,
	type ToolAttachmentsBundle,
	type ToolCatalogEntryKind,
	type ToolCatalogRiskFloor,
	type ToolName,
} from "@agent-gateway/contracts";
import { catalogEntries, catalogEntryVersions } from "@agent-gateway/db";
import {
	type CompiledCatalogEntry,
	compileAttachments,
	compiledAgentPermissions,
	modeSupportedByKind,
} from "@agent-gateway/policy";
import { eq, inArray } from "drizzle-orm";
import type { UnitOfWork } from "./deps.ts";

type Db = UnitOfWork["tx"]["db"];

type AttachableCatalogEntry = Readonly<{
	deletedAt: Date | null;
	kind: ToolCatalogEntryKind;
	implementationKey: ToolName;
	riskFloor: ToolCatalogRiskFloor;
}>;

async function loadAttachableEntries(
	db: Db,
	entryIds: ReadonlySet<string>,
): Promise<ReadonlyMap<string, AttachableCatalogEntry>> {
	if (entryIds.size === 0) {
		return new Map();
	}
	const rows = await db
		.select({
			id: catalogEntries.id,
			deletedAt: catalogEntries.deletedAt,
			kind: catalogEntries.kind,
			implementationKey: catalogEntries.implementationKey,
			riskFloor: catalogEntryVersions.riskFloor,
		})
		.from(catalogEntries)
		.innerJoin(catalogEntryVersions, eq(catalogEntries.currentVersionId, catalogEntryVersions.id))
		.where(inArray(catalogEntries.id, [...entryIds]));
	return new Map(
		rows.map((row) => [
			row.id,
			{
				deletedAt: row.deletedAt,
				kind: row.kind,
				implementationKey: row.implementationKey,
				riskFloor: row.riskFloor,
			},
		]),
	);
}

/**
 * Every entry named by any agent's attachments in `toolAttachments`, reduced to what the pure
 * compiler needs (`kind`/`implementationKey` alone), excluding deleted entries — the compiler
 * already treats an attachment naming one absent here as contributing nothing, the same as an
 * unknown entry. Shared by `management.ts`'s bundle-permissions mirror
 * (`mirrorCompiledAttachmentPermissionsIn`, ADR-027's bundle-mirror invariant) so it never loads
 * catalog rows through a second, differently-shaped query.
 */
export async function loadCompilableCatalogEntries(
	db: Db,
	toolAttachments: ToolAttachmentsBundle,
): Promise<ReadonlyMap<string, CompiledCatalogEntry>> {
	const entryIds = new Set<string>();
	for (const attachments of Object.values(toolAttachments)) {
		for (const attachment of attachments) {
			entryIds.add(attachment.entryId);
		}
	}
	const entries = await loadAttachableEntries(db, entryIds);
	const result = new Map<string, CompiledCatalogEntry>();
	for (const [id, entry] of entries) {
		if (entry.deletedAt === null) {
			result.set(id, { kind: entry.kind, implementationKey: entry.implementationKey });
		}
	}
	return result;
}

/**
 * ADR-027's bundle-mirror invariant, the compiling step alone: `agentsIn`, with every agent
 * `toolAttachments` names (even with an explicitly empty list) having its `permissions` replaced
 * by its own compiled attachments. An agent absent from `toolAttachments` (legacy) is returned
 * unchanged. A leaf function — plain agents and a finance agent id, not a whole draft bundle — so
 * both `admin.ts`'s `writeConfigRevisionIn` (the single shared writer every committing path ends
 * in) and `management.ts`'s own draft-level `mirrorCompiledAttachmentPermissionsIn` call it without
 * either importing the other (`management.ts` already imports from `admin.ts`). Idempotent against
 * a caller that already mirrored — compiling an already-compiled result reproduces it exactly — so
 * calling it again here costs correctness nothing, only a repeat catalog read.
 */
export async function mirrorCompiledAttachmentPermissions(
	db: Db,
	financeAgentId: AgentId,
	agentsIn: Readonly<AgentConfig[]>,
	toolAttachments: ToolAttachmentsBundle,
): Promise<Readonly<AgentConfig[]>> {
	if (Object.keys(toolAttachments).length === 0) {
		return agentsIn;
	}
	const catalog = await loadCompilableCatalogEntries(db, toolAttachments);
	return agentsIn.map((agent) => {
		const attachments = toolAttachments[agent.id];
		if (attachments === undefined) {
			return agent;
		}
		const compiled = compileAttachments({
			agentId: agent.id,
			financeAgentId,
			adapter: agent.runtime.adapter,
			attachments,
			catalog,
		});
		const permissions = compiledAgentPermissions(compiled, {
			agentId: agent.id,
			financeAgentId,
			observeSystem: agent.permissions.observe_system === true,
		});
		return { ...agent, permissions };
	});
}

async function loadKnownEntryVersions(
	db: Db,
	entryIds: ReadonlySet<string>,
): Promise<ReadonlyMap<string, ReadonlySet<number>>> {
	if (entryIds.size === 0) {
		return new Map();
	}
	const rows = await db
		.select({ entryId: catalogEntryVersions.entryId, version: catalogEntryVersions.version })
		.from(catalogEntryVersions)
		.where(inArray(catalogEntryVersions.entryId, [...entryIds]));
	const result = new Map<string, Set<number>>();
	for (const row of rows) {
		const versions = result.get(row.entryId) ?? new Set<number>();
		versions.add(row.version);
		result.set(row.entryId, versions);
	}
	return result;
}

/**
 * Every catalog constraint an attachment must satisfy, checked against the database: its entry
 * exists and is not deleted, its `pinnedVersion` (when set) names a real version of that entry,
 * its `mode` respects the entry's own `riskFloor`, and its `mode` is one its entry's own `kind`
 * actually supports (`modeSupportedByKind`, `@agent-gateway/policy`): a native capability or a
 * direct Gateway action (`mattermost.post`, `memory.write`) has no enforcement point that can
 * pause a turn mid-flight for a human, so `require_approval` is refused for them — only
 * `allow`/`disabled` are; a tool-broker executor action always needs a human (its risk floor
 * already refuses `allow`), so only `require_approval`/`disabled` are. An attachment's `settings`
 * bound is already enforced structurally wherever one is parsed (`ToolAttachmentSettingsSchema`);
 * nothing here compiles `configSchema` into a validator (ADR-027 leaves that for later work).
 */
export async function attachmentCatalogProblems(
	db: Db,
	toolAttachments: ToolAttachmentsBundle,
): Promise<Readonly<string[]>> {
	const entryIds = new Set<string>();
	for (const attachments of Object.values(toolAttachments)) {
		for (const attachment of attachments) {
			entryIds.add(attachment.entryId);
		}
	}
	if (entryIds.size === 0) {
		return [];
	}
	const [entries, versions] = await Promise.all([
		loadAttachableEntries(db, entryIds),
		loadKnownEntryVersions(db, entryIds),
	]);
	const problems: string[] = [];
	for (const [agentId, attachments] of Object.entries(toolAttachments)) {
		for (const attachment of attachments) {
			const entry = entries.get(attachment.entryId);
			if (entry === undefined || entry.deletedAt !== null) {
				problems.push(
					`toolAttachments: agent '${agentId}': catalog entry '${attachment.entryId}' does not exist`,
				);
				continue;
			}
			if (!riskFloorAllows(attachment.mode, entry.riskFloor)) {
				problems.push(
					`toolAttachments: agent '${agentId}': catalog entry '${attachment.entryId}' requires at ` +
						"least 'require_approval' (its risk floor)",
				);
			}
			if (!modeSupportedByKind(entry.kind, attachment.mode)) {
				problems.push(
					`toolAttachments: agent '${agentId}': catalog entry '${attachment.entryId}' (kind ` +
						`'${entry.kind}') does not support mode '${attachment.mode}'`,
				);
			}
			if (
				attachment.pinnedVersion !== null &&
				!(versions.get(attachment.entryId)?.has(attachment.pinnedVersion) ?? false)
			) {
				problems.push(
					`toolAttachments: agent '${agentId}': catalog entry '${attachment.entryId}' has no ` +
						`version ${attachment.pinnedVersion}`,
				);
			}
		}
	}
	return problems;
}
