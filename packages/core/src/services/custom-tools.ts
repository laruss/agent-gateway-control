import {
	type ActionParam,
	type ApprovalRequestDraft,
	CUSTOM_DEFINITION_VERSION_PARAM,
	type CustomHttpsDefinition,
	customToolEntryId,
} from "@agent-gateway/contracts";
import { catalogEntries, catalogEntryVersions } from "@agent-gateway/db";
import { customDefinitionVersionIssues, customToolParamIssues } from "@agent-gateway/policy";
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

export type CustomApprovalDraftResult =
	| Readonly<{ kind: "ok"; draft: ApprovalRequestDraft }>
	| Readonly<{ kind: "refused"; issues: Readonly<string[]> }>;

/**
 * For a `needs_human` request naming a `custom_https` action (`custom.<entry-id>`): validates the
 * model's own parameters against the entry's *current* definition and, only once they pass,
 * returns the draft augmented with `CUSTOM_DEFINITION_VERSION_PARAM` pinned to that version — added
 * here, by the controller, never by the model. The same comparison at grant time
 * (`customGrantTimeIssues`) is what lets an edited definition invalidate a still-pending request.
 * A draft naming any other action type is returned unchanged (`kind: "ok"`).
 */
export async function prepareCustomApprovalDraft(
	db: Db,
	draft: ApprovalRequestDraft,
): Promise<CustomApprovalDraftResult> {
	const entryId = customToolEntryId(draft.actionType);
	if (entryId === null) {
		return { kind: "ok", draft };
	}
	const current = await loadCurrentCustomHttpsDefinition(db, entryId);
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
 * snapshot): whether `action`'s own pinned `custom_https` definition version still matches the
 * entry's current one, and whether its stored parameters still pass the current definition's own
 * typed rules. An action naming any other action type has nothing to check here (`[]`).
 */
export async function customGrantTimeIssues(
	db: Db,
	action: Readonly<{ actionType: string; actionParams: Readonly<ActionParam[]> }>,
): Promise<Readonly<string[]>> {
	const entryId = customToolEntryId(action.actionType);
	if (entryId === null) {
		return [];
	}
	const current = await loadCurrentCustomHttpsDefinition(db, entryId);
	if (current === null) {
		return [`custom tool '${entryId}' no longer exists or is not a custom_https entry`];
	}
	const pinned = action.actionParams.find(
		(param) => param.name === CUSTOM_DEFINITION_VERSION_PARAM,
	);
	const pinnedVersion = pinned === undefined ? Number.NaN : Number(pinned.value);
	if (!Number.isInteger(pinnedVersion)) {
		return ["the stored action carries no valid definition version"];
	}
	const versionIssues = customDefinitionVersionIssues(pinnedVersion, current.version);
	if (versionIssues.length > 0) {
		return versionIssues;
	}
	return customToolParamIssues(current.definition, action.actionParams);
}
