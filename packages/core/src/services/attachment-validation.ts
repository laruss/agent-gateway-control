import {
	riskFloorAllows,
	type ToolAttachmentsBundle,
	type ToolCatalogRiskFloor,
} from "@agent-gateway/contracts";
import { catalogEntries, catalogEntryVersions } from "@agent-gateway/db";
import { eq, inArray } from "drizzle-orm";
import type { UnitOfWork } from "./deps.ts";

type Db = UnitOfWork["tx"]["db"];

type AttachableCatalogEntry = Readonly<{ deletedAt: Date | null; riskFloor: ToolCatalogRiskFloor }>;

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
			riskFloor: catalogEntryVersions.riskFloor,
		})
		.from(catalogEntries)
		.innerJoin(catalogEntryVersions, eq(catalogEntries.currentVersionId, catalogEntryVersions.id))
		.where(inArray(catalogEntries.id, [...entryIds]));
	return new Map(
		rows.map((row) => [row.id, { deletedAt: row.deletedAt, riskFloor: row.riskFloor }]),
	);
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
 * and its `mode` respects the entry's own `riskFloor`. An attachment's `settings` bound is already
 * enforced structurally wherever one is parsed (`ToolAttachmentSettingsSchema`); nothing here
 * compiles `configSchema` into a validator (ADR-027 leaves that for later work).
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
