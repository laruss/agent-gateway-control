import { z } from "zod";
import { AgentConfigSchema } from "./agent-config.ts";
import { AgentIdSchema, Sha256HexSchema, safeText, TimestampSchema } from "./common.ts";
import { OrganizationConfigSchema } from "./organization.ts";
import {
	AgentToolAttachmentsSchema,
	ToolAttachmentModeSchema,
	ToolAttachmentSettingsSchema,
	ToolAttachmentsBundleSchema,
	ToolCatalogEntryIdSchema,
} from "./tool-catalog.ts";

/**
 * The bundle shape's own version, independent of the database schema: a later format may add
 * or change fields an older reader does not expect. Every snapshot ever stored (before and after
 * ADR-027) is format 1: this is exactly the shape a 0.6.0 (or earlier) release's own
 * `ConfigSnapshotBundleSchema` parses, byte for byte — see `ConfigSnapshotBundleSchema`'s own
 * doc comment below for why.
 */
export const CONFIG_SNAPSHOT_FORMAT = 1;

/**
 * A complete, reproducible configuration: everything `applyConfig` hashes and needs to
 * reconstruct the effective configuration without reading anything else — organization, every
 * agent definition and its resolved role prompt, the constitution text. This is the payload a
 * `config_snapshots` row stores, content-addressed by its canonical hash, and it is deliberately
 * **exactly** the shape a release before ADR-027's catalog ever shipped already reads: a tool's
 * attachments are never a field of this schema (see `ConfigAttachmentsSnapshotSchema` below,
 * `config_attachment_snapshots`'s own content-addressed, separate table). Storing attachments
 * anywhere inside this bundle would mean a 0.6.0 controller's own (`strictObject`, unknown keys
 * refused) copy of this schema fails to parse the snapshot the moment any attachment is ever
 * touched, and so fails to start at all after a rollback to it — exactly the regression this
 * shape avoids by construction, not by a version bump or a default.
 */
export const ConfigSnapshotBundleSchema = z.strictObject({
	organization: OrganizationConfigSchema,
	agents: z.array(AgentConfigSchema),
	constitution: z.string().min(1),
	rolePrompts: z.record(AgentIdSchema, z.string().min(1)),
});
export type ConfigSnapshotBundle = z.infer<typeof ConfigSnapshotBundleSchema>;

/**
 * The bundle format a `config_attachment_snapshots` row stores: every agent's tool attachments,
 * keyed by agent id (ADR-027), the same `ToolAttachmentsBundleSchema` the bundle itself used to
 * carry directly. Independent of `CONFIG_SNAPSHOT_FORMAT`: the two snapshots are hashed, stored
 * and versioned separately, and a revision names each with its own nullable column
 * (`config_revisions.snapshot_hash`, always set; `attachments_snapshot_hash`, null for a revision
 * that predates this split, or one `commitChangeIn` recorded with no agent ever touched through
 * the hub). A release before this table and column existed does not know either exists and reads
 * neither.
 */
export const CONFIG_ATTACHMENTS_SNAPSHOT_FORMAT = 1;
export const ConfigAttachmentsSnapshotSchema = ToolAttachmentsBundleSchema;
export type ConfigAttachmentsSnapshot = z.infer<typeof ConfigAttachmentsSnapshotSchema>;

/**
 * Why a revision was created. `cli_apply` and `backfill` are produced today; the rest name
 * sources later management surfaces add (a console edit, an agent's proposal, a rollback to an
 * earlier snapshot, a YAML import).
 */
export const CONFIG_REVISION_SOURCES = [
	"cli_apply",
	"backfill",
	"console",
	"agent",
	"rollback",
	"import",
] as const;
export const ConfigRevisionSourceSchema = z.enum(CONFIG_REVISION_SOURCES);
export type ConfigRevisionSource = z.infer<typeof ConfigRevisionSourceSchema>;

/** A short, free-text explanation of why a revision was made; never a credential. */
export const ConfigRevisionReasonSchema = safeText(500, "text");

/** A caller-supplied retry token for `commitChange`; bounded, never a credential. */
export const IdempotencyKeySchema = safeText(200, "verbatim");

/**
 * One entry of the configuration's chronological journal: a `config_revisions` row. Applying
 * content identical to an earlier snapshot creates a new revision pointing at the same
 * `snapshotHash`, so the journal records every change even when none of the content did.
 * `attachmentsSnapshotHash` names this same revision's own `config_attachment_snapshots` row
 * (ADR-027): null for a revision recorded before this column existed, or (going forward)
 * for one whose resulting configuration has no agent ever touched through the tool-catalog hub —
 * a release before this column existed reads `snapshotHash` only and never looks for it at all.
 */
