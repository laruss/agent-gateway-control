import { randomUUID } from "node:crypto";
import {
	type AgentConfig,
	AgentConfigSchema,
	type AgentId,
	type AgentLifecycleOperationKind,
	type AgentLifecycleOperationState,
	type AgentLifecycleSource,
	BOT_SECRET_FILE_PREFIX,
	CONFIG_ATTACHMENTS_SNAPSHOT_FORMAT,
	CONFIG_SNAPSHOT_FORMAT,
	ConfigAttachmentsSnapshotSchema,
	type ConfigRevisionSource,
	type ConfigSnapshotBundle,
	type MattermostId,
	MattermostIdSchema,
	type OrganizationConfig,
	OrganizationConfigSchema,
	QUEUES,
	RolePromptSchema,
	type RuntimeAdapterId,
	type ToolAttachment,
	type ToolAttachmentsBundle,
	validateConfigBundle,
} from "@agent-gateway/contracts";
import {
	type AgentState,
	agentInbox,
	agentLifecycle,
	agentLifecycleOperations,
	agentRuns,
	agents,
	approvalRequests,
	catalogAttachments,
	configAttachmentSnapshots,
	configRevisionAcks,
	configRevisions,
	configSnapshots,
	configVersions,
	type DirectoryKind,
	events,
	gatewayControls,
	mattermostChannelGrants,
	mattermostDirectory,
	mattermostIdentities,
	type OutboxStatus,
	outbox,
	sourceCursors,
	toolActions,
	waitSubscriptions,
	withTransaction,
} from "@agent-gateway/db";
import { canonicalHash } from "@agent-gateway/events";
import {
	and,
	asc,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	ne,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import { grantedChannels } from "../channel-access.ts";
import { nextAgentState, requireTransition } from "../state-machine.ts";
import { revokeQueuedActions, sweepApprovals, withdrawOpenApprovals } from "./approvals.ts";
import {
	attachmentCatalogProblems,
	duplicateAttachmentIssues,
	mirrorCompiledAttachmentPermissions,
} from "./attachment-validation.ts";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import {
	rejectLifecycleOwnedRemovals,
	rejectLifecycleOwnedTokenPathChanges,
	rejectRetiredAgentReadditions,
} from "./lifecycle-guards.ts";
import { type RuntimeHealth, runtimeHealth } from "./runtime-health.ts";
import { type ScheduleResult, scheduleAgent } from "./scheduler.ts";
import {
	audit,
	lifecycleOwnedAgentIds,
	loadActiveConfig,
	loadChannelAccess,
	loadDirectory,
	lockAgent,
	setAgentState,
	toGatewayEvent,
} from "./store.ts";
import { cancelActiveWaits } from "./wait-store.ts";

type Db = UnitOfWork["tx"]["db"];

export async function inTransaction<T>(
	deps: ControlPlaneDeps,
	work: (uow: UnitOfWork) => Promise<T>,
): Promise<T> {
	return withTransaction(deps.pool, (tx) =>
		work({ deps, tx, jobs: deps.jobs(tx), now: deps.clock() }),
	);
}

export class AdminError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdminError";
	}
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * A configuration bundle as read from disk, with prompt files already resolved to text.
 * `toolAttachments` is never part of the stored `ConfigSnapshotBundle` itself (ADR-027:
 * attachments are a separate, content-addressed document — see `config_attachment_snapshots`) —
 * here it is only the *input-side* signal `applyConfig` resolves before writing: omitted, no
 * attachments document was supplied at all (a plain YAML directory with no
 * `tool-attachments.json`), and every agent's existing attachments carry forward unchanged rather
 * than being silently cleared; given (even `{}`), it replaces the stored document in full. See
 * `resolveApplyToolAttachments`.
 */
export type ConfigApplyInput = Readonly<{
	organization: OrganizationConfig;
	agents: Readonly<AgentConfig[]>;
	constitution: string;
	rolePrompts: Readonly<Record<string, string>>;
	toolAttachments?: ToolAttachmentsBundle;
}>;

export type ConfigApplyResult = Readonly<{
	version: string;
	revisionId: number;
	created: Readonly<string[]>;
	updated: Readonly<string[]>;
	disabled: Readonly<string[]>;
}>;

/** Validation of a bundle before it touches the database; returns every problem found. */
export function configBundleProblems(input: ConfigApplyInput): Readonly<string[]> {
	const problems: string[] = [];
	const organization = OrganizationConfigSchema.safeParse(input.organization);
	if (!organization.success) {
		problems.push(
			...organization.error.issues.map((i) => `organization: ${i.path.join(".")}: ${i.message}`),
		);
	}
	// `config export` writes one file per distinct `role_file`/`constitution_file` path, verbatim:
	// two agents sharing a path (or an agent sharing it with the constitution) must agree on the
	// text that path holds, or an export would silently keep only one of them.
	const roleFileText = new Map<string, Readonly<{ agentId: string; text: string }>>();
	for (const agent of input.agents) {
		const parsed = AgentConfigSchema.safeParse(agent);
		if (!parsed.success) {
			problems.push(
				...parsed.error.issues.map((i) => `agent ${agent.id}: ${i.path.join(".")}: ${i.message}`),
			);
		}
		if (agent.concurrency.max_active_runs !== 1) {
			problems.push(`agent ${agent.id}: max_active_runs other than 1 is not supported yet`);
		}
		// Own-property lookup, never `in` (which also walks the prototype chain: `"constructor" in
		// {}` is `true`) or a bare bracket read: an agent id like `constructor` has no own property
		// here when no caller actually supplied one, but `in`/a bracket read would otherwise resolve
		// it, through the prototype chain, to `Object.prototype.constructor` — a function, not a role
		// prompt string and not `undefined` either — wrongly treated as "present" or fed to
		// `RolePromptSchema` as a confusing non-string failure instead of "missing or empty".
		if (!Object.hasOwn(input.rolePrompts, agent.id) || input.rolePrompts[agent.id]?.trim() === "") {
			problems.push(`agent ${agent.id}: role prompt is missing or empty`);
			continue;
		}
		const text = input.rolePrompts[agent.id] ?? "";
		// The same bound `set_role_prompt`/`config import` enforce (`RolePromptSchema`): anything
		// `commitChange`/`applyConfig` accepts must also be exportable and re-importable.
		const roleBound = RolePromptSchema.safeParse(text);
		if (!roleBound.success) {
			problems.push(
				...roleBound.error.issues.map((i) => `agent ${agent.id}: role prompt: ${i.message}`),
			);
		}
		const path = agent.prompts.role_file;
		const sharedWith = roleFileText.get(path);
		if (sharedWith === undefined) {
			roleFileText.set(path, { agentId: agent.id, text });
		} else if (sharedWith.text !== text) {
			problems.push(
				`agent ${agent.id}: role prompt differs from agent ${sharedWith.agentId}'s, though both share role_file '${path}'`,
			);
		}
		if (
			organization.success &&
			path === organization.data.organization.constitution_file &&
			text !== input.constitution
		) {
			problems.push(
				`agent ${agent.id}: role_file '${path}' is also the constitution file, but its role prompt differs from the constitution text`,
			);
		}
	}
	if (input.constitution.trim() === "") {
		problems.push("organization: constitution is empty");
	} else {
		const constitutionBound = RolePromptSchema.safeParse(input.constitution);
		if (!constitutionBound.success) {
			problems.push(
				...constitutionBound.error.issues.map((i) => `organization: constitution: ${i.message}`),
			);
		}
	}
	// A `rolePrompts` entry for an agent not in `input.agents` (e.g. a `replace_bundle` naming
	// `rolePrompts.ghost` with no agent `ghost`) would validate and commit, yet `config export`
	// only ever writes the role prompt of a configured agent: re-importing the export would then
	// resolve to a different, smaller `rolePrompts` map and a different hash.
	const configuredAgentIds = new Set(input.agents.map((agent) => agent.id));
	for (const agentId of Object.keys(input.rolePrompts)) {
		if (!configuredAgentIds.has(agentId)) {
			problems.push(`rolePrompts: '${agentId}' has a role prompt but is not a configured agent`);
		}
	}
	if (problems.length === 0) {
		problems.push(
			...validateConfigBundle({ organization: input.organization, agents: input.agents }).map(
				(issue) =>
					`${issue.agentId === null ? "bundle" : `agent ${issue.agentId}`}: ${issue.message}`,
			),
		);
	}
	return problems;
}

/**
 * A channel taken out of an agent's `allowed_channels` must not come back as a grant: bootstrap
 * added the bot there with the admin's token, and that add record would otherwise count. A
 * revoked row dated now is written for it (an owner's grant still active is left alone), so
 * only a later add grants the channel again.
 */
async function tombstoneUnconfiguredChannels(
	uow: UnitOfWork,
	before: Readonly<Readonly<{ id: string; config: AgentConfig }>[]>,
	after: Readonly<AgentConfig[]>,
): Promise<void> {
	const { db } = uow.tx;
	const config = await loadActiveConfig(db);
	const teamId =
		config === null
			? undefined
			: (await loadDirectory(db, "team")).get(config.organization.mattermost.team);
	if (teamId === undefined) {
		return;
	}
	const channels = await loadDirectory(db, "channel");
	const identities = new Map(
		(
			await db
				.select({
					agentId: mattermostIdentities.agentId,
					userId: mattermostIdentities.mattermostUserId,
				})
				.from(mattermostIdentities)
		).map((row) => [row.agentId, row.userId]),
	);
	for (const old of before) {
		const kept = new Set(
			after.find((agent) => agent.id === old.id)?.mattermost.allowed_channels ?? [],
		);
		const botUserId = identities.get(old.id) ?? null;
		for (const name of old.config.mattermost.allowed_channels) {
			const channelId = channels.get(name);
			if (kept.has(name) || channelId === undefined || botUserId === null) {
				continue;
			}
			const values = {
				teamId,
				channelName: name,
				botUserId,
				state: "revoked" as const,
				grantorUserId: null,
				evidencePostId: null,
				sinceMs: uow.now.getTime(),
				revokedReason: "config_removed",
				grantedAt: uow.now,
				revokedAt: uow.now,
			};
			await db
				.insert(mattermostChannelGrants)
				.values({ agentId: old.id, channelId, ...values })
				.onConflictDoUpdate({
					target: [mattermostChannelGrants.agentId, mattermostChannelGrants.channelId],
					set: { ...values, generation: sql`${mattermostChannelGrants.generation} + 1` },
					// A revoked record, or an active one of a replaced bot (it grants nothing).
					setWhere: or(
						eq(mattermostChannelGrants.state, "revoked"),
						ne(mattermostChannelGrants.botUserId, sql`excluded.bot_user_id`),
					),
				});
		}
	}
}

