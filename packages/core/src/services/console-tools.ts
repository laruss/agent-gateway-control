import type {
	AgentId,
	ConsoleAdoptCommitResponse,
	ConsoleAdoptPreviewResponse,
	ConsoleAgentToolsResponse,
	ConsoleAttachToolRequest,
	ConsoleAttachToolResponse,
	ConsoleCatalogAttachedAgent,
	ConsoleCreateCustomToolRequest,
	ConsoleDetachToolRequest,
	ConsoleDetachToolResponse,
	ConsoleEditCatalogEntryRequest,
	ConsoleLegacyGrantingAgent,
	ConsoleToolCatalogListItem,
	ConsoleToolCatalogListResponse,
	ConsoleUpdateAttachmentRequest,
	ConsoleUpdateAttachmentResponse,
	ToolCatalogEntry,
	ToolCatalogEntryId,
	ToolCatalogEntryVersion,
	ToolCatalogEntryView,
} from "@agent-gateway/contracts";
import { RuntimeAdapterIdSchema } from "@agent-gateway/contracts";
import { agents, catalogAttachments } from "@agent-gateway/db";
import { asc, eq } from "drizzle-orm";
import { AdminError, inTransaction } from "./admin.ts";
import type { ControlPlaneDeps } from "./deps.ts";
import {
	knownCatalogEntries,
	legacyAttachmentsFromPermissions,
	loadEffectivePermissionsIn,
} from "./effective-permissions.ts";
import { activeConfigRevisionId, loadActiveBundle, ManagementConflictError } from "./management.ts";
import { runtimeHealth } from "./runtime-health.ts";
import {
	adoptAgentToolAttachments,
	attachTool,
	createCustomHttpsTool,
	createCustomHttpsToolInputProblems,
	deleteCatalogEntry,
	detachTool,
	EMPTY_AVAILABILITY_CONTEXT,
	editCatalogEntry,
	editCatalogEntryInputProblems,
	getCatalogEntry,
	installedAdaptersFromHealth,
	legacyAgentsGrantingTool,
	listCatalogEntries,
	listCatalogEntryVersions,
	StaleCatalogEntryVersionError,
	StaleConversionError,
	type ToolCatalogAvailabilityContext,
	updateAttachment,
} from "./tool-catalog.ts";

// ---------------------------------------------------------------------------
// The Instruments & Utils hub's own read models and change-set translation (ADR-025/ADR-027): the
// first real caller of the tool-catalog service's own functions beyond the CLI and tests. Exactly
// `console-management.ts`'s own convention — never a `Request`/`Response` here, every result a
// plain, typed union the HTTP layer (`apps/controller/src/console-tools.ts`) maps onto a status
// code. A secret alias's own "is it set" status is deliberately NOT computed here: this package
// depends on no filesystem access at all (`docs/project-structure.md`'s boundary), so the
// controller — which already reads secret files for other purposes — enriches
// `consoleGetToolCatalogEntry`'s result with that one fact itself.
// ---------------------------------------------------------------------------

async function availabilityContext(
	deps: ControlPlaneDeps,
): Promise<ToolCatalogAvailabilityContext> {
	// `registeredExecutorActionTypes`/`registeredNamespaces` have no live signal yet in production
	// (ADR-027's own documented gap — no running tool runner reports what it registers back to the
	// controller this release); only `installedAdapters` (native capabilities) reflects something
	// this process can actually observe (`runtimeHealth`).
	const health = await runtimeHealth(deps);
	return { ...EMPTY_AVAILABILITY_CONTEXT, installedAdapters: installedAdaptersFromHealth(health) };
}

