import type {
	AgentId,
	ChannelGrantInput,
	MattermostId,
	MembershipState,
	RejectedAdd,
} from "@agent-gateway/contracts";
import {
	agents,
	gatewayControls,
	mattermostChannelGrants,
	mattermostIdentities,
	runtimeSessions,
	sourceCursors,
	withTransaction,
} from "@agent-gateway/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agentChannelIds, grantedChannels } from "../channel-access.ts";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import { lockLifecycleRows, queueMembershipReprovisioning } from "./management.ts";
import { channelCursorIds } from "./mattermost-bridge.ts";
import {
	audit,
	loadActiveConfig,
	loadChannelAccess,
	loadDirectory,
	loadOwnerUserIds,
	loadTeamChannels,
	lockAgent,
	raiseAlert,
} from "./store.ts";

/**
 * Channel grants: an owner or system admin adds an agent's bot to a channel in Mattermost, and
 * the agent may work there from that moment (ADR-022). The membership synchronizer finds the
 * adds and removals; these are the records behind it.
 */

async function inTransaction<T>(
	deps: ControlPlaneDeps,
	work: (uow: UnitOfWork) => Promise<T>,
): Promise<T> {
	return withTransaction(deps.pool, (tx) =>
		work({ deps, tx, jobs: deps.jobs(tx), now: deps.clock() }),
	);
}

/**
 * Takes the configuration row exclusively, like a config apply: a post authorized under the old
 * grants (which holds the row in share mode) finishes first, and none starts until this commits.
 */
async function lockConfigExclusive({ tx }: UnitOfWork): Promise<void> {
	await tx.db.insert(gatewayControls).values({ id: 1 }).onConflictDoNothing();
	await tx.db
		.select({ id: gatewayControls.id })
		.from(gatewayControls)
		.where(eq(gatewayControls.id, 1))
		.for("update");
}

export async function loadMembershipState(deps: ControlPlaneDeps): Promise<MembershipState | null> {
	return inTransaction(deps, async ({ tx }) => {
		const config = await loadActiveConfig(tx.db);
		if (config === null) {
			return null;
		}
		const { mattermost } = config.organization;
		const teamId = (await loadDirectory(tx.db, "team")).get(mattermost.team);
		const listenerId = (await loadDirectory(tx.db, "user")).get(mattermost.listener.username);
		if (teamId === undefined || listenerId === undefined) {
			return null;
		}
		const named = await loadTeamChannels(tx.db);
		const resolve = (names: Readonly<string[]>) =>
			new Set(
				names.flatMap((name) => {
					const id = named.get(name);
					return id === undefined ? [] : [id];
				}),
			);
		const botRows = await tx.db
			.select({
				agentId: agents.id,
				config: agents.config,
				userId: mattermostIdentities.mattermostUserId,
				tokenSecretRef: mattermostIdentities.tokenSecretRef,
			})
			.from(agents)
			.innerJoin(mattermostIdentities, eq(mattermostIdentities.agentId, agents.id))
			.where(eq(agents.configVersion, config.version));
		const grants = await tx.db
			.select({
				agentId: mattermostChannelGrants.agentId,
				channelId: mattermostChannelGrants.channelId,
				state: mattermostChannelGrants.state,
				botUserId: mattermostChannelGrants.botUserId,
				sinceMs: mattermostChannelGrants.sinceMs,
				revokedReason: mattermostChannelGrants.revokedReason,
				checkedAtMs: mattermostChannelGrants.checkedAtMs,
			})
			.from(mattermostChannelGrants)
			.where(eq(mattermostChannelGrants.teamId, teamId));
		return {
			teamId,
			ownerUserIds: new Set(await loadOwnerUserIds(tx.db)),
			listener: { userId: listenerId, tokenSecretRef: mattermost.listener.token_secret_file },
			bots: botRows.flatMap((row) =>
				row.userId === null
					? []
					: [
							{
								agentId: row.agentId,
								userId: row.userId,
								tokenSecretRef: row.tokenSecretRef,
								configuredChannelIds: resolve(row.config.mattermost.allowed_channels),
							},
						],
			),
			grants,
		};
	});
}

/**
 * Records an owner's or system admin's add as a grant. A channel not followed yet starts its
 * catch-up at the add itself, so a mention right after it is not lost; a followed channel keeps
 * its catch-up, and the grant's floor keeps older posts from the agent. False when the grant is
 * stale: the agent or its bot changed, or a record at least as new exists.
 */