/**
 * Orders agent definitions by id the same way wherever a bundle is assembled, so its hash never
 * depends on where the agents came from: a config directory's read order, or a database query's
 * collation (which can disagree with this plain code-unit order, e.g. for ids like `aa`/`a-z`).
 */
function compareAgentIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The canonical, content-addressed bundle a configuration apply hashes and stores: this is the
 * value `canonicalHash` turns into `config_versions.version` / `config_snapshots.hash`. Agents
 * are sorted by id, so the hash does not depend on the order a config directory lists them in.
 */
export function configSnapshotBundle(input: ConfigApplyInput): ConfigSnapshotBundle {
	return {
		organization: input.organization,
		agents: [...input.agents].sort((a, b) => compareAgentIds(a.id, b.id)),
		constitution: input.constitution,
		rolePrompts: { ...input.rolePrompts },
	};
}

/** `canonicalizeAttachments` (`management.ts`'s own, tested copy), duplicated here for the same
 * reason as the rest of this file's "shared with the managed-configuration service" section below
 * (an import cycle: `management.ts` already imports `writeConfigRevisionIn` from this file). Every
 * agent's attachment list sorted by `entryId`, so a round-trip export/import or an unrelated apply
 * never manufactures a new revision purely from attachment order (ADR-027). */
function canonicalizeAttachmentsIn(bundle: ToolAttachmentsBundle): ToolAttachmentsBundle {
	const result: Record<string, ToolAttachment[]> = {};
	for (const [agentId, attachments] of Object.entries(bundle)) {
		result[agentId] = [...attachments].sort((a, b) =>
			a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0,
		);
	}
	return result;
}

/** The attachments document behind `revisionId` (`{}`: no revision, or no document recorded for
 * it), read the same trusted-column way `loadOrganizationIn` reads `agents.config` — never through
 * the validated, cached `management.ts` reader (same import-cycle reason as above). */
async function loadToolAttachmentsIn(
	db: Db,
	revisionId: number | null,
): Promise<ToolAttachmentsBundle> {
	if (revisionId === null) {
		return {};
	}
	const [revision] = await db
		.select({ attachmentsSnapshotHash: configRevisions.attachmentsSnapshotHash })
		.from(configRevisions)
		.where(eq(configRevisions.id, revisionId));
	if (revision === undefined || revision.attachmentsSnapshotHash === null) {
		return {};
	}
	const [snapshot] = await db
		.select({ bundle: configAttachmentSnapshots.bundle })
		.from(configAttachmentSnapshots)
		.where(eq(configAttachmentSnapshots.hash, revision.attachmentsSnapshotHash));
	if (snapshot === undefined) {
		return {};
	}
	const parsed = ConfigAttachmentsSnapshotSchema.safeParse(snapshot.bundle);
	return parsed.success ? parsed.data : {};
}

/**
 * The attachments document `applyConfig` stores for this apply (ADR-027):
 * `input.toolAttachments` explicitly, when given (an operator-supplied `tool-attachments.json`,
 * even `{}`); otherwise every agent's attachments carried forward unchanged from whichever
 * revision was active immediately before this apply — a plain YAML directory that never resolved
 * one must not silently clear a hub-managed agent's attachments. Either way, filtered down to the
 * agents this apply still configures (an agent it drops cannot keep attachments no configured
 * agent may hold) and canonicalized.
 */
async function resolveApplyToolAttachments(
	db: Db,
	parentRevisionId: number | null,
	input: ConfigApplyInput,
): Promise<ToolAttachmentsBundle> {
	const configuredAgentIds = new Set(input.agents.map((agent) => agent.id));
	const source = input.toolAttachments ?? (await loadToolAttachmentsIn(db, parentRevisionId));
	const filtered = Object.fromEntries(
		Object.entries(source).filter(([agentId]) => configuredAgentIds.has(agentId)),
	);
	return canonicalizeAttachmentsIn(filtered);
}

/** The configuration row's history fields, as `gateway_controls` held them before this change. */
type ActiveControlsRow = Readonly<{
	version: string | null;
	generation: number;
	revision: number | null;
}>;

/**
 * Whether the snapshot behind `snapshotHash` still agrees with the live `agents.enabled` column,
 * for every agent of `configVersion` plus any other agent that is enabled although its own row
 * lags behind it: false once an operational toggle moves the projection after that snapshot was
 * recorded (`setAgentEnabled` once did this; an older release's own direct toggle still can), even
 * though nothing bumped `config_generation` — including a release before configuration history
 * existed re-enabling a row after the agent had already left the active configuration (its own
 * `config_version` stays stale, but it is enabled and routing/scheduling runs it regardless of
 * which version its row names; see `ensureConfigHistoryIn`). Compared against the last *recorded*
 * snapshot — whether originally applied or itself an earlier backfill — rather than `agents.config`
 * (which a backfill never rewrites, so it would otherwise never agree again once it first fell
 * behind).
 */
async function recordedEnabledAgreesWithLive(
	db: UnitOfWork["tx"]["db"],
	snapshotHash: string,
	configVersion: string,
): Promise<boolean> {
	const [snapshot] = await db
		.select({ bundle: configSnapshots.bundle })
		.from(configSnapshots)
		.where(eq(configSnapshots.hash, snapshotHash));
	if (snapshot === undefined) {
		return false;
	}
	const recorded = new Map(snapshot.bundle.agents.map((agent) => [agent.id, agent.enabled]));
	const live = await db
		.select({ id: agents.id, enabled: agents.enabled })
		.from(agents)
		.where(or(eq(agents.configVersion, configVersion), eq(agents.enabled, true)));
	return live.length === recorded.size && live.every((row) => recorded.get(row.id) === row.enabled);
}

/**
 * Resolves the revision to record as the new one's parent, backfilling one for the active
 * configuration first when it is not already represented by an up-to-date revision: either none
 * has ever been recorded (a database upgraded from a release before configuration history
 * existed), the recorded one is stale (an older release changed the active configuration directly
 * — `active_config_version`/`config_generation` moved on — without writing a revision for it), or
 * the live `agents.enabled` projection has drifted from what the recorded revision's snapshot says
 * (an operational toggle that bypassed configuration history — see `recordedEnabledAgreesWithLive`):
 * `config_generation` alone does not move for that, so it must be checked on its own. A no-op,
 * returning `row.revision` unchanged, once the recorded revision's generation already matches and
 * no agent has drifted since, or when there is no active configuration at all (a fresh database:
 * the very first apply gets no parent).
 *
 * The backfilled snapshot holds the agent definitions and role prompts the active `config_version`
 * still has (older, since-replaced ones were never retained, and role prompts of an agent no
 * longer in the active bundle are lost with it), plus any other agent that is enabled although its
 * row lags behind the active version — retained from before it left the configuration, by a
 * release that re-enabled it directly, and still actually running regardless (`loadAgents` reads
 * every row, not only those at the active version): its own stored, stale `config`/`role_prompt`
 * are what the backfill has to go on, since nothing else was ever retained for it either. Sorted
 * exactly as `configSnapshotBundle` sorts them, with each agent's `enabled` taken from the live
 * `agents.enabled` column rather than its stored `config` — the backfill's whole point is to
 * reflect what is actually running, not a value a bypassed toggle left stale. It is stored under
 * its own recomputed hash — which can differ from `config_versions.version` of the same row, since
 * nothing here reconstructs a role prompt or an ordering the original apply alone knew — never
 * under a hash it does not actually reproduce.
 *
 * The stale revision's own attachments document (ADR-027), if it had one, carries forward into the
 * backfill revision unchanged, filtered to the agents the backfilled bundle still configures (the
 * same rule `resolveApplyToolAttachments` applies for a plain YAML `config apply`) — never silently
 * dropped to `{}` just because this particular write path never otherwise touches attachments: a
 * backfill triggered only by `agents.enabled` drifting (an older release's own direct toggle, no
 * attachment ever touched) must not demote every hub-managed agent to legacy on its own.
 */
