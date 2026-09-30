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
import { grantedChannels } from "../channel-access.ts";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
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
		await endSessions(uow, input.agentId);
		await audit(uow, "system", "mattermost.channel.granted", "agent", input.agentId, {
			channel_id: input.channelId,
			channel_name: input.channelName,
			grantor_user_id: input.grantorUserId,
			evidence_post_id: input.evidencePostId,
		});
		return true;
	});
}

/**
 * Revokes an agent's grant in a channel (its bot left or was removed). The agent's pending work
 * from there is dropped where it is checked (routing, scheduling, the turn's authority,
 * delivery). True when the channel is still followed for others, false when nothing needs it
 * any more: its catch-up is deleted and the listener may leave.
 */
export async function revokeChannelGrant(
	deps: ControlPlaneDeps,
	agentId: AgentId,
	channelId: MattermostId,
	reason: string,
): Promise<boolean> {
	return inTransaction(deps, async (uow) => {
		await lockConfigExclusive(uow);
		await lockAgent(uow.tx.db, agentId);
		const { db } = uow.tx;
		const revoked = await db
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
		if (revoked.length > 0) {
			await endSessions(uow, agentId);
			await audit(uow, "system", "mattermost.channel.revoked", "agent", agentId, {
				channel_id: channelId,
				channel_name: revoked[0]?.name ?? null,
				reason,
			});
		}
		return channelStillFollowed(uow, channelId);
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
 * Ends the agent's stored provider sessions: their transcripts hold what earlier turns saw, and
 * a changed grant (a channel taken away, or given again with a newer floor) must not resume it.
 */
async function endSessions({ tx }: UnitOfWork, agentId: AgentId): Promise<void> {
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