export async function grantChannel(
	deps: ControlPlaneDeps,
	input: ChannelGrantInput,
): Promise<boolean> {
	return inTransaction(deps, async (uow) => {
		await lockConfigExclusive(uow);
		// The agent too, as scheduling holds it: no turn is built from the access this changes.
		await lockAgent(uow.tx.db, input.agentId);
		// Dated after the locks: a run queued while this waited for them is older than the grant.
		const now = uow.deps.clock();
		const { db } = uow.tx;
		const config = await loadActiveConfig(db);
		const [bot] = await db
			.select({ userId: mattermostIdentities.mattermostUserId, config: agents.config })
			.from(mattermostIdentities)
			.innerJoin(agents, eq(agents.id, mattermostIdentities.agentId))
			.where(
				and(
					eq(mattermostIdentities.agentId, input.agentId),
					eq(agents.configVersion, config?.version ?? ""),
				),
			);
		if (bot === undefined || bot.userId !== input.botUserId) {
			return false;
		}
		// A configured channel needs no grant, and bootstrap's own add there (with the admin's
		// token) must never become one: a pass that read the configuration before it changed
		// could otherwise take that add for an admin's.
		const named = await loadTeamChannels(db);
		if (
			bot.config.mattermost.allowed_channels.some((name) => named.get(name) === input.channelId)
		) {
			return false;
		}
		const [existing] = await db
			.select({ state: mattermostChannelGrants.state, sinceMs: mattermostChannelGrants.sinceMs })
			.from(mattermostChannelGrants)
			.where(
				and(
					eq(mattermostChannelGrants.agentId, input.agentId),
					eq(mattermostChannelGrants.channelId, input.channelId),
				),
			);
		// An add at or before the latest record is that record's own add (or older): it grants
		// nothing again.
		if (existing !== undefined && input.sinceMs <= existing.sinceMs) {
			return existing.state === "active";
		}
		const values = {
			teamId: input.teamId,
			channelName: input.channelName,
			botUserId: input.botUserId,
			state: "active" as const,
			grantorUserId: input.grantorUserId,
			evidencePostId: input.evidencePostId,
			sinceMs: input.sinceMs,
			checkedAtMs: input.sinceMs,
			revokedReason: null,
			grantedAt: now,
			revokedAt: null,
		};
		await db
			.insert(mattermostChannelGrants)
			.values({ agentId: input.agentId, channelId: input.channelId, ...values })
			.onConflictDoUpdate({
				target: [mattermostChannelGrants.agentId, mattermostChannelGrants.channelId],
				set: { ...values, generation: sql`${mattermostChannelGrants.generation} + 1` },
			});
		const ids = channelCursorIds(input.channelId);
		const starts = [
			{ sourceId: ids.floorPosts, cursorType: "post_ids", cursorValue: input.evidencePostId },
			{ sourceId: ids.floor, cursorType: "create_at_ms", cursorValue: String(input.sinceMs) },
			// Strictly after: posts in the add's own millisecond are read too (the floor decides).
			{ sourceId: ids.cursor, cursorType: "update_at_ms", cursorValue: String(input.sinceMs - 1) },
		];
		for (const start of starts) {
			await db
				.insert(sourceCursors)
				.values({ ...start, updatedAt: uow.now })
				.onConflictDoNothing({ target: sourceCursors.sourceId });
		}
		await endAgentRuntimeSessions(uow, input.agentId);
		await audit(uow, "system", "mattermost.channel.granted", "agent", input.agentId, {
			channel_id: input.channelId,
			channel_name: input.channelName,
			grantor_user_id: input.grantorUserId,
			evidence_post_id: input.evidencePostId,
		});
		return true;
	});
}

/** The tombstone + audit every grant revocation shares, whoever asked for it (`actor`): sets the
 * grant `revoked` (so re-adding the bot later never silently re-grants it), ends the agent's
 * sessions once, and audits. Returns the channel name revoked, or null when nothing was active to
 * revoke (an already-revoked or never-granted channel — the caller's own transaction still goes
 * on; this is not refused as an error, the same way a repeat of any other idempotent cleanup
 * isn't). Called with the agent row already locked by the caller (`lockConfigExclusive` +
 * `lockAgent`, in that order — or, for a retiring agent, the lock `requestAgentRetire` already
 * holds).
 */