async function attachedAgentCounts(
	deps: ControlPlaneDeps,
): Promise<ReadonlyMap<ToolCatalogEntryId, number>> {
	return inTransaction(deps, async ({ tx }) => {
		const rows = await tx.db
			.select({ entryId: catalogAttachments.entryId })
			.from(catalogAttachments);
		const counts = new Map<ToolCatalogEntryId, number>();
		// One `catalog_attachments` row is already one (agent, entry) pair (its own unique target,
		// `admin.ts`'s reconciliation), so a plain count per entry is already a distinct-agent count.
		for (const row of rows) {
			counts.set(row.entryId, (counts.get(row.entryId) ?? 0) + 1);
		}
		return counts;
	});
}

/** `GET /api/tools`: every active catalog entry, grouped by `kind` client-side. */
export async function consoleListToolCatalog(
	deps: ControlPlaneDeps,
): Promise<ConsoleToolCatalogListResponse> {
	const context = await availabilityContext(deps);
	const [entries, counts] = await Promise.all([
		listCatalogEntries(deps, context),
		attachedAgentCounts(deps),
	]);
	const items: ConsoleToolCatalogListItem[] = entries.map((entry) => ({
		id: entry.id,
		kind: entry.kind,
		name: entry.currentVersion.name,
		description: entry.currentVersion.description,
		isBuiltin: entry.isBuiltin,
		riskFloor: entry.currentVersion.riskFloor,
		supportedAdapters: entry.currentVersion.supportedAdapters,
		available: entry.available,
		attachedAgentCount: counts.get(entry.id) ?? 0,
		deleted: false,
	}));
	return { entries: items, knownRuntimeAdapters: [...RuntimeAdapterIdSchema.options] };
}

/** Every agent currently attached to `entryId`, its own display name joined in, sorted by agent id
 * — the cheap, indexed `catalog_attachments` read ADR-027 describes, not a snapshot
 * deserialization. */
async function listEntryAttachments(
	deps: ControlPlaneDeps,
	entryId: string,
): Promise<Readonly<ConsoleCatalogAttachedAgent[]>> {
	return inTransaction(deps, ({ tx }) =>
		tx.db
			.select({
				agentId: catalogAttachments.agentId,
				displayName: agents.displayName,
				mode: catalogAttachments.mode,
				pinnedVersion: catalogAttachments.pinnedVersion,
			})
			.from(catalogAttachments)
			.innerJoin(agents, eq(agents.id, catalogAttachments.agentId))
			.where(eq(catalogAttachments.entryId, entryId))
			.orderBy(asc(catalogAttachments.agentId)),
	);
}

export type ConsoleCatalogEntryCore = Readonly<{
	entry: ToolCatalogEntryView;
	versions: Readonly<ToolCatalogEntryVersion[]>;
	attachedAgents: Readonly<ConsoleCatalogAttachedAgent[]>;
	legacyGrantingAgents: Readonly<ConsoleLegacyGrantingAgent[]>;
}>;

/** `GET /api/tools/:entryId`, minus the secret-alias "is it set" status the controller layer adds
 * (see this file's own doc comment). Null when `entryId` does not exist or is deleted. */
export async function consoleGetToolCatalogEntry(
	deps: ControlPlaneDeps,
	entryId: string,
): Promise<ConsoleCatalogEntryCore | null> {
	const context = await availabilityContext(deps);
	const entry = await getCatalogEntry(deps, entryId, context);
	if (entry === null) {
		return null;
	}
	const [versions, attachedAgents, legacyGrantingAgents] = await Promise.all([
		listCatalogEntryVersions(deps, entryId),
		listEntryAttachments(deps, entryId),
		inTransaction(deps, ({ tx }) => legacyAgentsGrantingTool(tx.db, entry.implementationKey)),
	]);
	return { entry, versions, attachedAgents, legacyGrantingAgents };
}

export type ConsoleCreateCustomToolResult =
	| Readonly<{ kind: "ok"; entry: ToolCatalogEntry }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>;

/** `POST /api/tools`: defines a new owner-managed `custom_https` entry (ADR-027), the console's
 * own equivalent of `gateway tools custom create`. */
