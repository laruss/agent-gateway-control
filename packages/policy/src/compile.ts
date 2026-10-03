import type {
	AgentId,
	AgentPermissions,
	PermissionWidening,
	RuntimeAdapterId,
	ToolAccessLevel,
	ToolAttachment,
	ToolCatalogEntryId,
	ToolCatalogEntryKind,
	ToolName,
	ToolPolicySnapshot,
} from "@agent-gateway/contracts";
import { FINANCE_TOOLS, toolPatternCovers } from "@agent-gateway/contracts";

/**
 * `ToolAccessLevel`/`PermissionWidening` (ADR-027's "a removal never widens effective
 * permissions"): the same reasoning as `modeSupportedByKind` above — a console confirm dialog needs
 * these shapes to hash and display a widening without depending on this package's own IO-adjacent
 * code, so both live in `@agent-gateway/contracts` and are re-exported here unchanged.
 */
export type { PermissionWidening, ToolAccessLevel } from "@agent-gateway/contracts";
/**
 * Which attachment modes an entry's own `kind` supports at all: moved to
 * `@agent-gateway/contracts` (beside `riskFloorAllows`) so a console client can share the same
 * rule without depending on this package's own Node-only, IO-adjacent code (egress/IP
 * classification among it); re-exported here unchanged so every existing import of this module
 * keeps working.
 */
export { modeSupportedByKind } from "@agent-gateway/contracts";

// ---------------------------------------------------------------------------
// Catalog-level native dependencies: data, not scattered ifs. Two different kinds of fact,
// deliberately kept separate because they push effective permissions in opposite directions:
//
// - `NATIVE_TOOL_DEPENDENCIES` *adds*: granting the key tool with mode `allow` also makes the
//   listed tools effectively usable, because the runtime needs them to perform the granted
//   action (running commands needs reading the files the commands run against). An agent that
//   attaches only `tests.run` still gets `repository.read` for free; attaching `tests.run` does
//   not, by itself, also hand over `workspace.write` as its own grantable capability — a
//   runtime-wide fact (`packages/runtime-sdk`'s `nativeToolGrants`) this table restates for the
//   compiled result so every enforcement point that reads it (not only `nativeToolGrants`
//   itself) agrees on what is effectively allowed.
// - `ADAPTER_NATIVE_PREREQUISITES` *narrows, as a fact only*: for a specific runtime adapter, a
//   tool that is granted may still be practically unusable without another also being granted,
//   because that adapter has no other way to perform it. Codex reads files only through its
//   shell (`packages/runtime-codex`'s `SHELL_FEATURES`, withheld unless `tests.run` is granted),
//   so `repository.read` alone gives a Codex agent no file access at all. The adapter itself
//   already fails this closed (`sandboxArgs`); this table exists so the compiled result can
//   *say so* (`missingPrerequisites`), not to change what is granted.
// ---------------------------------------------------------------------------

export const NATIVE_TOOL_DEPENDENCIES: Readonly<Partial<Record<ToolName, Readonly<ToolName[]>>>> = {
	"workspace.write": ["repository.read"],
	"tests.run": ["repository.read", "workspace.write"],
};

export const ADAPTER_NATIVE_PREREQUISITES: Readonly<
	Partial<Record<RuntimeAdapterId, Readonly<Partial<Record<ToolName, Readonly<ToolName[]>>>>>>
> = {
	codex: { "repository.read": ["tests.run"] },
};

/**
 * Every tool `toolName` would transitively imply, granted with `allow`
 * (`NATIVE_TOOL_DEPENDENCIES`, walked to a fixed point) — never including `toolName` itself. Used
 * where a caller must know what a tool *would* pull in before any attachment of it actually exists
 * to compile against (admission-time: `checkAttachable` refuses attaching a native tool whose own
 * implied prerequisite has no live catalog entry, ADR-027's "a deleted entry is never granted
 * implicitly" — defence in depth alongside the compiler's own, identical rule at the moment every
 * attachment is actually compiled, which this does not replace: a prerequisite deleted *after* an
 * attachment already exists is still caught there, not here).
 */
