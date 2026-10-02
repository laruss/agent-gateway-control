import type {
	AgentId,
	AgentPermissions,
	RuntimeAdapterId,
	ToolAttachment,
	ToolAttachmentMode,
	ToolCatalogEntryId,
	ToolCatalogEntryKind,
	ToolName,
	ToolPolicySnapshot,
} from "@agent-gateway/contracts";
import { toolPatternCovers } from "@agent-gateway/contracts";

/** The only tool pattern that ever names every finance capability at once; kept here, not
 * imported from `@agent-gateway/contracts`' `config-bundle.ts`, so this pure package never
 * depends on that module's own IO-free but configuration-apply-specific surface. */
const FINANCE_TOOLS = "finance.*";

// ---------------------------------------------------------------------------
// Catalog-level native dependencies: data, not scattered ifs (step 1 of the phase this
// compiler belongs to). Two different kinds of fact, deliberately kept separate because they
// push effective permissions in opposite directions:
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
 * The attachment modes an entry's own `kind` actually supports, regardless of its `riskFloor`:
 * a native capability or a direct Gateway action (`mattermost.post`, `memory.write`) has no
 * enforcement point that can pause a turn mid-flight for a human's decision, so `require_approval`
 * is refused for them — only `allow`/`disabled` are. A tool-broker executor action always needs a
 * human (its risk floor is already `require_approval`; `riskFloorAllows` refuses `allow` for it),
 * so only `require_approval`/`disabled` are supported. `custom_https` is reserved: nothing is ever
 * attachable against it, so it supports no mode at all.
 */
const MODES_BY_KIND: Readonly<Record<ToolCatalogEntryKind, ReadonlySet<ToolAttachmentMode>>> = {
	native: new Set(["allow", "disabled"]),
	gateway: new Set(["allow", "disabled"]),
	executor: new Set(["require_approval", "disabled"]),
	custom_https: new Set(),
};

/**
 * Whether `kind` supports `mode` at all, independent of any particular entry's `riskFloor`
 * (`riskFloorAllows` is the complementary, per-entry check). Pure; shared by the write-boundary
 * validation (`attachmentCatalogProblems`) and anything else that needs to reject an attachment
 * before it is ever compiled.
 */
export function modeSupportedByKind(kind: ToolCatalogEntryKind, mode: ToolAttachmentMode): boolean {
	return MODES_BY_KIND[kind].has(mode);
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
	/** Every catalog entry an attachment might name, by its id. An attachment naming an id absent
	 * here (a deleted or otherwise unknown entry) contributes nothing — the write boundary never
	 * lets this happen for a committed configuration, but the compiler itself stays fail-closed. */
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
	/** Tools in `allow` whose adapter-specific prerequisite (`ADAPTER_NATIVE_PREREQUISITES`) is
	 * not itself in `allow`: granted, but not actually usable under this agent's own runtime
	 * adapter until the missing prerequisite is attached too. Informational only — the adapter
	 * itself already withholds the capability; this never removes anything from `allow`. */
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

	// Native dependency propagation, to a fixed point: implying an implied tool may itself imply
	// more (`tests.run` implies `workspace.write`, which implies `repository.read`).
	const impliedBy: Record<string, Set<ToolName>> = {};
	let changed = true;
	while (changed) {
		changed = false;
		for (const tool of [...allow]) {
			for (const implied of NATIVE_TOOL_DEPENDENCIES[tool] ?? []) {
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

	const missingPrerequisites: Record<string, Set<ToolName>> = {};
	const adapterRules = ADAPTER_NATIVE_PREREQUISITES[input.adapter] ?? {};
	for (const [tool, requires] of Object.entries(adapterRules)) {
		if (!allow.has(tool as ToolName)) {
			continue;
		}
		const missing = (requires ?? []).filter((required) => !allow.has(required));
		if (missing.length > 0) {
			missingPrerequisites[tool] = new Set(missing);
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