export async function consoleCreateCustomTool(
	deps: ControlPlaneDeps,
	input: ConsoleCreateCustomToolRequest,
	actor: string,
): Promise<ConsoleCreateCustomToolResult> {
	const problems = createCustomHttpsToolInputProblems({ ...input, actor });
	if (problems.length > 0) {
		return { kind: "invalid", problems };
	}
	try {
		const entry = await createCustomHttpsTool(deps, { ...input, actor });
		return { kind: "ok", entry };
	} catch (error) {
		if (error instanceof AdminError) {
			return { kind: "invalid", problems: [error.message] };
		}
		throw error;
	}
}

export type ConsoleEditCatalogEntryResult =
	| Readonly<{ kind: "ok"; entry: ToolCatalogEntry }>
	| Readonly<{ kind: "not-found" }>
	| Readonly<{ kind: "conflict"; currentVersion: number }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>;

/** `POST /api/tools/:entryId/edit`: publishes a new, immutable version (ADR-027). A built-in's own
 * `httpsDefinition` is never accepted by `ConsoleEditCatalogEntryRequestSchema`'s own shape, but a
 * non-built-in, non-`custom_https` edit of it is still refused here, at `editCatalogEntry`'s own
 * kind check — surfaced as `invalid`, same as every other business-rule refusal.
 * `input.expectedVersion`, when the console gives it (the entry-detail page's own last-shown
 * version), binds this edit to it — refused as `kind: "conflict"` once someone else's edit already
 * moved the entry to a different version, rather than silently merging this one's own fields over
 * changes the owner never saw (`StaleCatalogEntryVersionError`). */
export async function consoleEditCatalogEntry(
	deps: ControlPlaneDeps,
	entryId: string,
	input: ConsoleEditCatalogEntryRequest,
	actor: string,
): Promise<ConsoleEditCatalogEntryResult> {
	const context = await availabilityContext(deps);
	const existing = await getCatalogEntry(deps, entryId, context);
	if (existing === null) {
		return { kind: "not-found" };
	}
	const problems = editCatalogEntryInputProblems({ entryId, ...input, actor });
	if (problems.length > 0) {
		return { kind: "invalid", problems };
	}
	try {
		const entry = await editCatalogEntry(deps, { entryId, ...input, actor });
		return { kind: "ok", entry };
	} catch (error) {
		if (error instanceof StaleCatalogEntryVersionError) {
			return { kind: "conflict", currentVersion: error.currentVersion };
		}
		if (error instanceof AdminError) {
			return { kind: "invalid", problems: [error.message] };
		}
		throw error;
	}
}

export type ConsoleDeleteCatalogEntryResult =
	| Readonly<{ kind: "ok"; affectedAgentIds: Readonly<AgentId[]> }>
	| Readonly<{ kind: "not-found" }>
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>;

/** `POST /api/tools/:entryId/delete`: removes every agent's attachment of `entryId` atomically and
 * tombstones a built-in (`deleteCatalogEntry`, ADR-027). `affectedAgentIds` comes back from
 * `deleteCatalogEntry` itself — read fresh inside its own transaction, immediately before it
 * commits — never a separate, earlier read of this function's own that a concurrent attach or
 * detach could have made stale by the time the delete actually ran. `expectedAttachedAgentIds`,
 * when the caller gives it (the console's own last-shown impact preview), binds the delete to that
 * exact set: refused as a conflict the moment the live set no longer matches, rather than silently
 * deleting a different one than what the owner actually confirmed. */
