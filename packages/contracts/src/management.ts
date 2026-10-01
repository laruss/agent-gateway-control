import { z } from "zod";
import { AgentConfigSchema } from "./agent-config.ts";
import { AgentIdSchema, Sha256HexSchema, safeText, TimestampSchema } from "./common.ts";
import { OrganizationConfigSchema } from "./organization.ts";

/**
 * The bundle shape's own version, independent of the database schema: a later format may add
 * or change fields an older reader does not expect. Every snapshot stored today is format 1.
 */
export const CONFIG_SNAPSHOT_FORMAT = 1;

/**
 * A complete, reproducible configuration: everything `applyConfig` hashes and needs to
 * reconstruct the effective configuration without reading anything else (organization, every
 * agent definition and its resolved role prompt, the constitution text). This is the payload a
 * `config_snapshots` row stores, content-addressed by its canonical hash.
 */
export const ConfigSnapshotBundleSchema = z.strictObject({
	organization: OrganizationConfigSchema,
	agents: z.array(AgentConfigSchema),
	constitution: z.string().min(1),
	rolePrompts: z.record(AgentIdSchema, z.string().min(1)),
});
export type ConfigSnapshotBundle = z.infer<typeof ConfigSnapshotBundleSchema>;

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
 */
export const ConfigRevisionSchema = z.strictObject({
	id: z.int().positive(),
	snapshotHash: Sha256HexSchema,
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
	z.strictObject({ type: z.literal("replace_bundle"), bundle: ConfigSnapshotBundleSchema }),
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
	}),
	z.strictObject({ type: z.literal("remove_agent"), agentId: AgentIdSchema }),
	z.strictObject({ type: z.literal("set_constitution"), constitution: z.string().min(1) }),
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

/**
 * A deterministic structural diff of two configuration bundles: every agent added, removed or
 * changed (a changed agent names its own changed top-level fields and its role prompt's change),
 * the organization's changed field paths, and the constitution's change. Same inputs always
 * produce an identical diff; see `prepareChange`.
 */
export const ConfigDiffSchema = z.strictObject({
	agents: z.array(ConfigDiffAgentSchema),
	organizationFieldPaths: FieldPathsSchema,
	constitution: TextChangeSchema,
});
export type ConfigDiff = z.infer<typeof ConfigDiffSchema>;