async function tombstoneGrant(
	uow: UnitOfWork,
	agentId: AgentId,
	channelId: MattermostId,
	reason: string,
): Promise<string | null> {
	const revoked = await uow.tx.db
		.update(mattermostChannelGrants)
		.set({
			state: "revoked",
			revokedReason: reason,
			// Dated after the locks, like a grant.
			revokedAt: uow.deps.clock(),
			generation: sql`${mattermostChannelGrants.generation} + 1`,
		})
		.where(
			and(
				eq(mattermostChannelGrants.agentId, agentId),
				eq(mattermostChannelGrants.channelId, channelId),
				eq(mattermostChannelGrants.state, "active"),
			),
		)
		.returning({ name: mattermostChannelGrants.channelName });
	if (revoked.length === 0) {
		return null;
	}
	await endAgentRuntimeSessions(uow, agentId);
	return revoked[0]?.name ?? null;
}

/**
 * Revokes an agent's grant in a channel, reactively: the membership synchronizer's own record
 * that the bot already left the channel (by its own decision, or because Mattermost reports it is
 * no longer a member) — never a call that itself removes anything from Mattermost, only the
 * bookkeeping after the fact. The agent's pending work from there is dropped where it is checked
 * (routing, scheduling, the turn's authority, delivery). True when the channel is still followed
 * for others, false when nothing needs it any more: its catch-up is deleted and the listener may
 * leave.
 */
export async function recordChannelGrantRevoked(
	deps: ControlPlaneDeps,
	agentId: AgentId,
	channelId: MattermostId,
	reason: string,
): Promise<boolean> {
	return inTransaction(deps, async (uow) => {
		await lockConfigExclusive(uow);
		await lockAgent(uow.tx.db, agentId);
		const channelName = await tombstoneGrant(uow, agentId, channelId, reason);
		if (channelName !== null) {
			await audit(uow, "system", "mattermost.channel.revoked", "agent", agentId, {
				channel_id: channelId,
				channel_name: channelName,
				reason,
			});
		}
		return channelStillFollowed(uow, channelId);
	});
}

/**
 * Revokes every active grant an agent still has, in the caller's own transaction
 * (`requestAgentRetire`, ADR-026): a retiring agent can never act again, including through a
 * channel an owner or admin granted it directly, so every one of its grants is tombstoned right
 * there — never left for the membership synchronizer to notice on its own schedule. The caller
 * already holds whatever lock this needs (the agent's own row, locked before this is called, the
 * same order every other writer here takes). Returns the channel ids revoked, for the caller's own
 * audit entry.
 */
export async function revokeAllActiveGrantsIn(
	uow: UnitOfWork,
	agentId: AgentId,
	reason: string,
): Promise<Readonly<MattermostId[]>> {
	const revoked = await uow.tx.db
		.update(mattermostChannelGrants)
		.set({
			state: "revoked",
			revokedReason: reason,
			revokedAt: uow.deps.clock(),
			generation: sql`${mattermostChannelGrants.generation} + 1`,
		})
		.where(
			and(
				eq(mattermostChannelGrants.agentId, agentId),
				eq(mattermostChannelGrants.state, "active"),
			),
		)
		.returning({ channelId: mattermostChannelGrants.channelId });
	if (revoked.length > 0) {
		await endAgentRuntimeSessions(uow, agentId);
	}
	return revoked.map((row) => row.channelId);
}

export type RevokeChannelGrantInput = Readonly<{
	agentId: AgentId;
	channelId: MattermostId;
	actor: string;
}>;

/**
 * Revokes an agent's grant by an owner's or operator's own decision (`gateway agents
 * revoke-grant`): tombstones it the same way {@link recordChannelGrantRevoked} does, but also asks
 * for the bot's actual removal — a lifecycle-owned, `ready` agent gets a `reprovision` operation
 * queued (its own leaving-channels step re-checks live grants itself, ADR-026), so the provisioner
 * acts on it without waiting for an unrelated configuration change; a bootstrap-managed agent has
 * no such operation to queue, and is instead left to the membership synchronizer's own next pass,
 * which removes a bot from a channel it no longer has a grant or configuration for. Locks the
 * agent's `agent_lifecycle` row before its `agents` row (`lockLifecycleRows`, the global lock
 * order every lifecycle writer keeps), so this can never deadlock against `completeOperation`.
 */
export async function revokeChannelGrant(
	deps: ControlPlaneDeps,
	input: RevokeChannelGrantInput,
): Promise<boolean> {
	return inTransaction(deps, async (uow) => {
		await lockConfigExclusive(uow);
		const { db } = uow.tx;
		const lockedLifecycle = await lockLifecycleRows(db, [input.agentId]);
		await lockAgent(db, input.agentId);
		const channelName = await tombstoneGrant(
			uow,
			input.agentId,
			input.channelId,
			`revoked by ${input.actor}`,
		);
		if (channelName !== null) {
			await audit(uow, input.actor, "mattermost.channel.revoked", "agent", input.agentId, {
				channel_id: input.channelId,
				channel_name: channelName,
				reason: "revoke-grant",
			});
			await queueMembershipReprovisioning(
				uow,
				[input.agentId],
				lockedLifecycle,
				null,
				input.actor,
				"cli",
			);
		}
		return channelStillFollowed(uow, input.channelId);
	});
}