export async function consoleDeleteCatalogEntry(
	deps: ControlPlaneDeps,
	entryId: string,
	actor: string,
	expectedAttachedAgentIds?: Readonly<AgentId[]>,
): Promise<ConsoleDeleteCatalogEntryResult> {
	const context = await availabilityContext(deps);
	const existing = await getCatalogEntry(deps, entryId, context);
	if (existing === null) {
		return { kind: "not-found" };
	}
	try {
		const { affected } = await deleteCatalogEntry(
			deps,
			entryId,
			actor,
			"console",
			expectedAttachedAgentIds,
		);
		return { kind: "ok", affectedAgentIds: affected };
	} catch (error) {
		if (error instanceof ManagementConflictError) {
			return { kind: "conflict", currentRevisionId: error.currentRevisionId };
		}
		if (error instanceof AdminError) {
			return { kind: "invalid", problems: [error.message] };
		}
		throw error;
	}
}

/** Whether `agentId` exists in the active configuration snapshot right now — the same existence
 * check every agent sub-route below needs before touching its attachments. */
async function agentExistsNow(deps: ControlPlaneDeps, agentId: string): Promise<boolean> {
	const revisionId = await activeConfigRevisionId(deps);
	const { bundle } = await inTransaction(deps, ({ tx }) => loadActiveBundle(tx.db, revisionId));
	return bundle.agents.some((agent) => agent.id === agentId);
}

/** `GET /api/agents/:id/tools`: requested attachments (recorded, for a hub-managed agent; a
 * read-only legacy conversion otherwise) against effective, compiled permissions — the agent
 * capability editor's own data (ADR-027). Null when the agent does not exist in the active
 * configuration. */
export async function consoleAgentTools(
	deps: ControlPlaneDeps,
	agentId: string,
): Promise<ConsoleAgentToolsResponse | null> {
	const revisionId = await activeConfigRevisionId(deps);
	return inTransaction(deps, async ({ tx }) => {
		const { bundle } = await loadActiveBundle(tx.db, revisionId);
		const agent = bundle.agents.find((candidate) => candidate.id === agentId);
		if (agent === undefined) {
			return null;
		}
		const financeAgentId = (bundle.organization?.organization.finance_agent_id ?? "") as AgentId;
		const toolAttachmentsManaged = bundle.toolAttachments[agentId] !== undefined;
		const known = await knownCatalogEntries(tx.db);
		const legacy = legacyAttachmentsFromPermissions(agent.permissions, known);
		const requested = toolAttachmentsManaged
			? (bundle.toolAttachments[agentId] ?? [])
			: legacy.attachments;
		const unresolved = toolAttachmentsManaged ? [] : legacy.unresolved;
		const effective = await loadEffectivePermissionsIn(
			tx,
			{ id: agentId as AgentId, config: agent, toolAttachmentsManaged },
			financeAgentId,
		);
		return {
			agentId: agentId as AgentId,
			hubManaged: toolAttachmentsManaged,
			baseRevisionId: revisionId,
			requested: [...requested],
			unresolved: [...unresolved],
			effective: {
				allow: [...effective.toolPolicy.allow],
				requireApproval: [...effective.toolPolicy.requireHumanApproval],
				deny: [...effective.toolPolicy.deny],
			},
			capabilities: [...effective.capabilities],
			missingPrerequisites: Object.fromEntries(
				Object.entries(effective.missingPrerequisites).map(([tool, missing]) => [
					tool,
					[...missing],
				]),
			),
			memoryWriteAllowed: effective.memoryWriteAllowed,
		};
	});
}

export type ConsoleAttachToolResult =
	| (Readonly<{ kind: "ok" }> & ConsoleAttachToolResponse)
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>;

/** `POST /api/agents/:id/tools/attach`: binds `input.entryId` to `agentId`, converting a still-
 * legacy agent's `permissions` into real attachments in the same revision when needed
 * (`attachTool`, ADR-027). */
