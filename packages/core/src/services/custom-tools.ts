import {
	type ActionParam,
	type AgentId,
	type ApprovalRequestDraft,
	CUSTOM_DEFINITION_VERSION_PARAM,
	CUSTOM_REQUEST_PREVIEW_MAX,
	type CustomHttpsDefinition,
	customToolEntryId,
} from "@agent-gateway/contracts";
import { catalogAttachments, catalogEntries, catalogEntryVersions } from "@agent-gateway/db";
import {
	customDefinitionVersionIssues,
	customRequestSummary,
	customToolParamIssues,
	resolveCustomHttpRequest,
} from "@agent-gateway/policy";
import { and, eq, isNull } from "drizzle-orm";
import type { UnitOfWork } from "./deps.ts";

type Db = UnitOfWork["tx"]["db"];

/**
 * Pinning a `custom_https` approval to the definition version it was resolved against, and
 * re-checking that pin at grant time (ADR-027): the one piece of `custom_https`-specific policy
 * that needs the database, so it lives in `core`, never in the IO-free `policy` package.
 */

export type CustomHttpsCurrentVersion = Readonly<{
	version: number;
	definition: CustomHttpsDefinition;
}>;

/** `entryId`'s current version's own `custom_https` definition, or null when the entry does not
 * exist, is deleted, or is not a `custom_https` entry at all. */
export async function loadCurrentCustomHttpsDefinition(
	db: Db,
	entryId: string,
): Promise<CustomHttpsCurrentVersion | null> {
	const [row] = await db
		.select({
			version: catalogEntryVersions.version,
			httpsDefinition: catalogEntryVersions.httpsDefinition,
		})
		.from(catalogEntries)
		.innerJoin(catalogEntryVersions, eq(catalogEntries.currentVersionId, catalogEntryVersions.id))
		.where(
			and(
				eq(catalogEntries.id, entryId),
				eq(catalogEntries.kind, "custom_https"),
				isNull(catalogEntries.deletedAt),
			),
		);
	if (row === undefined || row.httpsDefinition === null) {
		return null;
	}
	return { version: row.version, definition: row.httpsDefinition };
}

/** `entryId`'s own `custom_https` definition at exactly `version` (never "current") — the
 * immutable content a pinned attachment actually resolves to, read the same way
 * `gateway_custom_tool_definition` reads it for execution. Null under the same conditions
 * {@link loadCurrentCustomHttpsDefinition} is (the entry gone, deleted, not `custom_https`), or
 * when `version` simply does not exist for it. */
export async function loadCustomHttpsDefinitionAtVersion(
	db: Db,
	entryId: string,
	version: number,
): Promise<CustomHttpsCurrentVersion | null> {
	const [row] = await db
		.select({
			version: catalogEntryVersions.version,
			httpsDefinition: catalogEntryVersions.httpsDefinition,
		})
		.from(catalogEntries)
		.innerJoin(catalogEntryVersions, eq(catalogEntryVersions.entryId, catalogEntries.id))
		.where(
			and(
				eq(catalogEntries.id, entryId),
				eq(catalogEntries.kind, "custom_https"),
				isNull(catalogEntries.deletedAt),
				eq(catalogEntryVersions.version, version),
			),
		);
	if (row === undefined || row.httpsDefinition === null) {
		return null;
	}
	return { version: row.version, definition: row.httpsDefinition };
}

/**
 * `agentId`'s own attachment of `entryId` — its `pinnedVersion` (`null` tracks the entry's current
 * version; a positive integer pins it, ADR-027) — read straight from `catalog_attachments`, the
 * current-state projection of the active revision's own attachments document: a cheap, indexed
 * `(agentId, entryId)` primary-key read, never the whole bundle. `null` too when no such attachment
 * exists at all (a legacy agent, or a hub-managed one simply not attached to this entry) — both
 * default to "track current", the same as an explicitly unpinned attachment.
 */
