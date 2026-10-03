import {
	type AgentConfig,
	type AgentId,
	type ChangeSet,
	riskFloorAllows,
	type ToolAttachment,
	type ToolAttachmentsBundle,
	type ToolCatalogEntryKind,
	type ToolCatalogRiskFloor,
	type ToolName,
} from "@agent-gateway/contracts";
import { catalogEntries, catalogEntryVersions } from "@agent-gateway/db";
import { canonicalHash } from "@agent-gateway/events";
import {
	type CompiledCatalogEntry,
	compileAttachments,
	compiledAgentPermissions,
	describeWidenedTools,
	modeSupportedByKind,
	type PermissionWidening,
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
		// Own-property lookup, never plain bracket access: `toolAttachments` is a plain-object
		// dictionary keyed by agent id, and an agent id like `constructor` is a valid `AgentId`
		// (lowercase letters only) that has no own property here but still resolves, through the
		// prototype chain, to `Object.prototype.constructor` — a function, not `undefined` and not
		// an attachment list — which would otherwise reach `compileAttachments` below and throw
		// (`for...of` over a function) on every commit, for any configuration that happens to name
		// such an agent at all, attached to anything or not.
		if (!Object.hasOwn(toolAttachments, agent.id)) {
			return agent;
		}
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

// ---------------------------------------------------------------------------
// Removing an attachment, or replacing an existing hub-managed list wholesale, must never widen
// what its agent may do (ADR-027): clearing a `disabled`/`require_approval` attachment that was the
// only thing suppressing a native dependency's implication (`tests.run` implying `workspace.write`,
// `NATIVE_TOOL_DEPENDENCIES`) would otherwise let that implication through the moment nothing
// explicit governs the implied tool any more. Enforced once, here, at the shared commit boundary
// (`commitChangeIn`) under its own lock and against the exact revision being committed — never a
// separate, earlier read `detachTool`/`deleteCatalogEntry` used to take outside any transaction,
// racing a concurrent change between that read and the commit itself.
// ---------------------------------------------------------------------------

/** One agent, and every tool whose effective access would increase for it — {@link
 * changeSetWidenings}'s own result, keyed by agent. */
export type AttachmentWidening = Readonly<{
	agentId: AgentId;
	tools: Readonly<PermissionWidening[]>;
}>;

/**
 * Every agent id a change set's own `detach_tool`/`clear_tool_attachments`/`set_tool_attachments`
 * operations name, against `base`'s attachments document — the only operations a removal (or a
 * wholesale replace) can hide a widening behind; `attach_tool`/`update_attachment` grant or restrict
 * something the owner explicitly asked for and are never checked here. `set_tool_attachments` is
 * named only when the agent it targets already had an attachments document in `base`: *replacing*
 * an existing hub-managed list, never the first conversion that establishes one (legacy-to-hub
 * conversion is "identical in effect" by construction, adoption's own invariant).
 */
function changeSetWideningCandidates(
	changeSet: ChangeSet,
	base: ToolAttachmentsBundle,
): ReadonlySet<AgentId> {
	const agentIds = new Set<AgentId>();
	for (const op of changeSet) {
		if (op.type === "detach_tool") {
			if (Object.hasOwn(base, op.agentId)) {
				agentIds.add(op.agentId);
			}
		} else if (op.type === "clear_tool_attachments") {
			for (const [agentId, attachments] of Object.entries(base)) {
				if (attachments.some((attachment) => attachment.entryId === op.entryId)) {
					agentIds.add(agentId as AgentId);
				}
			}
		} else if (op.type === "set_tool_attachments") {
			if (Object.hasOwn(base, op.agentId)) {
				agentIds.add(op.agentId);
			}
		}
	}
	return agentIds;
}

/**
 * Every widening a change set would cause, comparing each affected agent's compiled attachments in
 * `base` against the same agent's in `draft` ({@link changeSetWideningCandidates} picks which
 * agents are even worth comparing). `base`/`draft` are the exact bundles `commitChangeIn` already
 * holds — the before state the commit is about to replace, and the after state
 * `mirrorCompiledAttachmentPermissionsIn` already produced from the same change set — so this reuses
 * reads the boundary already made rather than taking a separate one of its own. An agent `base`
 * does not (yet) have an attachments document for is skipped: nothing to compare "before" against
 * (a still-legacy agent `set_tool_attachments` is about to make hub-managed for the first time).
 */
export async function changeSetWidenings(
	db: Db,
	changeSet: ChangeSet,
	base: Readonly<{
		agents: Readonly<AgentConfig[]>;
		toolAttachments: ToolAttachmentsBundle;
		financeAgentId: AgentId;
	}>,
	draft: Readonly<{ toolAttachments: ToolAttachmentsBundle }>,
): Promise<Readonly<AttachmentWidening[]>> {
	const candidates = changeSetWideningCandidates(changeSet, base.toolAttachments);
	if (candidates.size === 0) {
		return [];
	}
	const merged: Record<string, ToolAttachment[]> = {};
	for (const [agentId, attachments] of Object.entries(base.toolAttachments)) {
		merged[agentId] = [...attachments];
	}
	for (const [agentId, attachments] of Object.entries(draft.toolAttachments)) {
		// Own-property lookup: an agent id like `constructor`, present in `draft` but not (yet) an
		// own property of `merged` (the first loop never reached it), would otherwise resolve through
		// the prototype chain to `Object.prototype.constructor` — a function, not an array — which
		// `[...fn]` would throw on rather than read as "nothing merged for this agent yet".
		const already = (Object.hasOwn(merged, agentId) ? merged[agentId] : undefined) ?? [];
		merged[agentId] = [...already, ...attachments];
	}
	const catalog = await loadCompilableCatalogEntries(db, merged);
	const widenings: AttachmentWidening[] = [];
	for (const agentId of candidates) {
		const agent = base.agents.find((candidate) => candidate.id === agentId);
		const beforeAttachments = Object.hasOwn(base.toolAttachments, agentId)
			? base.toolAttachments[agentId]
			: undefined;
		if (agent === undefined || beforeAttachments === undefined) {
			continue;
		}
		const afterAttachments = Object.hasOwn(draft.toolAttachments, agentId)
			? (draft.toolAttachments[agentId] ?? [])
			: [];
		const before = compileAttachments({
			agentId,
			financeAgentId: base.financeAgentId,
			adapter: agent.runtime.adapter,
			attachments: beforeAttachments,
			catalog,
		});
		const after = compileAttachments({
			agentId,
			financeAgentId: base.financeAgentId,
			adapter: agent.runtime.adapter,
			attachments: afterAttachments,
			catalog,
		});
		const tools = describeWidenedTools(before, after);
		if (tools.length > 0) {
			widenings.push({ agentId, tools });
		}
	}
	return widenings.sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
}

/** The hash `commitChangeIn` compares `CommitChangeInput.acceptWidening` against: a caller that
 * already saw this exact `widenings` list (the console's own 422 response) echoes it back to
 * proceed anyway, refused the moment a concurrent change makes the catalog compute a different list
 * now — a stale or forged hash can never match a list the server did not just compute itself. */
export function acceptWideningHash(widenings: Readonly<AttachmentWidening[]>): string {
	return canonicalHash(
		widenings.map((widening) => ({
			agentId: widening.agentId,
			tools: widening.tools.map((tool) => ({ tool: tool.tool, from: tool.from, to: tool.to })),
		})),
	);
}

/** One hub-managed agent that effectively holds a tool only because another attached tool's own
 * implication grants it (`NATIVE_TOOL_DEPENDENCIES`, `@agent-gateway/policy`) — naming which
 * attached tool(s) imply it. */
export type ImplicitToolHolder = Readonly<{ agentId: AgentId; impliedBy: Readonly<ToolName[]> }>;

/**
 * Every hub-managed agent of `bundle` that effectively holds `implementationKey` through another
 * attached tool's own implication, never through an attachment of its own entry
 * (`compileAttachments`'s own `impliedBy`). Deleting the catalog entry `implementationKey` names
 * retires it from the hub — gone from every list, never attachable again — while the compiler goes
 * on granting it regardless, for as long as whatever implies it (`tests.run` implying
 * `workspace.write`) stays attached: the hub would show the capability as retired everywhere while
 * an agent keeps using it, unaffected. The same discrepancy `tool-catalog.ts`'s own
 * `legacyAgentsGrantingTool` already guards against for a legacy agent's own `permissions` — this
 * restates it for a hub-managed agent's *compiled* attachments, which a legacy agent has none of, so
 * the two never overlap: between them, every agent that would keep the capability is caught.
 */
export async function agentsImplicitlyHoldingTool(
	db: Db,
	bundle: Readonly<{
		agents: Readonly<AgentConfig[]>;
		toolAttachments: ToolAttachmentsBundle;
		financeAgentId: AgentId;
	}>,
	implementationKey: ToolName,
): Promise<Readonly<ImplicitToolHolder[]>> {
	if (Object.keys(bundle.toolAttachments).length === 0) {
		return [];
	}
	const catalog = await loadCompilableCatalogEntries(db, bundle.toolAttachments);
	const holders: ImplicitToolHolder[] = [];
	for (const agent of bundle.agents) {
		const attachments = Object.hasOwn(bundle.toolAttachments, agent.id)
			? bundle.toolAttachments[agent.id]
			: undefined;
		if (attachments === undefined) {
			continue;
		}
		const compiled = compileAttachments({
			agentId: agent.id,
			financeAgentId: bundle.financeAgentId,
			adapter: agent.runtime.adapter,
			attachments,
			catalog,
		});
		const impliers = compiled.impliedBy[implementationKey];
		if (impliers !== undefined && impliers.length > 0) {
			holders.push({ agentId: agent.id, impliedBy: impliers });
		}
	}
	return holders.sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
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
 * Every agent attaching the same catalog entry more than once (`attachTool`'s own op always
 * replaces any existing attachment of the same `entryId` before adding its own — `applyOperation`,
 * `management.ts` — so this can only ever come from a document built outside that path: a raw
 * `tool-attachments.json` import, or a hand-built `set_tool_attachments`). Two attachments of one
 * entry — `allow` and `disabled`, say — compile into overlapping permission-list entries that
 * `AgentConfigSchema` itself refuses (`toolPatternOverlaps`), so left unchecked here, a bundle
 * like this commits cleanly and only fails later, when something next reads it back
 * (`loadActiveBundle`). Pure; no catalog lookup needed to tell two attachments of the same entry
 * apart.
 */
export function duplicateAttachmentIssues(
	toolAttachments: ToolAttachmentsBundle,
): Readonly<string[]> {
	const problems: string[] = [];
	for (const [agentId, attachments] of Object.entries(toolAttachments)) {
		const seen = new Set<string>();
		for (const attachment of attachments) {
			if (seen.has(attachment.entryId)) {
				problems.push(
					`toolAttachments: agent '${agentId}' attaches catalog entry '${attachment.entryId}' more than once`,
				);
			}
			seen.add(attachment.entryId);
		}
	}
	return problems;
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
 * Also includes {@link duplicateAttachmentIssues}, which needs no catalog lookup of its own but
 * belongs in the same, single gate every committing path already calls.
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
		return duplicateAttachmentIssues(toolAttachments);
	}
	const [entries, versions] = await Promise.all([
		loadAttachableEntries(db, entryIds),
		loadKnownEntryVersions(db, entryIds),
	]);
	const problems: string[] = [...duplicateAttachmentIssues(toolAttachments)];
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