export function transitiveNativeDependencies(toolName: ToolName): ReadonlySet<ToolName> {
	const result = new Set<ToolName>();
	const stack = [...(NATIVE_TOOL_DEPENDENCIES[toolName] ?? [])];
	while (stack.length > 0) {
		const next = stack.pop();
		if (next === undefined || result.has(next)) {
			continue;
		}
		result.add(next);
		stack.push(...(NATIVE_TOOL_DEPENDENCIES[next] ?? []));
	}
	return result;
}

/** What the compiler needs to know about a catalog entry an attachment names; nothing else. */
export type CompiledCatalogEntry = Readonly<{
	kind: ToolCatalogEntryKind;
	implementationKey: ToolName;
}>;

export type CompileAttachmentsInput = Readonly<{
	agentId: AgentId;
	/** `organization.finance_agent_id`: the only agent finance capabilities ever compile in for. */
	financeAgentId: AgentId;
	adapter: RuntimeAdapterId;
	attachments: Readonly<ToolAttachment[]>;
	/** Every live catalog entry this compile could possibly need, by its id — every entry
	 * `attachments` itself names, *and* every entry a native dependency (`NATIVE_TOOL_DEPENDENCIES`)
	 * could ever imply, whether this agent (or any agent) is attached to it or not: an implied tool
	 * commonly has no attachment of its own at all (`repository.read` implied by `tests.run`), so the
	 * compiler can only tell a merely-unattached implied tool apart from a deleted one by whether its
	 * own entry is here. An attachment naming an id absent here (a deleted or otherwise unknown
	 * entry) contributes nothing — the write boundary never lets this happen for a committed
	 * configuration, but the compiler itself stays fail-closed. A deleted entry is never a member of
	 * this map at all (every caller excludes it before this function ever sees it) — this is how the
	 * compiler tells "unattached but live" (still implied) apart from "deleted" (never granted,
	 * reported as a missing prerequisite instead, ADR-027's "a deleted entry is never granted
	 * implicitly"). */
	catalog: ReadonlyMap<ToolCatalogEntryId, CompiledCatalogEntry>;
}>;

export type CompiledToolPermissions = Readonly<{
	/** Disjoint from `requireApproval` and `deny`: every tool this agent may use outright. */
	allow: Readonly<ToolName[]>;
	/** Disjoint from `allow` and `deny`: every tool this agent may use only with a human's approval. */
	requireApproval: Readonly<ToolName[]>;
	/** Disjoint from `allow` and `requireApproval`: every tool an attachment explicitly disabled. */
	deny: Readonly<ToolName[]>;
	/** Every tool in `allow` added beyond what was directly attached that way, because another
	 * attached tool implies it (`NATIVE_TOOL_DEPENDENCIES`); keyed by the implied tool, listing
	 * what implied it. A tool absent here that is in `allow` was attached directly. */
	impliedBy: Readonly<Record<string, Readonly<ToolName[]>>>;
	/** Every tool naming a prerequisite it does not actually have, for either of two reasons, kept in
	 * one field because a caller reacts to both the same way (show it, change nothing it grants): (1)
	 * a tool in `allow` whose adapter-specific prerequisite (`ADAPTER_NATIVE_PREREQUISITES`) is not
	 * itself in `allow` — granted, but not actually usable under this agent's own runtime adapter
	 * until the missing prerequisite is attached too; informational only, the adapter itself already
	 * withholds the capability. (2) a tool in `allow` whose native dependency
	 * (`NATIVE_TOOL_DEPENDENCIES`) names a tool with no live catalog entry at all (deleted, or never
	 * seeded) — the implication could not be applied, so the named tool is never in `allow` either,
	 * unlike case (1)'s own prerequisite (which may simply not be attached yet, not deleted); case (2)
	 * also adds the named tool to `deny`, explicitly, so a runtime-side inference reading only the
	 * compiled result's three lists (`nativeToolGrants`) withholds it too, rather than re-deriving the
	 * very grant the deletion was supposed to revoke. Neither case ever removes anything from `allow`
	 * itself. */
	missingPrerequisites: Readonly<Record<string, Readonly<ToolName[]>>>;
	/** `"memory.write"` is in `allow`: the agent may propose memory writes at all. */
	memoryWriteAllowed: boolean;
}>;

