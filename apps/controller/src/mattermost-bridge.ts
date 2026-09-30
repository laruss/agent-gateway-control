import {
	ApprovalCardPendingError,
	advanceNumericCursor,
	afterChannelStart,
	type ControlPlaneDeps,
	channelAdmits,
	channelCursorIds,
	deleteUnmanagedChannelCursors,
	grantChannel,
	handleApprovalReply,
	ingestEvent,
	ingestEventIf,
	loadConfigGeneration,
	loadDirectoryEntry,
	loadMattermostSnapshot,
	loadMembershipState,
	outboxReceiptPostId,
	postCreationExists,
	readChannelFloor,
	readNumericCursor,
	recordImpersonation,
	rejectChannelAdd,
	revokeChannelGrant,
	startManagedChannel,
	threadCorrelation,
	unneededChannels,
	whileAgentMayPost,
	whileListenerMayPost,
} from "@agent-gateway/core";
import type { Logger } from "@agent-gateway/logging";
import {
	AwaitingReceiptError,
	type BotCredentials,
	type BridgeDirectory,
	type ListenerStore,
	type MattermostDeliverers,
	type MembershipStore,
	mattermostDeliverers,
	type RunningListener,
	type RunningMembershipSync,
	startListener,
	startMembershipSync,
} from "@agent-gateway/mattermost";
import { readSecretFile, resolveSecretPath, secretFileState } from "@agent-gateway/service";

export type MattermostBridgeOptions = Readonly<{
	baseUrl: string;
	/** HMAC key for the routing metadata of agent posts; never leaves the controller. */
	routingKey: string;
	/** Local directory standing in for `/run/secrets/` (development and tests). */
	secretsDir?: string;
	/** Listener timing overrides, for tests. */
	syncIntervalMs?: number;
	pingIntervalMs?: number;
	reconnectMinMs?: number;
	/** How often agent bots' channel memberships are checked, for tests. */
	membershipIntervalMs?: number;
	membershipGraceMs?: number;
}>;

/** The event source of a Mattermost team: stable across URL changes, unique per team. */
export function mattermostSource(team: string): string {
	return `mattermost://${team}`;
}

async function bridgeDirectory(deps: ControlPlaneDeps): Promise<BridgeDirectory | null> {
	const snapshot = await loadMattermostSnapshot(deps);
	if (snapshot === null) {
		return null;
	}
	const approvals = snapshot.organization.mattermost.approvals_channel;
	const approvalsChannelId =
		[...snapshot.channels].find(([, name]) => name === approvals)?.[0] ?? null;
	return {
		source: mattermostSource(snapshot.organization.mattermost.team),
		channels: snapshot.channels,
		approvalsChannelId,
		agents: snapshot.agents,
	};
}

/** The listener bot's account as bootstrap recorded it, or null. */
async function listenerUserId(deps: ControlPlaneDeps) {
	const snapshot = await loadMattermostSnapshot(deps);
	if (snapshot === null) {
		return null;
	}
	return loadDirectoryEntry(deps, "user", snapshot.organization.mattermost.listener.username);
}

export function listenerStore(deps: ControlPlaneDeps): ListenerStore {
	return {
		directory: () => bridgeDirectory(deps),
		listenerUserId: () => listenerUserId(deps),
		ingest: async (event, admission) => {
			if (admission === null) {
				return (await ingestEvent(deps, event)).status;
			}
			const result = await ingestEventIf(
				deps,
				event,
				afterChannelStart(admission.channelId, admission.postId, admission.createAt),
			);
			return result === null ? "not_admitted" : result.status;
		},
		hasPostCreation: (source, subject) => postCreationExists(deps, source, subject),
		threadCorrelation: (source, subject) => threadCorrelation(deps, source, subject),
		cursor: (channelId) => readNumericCursor(deps, channelCursorIds(channelId).cursor),
		floor: (channelId) => readChannelFloor(deps, channelId),
		startChannel: (channelId, start, generation) =>
			startManagedChannel(deps, channelId, start, generation),
		configGeneration: () => loadConfigGeneration(deps),
		admits: (admission) =>
			channelAdmits(deps, admission.channelId, admission.postId, admission.createAt),
		saveCursor: (channelId, updateAt) =>
			advanceNumericCursor(deps, channelCursorIds(channelId).cursor, updateAt),
		forgetUnmanagedChannels: () => deleteUnmanagedChannelCursors(deps),
		deliveredPost: (key) => outboxReceiptPostId(deps, key),
		reject: (post) => recordImpersonation(deps, post),
		approvalReply: async (reply) => {
			try {
				return await handleApprovalReply(deps, reply);
			} catch (error) {
				if (error instanceof ApprovalCardPendingError) {
					throw new AwaitingReceiptError(reply.postId);
				}
				throw error;
			}
		},
	};
}

