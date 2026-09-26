import { z } from "zod";
import { ApprovalRequestDraftSchema } from "./approval.ts";
import {
	AgentIdSchema,
	BROADCAST_MENTIONS,
	hasUnsafeCharacters,
	JsonObjectSchema,
	MattermostIdSchema,
	type MemoryNamespace,
	MemoryNamespaceSchema,
	memoryVisibilityIssue,
	mentionedNames,
	RuntimeAdapterIdSchema,
	Sha256HexSchema,
	safeText,
	TimestampSchema,
	ToolPatternSchema,
	TrustLevelSchema,
	toolPatternOverlaps,
	UuidSchema,
	type Visibility,
	VisibilitySchema,
} from "./common.ts";
import { GatewayEventSchema, mattermostPostTrustIssue } from "./event.ts";
import { OrganizationLimitsSchema, OrganizationRuleSchema } from "./organization.ts";
import { WaitConditionSchema } from "./wait.ts";

/** Mattermost post limit is 16383 characters; keep headroom for the visible @mentions. */
const MAX_MESSAGE_MARKDOWN = 15_000;
/**
 * True when a mention reaches the whole channel: `@all`, `@here`, `@channel`, also when
 * followed by punctuation or a suffix Mattermost splits off (`@all-hands`, `@here.`).
 * `@allison` is an ordinary mention.
 */
function isBroadcastMention(name: string): boolean {
	return BROADCAST_MENTIONS.some((broadcast) => {
		if (!name.startsWith(broadcast)) {
			return false;
		}
		const next = name.charAt(broadcast.length);
		return next === "" || !/[\p{L}\p{N}]/u.test(next);
	});
}

function hasBroadcastMention(text: string): boolean {
	return mentionedNames(text).some(isBroadcastMention);
}

function unique<T>(values: Readonly<T[]>): boolean {
	return new Set(values).size === values.length;
}

// ---------------------------------------------------------------------------
// Model output: what the LLM itself produces. Kept compatible with provider
// strict structured output (every property required, nullable instead of
// optional, no open records, anyOf instead of oneOf). See ADR-009.
// ---------------------------------------------------------------------------

const SummaryItemsSchema = z.array(safeText(500, "text")).max(20);

/** Durable working summary kept between turns. Never chain-of-thought. */
export const WorkingSummarySchema = z.strictObject({
	assigned: safeText(2000, "text"),
	facts: SummaryItemsSchema,
	decisions: SummaryItemsSchema,
	done: SummaryItemsSchema,
	remaining: SummaryItemsSchema,
	waitingFor: SummaryItemsSchema,
	risks: SummaryItemsSchema,
});
export type WorkingSummary = z.infer<typeof WorkingSummarySchema>;

/** Turn-local name of an artifact produced in this turn; resolved to a stored id after validation. */
const ArtifactKeySchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "artifact key like 'market-report'");

/**
 * Reference to exactly one artifact: an existing one by `artifactId`, or one produced in this
 * turn by its `artifactKey`.
 */
export const ArtifactRefSchema = z
	.strictObject({
		artifactId: UuidSchema.nullable(),
		artifactKey: ArtifactKeySchema.nullable(),
	})
	.check((ctx) => {
		if ((ctx.value.artifactId === null) === (ctx.value.artifactKey === null)) {
			ctx.issues.push({
				code: "custom",
				input: ctx.value,
				path: ["artifactId"],
				message: "exactly one of artifactId or artifactKey must be set",
			});
		}
	});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

function isWorkspaceRelative(path: string): boolean {
	const segments = path.split("/");
	return !path.includes("\\") && segments.every((s) => s !== "" && s !== "." && s !== "..");
}

/** Workspace-relative path: no absolute paths, no `.`/`..` or empty segments, no backslashes. */
const WorkspacePathSchema = z
	.string()
	.min(1)
	.max(1024)
	.refine(isWorkspaceRelative, "workspace-relative path without '..'")
	.refine((path) => !hasUnsafeCharacters(path, "verbatim"), "control characters are not allowed");

function hasNoUserinfo(url: string): boolean {
	const parsed = URL.parse(url);
	return parsed !== null && parsed.username === "" && parsed.password === "";
}

