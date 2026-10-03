import { z } from "zod";
import {
	AgentIdSchema,
	JsonObjectSchema,
	RuntimeAdapterIdSchema,
	ToolNameSchema,
} from "./common.ts";
import { CustomHttpsDefinitionSchema, UTILITY_TEXT_TRANSFORM } from "./custom-tool.ts";

/**
 * What backs a catalog entry. `native` is a runtime's own built-in tool (reading or writing the
 * run workspace, running commands, web search/fetch — `packages/runtime-sdk`'s `NativeTool`s).
 * `gateway` is a capability the Gateway itself performs, never a runtime or the tool broker
 * (posting to Mattermost, writing memory). `executor` is a tool-broker action backed by a
 * registered executor (`@agent-gateway/tool-broker`). `custom_https` is an owner's own
 * HTTPS-backed tool definition (`CustomHttpsDefinitionSchema`, `custom-http.ts`), executed by the
 * tool runner's `custom` namespace. `utility` is a fixed, image-shipped implementation with a
 * typed input and a bounded output, executed by the tool runner's `utility` namespace — not an
 * arbitrary worker command, and never owner-defined (only this release's own code ships one).
 */
export const TOOL_CATALOG_ENTRY_KINDS = [
	"native",
	"gateway",
	"executor",
	"custom_https",
	"utility",
] as const;
export const ToolCatalogEntryKindSchema = z.enum(TOOL_CATALOG_ENTRY_KINDS);
export type ToolCatalogEntryKind = z.infer<typeof ToolCatalogEntryKindSchema>;

/** A catalog entry's stable id: lowercase, hyphenated, never reused once seeded or created. */
export const ToolCatalogEntryIdSchema = z
	.string()
	.min(2)
	.max(64)
	.regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "lowercase letters, digits, inner '-'");
export type ToolCatalogEntryId = z.infer<typeof ToolCatalogEntryIdSchema>;

/**
 * The minimum attachment mode an entry may be given: `allow` places no floor (any of
 * `allow`/`require_approval`/`disabled` is fine); `require_approval` refuses attaching it as a
 * bare `allow` (only `require_approval` or `disabled` are accepted) — the same bar finance tools
 * already clear in `packages/policy` (a finance write always needs a human). `disabled` is never a
 * floor: an attachment can always be turned off regardless of risk.
 */
export const TOOL_CATALOG_RISK_FLOORS = ["allow", "require_approval"] as const;
export const ToolCatalogRiskFloorSchema = z.enum(TOOL_CATALOG_RISK_FLOORS);
export type ToolCatalogRiskFloor = z.infer<typeof ToolCatalogRiskFloorSchema>;

/** How an attachment grants (or withholds) an entry; `packages/policy` does not read this yet. */
export const TOOL_ATTACHMENT_MODES = ["allow", "require_approval", "disabled"] as const;
export const ToolAttachmentModeSchema = z.enum(TOOL_ATTACHMENT_MODES);
export type ToolAttachmentMode = z.infer<typeof ToolAttachmentModeSchema>;

/**
 * Whether `mode` clears `riskFloor`: `mode: "allow"` is refused once `riskFloor` is
 * `require_approval` (only `require_approval` or `disabled` are accepted then); `disabled` is
 * never refused regardless of floor — an attachment can always be turned off. Pure, shared by
 * every write path that can set or change an attachment's mode (`tool-catalog.ts`'s
 * `attachTool`/`updateAttachment`, and `management.ts`'s shared commit-boundary check), so neither
 * copy of the rule can drift from the other.
 */
export function riskFloorAllows(
	mode: ToolAttachmentMode,
	riskFloor: ToolCatalogRiskFloor,
): boolean {
	return mode !== "allow" || riskFloor === "allow";
}

function boundedJson(maxChars: number, what: string) {
	return JsonObjectSchema.refine(
		(value) => JSON.stringify(value).length <= maxChars,
		`${what} must serialize to at most ${maxChars} characters`,
	);
}

/** A configuration JSON Schema an entry's settings must honour; bounded, never executed. */
export const ToolCatalogConfigSchemaSchema = boundedJson(20_000, "config schema");