function isFinanceTool(key: ToolName): boolean {
	return toolPatternCovers(FINANCE_TOOLS, key);
}

/**
 * Compiles one agent's attachments against the catalog into disjoint, concrete effective tool
 * lists, applying native dependencies and surfacing adapter-specific prerequisites. Pure; performs
 * no IO.
 *
 * Finance capabilities are compiled in only for `financeAgentId`: an attachment of a finance
 * catalog entry held by any other agent contributes nothing at all (as though never attached),
 * the same invariant `config-bundle.ts`'s `financeIssues` already enforces for hand-authored
 * `permissions` — attaching a finance entry to the wrong agent through the hub must never become a
 * second, silently-inconsistent way to grant finance access.
 */
export function compileAttachments(input: CompileAttachmentsInput): CompiledToolPermissions {
	const allow = new Set<ToolName>();
	const requireApproval = new Set<ToolName>();
	const deny = new Set<ToolName>();

	for (const attachment of input.attachments) {
		const entry = input.catalog.get(attachment.entryId);
		if (entry === undefined) {
			continue;
		}
		const { implementationKey } = entry;
		if (isFinanceTool(implementationKey) && input.agentId !== input.financeAgentId) {
			continue;
		}
		switch (attachment.mode) {
			case "allow":
				allow.add(implementationKey);
				break;
			case "require_approval":
				requireApproval.add(implementationKey);
				break;
			case "disabled":
				deny.add(implementationKey);
				break;
		}
	}

	// Every implementation key a live (non-deleted) catalog entry actually names — never only the
	// entries `attachments` itself names: an implied tool commonly has no attachment of its own at
	// all (the normal case, e.g. `repository.read` implied by `tests.run`), so a caller populates
	// `input.catalog` with every entry a native dependency could ever target, attached or not
	// (`@agent-gateway/core`'s own loaders do this). A tombstoned entry's `implementationKey` is
	// never added back here regardless of how many other agents' attachments this same `catalog` map
	// was built for — deletion excludes it at the source, the same way every other active read does.
	const liveImplementationKeys = new Set(
		[...input.catalog.values()].map((entry) => entry.implementationKey),
	);

	// Native dependency propagation, to a fixed point: implying an implied tool may itself imply
	// more (`tests.run` implies `workspace.write`, which implies `repository.read`). A tool whose
	// own catalog entry is deleted (or was never live at all) can never be granted this way,
	// however many attached tools would otherwise imply it — compile is the last, defence-in-depth
	// gate against that (ADR-027): a deleted entry is never granted implicitly, whatever committed
	// it that way (a stale attachment predating the deletion, a restored or rolled-back revision).
	// Reported as a missing prerequisite of the tool(s) that would have implied it, the same shape
	// (and the same field) `ADAPTER_NATIVE_PREREQUISITES` below already reports a granted-but-inert
	// tool with — a caller does not need two different reasons a tool is listed there to react to it.
	// It is also added to `deny`, explicitly, not merely left out of `allow`: a runtime-side
	// inference that reads only the compiled result's three lists, never `missingPrerequisites`
	// (`packages/runtime-sdk`'s `nativeToolGrants`, deriving `read` from a granted `write`) must see
	// this withheld too, or it silently re-derives the very grant the deleted entry was supposed to
	// revoke. This can never collide with an explicit attachment of the same key: a deleted entry
	// has no live catalog row left to attach, so `catalog.get` above already skips any attachment
	// naming it, before `allow`/`requireApproval`/`deny` are ever populated from attachments at all.
	const impliedBy: Record<string, Set<ToolName>> = {};
	const missingPrerequisites: Record<string, Set<ToolName>> = {};
	const addMissingPrerequisite = (tool: string, missing: ToolName): void => {
		if (missingPrerequisites[tool] === undefined) {
			missingPrerequisites[tool] = new Set();
		}
		missingPrerequisites[tool].add(missing);
	};
	let changed = true;
	while (changed) {
		changed = false;
		for (const tool of [...allow]) {
			for (const implied of NATIVE_TOOL_DEPENDENCIES[tool] ?? []) {
				// Checked before the explicit-restriction check below, deliberately: a dead dependency
				// must be reported for *every* tool that would otherwise imply it, not only the first
				// one the fixed-point loop happens to reach. Once any tool records it, `deny` already
				// carries it — if liveness were checked second, every later implier would see its own
				// `deny.add` reflected back as "already explicitly restricted" and skip reporting itself
				// as a missing prerequisite at all, silently undercounting which attached tools are
				// actually affected.
				if (!liveImplementationKeys.has(implied)) {
					addMissingPrerequisite(tool, implied);
					deny.add(implied);
					continue;
				}
				if (deny.has(implied) || requireApproval.has(implied)) {
					// An explicit restriction on the implied tool wins over an implied grant.
					continue;
				}
				if (!allow.has(implied)) {
					allow.add(implied);
					changed = true;
				}
				if (impliedBy[implied] === undefined) {
					impliedBy[implied] = new Set();
				}
				impliedBy[implied].add(tool);
			}
		}
	}

	const adapterRules = ADAPTER_NATIVE_PREREQUISITES[input.adapter] ?? {};
	for (const [tool, requires] of Object.entries(adapterRules)) {
		if (!allow.has(tool as ToolName)) {
			continue;
		}
		const missing = (requires ?? []).filter((required) => !allow.has(required));
		for (const required of missing) {
			addMissingPrerequisite(tool, required);
		}
	}

	// `memory.write` is the one capability whose authority (`writableMemoryNamespaces`,
	// `packages/core/src/turn-context.ts`) and rendered prompt (`packages/runtime-sdk/src/
	// prompt.ts`'s `memoryWriteDenied`) are both derived from `deny` alone, never from "absent from
	// allow": detaching it (or never attaching it at all) must show up as an explicit denial, not
	// silent absence from every list, or that independent re-derivation would wrongly tell the
	// model it may propose memory writes it cannot.
	const MEMORY_WRITE: ToolName = "memory.write";
	if (!allow.has(MEMORY_WRITE)) {
		deny.add(MEMORY_WRITE);
	}

	const toSortedRecord = (
		source: Readonly<Record<string, Set<ToolName>>>,
	): Readonly<Record<string, Readonly<ToolName[]>>> => {
		const result: Record<string, Readonly<ToolName[]>> = {};
		for (const [key, values] of Object.entries(source).sort(([a], [b]) => (a < b ? -1 : 1))) {
			result[key] = [...values].sort();
		}
		return result;
	};

	return {
		allow: [...allow].sort(),
		requireApproval: [...requireApproval].sort(),
		deny: [...deny].sort(),
		impliedBy: toSortedRecord(impliedBy),
		missingPrerequisites: toSortedRecord(missingPrerequisites),
		memoryWriteAllowed: allow.has("memory.write"),
	};
}