export const ArtifactDescriptorSchema = z
	.strictObject({
		/** Unique within the turn; messages attach the artifact through `artifactKey`. */
		key: ArtifactKeySchema,
		kind: z.enum(["file", "diff", "commit", "report", "link"]),
		/** Set for artifacts inside the run workspace. */
		workspacePath: WorkspacePathSchema.nullable(),
		/** Set for external links; https only. */
		url: z
			.url({ protocol: /^https$/ })
			.max(2048)
			.refine(hasNoUserinfo, "credentials in URLs are not allowed")
			.nullable(),
		sha256: Sha256HexSchema.nullable(),
		mimeType: z.string().min(1).max(255).nullable(),
		sizeBytes: z.int().min(0).nullable(),
		visibility: VisibilitySchema,
		description: safeText(1000, "text").nullable(),
	})
	.check((ctx) => {
		if ((ctx.value.workspacePath === null) === (ctx.value.url === null)) {
			ctx.issues.push({
				code: "custom",
				input: ctx.value,
				path: ["workspacePath"],
				message: "exactly one of workspacePath or url must be set",
			});
		}
	});
export type ArtifactDescriptor = z.infer<typeof ArtifactDescriptorSchema>;

export const PublicMessageSchema = z.strictObject({
	channelId: MattermostIdSchema,
	rootPostId: MattermostIdSchema.nullable(),
	/** Message body. The Gateway prepends visible @mentions for `targetAgentIds` itself. */
	markdown: safeText(MAX_MESSAGE_MARKDOWN, "text").refine(
		(text) => !hasBroadcastMention(text),
		"broadcast mentions (@all, @here, @channel) are not allowed",
	),
	targetAgentIds: z.array(AgentIdSchema).max(8).refine(unique, "target agent ids must be unique"),
	attachments: z.array(ArtifactRefSchema).max(10),
});
export type PublicMessage = z.infer<typeof PublicMessageSchema>;

export const IdleStateSchema = z.strictObject({ kind: z.literal("idle") });
export const WaitingStateSchema = z.strictObject({
	kind: z.literal("waiting"),
	waits: z.array(WaitConditionSchema).min(1).max(8),
});
export const NeedsHumanStateSchema = z.strictObject({
	kind: z.literal("needs_human"),
	approvalRequest: ApprovalRequestDraftSchema,
});
export const FailedStateSchema = z.strictObject({
	kind: z.literal("failed"),
	publicError: safeText(2000, "text"),
	retryable: z.boolean(),
});

/** Plain union (JSON Schema `anyOf`): providers' strict mode does not accept `oneOf`. */
export const NextStateSchema = z.union([
	IdleStateSchema,
	WaitingStateSchema,
	NeedsHumanStateSchema,
	FailedStateSchema,
]);
export type NextState = z.infer<typeof NextStateSchema>;

type MemoryVisibilityContext = {
	value: Readonly<{ namespace: MemoryNamespace; visibility: Visibility }>;
	issues: z.core.$ZodRawIssue[];
};

function checkMemoryVisibility(ctx: MemoryVisibilityContext): void {
	const message = memoryVisibilityIssue(ctx.value.namespace, ctx.value.visibility);
	if (message !== null) {
		ctx.issues.push({ code: "custom", input: ctx.value.visibility, path: ["visibility"], message });
	}
}

export const MemoryProposalSchema = z
	.strictObject({
		namespace: MemoryNamespaceSchema,
		key: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,255}$/),
		content: safeText(10_000, "text"),
		visibility: VisibilitySchema,
	})
	.check(checkMemoryVisibility);
export type MemoryProposal = z.infer<typeof MemoryProposalSchema>;

export const AgentTurnModelOutputSchema = z.strictObject({
	publicMessages: z.array(PublicMessageSchema).max(10),
	nextState: NextStateSchema,
	publicSummary: WorkingSummarySchema,
	memoryProposals: z.array(MemoryProposalSchema).max(20),
	artifacts: z
		.array(ArtifactDescriptorSchema)
		.max(50)
		.refine((artifacts) => unique(artifacts.map((a) => a.key)), "artifact keys must be unique"),
});
export type AgentTurnModelOutput = z.infer<typeof AgentTurnModelOutputSchema>;

// ---------------------------------------------------------------------------
// AgentTurnResult: model output plus metadata the runtime adapter adds.
// Side-effect receipts are never part of it: they come from the Tool Broker.
// ---------------------------------------------------------------------------