/**
 * Records that an active grant's channel was checked for a re-add up to `atMs`; never moves the
 * mark back.
 */
export async function markGrantChecked(
	deps: ControlPlaneDeps,
	agentId: AgentId,
	channelId: MattermostId,
	atMs: number,
): Promise<void> {
	await inTransaction(deps, async ({ tx }) => {
		await tx.db
			.update(mattermostChannelGrants)
			.set({ checkedAtMs: atMs })
			.where(
				and(
					eq(mattermostChannelGrants.agentId, agentId),
					eq(mattermostChannelGrants.channelId, channelId),
					eq(mattermostChannelGrants.state, "active"),
					sql`coalesce(${mattermostChannelGrants.checkedAtMs}, 0) < ${atMs}`,
				),
			);
	});
}

/**
 * Ends the agent's stored provider sessions: their transcripts hold what earlier turns saw, and a
 * changed grant (a channel taken away, or given again with a newer floor) must not resume it.
 * Exported for `requestAgentRetire` (`agent-lifecycle.ts`, ADR-026), which ends a retiring agent's
 * sessions unconditionally, regardless of whether it had any channel grant to revoke: a restored
 * agent must never pick up a pre-retirement session (`resumable-if-available`, `runtime_sessions`),
 * the same guarantee a changed grant already gets here.
 */
export async function endAgentRuntimeSessions({ tx }: UnitOfWork, agentId: AgentId): Promise<void> {
	await tx.db
		.update(runtimeSessions)
		.set({ status: "revoked" })
		.where(and(eq(runtimeSessions.agentId, agentId), eq(runtimeSessions.status, "active")));
}

/**
 * Whether a channel is still followed: configured, or granted to an agent as the channel access
 * counts grants (a stale row of a replaced bot or a removed agent does not keep it). When it is
 * not, its catch-up is deleted.
 */
async function channelStillFollowed(uow: UnitOfWork, channelId: MattermostId): Promise<boolean> {
	const { db } = uow.tx;
	const config = await loadActiveConfig(db);
	const access = await loadChannelAccess(db);
	const configured = (config?.organization.mattermost.channels ?? []).some(
		(name) => access.named.get(name) === channelId,
	);
	if (configured || grantedChannels(access).has(channelId)) {
		return true;
	}
	const ids = channelCursorIds(channelId);
	await db
		.delete(sourceCursors)
		.where(inArray(sourceCursors.sourceId, [ids.cursor, ids.floor, ids.floorPosts]));
	return false;
}

/**
 * Audits an add that grants nothing and alerts the operators: once per add record, and for a
 * membership without one, once a day.
 */
export async function rejectChannelAdd(deps: ControlPlaneDeps, add: RejectedAdd): Promise<void> {
	await inTransaction(deps, async (uow) => {
		const detail = {
			agent_id: add.agentId,
			channel_id: add.channelId,
			channel_name: add.channelName,
			actor_user_id: add.actorUserId,
			evidence_post_id: add.evidencePostId,
			reason: add.reason,
		};
		await audit(uow, "system", "mattermost.channel.add_rejected", "agent", add.agentId, detail);
		const message =
			add.reason === "add_unverified"
				? `@${add.agentId} may have been removed from ~${add.channelName} and added again, but too many posts followed to tell by whom; its bot left the channel. Add it again.`
				: add.reason === "configuration_removed"
					? `@${add.agentId} was taken out of ~${add.channelName} by the configuration; its bot left the channel.`
					: add.reason === "listener_not_added"
						? `@${add.agentId} was added to ~${add.channelName}, but the Gateway could not add its listener there, so its bot left again. Check that channel members may add members, or add the listener by hand before the agent.`
						: add.reason === "not_owner_or_admin"
							? `@${add.agentId} was added to ~${add.channelName} by someone who is neither an owner nor a system admin; its bot left the channel.`
							: `@${add.agentId} was in ~${add.channelName}, but no add by an owner or system admin was found; its bot left the channel.`;
		const occurrence = add.evidencePostId ?? uow.now.toISOString().slice(0, 10);
		await raiseAlert(
			uow,
			`channel-add:${add.agentId}:${add.channelId}:${add.reason}:${occurrence}`,
			message,
			detail,
		);
	});
}