export const ConfigRevisionSchema = z.strictObject({
	id: z.int().positive(),
	snapshotHash: Sha256HexSchema,
	attachmentsSnapshotHash: Sha256HexSchema.nullable(),
	parentRevisionId: z.int().positive().nullable(),
	generation: z.int().nonnegative(),
	actor: z.string().min(1),
	source: ConfigRevisionSourceSchema,
	reason: ConfigRevisionReasonSchema.nullable(),
	/** Set when `commitChange` was given one; null for `applyConfig`'s own revisions. */
	idempotencyKey: IdempotencyKeySchema.nullable(),
	/** sha256 of the change set that produced this revision; null alongside a null key. */
	changeHash: Sha256HexSchema.nullable(),
	createdAt: TimestampSchema,
});
export type ConfigRevision = z.infer<typeof ConfigRevisionSchema>;

// ---------------------------------------------------------------------------
// Change operations
// ---------------------------------------------------------------------------

/** Bounded free text for a role prompt set directly through the managed-config service. */
export const RolePromptSchema = safeText(50_000, "text");

/**
 * One typed change to the active configuration. `replace_bundle` is the whole-bundle change
 * `config apply` has always made; the rest edit a single piece of it. `update_agent` replaces an
 * existing agent's definition (its role prompt is unaffected); `add_agent`/`remove_agent` bring
 * an agent into, or take it out of, the configuration entirely. Removing an agent does not delete
 * its history: the shared commit path disables its row exactly as today's `config apply` does for
 * an agent dropped from the YAML directory.
 */
export const ChangeOperationSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("replace_bundle"),
		bundle: ConfigSnapshotBundleSchema,
		/**
		 * The attachments document this replace carries, if any (ADR-027). Omitted (not merely
		 * `{}`): no attachments document was supplied at all — a plain YAML directory with no
		 * `tool-attachments.json`, or any other caller that never resolved one — and every agent's
		 * existing attachments (hub-managed or not) carry forward unchanged, filtered down to the
		 * agents `bundle` still configures; this is `replace_bundle`'s own whole-bundle-replace
		 * semantics applying to the *bundle*, never silently extended to attachments, which are a
		 * separate document that changes only when one is actually supplied. Present (even `{}`,
		 * every agent explicitly cleared): this *is* the new attachments document, replacing whatever
		 * was there before in full — `config export`/`import`'s own `tool-attachments.json`, or
		 * `config rollback`'s own carried-forward target content.
		 */
		toolAttachments: ToolAttachmentsBundleSchema.optional(),
	}),
	z.strictObject({ type: z.literal("update_agent"), agent: AgentConfigSchema }),
	z.strictObject({
		type: z.literal("set_role_prompt"),
		agentId: AgentIdSchema,
		rolePrompt: RolePromptSchema,
	}),
	z.strictObject({
		type: z.literal("set_agent_enabled"),
		agentId: AgentIdSchema,
		enabled: z.boolean(),
	}),
	z.strictObject({
		type: z.literal("add_agent"),
		agent: AgentConfigSchema,
		rolePrompt: RolePromptSchema,
		/** The agent's own attachments document, if any (ADR-027): omitted, it starts legacy
		 * (no key of its own — `requestAgentCreate`'s own, long-standing behavior for a brand-new
		 * agent); present (even `[]`), it starts hub-managed with exactly this list —
		 * `requestAgentRestore`'s own carried-forward last attachments, minus any that named a
		 * catalog entry since deleted. */
		toolAttachments: AgentToolAttachmentsSchema.optional(),
	}),
	z.strictObject({ type: z.literal("remove_agent"), agentId: AgentIdSchema }),
	z.strictObject({ type: z.literal("set_constitution"), constitution: z.string().min(1) }),
	/** Reassigns the organization's finance role to a different agent (`requestAgentRetire`'s own
	 * `reassignFinanceTo`, committed in the same change set as the `remove_agent` it accompanies). */
	z.strictObject({ type: z.literal("set_finance_agent"), agentId: AgentIdSchema }),
	/** Binds (or rebinds) one catalog entry to an agent (ADR-027); replaces any existing attachment
	 * of the same `entryId` for that agent. */
	z.strictObject({
		type: z.literal("attach_tool"),
		agentId: AgentIdSchema,
		entryId: ToolCatalogEntryIdSchema,
		pinnedVersion: z.int().positive().nullable(),
		mode: ToolAttachmentModeSchema,
		settings: ToolAttachmentSettingsSchema,
	}),
	/** Removes one agent's attachment of `entryId`; a no-op when it has none (ADR-027). */
	z.strictObject({
		type: z.literal("detach_tool"),
		agentId: AgentIdSchema,
		entryId: ToolCatalogEntryIdSchema,
	}),
	/** Patches an existing attachment's own fields, leaving the rest unchanged (ADR-027). */
	z.strictObject({
		type: z.literal("update_attachment"),
		agentId: AgentIdSchema,
		entryId: ToolCatalogEntryIdSchema,
		pinnedVersion: z.int().positive().nullable().optional(),
		mode: ToolAttachmentModeSchema.optional(),
		settings: ToolAttachmentSettingsSchema.optional(),
	}),
	/** Removes `entryId`'s attachment from every agent that has one, in one operation regardless of
	 * how many agents that is (`deleteCatalogEntry`, ADR-027) — never expressed as one `detach_tool`
	 * per agent, which `MAX_CHANGE_SET_OPERATIONS` could not bound for an entry attached widely. */
	z.strictObject({ type: z.literal("clear_tool_attachments"), entryId: ToolCatalogEntryIdSchema }),
]);
export type ChangeOperation = z.infer<typeof ChangeOperationSchema>;
export type ChangeOperationType = ChangeOperation["type"];