export async function ensureConfigHistoryIn(
	uow: UnitOfWork,
	row: ActiveControlsRow,
	actor: string,
): Promise<number | null> {
	if (row.version === null) {
		return row.revision;
	}
	const { db } = uow.tx;
	if (row.revision !== null) {
		const [existing] = await db
			.select({
				generation: configRevisions.generation,
				snapshotHash: configRevisions.snapshotHash,
			})
			.from(configRevisions)
			.where(eq(configRevisions.id, row.revision));
		if (
			existing !== undefined &&
			existing.generation === row.generation &&
			(await recordedEnabledAgreesWithLive(db, existing.snapshotHash, row.version))
		) {
			return row.revision;
		}
	}
	const [versionRow] = await db
		.select({
			organization: configVersions.organization,
			constitution: configVersions.constitution,
		})
		.from(configVersions)
		.where(eq(configVersions.version, row.version));
	if (versionRow === undefined) {
		// `active_config_version` names no row: nothing to backfill from; leave the pointer as is.
		return row.revision;
	}
	const agentRows = [
		...(await db
			.select({ config: agents.config, rolePrompt: agents.rolePrompt, enabled: agents.enabled })
			.from(agents)
			.where(or(eq(agents.configVersion, row.version), eq(agents.enabled, true)))),
	].sort((a, b) => compareAgentIds(a.config.id, b.config.id));
	const bundle: ConfigSnapshotBundle = {
		organization: versionRow.organization,
		agents: agentRows.map((agent) => ({ ...agent.config, enabled: agent.enabled })),
		constitution: versionRow.constitution,
		rolePrompts: Object.fromEntries(agentRows.map((agent) => [agent.config.id, agent.rolePrompt])),
	};
	// The stale revision's own attachments document (if any) carries forward, filtered to the
	// agents this backfill bundle still configures — the same rule `resolveApplyToolAttachments`
	// already applies for a plain YAML `config apply`. Never reconstructed from nothing: a database
	// upgraded from a release before ADR-027 ever recorded one has none to carry forward, and this
	// backfill honestly carries none either (`attachmentsSnapshotHash` stays null below). Without
	// this, a backfill triggered only by `agents.enabled` drifting (an older release's own direct
	// toggle, no attachment ever touched) would otherwise demote every hub-managed agent to legacy —
	// `attachments_snapshot_hash` null means exactly that (ADR-027's own rollback-recovery rule),
	// which is only actually true for a release that predates attachments altogether.
	const configuredAgentIds = new Set(bundle.agents.map((agent) => agent.id));
	const toolAttachments = canonicalizeAttachmentsIn(
		Object.fromEntries(
			Object.entries(await loadToolAttachmentsIn(db, row.revision)).filter(([agentId]) =>
				configuredAgentIds.has(agentId),
			),
		),
	);
	const hasToolAttachments = Object.keys(toolAttachments).length > 0;
	const attachmentsSnapshotHash = hasToolAttachments ? canonicalHash(toolAttachments) : null;
	const hash = canonicalHash(bundle);
	await db
		.insert(configSnapshots)
		.values({
			hash,
			bundle,
			format: CONFIG_SNAPSHOT_FORMAT,
			origin: "backfill",
			createdAt: uow.now,
		})
		.onConflictDoNothing();
	if (attachmentsSnapshotHash !== null) {
		await db
			.insert(configAttachmentSnapshots)
			.values({
				hash: attachmentsSnapshotHash,
				bundle: toolAttachments,
				format: CONFIG_ATTACHMENTS_SNAPSHOT_FORMAT,
				createdAt: uow.now,
			})
			.onConflictDoNothing();
	}
	const [revision] = await db
		.insert(configRevisions)
		.values({
			snapshotHash: hash,
			attachmentsSnapshotHash,
			// The stale revision (if any) becomes this one's parent, same as a fresh backfill's
			// null parent when none was ever recorded.
			parentRevisionId: row.revision,
			generation: row.generation,
			actor,
			source: "backfill",
			createdAt: uow.now,
		})
		.returning({ id: configRevisions.id });
	await audit(uow, actor, "config.history_backfill", "config", row.version, {
		generation: row.generation,
		snapshot_hash: hash,
	});
	if (row.revision !== null) {
		// A revision was already recorded for this configuration, and it is now stale: something
		// changed `config_versions`/`agents` outside the revision journal, most likely a release
		// before this one that does not know the journal exists, running during a rollback
		// interval. The projections just backfilled are what the Gateway actually runs — never the
		// stale snapshot the old revision names — but a human should look at what changed.
		uow.deps.log.warn(
			`configuration changed outside revision history at generation ${row.generation}; ` +
				`recorded as revision ${revision?.id} (backfill); review with 'gateway config diff'/'history'`,
			{
				generation: row.generation,
				revision_id: revision?.id,
				parent_revision_id: row.revision,
				snapshot_hash: hash,
			},
		);
	}
	return revision?.id ?? null;
}

/**
 * Backfills configuration history for the active configuration if it is not already represented
 * by an up-to-date revision — none was ever recorded, or an older release changed the active
 * configuration without recording one (see `ensureConfigHistoryIn`). Safe to call at every
 * controller/CLI startup, whether or not backfilling is needed: a database whose recorded
 * revision already matches, or with no active configuration, is left untouched.
 */
export async function ensureConfigHistory(deps: ControlPlaneDeps, actor: string): Promise<void> {
	await inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		await db.insert(gatewayControls).values({ id: 1 }).onConflictDoNothing();
		const [controls] = await db
			.select({
				version: gatewayControls.activeConfigVersion,
				generation: gatewayControls.configGeneration,
				revision: gatewayControls.activeConfigRevision,
			})
			.from(gatewayControls)
			.where(eq(gatewayControls.id, 1))
			.for("update");
		if (controls === undefined) {
			return;
		}
		const revisionId = await ensureConfigHistoryIn(uow, controls, actor);
		if (revisionId !== controls.revision) {
			await db
				.update(gatewayControls)
				.set({ activeConfigRevision: revisionId, updatedAt: uow.now })
				.where(eq(gatewayControls.id, 1));
		}
	});
}

/**
 * The live projections `loadEffectivePermissionsIn` trusts without re-reading the active
 * revision's own attachments document every time (`catalog_attachments`,
 * `agents.tool_attachments_managed`), reconciled back to agree with it — never assumed to already
 * agree, the way every other reader of them does (ADR-027's "the active revision is the source of
 * truth" rule). They normally do agree, since `writeConfigRevisionIn` reconciles both in the same
 * transaction as every revision it writes; the one way they stop agreeing is a release before
 * ADR-027 writing a revision through its own, older `applyConfig` during a rollback interval — it
 * has no `toolAttachments` document to call `writeConfigRevisionIn` with at all (the parameter did
 * not exist for it) and knows nothing of either projection, so its revision lands with
 * `attachments_snapshot_hash` null while the projections are left exactly as a hub-managed agent's
 * last *pre-rollback* commit set them. Re-upgrading past this point would otherwise trust those
 * stale projections and resurrect (or keep denying) whatever access the older release's own
 * `permissions` edit actually changed, since nothing before this ever re-read the active revision's
 * attachments document again to check. A revision with a null `attachments_snapshot_hash` carries no
 * attachments document at all — only this release's own writer ever records one — so every agent it
 * names is legacy: this reconciles both projections to the empty document (`{}`). This is *not* the
 * same case as a plain YAML apply with no `tool-attachments.json` (a common point of confusion):
 * that apply still carries every agent's existing attachments forward unchanged, filtered to the
 * agents it still configures (`resolveApplyToolAttachments`), and so still ends up with a real,
 * non-null `attachments_snapshot_hash` whenever there was anything to carry forward — `{}` here is
 * reached only for a revision with no attachments document at all, the pre-ADR-027-writer case
 * above. A revision with a non-null hash was necessarily written by this release's
 * own writer, which already reconciled both projections to match it in the same transaction; this
 * still re-reads and reconciles against it rather than trusting that, so a database nudged out of
 * sync by anything else (a restored backup, a hand edit) is corrected the same way.
 *
 * A no-op, and cheap, in the overwhelmingly common case where the live projections already agree
 * with the active revision's document (compared by canonical hash, the same comparison
 * `attachments_snapshot_hash` itself is defined by) — safe to call at every controller/CLI startup,
 * next to `ensureConfigHistory`, whether or not reconciling is actually needed.
 */
export async function ensureToolAttachmentsReconciled(
	deps: ControlPlaneDeps,
	actor: string,
): Promise<void> {
	await inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		const [controls] = await db
			.select({ revision: gatewayControls.activeConfigRevision })
			.from(gatewayControls)
			.where(eq(gatewayControls.id, 1))
			.for("update");
		if (controls === undefined || controls.revision === null) {
			return;
		}
		const desired = canonicalizeAttachmentsIn(await loadToolAttachmentsIn(db, controls.revision));
		const managedAgentIds = await db
			.select({ id: agents.id })
			.from(agents)
			.where(eq(agents.toolAttachmentsManaged, true));
		const attachmentRows = await db
			.select({
				agentId: catalogAttachments.agentId,
				entryId: catalogAttachments.entryId,
				pinnedVersion: catalogAttachments.pinnedVersion,
				mode: catalogAttachments.mode,
				settings: catalogAttachments.settings,
			})
			.from(catalogAttachments);
		const liveByAgent = new Map<string, ToolAttachment[]>(
			managedAgentIds.map((row) => [row.id, []]),
		);
		for (const row of attachmentRows) {
			const list = liveByAgent.get(row.agentId);
			if (list !== undefined) {
				list.push({
					entryId: row.entryId,
					pinnedVersion: row.pinnedVersion,
					mode: row.mode,
					settings: row.settings,
				});
			}
		}
		const live = canonicalizeAttachmentsIn(Object.fromEntries(liveByAgent));
		if (canonicalHash(live) === canonicalHash(desired)) {
			return;
		}
		await reconcileCatalogAttachmentsIn(uow, desired);
		uow.deps.log.warn(
			"tool attachment projections disagreed with the active configuration revision's own " +
				"attachments document; reconciled to match it (likely a release before ADR-027 changed " +
				"configuration during a rollback interval) — review with 'gateway tools list'/'gateway " +
				"agents show <agent>'",
			{ revision_id: controls.revision },
		);
		await audit(
			uow,
			actor,
			"config.tool_attachments_reconciled",
			"config",
			String(controls.revision),
		);
	});
}

/**
 * Whether `ensureConfigHistory` would backfill a revision right now, decided the same way it
 * decides that (no active configuration at all, or none ever recorded for one, or the recorded
 * revision's generation or live `agents.enabled` projection has since moved — see
 * `ensureConfigHistoryIn`/`recordedEnabledAgreesWithLive`) without writing anything. `gateway
 * doctor` is read-only and so never runs `ensureConfigHistory` itself (unlike every write command
 * and the controller's own startup): right after a forward upgrade, before anything has triggered
 * the backfill, the revision journal's latest entry still looks exactly as it did before the
 * upgrade, understating drift that has already happened to the live projections. This predicate
 * reports that drift truthfully whether or not it has been backfilled yet.
 */
export async function configHistoryNeedsBackfill(deps: ControlPlaneDeps): Promise<boolean> {
	return inTransaction(deps, async ({ tx }) => {
		const { db } = tx;
		const [controls] = await db
			.select({
				version: gatewayControls.activeConfigVersion,
				generation: gatewayControls.configGeneration,
				revision: gatewayControls.activeConfigRevision,
			})
			.from(gatewayControls)
			.where(eq(gatewayControls.id, 1));
		if (controls === undefined || controls.version === null) {
			return false;
		}
		if (controls.revision === null) {
			return true;
		}
		const [existing] = await db
			.select({
				generation: configRevisions.generation,
				snapshotHash: configRevisions.snapshotHash,
			})
			.from(configRevisions)
			.where(eq(configRevisions.id, controls.revision));
		if (existing === undefined || existing.generation !== controls.generation) {
			return true;
		}
		return !(await recordedEnabledAgreesWithLive(db, existing.snapshotHash, controls.version));
	});
}