async function resolveAttachmentPinnedVersion(
	db: Db,
	agentId: AgentId,
	entryId: string,
): Promise<number | null> {
	const [row] = await db
		.select({ pinnedVersion: catalogAttachments.pinnedVersion })
		.from(catalogAttachments)
		.where(and(eq(catalogAttachments.agentId, agentId), eq(catalogAttachments.entryId, entryId)));
	return row?.pinnedVersion ?? null;
}

export type CustomApprovalDraftResult =
	| Readonly<{ kind: "ok"; draft: ApprovalRequestDraft }>
	| Readonly<{ kind: "refused"; issues: Readonly<string[]> }>;

/**
 * For a `needs_human` request naming a `custom_https` action (`custom.<entry-id>`): resolves
 * `agentId`'s own selected version of the entry — a pinned attachment's exact version, or the
 * entry's current one when unpinned (or when `agentId` has no attachment of it at all, same
 * default) — validates the model's own parameters against *that* version's definition and, only
 * once they pass, returns the draft augmented with `CUSTOM_DEFINITION_VERSION_PARAM` pinned to it —
 * added here, by the controller, never by the model. An agent pinned to an older version is never
 * approved (or, at grant time, executed) against a newer one the entry has since moved on to: the
 * attachment and its capability description say what version it is, and this is what keeps the
 * approval and the execution agreeing with that. The same comparison at grant time
 * (`customGrantTimeIssues`) is what lets the definition being edited further, or the attachment
 * itself being re-pinned, invalidate a still-pending request. A draft naming any other action type
 * is returned unchanged (`kind: "ok"`).
 *
 * This function never itself renders the approval card's own request preview (see
 * `customApprovalRequestPreview`) — it only resolves and validates the version the model's
 * parameters are checked against.
 */
export async function prepareCustomApprovalDraft(
	db: Db,
	agentId: AgentId,
	draft: ApprovalRequestDraft,
): Promise<CustomApprovalDraftResult> {
	const entryId = customToolEntryId(draft.actionType);
	if (entryId === null) {
		return { kind: "ok", draft };
	}
	const pinnedVersion = await resolveAttachmentPinnedVersion(db, agentId, entryId);
	const current =
		pinnedVersion === null
			? await loadCurrentCustomHttpsDefinition(db, entryId)
			: await loadCustomHttpsDefinitionAtVersion(db, entryId, pinnedVersion);
	if (current === null) {
		return {
			kind: "refused",
			issues: [`custom tool '${entryId}' does not exist or is not a custom_https entry`],
		};
	}
	// `custom_tool_definition_version` is reserved for this call alone (`customHttpsDefinitionProblems`
	// already refuses a definition that declares it as a parameter): a model-supplied copy is
	// stripped here, before validation and before the one, real copy below is added, so exactly one
	// ever reaches the stored action — never two entries sharing the name, where a later
	// `.find(...)` (grant-time re-validation, execution) could pick the model's own value instead of
	// this call's.
	const modelActionParams = draft.actionParams.filter(
		(param) => param.name !== CUSTOM_DEFINITION_VERSION_PARAM,
	);
	const issues = customToolParamIssues(current.definition, modelActionParams);
	if (issues.length > 0) {
		return { kind: "refused", issues };
	}
	return {
		kind: "ok",
		draft: {
			...draft,
			actionParams: [
				...modelActionParams,
				{ name: CUSTOM_DEFINITION_VERSION_PARAM, value: String(current.version) },
			],
		},
	};
}

/**
 * At grant time (ADR-018: re-checked live against the active configuration, never the run's stale
 * snapshot): whether `action`'s own pinned `custom_https` definition version still matches
 * `agentId`'s own currently selected version — a pinned attachment's exact version, or the entry's
 * current one when unpinned, resolved fresh here rather than whatever was true when the request was
 * prepared — and whether its stored parameters still pass that version's own typed rules. A
 * mismatch catches either the definition being edited further, or the attachment itself having been
 * re-pinned or unpinned, since the request was made. An action naming any other action type has
 * nothing to check here (`[]`).
 */