export async function consoleAttachTool(
	deps: ControlPlaneDeps,
	agentId: string,
	input: ConsoleAttachToolRequest,
	actor: string,
): Promise<ConsoleAttachToolResult> {
	try {
		const result = await attachTool(deps, {
			agentId: agentId as AgentId,
			entryId: input.entryId,
			pinnedVersion: input.pinnedVersion,
			mode: input.mode,
			...(input.settings === undefined ? {} : { settings: input.settings }),
			actor,
			source: "console",
			idempotencyKey: input.idempotencyKey,
			...(input.reason === undefined ? {} : { reason: input.reason }),
			...(input.baseRevisionId === undefined ? {} : { baseRevisionId: input.baseRevisionId }),
		});
		return {
			kind: "ok",
			revisionId: result.revisionId,
			hash: result.hash,
			noop: result.noop,
			replayed: result.replayed,
			activeRevisionId: result.activeRevisionId,
			legacyConversion: [...result.legacyConversion],
		};
	} catch (error) {
		if (error instanceof ManagementConflictError) {
			return { kind: "conflict", currentRevisionId: error.currentRevisionId };
		}
		if (error instanceof AdminError) {
			return { kind: "invalid", problems: [error.message] };
		}
		throw error;
	}
}

export type ConsoleDetachToolResult =
	| (Readonly<{ kind: "ok" }> & ConsoleDetachToolResponse)
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>;

/** `POST /api/agents/:id/tools/detach`: a no-op (still a fresh revision) when `agentId` has no
 * attachment of `input.entryId`. */
export async function consoleDetachTool(
	deps: ControlPlaneDeps,
	agentId: string,
	input: ConsoleDetachToolRequest,
	actor: string,
): Promise<ConsoleDetachToolResult> {
	try {
		const result = await detachTool(deps, {
			agentId: agentId as AgentId,
			entryId: input.entryId,
			actor,
			source: "console",
			idempotencyKey: input.idempotencyKey,
			...(input.reason === undefined ? {} : { reason: input.reason }),
		});
		return {
			kind: "ok",
			revisionId: result.revisionId,
			hash: result.hash,
			noop: result.noop,
			replayed: result.replayed,
			activeRevisionId: result.activeRevisionId,
		};
	} catch (error) {
		if (error instanceof ManagementConflictError) {
			return { kind: "conflict", currentRevisionId: error.currentRevisionId };
		}
		if (error instanceof AdminError) {
			return { kind: "invalid", problems: [error.message] };
		}
		throw error;
	}
}

export type ConsoleUpdateAttachmentResult =
	| (Readonly<{ kind: "ok" }> & ConsoleUpdateAttachmentResponse)
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>;

/** `POST /api/agents/:id/tools/update`: patches an existing attachment's own fields (mode, pinned
 * version, settings); refused when there is no existing attachment to patch
 * (`updateAttachment`'s own rule). */
export async function consoleUpdateAttachment(
	deps: ControlPlaneDeps,
	agentId: string,
	input: ConsoleUpdateAttachmentRequest,
	actor: string,
): Promise<ConsoleUpdateAttachmentResult> {
	try {
		const result = await updateAttachment(deps, {
			agentId: agentId as AgentId,
			entryId: input.entryId,
			...(input.pinnedVersion === undefined ? {} : { pinnedVersion: input.pinnedVersion }),
			...(input.mode === undefined ? {} : { mode: input.mode }),
			...(input.settings === undefined ? {} : { settings: input.settings }),
			actor,
			source: "console",
			idempotencyKey: input.idempotencyKey,
			...(input.reason === undefined ? {} : { reason: input.reason }),
		});
		return {
			kind: "ok",
			revisionId: result.revisionId,
			hash: result.hash,
			noop: result.noop,
			replayed: result.replayed,
			activeRevisionId: result.activeRevisionId,
		};
	} catch (error) {
		if (error instanceof ManagementConflictError) {
			return { kind: "conflict", currentRevisionId: error.currentRevisionId };
		}
		if (error instanceof AdminError) {
			return { kind: "invalid", problems: [error.message] };
		}
		throw error;
	}
}

/** `GET /api/agents/:id/tools/adopt`: a dry-run preview of "Adopt into the tools hub" (ADR-027).
 * Null when the agent does not exist. */