/** An ordered, bounded list of operations applied to one bundle as a single change. */
export const MAX_CHANGE_SET_OPERATIONS = 50;
export const ChangeSetSchema = z.array(ChangeOperationSchema).min(1).max(MAX_CHANGE_SET_OPERATIONS);
export type ChangeSet = z.infer<typeof ChangeSetSchema>;
/** A change set as a caller supplies it, before schema defaults are filled in. */
export type ChangeSetInput = z.input<typeof ChangeSetSchema>;

// ---------------------------------------------------------------------------
// Structural diff
// ---------------------------------------------------------------------------

/** Dotted paths of the fields that differ between two structures; see `structuralFieldPaths`. */
export const FieldPathsSchema = z.array(z.string());

/** Whether a text blob changed, with its size (in code units) before and after regardless. */
export const TextChangeSchema = z.strictObject({
	changed: z.boolean(),
	beforeSize: z.int().nonnegative(),
	afterSize: z.int().nonnegative(),
});
export type TextChange = z.infer<typeof TextChangeSchema>;

export const ConfigDiffAgentSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("added"), agentId: AgentIdSchema }),
	z.strictObject({ kind: z.literal("removed"), agentId: AgentIdSchema }),
	z.strictObject({
		kind: z.literal("changed"),
		agentId: AgentIdSchema,
		/** The agent's own top-level fields that differ, e.g. `["runtime", "permissions"]`. */
		fieldPaths: FieldPathsSchema,
		rolePrompt: TextChangeSchema,
	}),
]);
export type ConfigDiffAgent = z.infer<typeof ConfigDiffAgentSchema>;

/** Which of an attachment's own fields changed, for a `"changed"` `ConfigDiffAttachment`; never
 * empty (nothing else would make it `"changed"` instead of absent). `settings` is reported as
 * changed or not as a whole — it is opaque, caller-defined JSON, never expanded key by key. */
export const ConfigDiffAttachmentFieldSchema = z.enum(["mode", "pinnedVersion", "settings"]);

/**
 * One agent's one catalog-entry attachment, added, removed or changed between two bundles
 * (ADR-027). Sorted by `agentId` then `entryId`, so the same two bundles always produce the same
 * list in the same order.
 */
export const ConfigDiffAttachmentSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("added"),
		agentId: AgentIdSchema,
		entryId: ToolCatalogEntryIdSchema,
	}),
	z.strictObject({
		kind: z.literal("removed"),
		agentId: AgentIdSchema,
		entryId: ToolCatalogEntryIdSchema,
	}),
	z.strictObject({
		kind: z.literal("changed"),
		agentId: AgentIdSchema,
		entryId: ToolCatalogEntryIdSchema,
		fields: z.array(ConfigDiffAttachmentFieldSchema).min(1),
	}),
]);
export type ConfigDiffAttachment = z.infer<typeof ConfigDiffAttachmentSchema>;

/**
 * A deterministic structural diff of two configuration bundles: every agent added, removed or
 * changed (a changed agent names its own changed top-level fields and its role prompt's change),
 * the organization's changed field paths, the constitution's change, and every agent's own
 * catalog-entry attachment added, removed or changed (ADR-027). Same inputs always produce an
 * identical diff; see `prepareChange`.
 */
export const ConfigDiffSchema = z.strictObject({
	agents: z.array(ConfigDiffAgentSchema),
	organizationFieldPaths: FieldPathsSchema,
	constitution: TextChangeSchema,
	toolAttachments: z.array(ConfigDiffAttachmentSchema),
});
export type ConfigDiff = z.infer<typeof ConfigDiffSchema>;