/**
 * Records that a human reviewed `revisionId` and accepts it, even though nothing about its
 * content was ever recommitted. Clears the `config:backfill` alert and `gateway doctor`'s
 * `config_history` check when `revisionId` is the drifted `backfill` revision they name
 * (`configHistoryConditions`): `commitChange` treats identical content as a no-op, so replaying a
 * `backfill` revision's own reviewed content (an import, or `config rollback` to it) writes no new
 * revision to supersede it, and an acknowledgement is the only way to clear the signal short of a
 * later, actually different change. Acknowledging does not change the configuration or write a
 * revision. One row per revision; acknowledging an already-acknowledged one replaces it (a new
 * actor, or the same one reaffirming) rather than failing, since acknowledging twice is harmless.
 */
export async function ackConfigRevision(
	deps: ControlPlaneDeps,
	revisionId: number,
	actor: string,
): Promise<void> {
	await inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		const [revision] = await db
			.select({ id: configRevisions.id })
			.from(configRevisions)
			.where(eq(configRevisions.id, revisionId));
		if (revision === undefined) {
			throw new AdminError(`config revision ${revisionId} does not exist`);
		}
		await db
			.insert(configRevisionAcks)
			.values({ revisionId, actor, ackedAt: uow.now })
			.onConflictDoUpdate({
				target: configRevisionAcks.revisionId,
				set: { actor, ackedAt: uow.now },
			});
		await audit(uow, actor, "config.ack", "config", String(revisionId));
	});
}

/** Everything {@link writeConfigRevisionIn} needs to write one configuration change. */
export type WriteConfigRevisionInput = Readonly<{
	/** The resolved agent definitions this change applies, *before* the bundle-mirror invariant
	 * below runs — a hub-managed agent's own `permissions` field here may already be stale (a plain
	 * YAML `config apply` carries whatever the directory says) or may already agree with
	 * `toolAttachments` (every other write path already mirrors before calling this). Either way,
	 * `writeConfigRevisionIn` recomputes the bundle and its hash from the *mirrored* agents, never
	 * from this value directly, so what is actually hashed and stored always agrees with
	 * `toolAttachments`. */
	input: ConfigApplyInput;
	/** This revision's own, final, already-canonicalized attachments document (ADR-027) —
	 * stored as its own content-addressed snapshot, separate from the bundle; `{}` when no agent has
	 * ever been touched through the tool-catalog hub. Resolved by the caller
	 * (`commitChangeIn`/`applyConfig`'s own `resolveApplyToolAttachments`). */
	toolAttachments: ToolAttachmentsBundle;
	generation: number;
	parentRevisionId: number | null;
	actor: string;
	source: ConfigRevisionSource;
	reason: string | null;
	idempotencyKey: string | null;
	changeHash: string | null;
}>;

/**
 * The one code path that writes a configuration change: `config_versions`/`agents` projections,
 * the snapshot and revision, channel tombstones and scheduling. Every caller — `applyConfig`'s
 * whole-bundle replace and the managed-config service's finer-grained operations — has already
 * validated the resulting bundle and resolved `generation`/`parentRevisionId` under the
 * `gateway_controls` lock; this function only writes. Agents that left the configuration are
 * disabled, never deleted: their history stays referenced. An agent with a run in progress cannot
 * be disabled; pause it first.
 *
 * ADR-027's bundle-mirror invariant is enforced here, not left to each caller to remember: every
 * hub-managed agent's `permissions` field is (re)compiled from `toolAttachments` before the bundle
 * is hashed or stored, so the stored bundle (and so `gateway config export`/`gateway agents show`)
 * can never disagree with enforcement, whichever path committed the change — a plain YAML `config
 * apply` included. Idempotent against a caller that already mirrored (`commitChangeIn` mirrors
 * earlier too, for its own no-op check and diff): compiling an already-compiled result reproduces
 * it exactly, so this never undoes or duplicates that work, only repeats a cheap catalog read.
 */
export async function writeConfigRevisionIn(
	uow: UnitOfWork,
	write: WriteConfigRevisionInput,
): Promise<ConfigApplyResult> {
	const {
		input: rawInput,
		toolAttachments,
		generation,
		parentRevisionId,
		actor,
		source,
		reason,
		idempotencyKey,
		changeHash,
	} = write;
	const { db } = uow.tx;
	// Every caller already runs `attachmentCatalogProblems` (which itself includes this) against
	// the same `toolAttachments` before ever reaching this shared writer; checked again here,
	// against whatever caller this ever grows, so a bundle with two attachments of the same entry
	// can never be written at all — never committed and only discovered later, when
	// `loadActiveBundle` next parses the overlapping permission lists it compiles into.
	const duplicateProblems = duplicateAttachmentIssues(toolAttachments);
	if (duplicateProblems.length > 0) {
		throw new AdminError(`configuration is invalid:\n- ${duplicateProblems.join("\n- ")}`);
	}
	const mirroredAgents = await mirrorCompiledAttachmentPermissions(
		db,
		rawInput.organization.organization.finance_agent_id,
		rawInput.agents,
		toolAttachments,
	);
	// The bundle-mirror invariant's own result, validated before it is ever hashed or written:
	// `AgentConfigSchema` itself refuses an agent whose compiled permission lists overlap
	// (`toolPatternOverlaps`) — catching that here, against the exact agents about to be stored,
	// is what keeps a bad compile result from ever reaching `config_snapshots` at all, rather than
	// surfacing only the next time something parses the snapshot back (`loadActiveBundle`).
	for (const agent of mirroredAgents) {
		const parsed = AgentConfigSchema.safeParse(agent);
		if (!parsed.success) {
			throw new AdminError(
				`internal: agent '${agent.id}'s compiled attachments produced an invalid configuration:\n- ${parsed.error.issues.map((issue) => issue.message).join("\n- ")}`,
			);
		}
	}
	const input: ConfigApplyInput = { ...rawInput, agents: mirroredAgents };
	const bundle = configSnapshotBundle(input);
	const version = canonicalHash(bundle);
	const previous = await loadActiveConfig(db);
	if (
		previous !== null &&
		previous.organization.mattermost.team !== input.organization.mattermost.team
	) {
		// Another team: every channel's catch-up starts afresh once bootstrap resolves it, so
		// switching away and back never replays the interval in between. The marker voids any
		// start scanned before this generation.
		await uow.tx.client.query(
			"delete from source_cursors where source_id ~ '^mattermost:channel(-floor|-floor-posts)?:'",
		);
		await markChannelsLeft(uow, [TEAM_CHANGE_MARKER], generation);
		// Grants were given in the old team's channels: another team starts without any.
		await db
			.update(mattermostChannelGrants)
			.set({
				state: "revoked",
				revokedReason: "team_changed",
				revokedAt: uow.now,
				generation: sql`${mattermostChannelGrants.generation} + 1`,
			})
			.where(eq(mattermostChannelGrants.state, "active"));
	} else if (previous !== null) {
		// A channel leaving the configuration loses its catch-up at once: re-added later, it
		// starts afresh instead of replaying what was posted while it was unmanaged.
		// A channel an agent was granted stays followed: its catch-up is the grant's.
		const kept = new Set(input.organization.mattermost.channels);
		const resolved = await loadDirectory(db, "channel");
		const granted = grantedChannels(await loadChannelAccess(db));
		const ids = previous.organization.mattermost.channels
			.filter((name) => !kept.has(name))
			.flatMap((name) => {
				const id = resolved.get(name);
				return id === undefined || granted.has(id) ? [] : [id];
			});
		if (ids.length > 0) {
			await uow.tx.client.query(
				`delete from source_cursors
					  where regexp_replace(source_id, '^mattermost:channel(-floor|-floor-posts)?:', '') = any($1::text[])
					    and source_id ~ '^mattermost:channel(-floor|-floor-posts)?:'`,
				[ids],
			);
			await markChannelsLeft(
				uow,
				ids.map((id) => `mattermost:channel-left:${id}`),
				generation,
			);
		}
	}
	await db
		.insert(configVersions)
		.values({
			version,
			organization: input.organization,
			constitution: input.constitution,
			appliedAt: uow.now,
		})
		.onConflictDoNothing();
	// Content-addressed: re-applying identical content hits the same row, and this change still
	// gets its own revision below.
	await db
		.insert(configSnapshots)
		.values({
			hash: version,
			bundle,
			format: CONFIG_SNAPSHOT_FORMAT,
			origin: "applied",
			createdAt: uow.now,
		})
		.onConflictDoNothing();
	// This revision's own attachments document (ADR-027), stored apart from `config_snapshots`
	// so that table stays exactly the shape a release before this column existed already reads:
	// `{}` (no agent ever touched through the hub) gets no row at all and a null column, the same
	// way `attachments_snapshot_hash` stays null for a revision recorded before this column existed.
	const hasToolAttachments = Object.keys(toolAttachments).length > 0;
	const attachmentsSnapshotHash = hasToolAttachments ? canonicalHash(toolAttachments) : null;
	if (attachmentsSnapshotHash !== null) {
		await db
			.insert(configAttachmentSnapshots)
			.values({
				hash: attachmentsSnapshotHash,
				bundle: toolAttachments,
				format: CONFIG_ATTACHMENTS_SNAPSHOT_FORMAT,
				createdAt: uow.now,
			})
			.onConflictDoNothing();
	}
	const [revision] = await db
		.insert(configRevisions)
		.values({
			snapshotHash: version,
			attachmentsSnapshotHash,
			parentRevisionId,
			generation,
			actor,
			source,
			reason,
			idempotencyKey,
			changeHash,
			createdAt: uow.now,
		})
		.returning({ id: configRevisions.id });
	if (revision === undefined) {
		throw new AdminError("recording the configuration revision did not return its id");
	}
	await db
		.insert(gatewayControls)
		.values({
			id: 1,
			activeConfigVersion: version,
			configGeneration: generation,
			activeConfigRevision: revision.id,
			updatedAt: uow.now,
		})
		.onConflictDoUpdate({
			target: gatewayControls.id,
			set: {
				activeConfigVersion: version,
				configGeneration: generation,
				activeConfigRevision: revision.id,
				updatedAt: uow.now,
			},
		});

	// Every existing agent row, locked in id order up front: the apply touches most of them.
	const before = await db
		.select({ id: agents.id, config: agents.config, version: agents.configVersion })
		.from(agents)
		.orderBy(asc(agents.id))
		.for("no key update");
	if (
		previous !== null &&
		previous.organization.mattermost.team === input.organization.mattermost.team
	) {
		await tombstoneUnconfiguredChannels(
			uow,
			before.filter((row) => row.version === previous.version),
			input.agents,
		);
	}
	const created: string[] = [];
	const updated: string[] = [];
	const disabled: string[] = [];
	const configured = new Set(input.agents.map((a) => a.id));
	for (const agent of [...input.agents].sort((a, b) => (a.id < b.id ? -1 : 1))) {
		const values = {
			displayName: agent.display_name,
			runtimeAdapter: agent.runtime.adapter,
			runtimeProfile: agent.runtime.profile,
			configVersion: version,
			maxActiveRuns: agent.concurrency.max_active_runs,
			config: agent,
			// Own-property lookup: see `configBundleProblems`'s own comment above — an agent id like
			// `constructor` with no role prompt of its own would otherwise resolve, through the
			// prototype chain, to `Object.prototype.constructor` instead of `undefined`.
			rolePrompt:
				(Object.hasOwn(input.rolePrompts, agent.id) ? input.rolePrompts[agent.id] : undefined) ??
				"",
			updatedAt: uow.now,
		};
		const existing = await lockAgent(db, agent.id);
		if (existing === null) {
			const state: AgentState = agent.enabled ? "idle" : "disabled";
			await db.insert(agents).values({
				id: agent.id,
				...values,
				enabled: agent.enabled,
				state,
				stateChangedAt: uow.now,
				createdAt: uow.now,
			});
			created.push(agent.id);
		} else {
			await db.update(agents).set(values).where(eq(agents.id, agent.id));
			await applyEnabled(uow, existing.id, existing.state, agent.enabled, actor);
			updated.push(agent.id);
		}
		await db
			.insert(mattermostIdentities)
			.values({
				agentId: agent.id,
				username: agent.mattermost.username,
				tokenSecretRef: agent.mattermost.token_secret_file,
			})
			.onConflictDoUpdate({
				target: mattermostIdentities.agentId,
				set: {
					username: agent.mattermost.username,
					tokenSecretRef: agent.mattermost.token_secret_file,
				},
			});
	}
	const known = await db.select({ id: agents.id }).from(agents).orderBy(asc(agents.id));
	for (const { id } of known.filter((row) => !configured.has(row.id))) {
		const row = await lockAgent(db, id);
		if (row !== null && row.state !== "disabled") {
			await applyEnabled(uow, id, row.state, false, actor);
			disabled.push(id);
		}
	}
	await reconcileCatalogAttachmentsIn(uow, toolAttachments);
	// Approved actions that have not begun are checked against the new policy.
	await revokeQueuedActions(uow);
	// Cards live in the approvals channel, and only replies there decide: when it moves (or the
	// team changes), the requests still waiting are withdrawn (their agents learn it and may
	// ask again).
	if (
		previous !== null &&
		(previous.organization.mattermost.approvals_channel !==
			input.organization.mattermost.approvals_channel ||
			previous.organization.mattermost.team !== input.organization.mattermost.team)
	) {
		await withdrawOpenApprovals(uow, null, "the approvals channel changed", true);
	}
	// An agent enabled by this config may already have work waiting in its inbox.
	for (const id of [...configured].sort()) {
		await scheduleAgent(uow, id);
	}
	await audit(uow, actor, "config.apply", "config", version, {
		revision: revision.id,
		created: created.length,
		updated: updated.length,
		disabled: disabled.length,
		source,
	});
	return { version, revisionId: revision.id, created, updated, disabled };
}