export async function customGrantTimeIssues(
	db: Db,
	agentId: AgentId,
	action: Readonly<{ actionType: string; actionParams: Readonly<ActionParam[]> }>,
): Promise<Readonly<string[]>> {
	const entryId = customToolEntryId(action.actionType);
	if (entryId === null) {
		return [];
	}
	const pinned = action.actionParams.find(
		(param) => param.name === CUSTOM_DEFINITION_VERSION_PARAM,
	);
	const storedVersion = pinned === undefined ? Number.NaN : Number(pinned.value);
	if (!Number.isInteger(storedVersion)) {
		return ["the stored action carries no valid definition version"];
	}
	const attachmentPinnedVersion = await resolveAttachmentPinnedVersion(db, agentId, entryId);
	const expected =
		attachmentPinnedVersion === null
			? await loadCurrentCustomHttpsDefinition(db, entryId)
			: await loadCustomHttpsDefinitionAtVersion(db, entryId, attachmentPinnedVersion);
	if (expected === null) {
		return [`custom tool '${entryId}' no longer exists or is not a custom_https entry`];
	}
	const versionIssues = customDefinitionVersionIssues(storedVersion, expected.version);
	if (versionIssues.length > 0) {
		return versionIssues;
	}
	return customToolParamIssues(expected.definition, action.actionParams);
}

export type CustomApprovalPreviewResult =
	/** Not a custom tool action at all, or the pinned version param is missing, invalid, or no
	 * longer names a real version (defensive: should not happen for anything that already passed
	 * {@link prepareCustomApprovalDraft}) — no preview belongs on this card. */
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "ok"; preview: string }>
	/** The full preview does not fit `MattermostApprovalPayloadSchema.customRequestPreview`'s own
	 * bound; the draft must be refused, never truncated (ADR-027). */
	| Readonly<{ kind: "refused"; issues: Readonly<string[]> }>;

/**
 * An authoritative, secret-free rendering of the exact HTTPS request `action` (a `custom_https`
 * approval's stored `actionType`/`actionParams`, its own pinned `CUSTOM_DEFINITION_VERSION_PARAM`
 * included) resolves to — the approval card's own preview, separate from the model's free-text
 * summary (ADR-027). Resolved against the exact pinned version (never "current"), the same version
 * execution itself reads through `gateway_custom_tool_definition`, so the preview never disagrees
 * with what actually runs. `{ kind: "none" }` for any action type that is not a custom tool, or
 * when the pinned version param is missing, invalid, or no longer names a real version.
 *
 * The owner must always see the complete request, never a cut one: a preview longer than
 * `CUSTOM_REQUEST_PREVIEW_MAX` (`MattermostApprovalPayloadSchema.customRequestPreview`'s own
 * schema bound — a resolved path or query value is percent-encoded, and a long enough one, a CJK
 * path segment, each character three UTF-8 bytes wide, nine characters once percent-encoded, can
 * make `customRequestSummary`'s rendering exceed that bound on its own) is `{ kind: "refused" }`,
 * never truncated — the caller refuses the whole draft, before an approval ever exists, rather
 * than storing a preview the owner cannot fully see.
 */
export async function customApprovalRequestPreview(
	db: Db,
	actionType: string,
	actionParams: Readonly<ActionParam[]>,
): Promise<CustomApprovalPreviewResult> {
	const entryId = customToolEntryId(actionType);
	if (entryId === null) {
		return { kind: "none" };
	}
	const pinned = actionParams.find((param) => param.name === CUSTOM_DEFINITION_VERSION_PARAM);
	const version = pinned === undefined ? Number.NaN : Number(pinned.value);
	if (!Number.isInteger(version)) {
		return { kind: "none" };
	}
	const current = await loadCustomHttpsDefinitionAtVersion(db, entryId, version);
	if (current === null) {
		return { kind: "none" };
	}
	const preview = customRequestSummary(resolveCustomHttpRequest(current.definition, actionParams));
	if (preview.length > CUSTOM_REQUEST_PREVIEW_MAX) {
		return {
			kind: "refused",
			issues: [
				`the request preview is too large to show in full for approval (${preview.length} characters, limit ${CUSTOM_REQUEST_PREVIEW_MAX}); use shorter parameter values`,
			],
		};
	}
	return { kind: "ok", preview };
}