export const RuntimeUsageSchema = z.strictObject({
	inputTokens: z.int().min(0).nullable(),
	outputTokens: z.int().min(0).nullable(),
	cachedInputTokens: z.int().min(0).nullable(),
	costUsd: z.number().min(0).nullable(),
	durationMs: z.int().min(0).nullable(),
	model: z.string().max(255).nullable(),
});
export type RuntimeUsage = z.infer<typeof RuntimeUsageSchema>;

/** Optional provider session handle; an optimization, never the source of truth. */
export const RuntimeSessionHandleSchema = z.strictObject({
	adapter: RuntimeAdapterIdSchema,
	providerSessionId: z.string().min(1).max(512),
	runtimeVersion: z.string().min(1).max(128),
	expiresAt: TimestampSchema.nullable(),
});
export type RuntimeSessionHandle = z.infer<typeof RuntimeSessionHandleSchema>;

export const AgentTurnResultSchema = AgentTurnModelOutputSchema.extend({
	schemaVersion: z.literal(1),
	runId: UuidSchema,
	usage: RuntimeUsageSchema.nullable(),
	session: RuntimeSessionHandleSchema.nullable(),
});
export type AgentTurnResult = z.infer<typeof AgentTurnResultSchema>;

// ---------------------------------------------------------------------------
// AgentTurnInput: assembled by the controller, consumed by a runtime adapter.
// ---------------------------------------------------------------------------

export const AgentIdentitySnapshotSchema = z.strictObject({
	agentId: AgentIdSchema,
	displayName: z.string().min(1),
	mattermostUsername: z.string().min(1),
	rolePrompt: z.string().min(1),
	configVersion: z.string().min(1),
});
export type AgentIdentitySnapshot = z.infer<typeof AgentIdentitySnapshotSchema>;

/** An agent this agent may address, with its public responsibilities. */
export const DirectoryEntrySchema = z.strictObject({
	agentId: AgentIdSchema,
	displayName: z.string().min(1),
	summary: z.string(),
});
export type DirectoryEntry = z.infer<typeof DirectoryEntrySchema>;

export const OrganizationSnapshotSchema = z.strictObject({
	organizationId: z.string().min(1),
	globalGoal: z.string().min(1),
	constitution: z.string().min(1),
	rules: z.array(OrganizationRuleSchema),
	limits: OrganizationLimitsSchema,
	directory: z.array(DirectoryEntrySchema),
});
export type OrganizationSnapshot = z.infer<typeof OrganizationSnapshotSchema>;

/** A wait that was matched or timed out and caused this turn. */
export const ResolvedWaitSchema = z.strictObject({
	waitId: UuidSchema,
	outcome: z.enum(["matched", "timeout"]),
	condition: WaitConditionSchema,
});
export type ResolvedWait = z.infer<typeof ResolvedWaitSchema>;

export const DurableAgentStateSchema = z.strictObject({
	previousRunId: UuidSchema.nullable(),
	previousSummary: WorkingSummarySchema.nullable(),
	resolvedWaits: z.array(ResolvedWaitSchema),
});
export type DurableAgentState = z.infer<typeof DurableAgentStateSchema>;

export const ThreadPostSchema = z
	.strictObject({
		postId: MattermostIdSchema,
		authorUserId: MattermostIdSchema,
		/** Set when the author is a Gateway-managed agent. */
		authorAgentId: AgentIdSchema.nullable(),
		createdAt: TimestampSchema,
		message: z.string(),
		trustLevel: TrustLevelSchema,
	})
	.check((ctx) => {
		const message = mattermostPostTrustIssue(
			ctx.value.trustLevel,
			ctx.value.authorAgentId !== null,
		);
		if (message !== null) {
			ctx.issues.push({
				code: "custom",
				input: ctx.value.trustLevel,
				path: ["trustLevel"],
				message,
			});
		}
	});
export type ThreadPost = z.infer<typeof ThreadPostSchema>;

/**
 * The thread a turn belongs to, as the Gateway recorded it: edits applied, deleted posts left out
 * (a deleted root keeps its author with an empty message). The triggering post and the pending
 * inbox posts are not repeated here; they carry their current text themselves.
 */