/**
 * Reconciles `catalog_attachments` — the current-state projection of
 * `ConfigSnapshotBundle.toolAttachments` (ADR-027), the same way the loop above reconciles `agents`
 * against `ConfigSnapshotBundle.agents` — to match `desired` exactly: a row for a binding no
 * longer in `desired` is removed, and one still there is inserted or updated. Also reconciles
 * `agents.tool_attachments_managed` to whether `desired` has a key for each agent at all (even an
 * explicitly empty list counts): the live, cheap "hub-managed" signal `catalog_attachments` rows
 * alone cannot give, since an empty list and "never touched" both have zero rows there. Runs on
 * every configuration write (`replace_bundle`, `attach_tool`, `detach_tool`, `update_attachment`,
 * `clear_tool_attachments` alike), so neither projection ever drifts from the bundle that is the
 * actual source of truth.
 */
async function reconcileCatalogAttachmentsIn(
	uow: UnitOfWork,
	desired: ToolAttachmentsBundle,
): Promise<void> {
	const { db } = uow.tx;
	const desiredRows = Object.entries(desired).flatMap(([agentId, attachments]) =>
		attachments.map((attachment) => ({ agentId, ...attachment })),
	);
	const existing = await db
		.select({ agentId: catalogAttachments.agentId, entryId: catalogAttachments.entryId })
		.from(catalogAttachments);
	const desiredKeys = new Set(desiredRows.map((row) => `${row.agentId}\u0000${row.entryId}`));
	const stale = existing.filter((row) => !desiredKeys.has(`${row.agentId}\u0000${row.entryId}`));
	for (const row of stale) {
		await db
			.delete(catalogAttachments)
			.where(
				and(
					eq(catalogAttachments.agentId, row.agentId),
					eq(catalogAttachments.entryId, row.entryId),
				),
			);
	}
	for (const row of desiredRows) {
		await db
			.insert(catalogAttachments)
			.values({
				agentId: row.agentId,
				entryId: row.entryId,
				pinnedVersion: row.pinnedVersion,
				mode: row.mode,
				settings: row.settings,
				createdAt: uow.now,
				updatedAt: uow.now,
			})
			.onConflictDoUpdate({
				target: [catalogAttachments.agentId, catalogAttachments.entryId],
				set: {
					pinnedVersion: row.pinnedVersion,
					mode: row.mode,
					settings: row.settings,
					updatedAt: uow.now,
				},
			});
	}
	const hubManagedIds = Object.keys(desired);
	if (hubManagedIds.length === 0) {
		await db.update(agents).set({ toolAttachmentsManaged: false });
	} else {
		await db
			.update(agents)
			.set({ toolAttachmentsManaged: true })
			.where(inArray(agents.id, hubManagedIds));
		await db
			.update(agents)
			.set({ toolAttachmentsManaged: false })
			.where(notInArray(agents.id, hubManagedIds));
	}
}

// ---------------------------------------------------------------------------
// Shared with the managed-configuration service (`management.ts`'s own `commitChangeIn`). Every
// committing path — `applyConfig`'s whole-bundle replace and `commitChangeIn`'s finer-grained
// operations — runs the same checks before it writes: a lifecycle-owned-only `/run/bot-secrets/`
// token path, a lifecycle-owned agent never dropped or re-added outside its own request, its
// `token_secret_file` never redirected outside its own request, and a `reprovision` queued for any
// lifecycle-owned, `ready` agent whose `allowed_channels` just changed (ADR-026).
// `rejectLifecycleOwnedRemovals`, `rejectRetiredAgentReadditions` and
// `rejectLifecycleOwnedTokenPathChanges` live in `./lifecycle-guards.ts`, a module neither this one
// nor `management.ts` owns, so each can import it without the other — `rejectUnownedBotSecretPathsIn`
// and the rest below stay a second copy here instead, for the same reason: Biome refuses the import
// cycle a shared definition in either file would need (`management.ts` already imports
// `writeConfigRevisionIn` from this one).
// ---------------------------------------------------------------------------

/**
 * `/run/bot-secrets/` is the lifecycle provisioner's own directory (ADR-026): naming it in
 * `token_secret_file` is refused for any agent that is not lifecycle-owned (its operation journal
 * names a `create` or `restore`) or one `trustedAgentIds` names. See `management.ts`'s own copy
 * for the full rationale (`rejectUnownedBotSecretPaths`); `applyConfig` never has a trusted id of
 * its own, so it always calls this with an empty set.
 */
async function rejectUnownedBotSecretPathsIn(
	db: Db,
	draftAgents: Readonly<AgentConfig[]>,
	trustedAgentIds: ReadonlySet<AgentId>,
): Promise<Readonly<string[]>> {
	const candidates = draftAgents.filter((agent) =>
		agent.mattermost.token_secret_file.startsWith(BOT_SECRET_FILE_PREFIX),
	);
	if (candidates.length === 0) {
		return [];
	}
	const owned = await lifecycleOwnedAgentIds(
		db,
		candidates.map((agent) => agent.id),
	);
	return candidates
		.filter((agent) => !trustedAgentIds.has(agent.id) && !owned.has(agent.id))
		.map(
			(agent) =>
				`agent ${agent.id}: token_secret_file '${agent.mattermost.token_secret_file}' is under ` +
				"the lifecycle provisioner's own directory, but this agent was not created or restored " +
				"through the lifecycle",
		);
}

/** Whether `a` and `b` name the same channels, regardless of order. */
function sameChannelsIn(a: Readonly<string[]>, b: Readonly<string[]>): boolean {
	const setA = new Set(a);
	const setB = new Set(b);
	return setA.size === setB.size && [...setA].every((name) => setB.has(name));
}

/** Agent ids (sorted) whose `allowed_channels` differ between `before` and `after` — see
 * `management.ts`'s own `channelsChangedAgentIds`. */
function channelsChangedAgentIdsIn(
	before: Readonly<AgentConfig[]>,
	after: Readonly<AgentConfig[]>,
): Readonly<string[]> {
	const beforeById = new Map(before.map((agent) => [agent.id, agent]));
	return after
		.filter((agent) => {
			const prior = beforeById.get(agent.id);
			return (
				prior !== undefined &&
				!sameChannelsIn(prior.mattermost.allowed_channels, agent.mattermost.allowed_channels)
			);
		})
		.map((agent) => agent.id)
		.sort();
}

/**
 * The organization behind `revisionId` (`null`: no revision has ever been recorded, or its
 * snapshot is somehow missing — the empty-database state `loadActiveBundle` itself treats as "no
 * organization yet"), read the same trusted-column way `priorAgents` above reads `agents.config`:
 * `applyConfig` only ever needs this one field (`mattermost.team`) to detect a team change, never
 * the validated, cached reader `management.ts`'s own `loadActiveBundle` is (kept a separate copy
 * for the same reason as the rest of this section).
 */