/** Bot tokens come from secret files, read at use so a rotated token applies at once. */
export function botCredentials(deps: ControlPlaneDeps, secretsDir?: string): BotCredentials {
	return {
		withAgentBot: async (agentId, channelId, post) => {
			const outcome = await whileAgentMayPost(
				deps,
				agentId,
				channelId,
				async (userId, tokenSecretRef) => {
					const path = resolveSecretPath(tokenSecretRef, secretsDir);
					if (userId === null || secretFileState(path) !== "private") {
						return { resolved: false } as const;
					}
					return {
						resolved: true,
						value: await post({ userId, token: readSecretFile(path) }),
					} as const;
				},
			);
			if (!outcome.allowed) {
				return { kind: "unauthorized" };
			}
			return outcome.value.resolved
				? { kind: "posted", value: outcome.value.value }
				: { kind: "unresolved" };
		},
		withListenerChannel: async (purpose, post) => {
			const outcome = await whileListenerMayPost(
				deps,
				purpose,
				async (userId, tokenSecretRef, channelId) => {
					const path = resolveSecretPath(tokenSecretRef, secretsDir);
					if (userId === null || channelId === null || secretFileState(path) !== "private") {
						return { resolved: false } as const;
					}
					return {
						resolved: true,
						value: await post({ userId, token: readSecretFile(path) }, channelId),
					} as const;
				},
			);
			return outcome?.resolved === true
				? { kind: "posted", value: outcome.value }
				: { kind: "unresolved" };
		},
		listenerBot: async () => {
			const snapshot = await loadMattermostSnapshot(deps);
			const userId = await listenerUserId(deps);
			if (snapshot === null || userId === null) {
				return null;
			}
			const ref = snapshot.organization.mattermost.listener.token_secret_file;
			return { userId, token: readSecretFile(resolveSecretPath(ref, secretsDir)) };
		},
	};
}

export function bridgeDeliverers(
	deps: ControlPlaneDeps,
	options: MattermostBridgeOptions,
): MattermostDeliverers {
	return mattermostDeliverers({
		baseUrl: options.baseUrl,
		routingKey: options.routingKey,
		credentials: botCredentials(deps, options.secretsDir),
	});
}

export function startBridgeListener(
	deps: ControlPlaneDeps,
	options: MattermostBridgeOptions,
	log: Logger,
): RunningListener {
	const credentials = botCredentials(deps, options.secretsDir);
	return startListener({
		baseUrl: options.baseUrl,
		token: async () => {
			const bot = await credentials.listenerBot();
			if (bot === null) {
				throw new Error("the listener bot is not bootstrapped yet");
			}
			return bot.token;
		},
		routingKey: options.routingKey,
		store: listenerStore(deps),
		log: log.child({ component: "mattermost-listener" }),
		clock: deps.clock,
		random: deps.random,
		...(options.syncIntervalMs === undefined ? {} : { syncIntervalMs: options.syncIntervalMs }),
		...(options.pingIntervalMs === undefined ? {} : { pingIntervalMs: options.pingIntervalMs }),
		...(options.reconnectMinMs === undefined ? {} : { reconnectMinMs: options.reconnectMinMs }),
	});
}

/** The records behind the membership synchronizer, and the bots' tokens from their secret files. */
export function membershipStore(deps: ControlPlaneDeps, secretsDir?: string): MembershipStore {
	return {
		state: () => loadMembershipState(deps),
		grant: (grant) => grantChannel(deps, grant),
		revoke: (agentId, channelId, reason) => revokeChannelGrant(deps, agentId, channelId, reason),
		reject: (rejection) => rejectChannelAdd(deps, rejection),
		unneeded: (channelIds) => unneededChannels(deps, channelIds),
		token: (secretRef) => {
			const path = resolveSecretPath(secretRef, secretsDir);
			return secretFileState(path) === "private" ? readSecretFile(path) : null;
		},
	};
}

export function startBridgeMembershipSync(
	deps: ControlPlaneDeps,
	options: MattermostBridgeOptions,
	log: Logger,
): RunningMembershipSync {
	return startMembershipSync({
		baseUrl: options.baseUrl,
		store: membershipStore(deps, options.secretsDir),
		log: log.child({ component: "mattermost-membership" }),
		clock: deps.clock,
		...(options.membershipIntervalMs === undefined
			? {}
			: { intervalMs: options.membershipIntervalMs }),
		...(options.membershipGraceMs === undefined
			? {}
			: { evidenceGraceMs: options.membershipGraceMs }),
	});
}