export async function consoleAdoptPreview(
	deps: ControlPlaneDeps,
	agentId: string,
	actor: string,
): Promise<ConsoleAdoptPreviewResponse | null> {
	if (!(await agentExistsNow(deps, agentId))) {
		return null;
	}
	const [result] = await adoptAgentToolAttachments(deps, {
		agentIds: [agentId as AgentId],
		dryRun: true,
		actor,
	});
	if (result === undefined) {
		throw new AdminError(`internal: adopt preview for '${agentId}' returned no result`);
	}
	return {
		agentId: result.agentId,
		alreadyHubManaged: result.alreadyHubManaged,
		baseRevisionId: result.revisionId,
		unresolved: [...result.unresolved],
		before: result.before,
		after: result.after,
		attachments: [...result.attachments],
		conversionHash: result.conversionHash,
		problems: [...result.problems],
	};
}

export type ConsoleAdoptCommitResult =
	| (Readonly<{ kind: "ok" }> & ConsoleAdoptCommitResponse)
	| Readonly<{ kind: "not-found" }>
	| Readonly<{ kind: "conflict"; currentRevisionId: number | null }>
	| Readonly<{ kind: "invalid"; problems: Readonly<string[]> }>;

/** `POST /api/agents/:id/tools/adopt`: commits the same conversion {@link consoleAdoptPreview}
 * previewed (ADR-027's `adoptAgentToolAttachments`, `source: "console"`) — against exactly the
 * revision that preview was read from (`baseRevisionId`, echoed back from its response), never a
 * freshly re-read "current" one: a configuration change landing between the preview and this
 * confirm is a conflict (`ManagementConflictError` -> `kind: "conflict"`), the same as every other
 * preview/commit pair in the console, rather than a commit silently built from newer attachments the
 * preview never showed. `expectedConversionHash` closes the same gap for the catalog itself, which
 * carries no config revision of its own: a catalog entry created, edited or deleted since the
 * preview changes what its legacy patterns resolve to without moving `baseRevisionId` at all —
 * `StaleConversionError` reports it the same way, `kind: "conflict"` against the same
 * `currentRevisionId` (unmoved; it is the catalog that changed, not the configuration), since
 * either way the console's own remedy is identical: reload the preview and try again. */
export async function consoleAdoptCommit(
	deps: ControlPlaneDeps,
	agentId: string,
	actor: string,
	baseRevisionId: number | null,
	expectedConversionHash: string,
	idempotencyKey: string,
	reason: string | undefined,
): Promise<ConsoleAdoptCommitResult> {
	if (!(await agentExistsNow(deps, agentId))) {
		return { kind: "not-found" };
	}
	try {
		const [result] = await adoptAgentToolAttachments(deps, {
			agentIds: [agentId as AgentId],
			dryRun: false,
			actor,
			source: "console",
			idempotencyKey,
			baseRevisionId,
			expectedAttachmentsHash: expectedConversionHash,
			...(reason === undefined ? {} : { reason }),
		});
		if (result === undefined) {
			throw new AdminError(`internal: adopt commit for '${agentId}' returned no result`);
		}
		return {
			kind: "ok",
			agentId: result.agentId,
			alreadyHubManaged: result.alreadyHubManaged,
			baseRevisionId: result.revisionId,
			unresolved: [...result.unresolved],
			before: result.before,
			after: result.after,
			attachments: [...result.attachments],
			conversionHash: result.conversionHash,
			problems: [...result.problems],
			commit: result.commit,
		};
	} catch (error) {
		if (error instanceof ManagementConflictError) {
			return { kind: "conflict", currentRevisionId: error.currentRevisionId };
		}
		if (error instanceof StaleConversionError) {
			return { kind: "conflict", currentRevisionId: baseRevisionId };
		}
		if (error instanceof AdminError) {
			return { kind: "invalid", problems: [error.message] };
		}
		throw error;
	}
}