// `deny` (absence from every list enforces identically, `tools.ts`'s own resolution of an uncovered
// action to "not granted") is the lowest effective access level, `require_approval` the middle,
// `allow` the highest (`ToolAccessLevel`, `@agent-gateway/contracts`, re-exported above).

const ACCESS_LEVEL_RANK: Readonly<Record<ToolAccessLevel, 0 | 1 | 2>> = {
	deny: 0,
	require_approval: 1,
	allow: 2,
};

function accessLevel(compiled: CompiledToolPermissions, tool: ToolName): ToolAccessLevel {
	if (compiled.allow.includes(tool)) {
		return "allow";
	}
	return compiled.requireApproval.includes(tool) ? "require_approval" : "deny";
}

/**
 * Every tool whose effective access level in `after` exceeds what it was in `before`, naming both
 * levels. Pure; the one comparison shared by every caller that removes an attachment (or replaces
 * an existing hub-managed list wholesale) and must never, by doing so, increase what an agent may
 * actually do (ADR-027): deleting a catalog entry clears every agent's attachment of it, and
 * detaching one agent's own attachment does the same for just that agent — either can silently
 * remove the one explicit `disabled`/`require_approval` that was suppressing a native dependency's
 * implication (`tests.run` implying `workspace.write`), so both compare their own before/after
 * compiled result through this rather than inventing the comparison twice.
 */