/**
 * Channels among those given that nothing needs any more (not configured, not granted); their
 * catch-up is deleted, so the listener may leave them.
 */
export async function unneededChannels(
	deps: ControlPlaneDeps,
	channelIds: Readonly<MattermostId[]>,
): Promise<MattermostId[]> {
	return inTransaction(deps, async (uow) => {
		const result: MattermostId[] = [];
		for (const channelId of channelIds) {
			if (!(await channelStillFollowed(uow, channelId))) {
				result.push(channelId);
			}
		}
		return result;
	});
}

/**
 * `agentId`'s channels right now: configured (`allowed_channels`, resolved by name) plus every
 * channel it currently holds an active ADR-022 grant for — read fresh, not from any snapshot
 * taken earlier in the same pass. The lifecycle provisioner's own `reprovision` leaving-channels
 * step calls this immediately before each removal, rather than once at the start of its pass, so
 * a grant made mid-pass is still honored (ADR-026).
 */
export async function loadAgentAllowedChannelIds(
	deps: ControlPlaneDeps,
	agentId: AgentId,
): Promise<ReadonlySet<MattermostId>> {
	return inTransaction(deps, async ({ tx }) => {
		const [row] = await tx.db
			.select({ config: agents.config })
			.from(agents)
			.where(eq(agents.id, agentId));
		if (row === undefined) {
			return new Set();
		}
		const access = await loadChannelAccess(tx.db);
		return agentChannelIds({ id: agentId, config: row.config }, access);
	});
}

/** Where one of an agent's channels comes from: named in its own `allowed_channels`, or given by
 * an ADR-022 grant. A third provenance, `member-unauthorized` — the bot is a member Mattermost
 * reports with neither — is live-only and not part of this (database-only) read model; `gateway
 * agents channels <id>` adds it itself from what the server actually reports. */
export type ChannelProvenance = "configured" | "granted";

export type AgentChannelAssignment = Readonly<{
	channelId: MattermostId;
	channelName: string;
	provenance: ChannelProvenance;
	/** Set only for `granted`: who gave it, when, and the post it was decided from. */
	grantedByUserId: MattermostId | null;
	grantedAt: string | null;
	evidencePostId: string | null;
}>;

/**
 * An agent's channels with provenance (the assignments read model, ADR-026): every configured
 * channel first, then every channel it holds an active grant for that is not also configured (a
 * configured channel is refused as a grant target at grant time, so the two should never overlap
 * in practice; this still never double-lists one). `gateway agents channels <id>` is its own CLI
 * surface; a console page reads it later.
 */
export async function loadAgentChannelAssignments(
	deps: ControlPlaneDeps,
	agentId: AgentId,
): Promise<Readonly<AgentChannelAssignment[]>> {
	return inTransaction(deps, async ({ tx }) => {
		const { db } = tx;
		const [row] = await db
			.select({ config: agents.config })
			.from(agents)
			.where(eq(agents.id, agentId));
		const named = await loadTeamChannels(db);
		const configured: AgentChannelAssignment[] = (
			row?.config.mattermost.allowed_channels ?? []
		).flatMap((name) => {
			const channelId = named.get(name);
			return channelId === undefined
				? []
				: [
						{
							channelId,
							channelName: name,
							provenance: "configured" as const,
							grantedByUserId: null,
							grantedAt: null,
							evidencePostId: null,
						},
					];
		});
		const configuredIds = new Set(configured.map((assignment) => assignment.channelId));
		const grants = await db
			.select({
				channelId: mattermostChannelGrants.channelId,
				channelName: mattermostChannelGrants.channelName,
				grantorUserId: mattermostChannelGrants.grantorUserId,
				grantedAt: mattermostChannelGrants.grantedAt,
				evidencePostId: mattermostChannelGrants.evidencePostId,
			})
			.from(mattermostChannelGrants)
			.where(
				and(
					eq(mattermostChannelGrants.agentId, agentId),
					eq(mattermostChannelGrants.state, "active"),
				),
			);
		const granted: AgentChannelAssignment[] = grants
			.filter((grant) => !configuredIds.has(grant.channelId))
			.map((grant) => ({
				channelId: grant.channelId,
				channelName: grant.channelName,
				provenance: "granted" as const,
				grantedByUserId: grant.grantorUserId,
				grantedAt: grant.grantedAt.toISOString(),
				evidencePostId: grant.evidencePostId,
			}));
		return [...configured, ...granted];
	});
}