async function loadOrganizationIn(
	db: Db,
	revisionId: number | null,
): Promise<OrganizationConfig | null> {
	if (revisionId === null) {
		return null;
	}
	const [revision] = await db
		.select({ snapshotHash: configRevisions.snapshotHash })
		.from(configRevisions)
		.where(eq(configRevisions.id, revisionId));
	if (revision === undefined) {
		return null;
	}
	const [snapshot] = await db
		.select({ bundle: configSnapshots.bundle })
		.from(configSnapshots)
		.where(eq(configSnapshots.hash, revision.snapshotHash));
	return snapshot?.bundle.organization ?? null;
}

/** Whether the organization's own Mattermost team just changed — see `management.ts`'s own
 * `organizationTeamChanged` for the full rationale. */
function organizationTeamChangedIn(
	before: OrganizationConfig | null,
	after: OrganizationConfig,
): boolean {
	return before !== null && before.mattermost.team !== after.mattermost.team;
}

type AgentLifecycleRow = typeof agentLifecycle.$inferSelect;

/** Locks (`for update`) the `agent_lifecycle` rows of `agentIds`, in ascending id order — see
 * `management.ts`'s own `lockLifecycleRows` for the full lock-order rationale. */
async function lockLifecycleRowsIn(
	db: Db,
	agentIds: Readonly<string[]>,
): Promise<ReadonlyMap<string, AgentLifecycleRow>> {
	if (agentIds.length === 0) {
		return new Map();
	}
	const sorted = [...agentIds].sort();
	const rows = await db
		.select()
		.from(agentLifecycle)
		.where(inArray(agentLifecycle.agentId, sorted))
		.orderBy(asc(agentLifecycle.agentId))
		.for("update");
	return new Map(rows.map((row) => [row.agentId, row]));
}

/** Queues a `reprovision` operation the same way `management.ts`'s own `queueMembershipReprovisioning`
 * does (see its doc comment for the full dedup/supersede rationale); kept as a second copy here for
 * the same reason as `rejectUnownedBotSecretPathsIn` above. */
async function queueMembershipReprovisioningIn(
	uow: UnitOfWork,
	agentIds: Readonly<string[]>,
	locked: ReadonlyMap<string, AgentLifecycleRow>,
	revisionId: number | null,
	actor: string,
	source: AgentLifecycleSource,
): Promise<void> {
	if (agentIds.length === 0) {
		return;
	}
	const { db } = uow.tx;
	const owned = await lifecycleOwnedAgentIds(db, agentIds);
	for (const agentId of agentIds) {
		const lifecycle = locked.get(agentId);
		if (lifecycle === undefined || lifecycle.status !== "ready" || !owned.has(agentId)) {
			continue;
		}
		let current:
			| { id: string; kind: AgentLifecycleOperationKind; state: AgentLifecycleOperationState }
			| undefined;
		if (lifecycle.operationId !== null) {
			[current] = await db
				.select({
					id: agentLifecycleOperations.id,
					kind: agentLifecycleOperations.kind,
					state: agentLifecycleOperations.state,
				})
				.from(agentLifecycleOperations)
				.where(eq(agentLifecycleOperations.id, lifecycle.operationId))
				.for("update");
		}
		if (current?.kind === "reprovision" && current.state === "pending") {
			continue;
		}
		if (current?.kind === "reprovision" && current.state === "running") {
			await db
				.update(agentLifecycleOperations)
				.set({ state: "cancelled", updatedAt: uow.now, finishedAt: uow.now })
				.where(eq(agentLifecycleOperations.id, current.id));
		}
		const operationId = randomUUID();
		const generation = lifecycle.generation + 1;
		await db.insert(agentLifecycleOperations).values({
			id: operationId,
			agentId,
			kind: "reprovision",
			requestedBy: actor,
			source,
			configRevisionId: revisionId,
			generation,
			state: "pending",
			checkpoints: {},
			createdAt: uow.now,
			updatedAt: uow.now,
		});
		await db
			.update(agentLifecycle)
			.set({ operationId, generation })
			.where(eq(agentLifecycle.agentId, agentId));
		await audit(uow, actor, "agent_lifecycle.reprovision", "agent", agentId, {
			operation_id: operationId,
			revision_id: revisionId,
		});
	}
}

/**
 * Stores a validated configuration as the active version and upserts its agents: the whole-bundle
 * replace `config apply` has always performed, now written through {@link writeConfigRevisionIn}.
 * The CLI has no revision it expects to still be active (a later step adds `--expected-revision`),
 * so this reads the current one itself and always proceeds — the one case the managed-config
 * service's `commitChange` would instead treat as a conflict never applies here, since there is
 * nothing else a plain `config apply` could have been expecting.
 */
export async function applyConfig(
	deps: ControlPlaneDeps,
	input: ConfigApplyInput,
	actor: string,
): Promise<ConfigApplyResult> {
	const problems = configBundleProblems(input);
	if (problems.length > 0) {
		throw new AdminError(`configuration is invalid:\n- ${problems.join("\n- ")}`);
	}
	return inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		// The configuration row first, for update: applies are serialized, and the generation and
		// parent revision below are resolved under this lock.
		await db.insert(gatewayControls).values({ id: 1 }).onConflictDoNothing();
		const [controls] = await db
			.select({
				version: gatewayControls.activeConfigVersion,
				generation: gatewayControls.configGeneration,
				revision: gatewayControls.activeConfigRevision,
			})
			.from(gatewayControls)
			.where(eq(gatewayControls.id, 1))
			.for("update");
		const generation = (controls?.generation ?? 0) + 1;
		// Backfills the history of a database upgraded from a release before it existed, so this
		// apply's revision gets the right parent instead of starting a disconnected history.
		const parentRevisionId = await ensureConfigHistoryIn(
			uow,
			{
				version: controls?.version ?? null,
				generation: controls?.generation ?? 0,
				revision: controls?.revision ?? null,
			},
			actor,
		);
		// Every committing path behaves the same (ADR-026): a plain `config apply` is refused the
		// lifecycle provisioner's own `/run/bot-secrets/` token path for an agent it does not own,
		// exactly like `commitChangeIn` already refuses it for a console patch or a CLI import.
		const botSecretProblems = await rejectUnownedBotSecretPathsIn(db, input.agents, new Set());
		if (botSecretProblems.length > 0) {
			throw new AdminError(`configuration is invalid:\n- ${botSecretProblems.join("\n- ")}`);
		}
		// Locked before `writeConfigRevisionIn` locks the `agents` table itself, the same order
		// `commitChangeIn` keeps (see `lockLifecycleRowsIn`). An unlocked read: only the diff it
		// informs needs to be current, not linearized with the write below (which locks the table
		// for real right after). Scoped to the currently *active* version, never every row the table
		// still holds: `agents` retains a removed (or retired) agent's own last configuration rather
		// than deleting its row (ADR-024), so an unscoped read would make a retired agent look
		// already "there" to `rejectRetiredAgentReadditions`'s own before/after diff below, even
		// though it is not part of the active configuration at all — exactly the reintroduction that
		// check exists to refuse.
		const priorAgents =
			controls?.version === undefined || controls.version === null
				? []
				: (
						await db
							.select({ config: agents.config })
							.from(agents)
							.where(eq(agents.configVersion, controls.version))
					).map((row) => row.config);
		// `config apply` never has a trusted removal id of its own (see `rejectLifecycleOwnedRemovals`):
		// an agent's retirement always runs through `requestAgentRetire`, never a whole-bundle replace.
		const removalProblems = await rejectLifecycleOwnedRemovals(
			db,
			priorAgents,
			input.agents,
			new Set(),
		);
		if (removalProblems.length > 0) {
			throw new AdminError(`configuration is invalid:\n- ${removalProblems.join("\n- ")}`);
		}
		// Every committing path behaves the same way (ADR-026): a plain `config apply` is refused a
		// retired agent reintroduced this way too, exactly like `commitChangeIn` already refuses it
		// for a console patch, a CLI import or a rollback.
		const readditionProblems = await rejectRetiredAgentReadditions(
			db,
			priorAgents,
			input.agents,
			new Set(),
		);
		if (readditionProblems.length > 0) {
			throw new AdminError(`configuration is invalid:\n- ${readditionProblems.join("\n- ")}`);
		}
		// Every committing path behaves the same way (ADR-026): a plain `config apply` is refused a
		// redirected `token_secret_file` for a lifecycle-owned agent too, exactly like
		// `commitChangeIn` already refuses it for a console patch or a CLI import.
		const tokenPathProblems = await rejectLifecycleOwnedTokenPathChanges(
			db,
			priorAgents,
			input.agents,
			new Set(),
		);
		if (tokenPathProblems.length > 0) {
			throw new AdminError(`configuration is invalid:\n- ${tokenPathProblems.join("\n- ")}`);
		}
		const priorOrganization = await loadOrganizationIn(db, parentRevisionId);
		const channelsChangedIds = organizationTeamChangedIn(priorOrganization, input.organization)
			? [
					...new Set([
						...channelsChangedAgentIdsIn(priorAgents, input.agents),
						...input.agents.map((agent) => agent.id),
					]),
				].sort()
			: channelsChangedAgentIdsIn(priorAgents, input.agents);
		const lockedLifecycle = await lockLifecycleRowsIn(db, channelsChangedIds);
		const toolAttachments = await resolveApplyToolAttachments(db, parentRevisionId, input);
		// The same catalog constraints every managed write checks (ADR-027): a directory exported before
		// an entry was deleted must not bring its attachment back through a plain `config apply`.
		const attachmentProblems = await attachmentCatalogProblems(db, toolAttachments);
		if (attachmentProblems.length > 0) {
			throw new AdminError(`configuration is invalid:\n- ${attachmentProblems.join("\n- ")}`);
		}
		const result = await writeConfigRevisionIn(uow, {
			input,
			toolAttachments,
			generation,
			parentRevisionId,
			actor,
			source: "cli_apply",
			reason: null,
			idempotencyKey: null,
			changeHash: null,
		});
		// A plain `config apply` queues a `reprovision` the same way a managed-configuration commit
		// does, for any lifecycle-owned, `ready` agent whose `allowed_channels` just changed: neither
		// path may leave the other as the only one that keeps a lifecycle-owned agent's Mattermost
		// membership in sync with its configuration.
		await queueMembershipReprovisioningIn(
			uow,
			channelsChangedIds,
			lockedLifecycle,
			result.revisionId,
			actor,
			"cli",
		);
		return result;
	});
}