export const ThreadContextSchema = z.strictObject({
	channelId: MattermostIdSchema,
	rootPostId: MattermostIdSchema,
	/**
	 * Null when the turn carries the root itself (as its trigger or an inbox event), or when the
	 * root was posted before the channel became managed (never recorded).
	 */
	rootPost: ThreadPostSchema.nullable(),
	/** The newest posts that fit the context budget, oldest first. */
	recentPosts: z.array(ThreadPostSchema),
	/** Public summaries of earlier runs in this thread, compacted; null before the first run. */
	summary: z.string().nullable(),
	/** Agents that posted in the thread or were addressed in it. */
	participantAgentIds: z.array(AgentIdSchema),
	/** Older posts left out of `recentPosts` by the budget. */
	omittedPostCount: z.int().min(0),
});
export type ThreadContext = z.infer<typeof ThreadContextSchema>;

export const MemoryItemSchema = z
	.strictObject({
		id: UuidSchema,
		namespace: MemoryNamespaceSchema,
		key: z.string().min(1),
		content: z.string(),
		visibility: VisibilitySchema,
		sourceRunId: UuidSchema.nullable(),
		createdAt: TimestampSchema,
	})
	.check(checkMemoryVisibility);
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

export const WorkspaceDescriptorSchema = z.strictObject({
	/** Absolute path of the per-run worktree, as mounted inside the worker. */
	path: z.string().startsWith("/"),
	repository: z.string().min(1),
	baseCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
	branch: z.string().min(1),
	writable: z.boolean(),
});
export type WorkspaceDescriptor = z.infer<typeof WorkspaceDescriptorSchema>;

/** Effective policy of a run. Lists never overlap, so every tool has exactly one outcome. */
export const ToolPolicySnapshotSchema = z
	.strictObject({
		policyVersion: z.string().min(1),
		allow: z.array(ToolPatternSchema),
		requireHumanApproval: z.array(ToolPatternSchema),
		deny: z.array(ToolPatternSchema),
	})
	.check((ctx) => {
		const { allow, requireHumanApproval, deny } = ctx.value;
		for (const overlap of toolPatternOverlaps({ allow, requireHumanApproval, deny })) {
			ctx.issues.push({
				code: "custom",
				input: ctx.value,
				path: [overlap.list],
				message: overlap.message,
			});
		}
	});
export type ToolPolicySnapshot = z.infer<typeof ToolPolicySnapshotSchema>;

/** Where the agent's memory proposals may go; `memories` come from the same namespaces. */
export const MemoryNamespacesSchema = z.strictObject({
	/** `agents/<id>`: accepted as proposed, visible to this agent only. */
	private: MemoryNamespaceSchema,
	/** `organization/<topic>`: proposals wait for an operator's review before anyone sees them. */
	shared: z.array(MemoryNamespaceSchema),
});
export type MemoryNamespaces = z.infer<typeof MemoryNamespacesSchema>;

/** A channel the agent may post to, as resolved by bootstrap. */
export const ChannelRefSchema = z.strictObject({
	channelId: MattermostIdSchema,
	name: z.string().min(1).max(64),
});
export type ChannelRef = z.infer<typeof ChannelRefSchema>;

export const AgentTurnInputSchema = z.strictObject({
	schemaVersion: z.literal(1),
	runId: UuidSchema,
	agent: AgentIdentitySnapshotSchema,
	organization: OrganizationSnapshotSchema,
	trigger: GatewayEventSchema,
	durableState: DurableAgentStateSchema,
	/** Channels the agent may post to; turns without a thread pick their channel from here. */
	channels: z.array(ChannelRefSchema).min(1),
	threadContext: ThreadContextSchema.nullable(),
	/** Accepted memory of the agent's namespaces, newest first, within the context budget. */
	memories: z.array(MemoryItemSchema),
	memoryNamespaces: MemoryNamespacesSchema,
	pendingInbox: z.array(GatewayEventSchema),
	workspace: WorkspaceDescriptorSchema.nullable(),
	toolPolicy: ToolPolicySnapshotSchema,
	/** JSON Schema of `AgentTurnModelOutput` the runtime must produce. */
	outputSchema: JsonObjectSchema,
	deadline: TimestampSchema,
});
export type AgentTurnInput = z.infer<typeof AgentTurnInputSchema>;
