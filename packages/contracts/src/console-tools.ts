import { z } from "zod";
import { AgentPermissionsSchema } from "./agent-config.ts";
import {
	AgentIdSchema,
	RuntimeAdapterIdSchema,
	Sha256HexSchema,
	ToolNameSchema,
	ToolPatternSchema,
	UuidSchema,
} from "./common.ts";
import { CustomHttpsDefinitionSchema } from "./custom-tool.ts";
import { ConfigRevisionReasonSchema } from "./management.ts";
import {
	ToolAttachmentModeSchema,
	ToolAttachmentSchema,
	ToolAttachmentSettingsSchema,
	ToolCatalogEntryDescriptionSchema,
	ToolCatalogEntryIdSchema,
	ToolCatalogEntryNameSchema,
	ToolCatalogEntrySchema,
	ToolCatalogEntryVersionSchema,
	ToolCatalogEntryViewSchema,
} from "./tool-catalog.ts";
import { CapabilityDescriptionSchema } from "./turn.ts";

/**
 * The Instruments & Utils hub's own management API (ADR-025/ADR-027): request/response DTOs for
 * the `/api/tools*` surface and the Agents hub's own `/api/agents/:id/tools*` tab, shared between
 * the controller (`apps/controller/src/console-tools.ts`) and the console frontend. Every
 * client-facing object is a `z.strictObject`, exactly like `console-management.ts`'s own
 * convention: an unrecognized field is a shape error, not silently dropped. No schema here ever
 * carries a secret value — only an alias name and whether it is set (ADR-027's "boolean only").
 */

// ---------------------------------------------------------------------------
// GET /api/tools: the hub's own list
// ---------------------------------------------------------------------------

export const ConsoleToolCatalogListItemSchema = z.strictObject({
	id: ToolCatalogEntryIdSchema,
	kind: ToolCatalogEntryVersionSchema.shape.kind,
	name: ToolCatalogEntryNameSchema,
	description: ToolCatalogEntryDescriptionSchema,
	isBuiltin: z.boolean(),
	riskFloor: ToolCatalogEntryVersionSchema.shape.riskFloor,
	supportedAdapters: ToolCatalogEntryVersionSchema.shape.supportedAdapters,
	available: z.boolean(),
	attachedAgentCount: z.int().nonnegative(),
	/** Always `false` today: a deleted entry is excluded from this list entirely (ADR-027) — kept
	 * so a future "include deleted/tombstoned" filter needs no response-shape change. */
	deleted: z.boolean(),
});
export type ConsoleToolCatalogListItem = z.infer<typeof ConsoleToolCatalogListItemSchema>;

export const ConsoleToolCatalogListResponseSchema = z.strictObject({
	entries: z.array(ConsoleToolCatalogListItemSchema),
	knownRuntimeAdapters: z.array(RuntimeAdapterIdSchema),
});
export type ConsoleToolCatalogListResponse = z.infer<typeof ConsoleToolCatalogListResponseSchema>;

// ---------------------------------------------------------------------------
// GET /api/tools/:entryId: the entry's own detail page
// ---------------------------------------------------------------------------

export const ConsoleCatalogAttachedAgentSchema = z.strictObject({
	agentId: AgentIdSchema,
	displayName: z.string(),
	mode: ToolAttachmentModeSchema,
	pinnedVersion: z.int().positive().nullable(),
});
export type ConsoleCatalogAttachedAgent = z.infer<typeof ConsoleCatalogAttachedAgentSchema>;

export const ConsoleCatalogSecretAliasStatusSchema = z.strictObject({
	alias: z.string(),
	/** `false`: `gateway tools secret set <alias>` has never written this alias's file on this
	 * deployment (or the console cannot see the tool runner's secrets mount at all — see
	 * `apps/controller/src/console-tools.ts`). Never a value, only presence (ADR-027). */
	set: z.boolean(),
});
export type ConsoleCatalogSecretAliasStatus = z.infer<typeof ConsoleCatalogSecretAliasStatusSchema>;

export const ConsoleToolCatalogEntryDetailResponseSchema = z.strictObject({
	entry: ToolCatalogEntryViewSchema,
	/** Oldest first, exactly like `gateway tools custom edit`'s own history. */
	versions: z.array(ToolCatalogEntryVersionSchema),
	attachedAgents: z.array(ConsoleCatalogAttachedAgentSchema),
	/** Empty for every kind but `custom_https`. */
	secretAliases: z.array(ConsoleCatalogSecretAliasStatusSchema),
});
export type ConsoleToolCatalogEntryDetailResponse = z.infer<
	typeof ConsoleToolCatalogEntryDetailResponseSchema
>;