export function describeWidenedTools(
	before: CompiledToolPermissions,
	after: CompiledToolPermissions,
): Readonly<PermissionWidening[]> {
	const everyTool = new Set<ToolName>([
		...before.allow,
		...before.requireApproval,
		...before.deny,
		...after.allow,
		...after.requireApproval,
		...after.deny,
	]);
	const widenings: PermissionWidening[] = [];
	for (const tool of everyTool) {
		const from = accessLevel(before, tool);
		const to = accessLevel(after, tool);
		if (ACCESS_LEVEL_RANK[to] > ACCESS_LEVEL_RANK[from]) {
			widenings.push({ tool, from, to });
		}
	}
	return widenings.sort((a, b) => (a.tool < b.tool ? -1 : 1));
}

/** {@link describeWidenedTools}, the tool names alone — every existing caller that only ever
 * needed "did this widen" plus "which tool", never the levels themselves. */
export function widenedTools(
	before: CompiledToolPermissions,
	after: CompiledToolPermissions,
): Readonly<ToolName[]> {
	return describeWidenedTools(before, after).map((widening) => widening.tool);
}

/**
 * `compiled` as a `ToolPolicySnapshot`'s own three lists (enforcement shape): concrete tool names
 * are always valid `ToolPattern`s, and the compiler already keeps the three sets disjoint, so this
 * is a plain relabelling, never a second place that could compute something different.
 */
export function compiledToolPolicyLists(
	compiled: CompiledToolPermissions,
): Pick<ToolPolicySnapshot, "allow" | "requireHumanApproval" | "deny"> {
	return {
		allow: [...compiled.allow],
		requireHumanApproval: [...compiled.requireApproval],
		deny: [...compiled.deny],
	};
}

/**
 * `compiled` mirrored into an `AgentPermissions`-shaped value (the bundle's own stored field,
 * ADR-027's bundle-mirror invariant): the same three lists, plus `finance.*` added to `tools_deny`
 * for every agent but the finance agent — never redundant with an individual finance pattern,
 * since the compiler already excludes finance entries from every other agent's `allow`/
 * `requireApproval`/`deny` sets entirely, so the single wildcard is the only finance-shaped
 * pattern this agent's mirrored permissions ever carry (`AgentPermissionsSchema` refuses two
 * overlapping patterns, across or within its lists, so a wildcard beside an individual finance
 * name would fail to parse). `observeSystem` passes through unchanged: `observe_system` is not a
 * catalog capability, so attachments never decide it.
 */
export function compiledAgentPermissions(
	compiled: CompiledToolPermissions,
	input: Readonly<{ agentId: AgentId; financeAgentId: AgentId; observeSystem: boolean }>,
): AgentPermissions {
	const isFinanceAgent = input.agentId === input.financeAgentId;
	const tools_deny = isFinanceAgent ? [...compiled.deny] : [...compiled.deny, FINANCE_TOOLS].sort();
	return {
		tools_allow: [...compiled.allow],
		tools_require_human_approval: [...compiled.requireApproval],
		tools_deny,
		...(input.observeSystem ? { observe_system: true } : {}),
	};
}
