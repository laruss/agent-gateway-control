import type { AgentPatch, ConsoleAgentDetail } from "@agent-gateway/contracts";

// ---------------------------------------------------------------------------
// Rebasing a draft onto a freshly reloaded agent, after a 409 conflict (ADR-025, P1): `AgentPatch`
// is already a sparse patch of only the fields the owner actually touched (every tab's own
// `patchDraft` call omits a field the moment its value returns to equal `original`, never a whole
// snapshot) — "track dirty fields, not whole snapshots" is the shape this draft already has.
// `rebaseDraft` is what "Reload and try again" (`review-dialog.tsx`) uses: it keeps every dirty
// field whose own live value did not change upstream (to be merged onto the new live definition
// the next time it is previewed or committed, same as always), and discards one that did — the
// owner's own edit to that one field is not silently re-applied over someone else's, equally
// silent, change to the very same field.
// ---------------------------------------------------------------------------

type FieldKey = keyof AgentPatch;

/** A short, human-readable name for each patchable field, for the notice a discarded field gets
 * (`agent-detail-page.tsx`). */
const FIELD_LABELS: Readonly<Record<FieldKey, string>> = {
	displayName: "display name",
	enabled: "enabled switch",
	rolePrompt: "role prompt",
	runtime: "runtime settings",
	wakeRules: "wake rules",
	allowedChannels: "allowed channels",
	permissions: "permissions",
};

/** Structural equality, recursing into plain objects and arrays alike. Exported for
 * `review-dialog.tsx`'s own staleness check (comparing a captured draft snapshot against the
 * live draft prop), not only for this module's own field-by-field rebase. */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((value, index) => deepEqual(value, b[index]))
		);
	}
	if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
		const aRecord = a as Record<string, unknown>;
		const bRecord = b as Record<string, unknown>;
		const keys = new Set([...Object.keys(aRecord), ...Object.keys(bRecord)]);
		return [...keys].every((key) => deepEqual(aRecord[key], bRecord[key]));
	}
	return false;
}

/** The part of `detail` each `AgentPatch` key is compared against, to tell whether a dirty field's
 * own live value changed upstream since the editor loaded it. Whole-field granularity (the
 * simplest acceptable resolution, ADR-025): a change anywhere inside `runtime` or `permissions`
 * conflicts the owner's entire edit to that field, never only the one sub-field that actually
 * moved. */
function fieldOf(detail: ConsoleAgentDetail, key: FieldKey): unknown {
	switch (key) {
		case "displayName":
			return detail.displayName;
		case "enabled":
			return detail.enabled;
		case "rolePrompt":
			return detail.rolePrompt;
		case "runtime":
			return detail.runtime;
		case "wakeRules":
			return detail.wakeRules;
		case "allowedChannels":
			return detail.mattermost.allowedChannels;
		case "permissions":
			return detail.permissions;
	}
}

export type RebaseDraftResult = Readonly<{
	/** `draft`, minus every field discarded below. Fields that survive are unchanged: they are
	 * merged onto `next`'s own live values the next time this draft is previewed or committed,
	 * exactly as before the reload. */
	rebased: AgentPatch;
	/** Human-readable labels of the fields dropped because their own live value changed between
	 * `previous` and `next` — for a visible notice; empty when nothing conflicted. */
	discardedFields: Readonly<string[]>;
}>;

/** Rebases `draft` from `previous` (the revision the editor had loaded) onto `next` (freshly
 * reloaded after a 409): every dirty field survives unless its own counterpart in `previous` and
 * `next` differ, in which case it is dropped (the owner's edit to that field is not re-applied
 * over the conflicting upstream change) and named in `discardedFields`. */
export function rebaseDraft(
	previous: ConsoleAgentDetail,
	next: ConsoleAgentDetail,
	draft: AgentPatch,
): RebaseDraftResult {
	const rebased: AgentPatch = { ...draft };
	const discardedFields: string[] = [];
	for (const key of Object.keys(draft) as FieldKey[]) {
		if (!deepEqual(fieldOf(previous, key), fieldOf(next, key))) {
			delete rebased[key];
			discardedFields.push(FIELD_LABELS[key]);
		}
	}
	return { rebased, discardedFields };
}

/** `draft`, minus every field `applied` touched — `agent-detail-page.tsx`'s own `onApplied`
 * handler uses this instead of discarding the whole draft once a commit succeeds: `applied` is
 * the snapshot `review-dialog.tsx` actually reviewed and committed, which by the time the commit
 * resolves may no longer be the whole of `draft` (dismissal is blocked while applying, but this
 * does not assume that holds forever) — a field edited after that snapshot was taken stays in the
 * draft, rather than being discarded along with everything that really did get committed. */
export function clearAppliedFields(draft: AgentPatch, applied: AgentPatch): AgentPatch {
	const next = { ...draft };
	for (const key of Object.keys(applied) as FieldKey[]) {
		delete next[key];
	}
	return next;
}