/** An attachment's own settings, validated structurally (bounded) only; `configSchema` is not
 * compiled into a validator this step (no UI, no new executors — see ADR-027). */
export const ToolAttachmentSettingsSchema = boundedJson(4_000, "settings");

/** `name`/`description`, the only fields a built-in entry's edit may ever change. */
export const ToolCatalogEntryNameSchema = z.string().min(1).max(100);
export const ToolCatalogEntryDescriptionSchema = z.string().min(1).max(2_000);

/** Adapters a (non-built-in) entry declares it works under; the same bound
 * `ToolCatalogEntryVersionSchema.supportedAdapters` carries, reused by `editCatalogEntry`'s own
 * input validation so the two never disagree. */
export const ToolCatalogSupportedAdaptersSchema = z.array(RuntimeAdapterIdSchema).max(16);

/**
 * One immutable version of a catalog entry's content. `kind`/`implementationKey` never change
 * across an entry's versions (an edit cannot repoint what an entry actually does); `configSchema`,
 * `riskFloor` and `supportedAdapters` may change only for an entry that is not built in — see
 * `packages/core`'s `builtInEditProblems`.
 */
export const ToolCatalogEntryVersionSchema = z.strictObject({
	id: z.int().positive(),
	entryId: ToolCatalogEntryIdSchema,
	version: z.int().positive(),
	kind: ToolCatalogEntryKindSchema,
	implementationKey: ToolNameSchema,
	name: ToolCatalogEntryNameSchema,
	description: ToolCatalogEntryDescriptionSchema,
	configSchema: ToolCatalogConfigSchemaSchema,
	riskFloor: ToolCatalogRiskFloorSchema,
	/** Adapters this capability works under; empty for `gateway`/`executor` (not adapter-scoped —
	 * every agent regardless of its runtime may hold it). */
	supportedAdapters: ToolCatalogSupportedAdaptersSchema,
	/** A `custom_https` version's own fixed destination, parameters, secrets and limits; null for
	 * every other kind. Immutable like the rest of the version: editing a custom tool publishes a
	 * new version with a new `httpsDefinition`, never changes this one in place — which is exactly
	 * what lets a stale approval be detected at grant time (`customDefinitionVersionIssues`,
	 * `@agent-gateway/policy`). */
	httpsDefinition: CustomHttpsDefinitionSchema.nullable(),
	createdBy: z.string().min(1).max(200),
	createdAt: z.iso.datetime({ offset: true }),
});
export type ToolCatalogEntryVersion = z.infer<typeof ToolCatalogEntryVersionSchema>;

/** A catalog entry's own identity: immutable `kind`/`implementationKey`/`isBuiltin`, pointing at
 * its current version's content. */
export const ToolCatalogEntrySchema = z.strictObject({
	id: ToolCatalogEntryIdSchema,
	kind: ToolCatalogEntryKindSchema,
	implementationKey: ToolNameSchema,
	isBuiltin: z.boolean(),
	currentVersion: ToolCatalogEntryVersionSchema,
	createdAt: z.iso.datetime({ offset: true }),
});
export type ToolCatalogEntry = z.infer<typeof ToolCatalogEntrySchema>;

/** `ToolCatalogEntry` plus its computed-not-stored availability in this release/deployment. */
export const ToolCatalogEntryViewSchema = ToolCatalogEntrySchema.extend({
	available: z.boolean(),
});
export type ToolCatalogEntryView = z.infer<typeof ToolCatalogEntryViewSchema>;

/**
 * One agent's binding to a catalog entry: `pinnedVersion` null tracks the entry's current version
 * (an edit propagates at once); a positive integer pins the attachment to that exact version even
 * as the entry is edited further. Lives inside `ConfigSnapshotBundle.toolAttachments` (ADR-027),
 * so it is versioned, rolled back and exported/imported exactly like the rest of the bundle; the
 * `catalog_attachments` table is only ever the current projection of that bundle field, the same
 * way the `agents` table projects `ConfigSnapshotBundle.agents`.
 */
export const ToolAttachmentSchema = z.strictObject({
	entryId: ToolCatalogEntryIdSchema,
	pinnedVersion: z.int().positive().nullable(),
	mode: ToolAttachmentModeSchema,
	settings: ToolAttachmentSettingsSchema,
});
export type ToolAttachment = z.infer<typeof ToolAttachmentSchema>;