/** Marker of the generation in which every channel left management (a team change). */
export const TEAM_CHANGE_MARKER = "mattermost:team-changed";

/**
 * Records the generation in which channels left management: a catch-up start scanned before it
 * is void for them (see `startManagedChannel`).
 */
async function markChannelsLeft(
	uow: UnitOfWork,
	markers: Readonly<string[]>,
	generation: number,
): Promise<void> {
	for (const sourceId of markers) {
		await uow.tx.db
			.insert(sourceCursors)
			.values({
				sourceId,
				cursorType: "generation",
				cursorValue: String(generation),
				updatedAt: uow.now,
			})
			.onConflictDoUpdate({
				target: sourceCursors.sourceId,
				set: { cursorValue: String(generation), updatedAt: uow.now },
			});
	}
}

/**
 * Enables or disables an agent. Disabling cancels the agent's waits and expires its pending
 * approvals, so nothing can resume it behind the operator's back. Enabling restores FAILED when
 * the agent's latest run failed: only a redrive clears a failure.
 */
async function applyEnabled(
	uow: UnitOfWork,
	agentId: string,
	state: AgentState,
	enabled: boolean,
	actor: string,
): Promise<void> {
	if (enabled === (state !== "disabled")) {
		return;
	}
	const reason = `${enabled ? "enabled" : "disabled"} by ${actor}`;
	if (!enabled) {
		const next = nextAgentState(state, "disable");
		if (next === null) {
			throw new AdminError(`agent '${agentId}' is '${state}'; pause it before disabling`);
		}
		await cancelActiveWaits(uow, agentId);
		// Its open approvals are withdrawn: nothing it asked for runs while it is disabled.
		await withdrawOpenApprovals(uow, agentId, reason);
		await setAgentState(uow, agentId, state, next, reason);
		return;
	}
	const [latest] = await uow.tx.db
		.select({ status: agentRuns.status })
		.from(agentRuns)
		.where(eq(agentRuns.agentId, agentId))
		.orderBy(desc(agentRuns.queuedAt))
		.limit(1);
	const transition = latest?.status === "failed" ? "enable_failed" : "enable";
	await setAgentState(uow, agentId, state, requireTransition(agentId, state, transition), reason);
}

/** Records a Mattermost id resolved for a configured name (bootstrap, or by hand in development). */
export async function setDirectoryEntry(
	deps: ControlPlaneDeps,
	kind: DirectoryKind,
	name: string,
	mattermostId: MattermostId,
	actor: string,
): Promise<void> {
	await inTransaction(deps, (uow) => setDirectoryEntryIn(uow, kind, name, mattermostId, actor));
}

/** {@link setDirectoryEntry} inside a caller's transaction. */
export async function setDirectoryEntryIn(
	uow: UnitOfWork,
	kind: DirectoryKind,
	name: string,
	mattermostId: MattermostId,
	actor: string,
): Promise<void> {
	const id = MattermostIdSchema.parse(mattermostId);
	// A renamed channel or user keeps its id: the old name gives way to the new one.
	await uow.tx.db
		.delete(mattermostDirectory)
		.where(
			and(
				eq(mattermostDirectory.kind, kind),
				eq(mattermostDirectory.mattermostId, id),
				ne(mattermostDirectory.name, name),
			),
		);
	await uow.tx.db
		.insert(mattermostDirectory)
		.values({ kind, name, mattermostId: id, resolvedAt: uow.now })
		.onConflictDoUpdate({
			target: [mattermostDirectory.kind, mattermostDirectory.name],
			set: { mattermostId: id, resolvedAt: uow.now },
		});
	await audit(uow, actor, "directory.set", kind, name, { mattermost_id: id });
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** An enabled agent whose runtime has no ready worker is degraded: its runs wait in the queue. */
export type AgentRuntimeStatus = "ok" | "degraded" | "disabled";

function runtimeStatusOf(
	enabled: boolean,
	adapter: RuntimeAdapterId,
	health: Readonly<RuntimeHealth[]>,
): AgentRuntimeStatus {
	if (!enabled) {
		return "disabled";
	}
	return health.some((h) => h.adapter === adapter && h.available) ? "ok" : "degraded";
}

export async function listAgents(deps: ControlPlaneDeps) {
	const rows = await deps.pool.query<{
		id: string;
		state: string;
		enabled: boolean;
		runtime_adapter: RuntimeAdapterId;
		pending: number;
		active_waits: number;
	}>(
		`select a.id, a.state, a.enabled, a.runtime_adapter,
		   (select count(*)::int from agent_inbox i where i.agent_id = a.id and i.status = 'pending') as pending,
		   (select count(*)::int from wait_subscriptions w where w.agent_id = a.id and w.status = 'active') as active_waits
		 from agents a order by a.id`,
	);
	const health = await runtimeHealth(deps);
	return rows.rows.map(({ enabled, ...row }) => ({
		...row,
		runtime_status: runtimeStatusOf(enabled, row.runtime_adapter, health),
	}));
}

export async function showAgent(deps: ControlPlaneDeps, agentId: string) {
	const shown = await inTransaction(deps, async ({ tx }) => {
		const [agent] = await tx.db.select().from(agents).where(eq(agents.id, agentId));
		if (agent === undefined) {
			throw new AdminError(`agent '${agentId}' does not exist`);
		}
		const [identity] = await tx.db
			.select()
			.from(mattermostIdentities)
			.where(eq(mattermostIdentities.agentId, agentId));
		const runs = await tx.db
			.select({
				id: agentRuns.id,
				status: agentRuns.status,
				outcome: agentRuns.outcome,
				attempt: agentRuns.attempt,
				errorCode: agentRuns.errorCode,
				queuedAt: agentRuns.queuedAt,
			})
			.from(agentRuns)
			.where(eq(agentRuns.agentId, agentId))
			.orderBy(desc(agentRuns.queuedAt))
			.limit(10);
		const waits = await tx.db
			.select()
			.from(waitSubscriptions)
			.where(and(eq(waitSubscriptions.agentId, agentId), eq(waitSubscriptions.status, "active")));
		return { agent, identity: identity ?? null, runs, waits };
	});
	const runtime = (await runtimeHealth(deps)).find((h) => h.adapter === shown.agent.runtimeAdapter);
	return {
		...shown,
		runtime: {
			status: runtimeStatusOf(
				shown.agent.enabled,
				shown.agent.runtimeAdapter,
				runtime === undefined ? [] : [runtime],
			),
			versions: runtime?.runtimeVersions ?? [],
			detail: runtime?.detail ?? null,
		},
	};
}

/** pg-boss jobs an operation made obsolete; the caller cancels them (the domain has no boss). */
export type CancelledJob = Readonly<{ queue: string; jobId: string }>;

/**
 * Pauses an agent. A run in progress is cancelled and its inbox entries return to pending, so
 * no work is lost; the worker's late report is ignored because the run is no longer active.
 * Exported for `requestAgentRetire` (`agent-lifecycle.ts`), which reuses this exact cancellation
 * before committing a `remove_agent` change set: the state machine only allows `disable` from
 * `idle`/`waiting`/`failed`/`paused`, never from `queued`/`running`, so an active run is cancelled
 * (moving the agent to `paused`) first.
 */
export async function pauseInTransaction(
	uow: UnitOfWork,
	agentId: string,
	actor: string,
	reason: string,
): Promise<CancelledJob[]> {
	const { db } = uow.tx;
	const agent = await lockAgent(db, agentId);
	if (agent === null) {
		throw new AdminError(`agent '${agentId}' does not exist`);
	}
	// A FAILED agent runs nothing; it stays FAILED until redriven, even through kill-all.
	if (agent.state === "paused" || agent.state === "disabled" || agent.state === "failed") {
		return [];
	}
	const next = requireTransition(agentId, agent.state, "pause");
	const active = await db
		.update(agentRuns)
		.set({
			status: "cancelled",
			finishedAt: uow.now,
			errorCode: "cancelled",
			errorDetailRedacted: reason,
		})
		.where(and(eq(agentRuns.agentId, agentId), inArray(agentRuns.status, ["queued", "running"])))
		.returning({ id: agentRuns.id, jobId: agentRuns.jobId, adapter: agentRuns.runtimeAdapter });
	for (const run of active) {
		await db
			.update(agentInbox)
			.set({ status: "pending", runId: null })
			.where(and(eq(agentInbox.runId, run.id), eq(agentInbox.status, "claimed")));
		await audit(uow, actor, "run.cancel", "run", run.id, { reason });
	}
	await setAgentState(uow, agentId, agent.state, next, reason);
	await audit(uow, actor, "agent.pause", "agent", agentId, { reason });
	return active.flatMap((run) =>
		run.jobId === null ? [] : [{ queue: `agent.run.${run.adapter}`, jobId: run.jobId }],
	);
}

export async function pauseAgent(
	deps: ControlPlaneDeps,
	agentId: string,
	actor: string,
): Promise<CancelledJob[]> {
	return inTransaction(deps, (uow) =>
		pauseInTransaction(uow, agentId, actor, `paused by ${actor}`),
	);
}

/** Resumes a paused agent: back to waiting if it still holds active waits, otherwise idle. */
export async function resumeAgent(
	deps: ControlPlaneDeps,
	agentId: string,
	actor: string,
): Promise<AgentState> {
	return inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		const agent = await lockAgent(db, agentId);
		if (agent === null) {
			throw new AdminError(`agent '${agentId}' does not exist`);
		}
		if (agent.state !== "paused") {
			throw new AdminError(`agent '${agentId}' is '${agent.state}', not paused`);
		}
		const waits = await db
			.select({ id: waitSubscriptions.id })
			.from(waitSubscriptions)
			.where(and(eq(waitSubscriptions.agentId, agentId), eq(waitSubscriptions.status, "active")));
		const next = requireTransition(
			agentId,
			agent.state,
			waits.length > 0 ? "resume_waiting" : "resume_idle",
		);
		await setAgentState(uow, agentId, agent.state, next, `resumed by ${actor}`);
		await audit(uow, actor, "agent.resume", "agent", agentId);
		await scheduleAgent(uow, agentId);
		return (await lockAgent(db, agentId))?.state ?? next;
	});
}

// ---------------------------------------------------------------------------
// Runs, waits, events, approvals
// ---------------------------------------------------------------------------