// ---------------------------------------------------------------------------
// POST /api/tools (create), POST /api/tools/:entryId/edit, POST /api/tools/:entryId/delete
// ---------------------------------------------------------------------------

export const ConsoleCreateCustomToolRequestSchema = z.strictObject({
	entryId: ToolCatalogEntryIdSchema,
	name: ToolCatalogEntryNameSchema,
	description: ToolCatalogEntryDescriptionSchema,
	httpsDefinition: CustomHttpsDefinitionSchema,
});
export type ConsoleCreateCustomToolRequest = z.infer<typeof ConsoleCreateCustomToolRequestSchema>;

export const ConsoleCreateCustomToolResponseSchema = z.strictObject({
	/** Availability is not computed here (no caller-supplied context at create time): a client
	 * reloads the list or detail route, both of which do, rather than this response guessing it. */
	entry: ToolCatalogEntrySchema,
});
export type ConsoleCreateCustomToolResponse = z.infer<typeof ConsoleCreateCustomToolResponseSchema>;

/**
 * One new, immutable version (ADR-027): `name`/`description` apply to every kind; `httpsDefinition`
 * is accepted only for a `custom_https` entry (checked server-side, the same rule
 * `editCatalogEntry`/`builtInEditProblems` already enforce) — a built-in's own edit request may only
 * ever carry `name`/`description`, refused otherwise.
 */
export const ConsoleEditCatalogEntryRequestSchema = z
	.strictObject({
		name: ToolCatalogEntryNameSchema.optional(),
		description: ToolCatalogEntryDescriptionSchema.optional(),
		httpsDefinition: CustomHttpsDefinitionSchema.optional(),
	})
	.refine((patch) => Object.keys(patch).length > 0, "edit must change at least one field");
export type ConsoleEditCatalogEntryRequest = z.infer<typeof ConsoleEditCatalogEntryRequestSchema>;

export const ConsoleEditCatalogEntryResponseSchema = z.strictObject({
	/** Same reasoning as {@link ConsoleCreateCustomToolResponseSchema}'s own `entry`: no availability
	 * here, a client reloads the detail route for it. */
	entry: ToolCatalogEntrySchema,
});
export type ConsoleEditCatalogEntryResponse = z.infer<typeof ConsoleEditCatalogEntryResponseSchema>;

/** No fields of its own: a confirmation dialog already showed the entry detail's own
 * `attachedAgents` as the deletion's impact before this is ever sent. */
export const ConsoleDeleteCatalogEntryRequestSchema = z.strictObject({});

export const ConsoleDeleteCatalogEntryResponseSchema = z.strictObject({
	entryId: ToolCatalogEntryIdSchema,
	/** Every agent that held this entry's attachment, read immediately before the delete committed
	 * (the rows themselves are gone once it has) — what actually lost access. */
	affectedAgentIds: z.array(AgentIdSchema),
});
export type ConsoleDeleteCatalogEntryResponse = z.infer<
	typeof ConsoleDeleteCatalogEntryResponseSchema
>;

// ---------------------------------------------------------------------------
// GET /api/agents/:id/tools: requested vs effective, for the agent capability editor
// ---------------------------------------------------------------------------

export const CONSOLE_UNRESOLVED_LISTS = [
	"tools_allow",
	"tools_require_human_approval",
	"tools_deny",
] as const;
export const ConsoleUnresolvedListSchema = z.enum(CONSOLE_UNRESOLVED_LISTS);

export const ConsoleUnresolvedPatternSchema = z.strictObject({
	list: ConsoleUnresolvedListSchema,
	pattern: ToolPatternSchema,
});
export type ConsoleUnresolvedPattern = z.infer<typeof ConsoleUnresolvedPatternSchema>;

export const ConsoleAgentToolsResponseSchema = z.strictObject({
	agentId: AgentIdSchema,
	/** `true`: `requested` is this agent's own recorded attachments, directly editable here;
	 * `false`: a legacy agent, whose `requested` is only a read-only preview of what its
	 * `permissions` lists convert to — "Adopt into the tools hub" is what makes it editable. */
	hubManaged: z.boolean(),
	requested: z.array(ToolAttachmentSchema),
	unresolved: z.array(ConsoleUnresolvedPatternSchema),
	effective: z.strictObject({
		allow: z.array(ToolNameSchema),
		requireApproval: z.array(ToolNameSchema),
		deny: z.array(ToolNameSchema),
	}),
	capabilities: z.array(CapabilityDescriptionSchema),
	/** A tool in `effective.allow` whose adapter-specific prerequisite is not itself granted
	 * (ADR-027's `ADAPTER_NATIVE_PREREQUISITES`) — informational, never removes anything. */
	missingPrerequisites: z.record(ToolNameSchema, z.array(ToolNameSchema)),
	memoryWriteAllowed: z.boolean(),
});
export type ConsoleAgentToolsResponse = z.infer<typeof ConsoleAgentToolsResponseSchema>;