/** At most this many attachments per agent; generous for a hub with a few dozen tools. */
export const MAX_ATTACHMENTS_PER_AGENT = 128;

export const AgentToolAttachmentsSchema = z
	.array(ToolAttachmentSchema)
	.max(MAX_ATTACHMENTS_PER_AGENT);

/** `ConfigSnapshotBundle.toolAttachments`: every agent's attachments, keyed by agent id. Missing
 * entirely on a bundle stored before this field existed; defaults to `{}` so that an old snapshot
 * still parses (ADR-027's losslessness requirement). */
export const ToolAttachmentsBundleSchema = z.record(AgentIdSchema, AgentToolAttachmentsSchema);
export type ToolAttachmentsBundle = z.infer<typeof ToolAttachmentsBundleSchema>;

// ---------------------------------------------------------------------------
// Built-in capabilities this release actually has
// ---------------------------------------------------------------------------

/**
 * One native runtime capability (`packages/runtime-sdk`'s `NATIVE_TOOLS`) and the adapters whose
 * own `capabilities.confinedTools` includes it today. Deliberately duplicated here rather than
 * imported: `packages/core` (where catalog seeding runs) depends on no runtime package, by design
 * (`docs/project-structure.md`), and each runtime-* package's own constant is private. A future
 * adapter change that is not mirrored here only affects what the catalog *displays* as supported —
 * never what policy enforces, which is untouched by this release (see ADR-027).
 */
export const BUILT_IN_NATIVE_CAPABILITIES: Readonly<
	{
		toolName: z.infer<typeof ToolNameSchema>;
		adapters: Readonly<z.infer<typeof RuntimeAdapterIdSchema>[]>;
	}[]
> = [
	{
		toolName: "repository.read",
		adapters: ["mock", "codex", "claude-code", "opencode-go"],
	},
	{
		toolName: "workspace.write",
		adapters: ["mock", "codex", "claude-code", "opencode-go"],
	},
	{ toolName: "tests.run", adapters: ["mock", "codex", "claude-code"] },
	{
		toolName: "web.search",
		adapters: ["mock", "codex", "claude-code", "grok", "kiro", "opencode-go", "hermes"],
	},
	{
		toolName: "web.fetch",
		adapters: ["mock", "codex", "claude-code", "grok", "kiro", "opencode-go", "hermes"],
	},
];

/** Gateway built-ins: performed by the Gateway itself, never a runtime or the tool broker. */
export const BUILT_IN_GATEWAY_TOOLS: Readonly<z.infer<typeof ToolNameSchema>[]> = [
	"mattermost.post",
	"memory.write",
];

/**
 * Tool-broker executor actions this release's code can register (`sandboxExecutors`,
 * `@agent-gateway/tool-broker`): the only concrete executor actions that exist today. Duplicated
 * here for the same reason as `BUILT_IN_NATIVE_CAPABILITIES` (`core` depends on no broker or
 * runtime package); the broker's production tool runner registers none of these unless
 * `TOOL_RUNNER_SANDBOX=true` (development/test only), which `ToolCatalogAvailabilityContext`'s
 * `registeredExecutorActionTypes` reflects, never this static list.
 */
export const BUILT_IN_EXECUTOR_ACTIONS: Readonly<z.infer<typeof ToolNameSchema>[]> = [
	"finance.payment.create",
	"finance.subscription.create",
];

/**
 * Packaged utilities this release's tool runner image actually implements
 * (`@agent-gateway/tool-broker`'s utility registry): fixed code, a typed input and a bounded,
 * side-effect-free output, never an arbitrary worker command. One utility ships this release,
 * proving the path; its availability still reflects whether its action type is actually
 * registered by a running tool runner (ADR-027's "computed, never stored" rule applies to it
 * exactly as it does to an `executor` entry — both are static, enumerable action-type lists).
 */
export const BUILT_IN_UTILITY_ACTIONS: Readonly<z.infer<typeof ToolNameSchema>[]> = [
	UTILITY_TEXT_TRANSFORM,
];