export async function listRuns(deps: ControlPlaneDeps, agentId: string | null, limit = 20) {
	return inTransaction(deps, ({ tx }) =>
		tx.db
			.select({
				id: agentRuns.id,
				agentId: agentRuns.agentId,
				status: agentRuns.status,
				outcome: agentRuns.outcome,
				attempt: agentRuns.attempt,
				errorCode: agentRuns.errorCode,
				queuedAt: agentRuns.queuedAt,
				finishedAt: agentRuns.finishedAt,
			})
			.from(agentRuns)
			.where(agentId === null ? undefined : eq(agentRuns.agentId, agentId))
			.orderBy(desc(agentRuns.queuedAt))
			.limit(limit),
	);
}

export async function showRun(deps: ControlPlaneDeps, runId: string) {
	return inTransaction(deps, async ({ tx }) => {
		const [run] = await tx.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
		if (run === undefined) {
			throw new AdminError(`run '${runId}' does not exist`);
		}
		const inbox = await tx.db
			.select({ eventId: agentInbox.eventId, status: agentInbox.status, waitId: agentInbox.waitId })
			.from(agentInbox)
			.where(eq(agentInbox.runId, runId));
		return { run, inbox };
	});
}

/** Cancels the agent's run in progress; the agent is paused (RUNNING -> PAUSED). */
export async function cancelRun(
	deps: ControlPlaneDeps,
	runId: string,
	actor: string,
): Promise<CancelledJob[]> {
	return inTransaction(deps, async (uow) => {
		const [peek] = await uow.tx.db
			.select({ agentId: agentRuns.agentId })
			.from(agentRuns)
			.where(eq(agentRuns.id, runId));
		if (peek === undefined) {
			throw new AdminError(`run '${runId}' does not exist`);
		}
		// Checked under the agent lock: the run may have finished since it was looked up.
		await lockAgent(uow.tx.db, peek.agentId);
		const [run] = await uow.tx.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
		if (run === undefined || (run.status !== "queued" && run.status !== "running")) {
			throw new AdminError(`run '${runId}' is '${run?.status}', not in progress`);
		}
		return pauseInTransaction(uow, run.agentId, actor, `run ${runId} cancelled by ${actor}`);
	});
}

/**
 * Re-runs the latest failed run of a FAILED agent (FAILED -> QUEUED). Its inbox entries go back
 * to pending and a new run with the same trigger is scheduled; the old run keeps its record.
 */
export async function redriveRun(
	deps: ControlPlaneDeps,
	runId: string,
	actor: string,
): Promise<ScheduleResult> {
	return inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
		if (run === undefined) {
			throw new AdminError(`run '${runId}' does not exist`);
		}
		const agent = await lockAgent(db, run.agentId);
		if (agent?.state !== "failed") {
			throw new AdminError(`agent '${run.agentId}' is '${agent?.state}', not failed`);
		}
		const [latest] = await db
			.select({ id: agentRuns.id })
			.from(agentRuns)
			.where(eq(agentRuns.agentId, run.agentId))
			.orderBy(desc(agentRuns.queuedAt))
			.limit(1);
		if (run.status !== "failed" || latest?.id !== run.id) {
			throw new AdminError(`run '${runId}' is not the agent's latest failed run`);
		}
		// Retention keeps the events of pending work and of FAILED agents; one that lost its
		// content anyway (the agent failed again later) has nothing left to redo.
		const [expired] = await db
			.select({ id: events.id })
			.from(agentInbox)
			.innerJoin(events, eq(events.id, agentInbox.eventId))
			.where(and(eq(agentInbox.runId, run.id), isNotNull(events.contentExpiredAt)))
			.limit(1);
		if (expired !== undefined) {
			throw new AdminError(
				`run '${runId}' cannot be redriven: its content expired under retention`,
			);
		}
		await db
			.update(agentInbox)
			.set({ status: "pending", runId: null })
			.where(
				and(eq(agentInbox.runId, run.id), inArray(agentInbox.status, ["claimed", "consumed"])),
			);
		await audit(uow, actor, "run.redrive", "run", runId);
		const result = await scheduleAgent(uow, run.agentId, {
			redrive: { runId: run.id, triggerEventId: run.triggerEventId },
		});
		if ("skipped" in result) {
			throw new AdminError(`redrive of '${runId}' did not start a run: ${result.skipped}`);
		}
		return result;
	});
}

export async function listWaits(deps: ControlPlaneDeps) {
	return inTransaction(deps, ({ tx }) =>
		tx.db
			.select({
				id: waitSubscriptions.id,
				agentId: waitSubscriptions.agentId,
				eventType: waitSubscriptions.eventType,
				correlationId: waitSubscriptions.correlationId,
				timeoutAt: waitSubscriptions.timeoutAt,
			})
			.from(waitSubscriptions)
			.where(eq(waitSubscriptions.status, "active"))
			.orderBy(waitSubscriptions.timeoutAt),
	);
}

/** An event by internal UUID or by its external id. */
export async function showEvent(deps: ControlPlaneDeps, id: string) {
	return inTransaction(deps, async ({ tx }) => {
		const isUuid = /^[0-9a-f-]{36}$/i.test(id);
		const rows = await tx.db
			.select()
			.from(events)
			.where(isUuid ? or(eq(events.id, id), eq(events.externalId, id)) : eq(events.externalId, id));
		// An event whose content retention removed is no longer a valid envelope: its columns
		// are shown instead.
		return rows.map((row) =>
			row.contentExpiredAt === null
				? { id: row.id, receivedAt: row.receivedAt, event: toGatewayEvent(row) }
				: {
						id: row.id,
						receivedAt: row.receivedAt,
						contentExpiredAt: row.contentExpiredAt,
						event: null,
						externalId: row.externalId,
						source: row.source,
						type: row.type,
						subject: row.subject,
						correlationId: row.correlationId,
						payload: row.payload,
					},
		);
	});
}

export async function listApprovals(deps: ControlPlaneDeps, status: string | null) {
	return inTransaction(deps, ({ tx }) =>
		tx.db
			.select({
				id: approvalRequests.id,
				agentId: approvalRequests.requestedByAgentId,
				actionType: approvalRequests.actionType,
				riskLevel: approvalRequests.riskLevel,
				status: approvalRequests.status,
				expiresAt: approvalRequests.expiresAt,
				decidedByUserId: approvalRequests.decidedByUserId,
				execution: toolActions.status,
			})
			.from(approvalRequests)
			.leftJoin(toolActions, eq(toolActions.approvalId, approvalRequests.id))
			.where(status === null ? undefined : eq(approvalRequests.status, status))
			.orderBy(desc(approvalRequests.createdAt)),
	);
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

/**
 * Emergency stop: no run starts while the switch is on, and every agent that is not disabled
 * is paused, cancelling runs in progress. Releasing the switch does not resume agents.
 */
export async function killAll(deps: ControlPlaneDeps, actor: string): Promise<CancelledJob[]> {
	const cancelled = await inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		await db
			.insert(gatewayControls)
			.values({ id: 1, killSwitch: true, updatedAt: uow.now })
			.onConflictDoUpdate({
				target: gatewayControls.id,
				set: { killSwitch: true, updatedAt: uow.now },
			});
		await audit(uow, actor, "gateway.kill_all", "gateway", "controls");
		// Under the controls row: a tool runner's `begin` either came first (the action runs and
		// is asked to stop) or finds the switch on.
		await withdrawOpenApprovals(uow, null, `kill-all by ${actor}`);
		const jobs: CancelledJob[] = [];
		const rows = await db.select({ id: agents.id }).from(agents).orderBy(agents.id);
		for (const row of rows) {
			jobs.push(...(await pauseInTransaction(uow, row.id, actor, `kill-all by ${actor}`)));
		}
		return jobs;
	});
	// The agents learn their approvals were withdrawn outside the kill-all transaction, in the
	// lock order of every approval use case; the reconcile sweep retries whatever fails here.
	await sweepApprovals(deps).catch((error: unknown) => {
		deps.log.warn("approvals not resolved after kill-all; the sweep retries", {
			error_message: error instanceof Error ? error.message : String(error),
		});
	});
	return cancelled;
}

export async function releaseKillSwitch(deps: ControlPlaneDeps, actor: string): Promise<void> {
	await inTransaction(deps, async (uow) => {
		await uow.tx.db
			.update(gatewayControls)
			.set({ killSwitch: false, updatedAt: uow.now })
			.where(eq(gatewayControls.id, 1));
		await audit(uow, actor, "gateway.kill_all_release", "gateway", "controls");
	});
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export async function listOutbox(deps: ControlPlaneDeps, status: OutboxStatus | null) {
	return inTransaction(deps, ({ tx }) =>
		tx.db
			.select({
				id: outbox.id,
				kind: outbox.kind,
				destination: outbox.destination,
				status: outbox.status,
				attempts: outbox.attempts,
				lastError: outbox.lastErrorRedacted,
				createdAt: outbox.createdAt,
			})
			.from(outbox)
			.where(status === null ? undefined : eq(outbox.status, status))
			.orderBy(desc(outbox.createdAt))
			.limit(100),
	);
}

/** Attempts a redriven outbox item gets on top of the ones it used. */
const OUTBOX_REDRIVE_ATTEMPTS = 8;

/**
 * Gives a dead outbox item a fresh set of attempts. The idempotency key is unchanged, so a
 * deliverer that already performed the effect returns its receipt instead of repeating it.
 */
export async function redriveOutbox(
	deps: ControlPlaneDeps,
	outboxId: string,
	actor: string,
): Promise<void> {
	await inTransaction(deps, async (uow) => {
		const [item] = await uow.tx.db
			.update(outbox)
			// `attempts` keeps counting: it is the fencing token of claims, so it never goes back.
			.set({
				status: "pending",
				maxAttempts: sql`${outbox.attempts} + ${OUTBOX_REDRIVE_ATTEMPTS}`,
				nextAttemptAt: uow.now,
				lockedUntil: null,
			})
			.where(
				and(eq(outbox.id, outboxId), eq(outbox.status, "dead"), isNull(outbox.contentExpiredAt)),
			)
			.returning({ id: outbox.id });
		if (item === undefined) {
			throw new AdminError(
				`outbox item '${outboxId}' does not exist, is not dead, or its payload expired under retention`,
			);
		}
		await uow.jobs.send(QUEUES.outboxDeliver, { outboxId });
		await audit(uow, actor, "outbox.redrive", "outbox", outboxId);
	});
}