// ---------------------------------------------------------------------------
// POST /api/agents/:id/tools/{attach,detach,update}: the editor's own mutations, reusing
// `attachTool`/`detachTool`/`updateAttachment` exactly (ADR-027) — the same commit shape
// `console-management.ts`'s own `ConsoleCommitResponseSchema` already uses.
// ---------------------------------------------------------------------------

const ConsoleToolCommitResultSchema = z.strictObject({
	revisionId: z.int().positive(),
	hash: Sha256HexSchema,
	noop: z.boolean(),
	replayed: z.boolean(),
	activeRevisionId: z.int().positive().nullable(),
});

export const ConsoleAttachToolRequestSchema = z.strictObject({
	idempotencyKey: UuidSchema,
	entryId: ToolCatalogEntryIdSchema,
	pinnedVersion: z.int().positive().nullable(),
	mode: ToolAttachmentModeSchema,
	settings: ToolAttachmentSettingsSchema.optional(),
	reason: ConfigRevisionReasonSchema.optional(),
});
export type ConsoleAttachToolRequest = z.infer<typeof ConsoleAttachToolRequestSchema>;

export const ConsoleAttachToolResponseSchema = ConsoleToolCommitResultSchema.extend({
	/** The legacy `permissions` attachments carried forward in this same revision, because the
	 * agent was not yet hub-managed (ADR-027) — empty when it already was. */
	legacyConversion: z.array(ToolAttachmentSchema),
});
export type ConsoleAttachToolResponse = z.infer<typeof ConsoleAttachToolResponseSchema>;

export const ConsoleDetachToolRequestSchema = z.strictObject({
	idempotencyKey: UuidSchema,
	entryId: ToolCatalogEntryIdSchema,
	reason: ConfigRevisionReasonSchema.optional(),
});
export type ConsoleDetachToolRequest = z.infer<typeof ConsoleDetachToolRequestSchema>;

export const ConsoleDetachToolResponseSchema = ConsoleToolCommitResultSchema;
export type ConsoleDetachToolResponse = z.infer<typeof ConsoleDetachToolResponseSchema>;

export const ConsoleUpdateAttachmentRequestSchema = z
	.strictObject({
		idempotencyKey: UuidSchema,
		entryId: ToolCatalogEntryIdSchema,
		pinnedVersion: z.int().positive().nullable().optional(),
		mode: ToolAttachmentModeSchema.optional(),
		settings: ToolAttachmentSettingsSchema.optional(),
		reason: ConfigRevisionReasonSchema.optional(),
	})
	.refine(
		(patch) =>
			patch.pinnedVersion !== undefined || patch.mode !== undefined || patch.settings !== undefined,
		"update must change at least one field",
	);
export type ConsoleUpdateAttachmentRequest = z.infer<typeof ConsoleUpdateAttachmentRequestSchema>;

export const ConsoleUpdateAttachmentResponseSchema = ConsoleToolCommitResultSchema;
export type ConsoleUpdateAttachmentResponse = z.infer<typeof ConsoleUpdateAttachmentResponseSchema>;

// ---------------------------------------------------------------------------
// GET /api/agents/:id/tools/adopt (dry-run preview), POST (commit): "Adopt into the tools hub"
// ---------------------------------------------------------------------------

export const ConsoleAdoptPreviewResponseSchema = z.strictObject({
	agentId: AgentIdSchema,
	alreadyHubManaged: z.boolean(),
	unresolved: z.array(ConsoleUnresolvedPatternSchema),
	before: AgentPermissionsSchema,
	after: AgentPermissionsSchema,
	attachments: z.array(ToolAttachmentSchema),
	problems: z.array(z.string()),
});
export type ConsoleAdoptPreviewResponse = z.infer<typeof ConsoleAdoptPreviewResponseSchema>;

export const ConsoleAdoptCommitRequestSchema = z.strictObject({
	idempotencyKey: UuidSchema,
	reason: ConfigRevisionReasonSchema.optional(),
});
export type ConsoleAdoptCommitRequest = z.infer<typeof ConsoleAdoptCommitRequestSchema>;

export const ConsoleAdoptCommitResponseSchema = ConsoleAdoptPreviewResponseSchema.extend({
	commit: ConsoleToolCommitResultSchema.nullable(),
});
export type ConsoleAdoptCommitResponse = z.infer<typeof ConsoleAdoptCommitResponseSchema>;
