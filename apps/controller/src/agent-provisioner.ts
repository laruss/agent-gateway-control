import type {
	AgentId,
	AgentLifecycleCheckpoints,
	AgentLifecycleOperationKind,
	MattermostId,
} from "@agent-gateway/contracts";
import { BOT_SECRET_FILE_PREFIX } from "@agent-gateway/contracts";
import {
	type ControlPlaneDeps,
	checkpointOperation,
	completeOperation,
	failOperation,
	listLifecycleOperations,
	listPendingLifecycleOperations,
	listRunningLifecycleOperations,
	loadAgentAllowedChannelIds,
	loadAgentConfig,
	loadDirectoryEntry,
	loadMattermostIdentity,
	loadMattermostSnapshot,
	markProvisioning,
	PROVISIONING_ADMIN_DIRECTORY_NAME,
	StaleLifecycleOperationError,
	setAgentBotUser,
	setDirectoryEntry,
} from "@agent-gateway/core";
import { errorFields, type Logger } from "@agent-gateway/logging";
import {
	type AdminMattermostClient,
	BootstrapError,
	ensureBot,
	findPlausibleGatewayBot,
	isExtraChannel,
	MattermostApiError,
	MattermostClient,
	revokeAllTokens,
	TOKEN_DESCRIPTION,
	tokenOwner,
} from "@agent-gateway/mattermost";
import {
	deleteSecretFile,
	readOptionalFileSetting,
	readSecretFile,
	resolveSecretPath,
	secretFileState,
	writeSecretFile,
} from "@agent-gateway/service";

/** Lifecycle operation kinds the main provisioning loop pursues: never `adopt` (written only
 * `succeeded`, by the startup backfill, never left `pending`/`running`). `retire` is handled by
 * its own loop (`RETIRE_KINDS`, `processRetireOperation`): its steps (revoking tokens, disabling
 * the bot, leaving channels) are different enough from `create`/`restore`/`reprovision`'s own
 * (resolving a bot, joining it) to keep separate rather than branching `processOperation` itself. */
const PROVISIONING_KINDS: ReadonlyArray<AgentLifecycleOperationKind> = [
	"create",
	"restore",
	"reprovision",
];

const RETIRE_KINDS: ReadonlyArray<AgentLifecycleOperationKind> = ["retire"];

export type AgentProvisionerOptions = Readonly<{
	baseUrl: string;
	/** Local directory standing in for `/run/secrets/` and `/run/bot-secrets/` (development and
	 * tests): both mounts resolve into it the same way (`resolveSecretPath`). */
	secretsDir?: string;
	/** How often the provisioner looks for new or resumed work; lower in tests. */
	pollIntervalMs?: number;
	/** `audit_log`/operation `requested_by` actor for what the provisioner itself does. */
	actor?: string;
}>;

export type RunningAgentProvisioner = Readonly<{ stop: () => Promise<void> }>;

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_ACTOR = "system";

/** A step's own failure that a retry can never fix: the operation is marked `failed` (never
 * retried by this loop again); anything else (a `MattermostApiError` whose `retryable` is true, or
 * an unexpected error) is left for the next tick. */
class PermanentProvisioningError extends Error {}

type LifecycleOperation = Awaited<ReturnType<typeof listRunningLifecycleOperations>>[number];

/**
 * Starts the Mattermost lifecycle provisioner: a loop, like the controller's other periodic work
 * (`controller.ts`'s own `reconcile`/`retain`), that resumes `running` operations from their
 * checkpoints and starts new `pending` ones (`create`/`restore`/`reprovision`), one external
 * Mattermost step at a time — persisting a checkpoint right after each step, and never holding a
 * database transaction across a Mattermost call (ADR-026). Idle, every tick a no-op, whenever no
 * admin token is configured (`MATTERMOST_ADMIN_TOKEN`/`MATTERMOST_ADMIN_TOKEN_FILE`): operations
 * stay `pending`, surfaced by `gateway doctor`.
 */
export function startAgentProvisioner(
	deps: ControlPlaneDeps,
	options: AgentProvisionerOptions,
	log: Logger,
): RunningAgentProvisioner {
	const actor = options.actor ?? DEFAULT_ACTOR;
	let stopped = false;
	let ticking: Promise<void> | null = null;
	const tick = (): Promise<void> => {
		ticking ??= runTick(deps, options, actor, log, () => stopped)
			.catch((error) => {
				log.error("agent provisioner tick failed", errorFields(error));
			})
			.finally(() => {
				ticking = null;
			});
		return ticking;
	};
	void tick();
	const timer = setInterval(() => void tick(), options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
	return {
		stop: async () => {
			stopped = true;
			clearInterval(timer);
			await ticking;
		},
	};
}

async function runTick(
	deps: ControlPlaneDeps,
	options: AgentProvisionerOptions,
	actor: string,
	log: Logger,
	stopped: () => boolean,
): Promise<void> {
	const adminToken = readOptionalFileSetting("MATTERMOST_ADMIN_TOKEN");
	if (adminToken === undefined) {
		return;
	}
	const admin = new MattermostClient({ baseUrl: options.baseUrl, token: adminToken });
	await runProvisionerPass(deps, admin, options, actor, log, stopped);
}

/**
 * One pass over every operation this provisioner pursues, given an already-authenticated admin
 * client: validates the account, records it for routing exclusion, then drives each operation's
 * steps. Exported, and `admin`/`resolveTokenOwner` are parameters rather than built inside, so
 * tests can run this directly against a fake Mattermost client — `startAgentProvisioner`'s own
 * loop (`runTick`) is the only production caller, and it is the one that resolves the real admin
 * token and constructs the real client.
 */
export async function runProvisionerPass(
	deps: ControlPlaneDeps,
	admin: AdminMattermostClient,
	options: AgentProvisionerOptions,
	actor: string,
	log: Logger,
	stopped: () => boolean = () => false,
	resolveTokenOwner: typeof tokenOwner = tokenOwner,
): Promise<void> {
	let me: Awaited<ReturnType<AdminMattermostClient["me"]>>;
	try {
		me = await admin.me();
	} catch (error) {
		log.error("agent provisioner: the Mattermost admin token was rejected", errorFields(error));
		return;
	}
	if (me.is_bot || !me.roles.split(/\s+/).includes("system_admin")) {
		log.error(
			"agent provisioner: the Mattermost admin account is not a non-bot system_admin; " +
				"'gateway mattermost admin-token set' refuses this, so the account changed since",
		);
		return;
	}
	// Excludes this account from routing (never a wake-up, never an approval): resolved every
	// tick, not only at startup, so a rotated or replaced admin account is picked up without a
	// restart. Written (and audited, `directory.set`) only when it actually changed — `me.id` is
	// otherwise the same account this already recorded every previous tick, and `setDirectoryEntry`
	// itself writes and audits unconditionally, so skipping the call here is what keeps a years-old
	// deployment's audit log from gaining one row every 3 seconds for nothing.
	const recordedAdminId = await loadDirectoryEntry(deps, "user", PROVISIONING_ADMIN_DIRECTORY_NAME);
	if (recordedAdminId !== me.id) {
		await setDirectoryEntry(deps, "user", PROVISIONING_ADMIN_DIRECTORY_NAME, me.id, actor);
	}

	const running = (await listRunningLifecycleOperations(deps)).filter((operation) =>
		PROVISIONING_KINDS.includes(operation.kind),
	);
	const pending = await listPendingLifecycleOperations(deps, PROVISIONING_KINDS);
	for (const operation of [...running, ...pending]) {
		if (stopped()) {
			return;
		}
		await processOperation(deps, admin, options, actor, operation, log, resolveTokenOwner, me.id);
	}

	const retiring = (await listRunningLifecycleOperations(deps)).filter((operation) =>
		RETIRE_KINDS.includes(operation.kind),
	);
	const pendingRetires = await listPendingLifecycleOperations(deps, RETIRE_KINDS);
	for (const operation of [...retiring, ...pendingRetires]) {
		if (stopped()) {
			return;
		}
		await processRetireOperation(deps, admin, options, actor, operation, log, me.id);
	}
}

async function processOperation(
	deps: ControlPlaneDeps,
	admin: AdminMattermostClient,
	options: AgentProvisionerOptions,
	actor: string,
	operation: LifecycleOperation,
	log: Logger,
	resolveTokenOwner: typeof tokenOwner,
	adminUserId: MattermostId,
): Promise<void> {
	// A cheap precheck, before ever claiming the operation: is there anything to provision yet at
	// all. Re-read fresh right after claiming below — never this copy — since a config edit that
	// committed between this read and the claim must still be reflected in what gets provisioned
	// (the two are serialized by the same `agent_lifecycle` row lock, so the edit is guaranteed
	// visible by the time the claim itself succeeds; this copy alone is not).
	const precheck = await loadAgentConfig(deps, operation.agentId);
	const precheckSnapshot = await loadMattermostSnapshot(deps);
	if (precheck === null || precheckSnapshot === null) {
		// The agent, or the whole active configuration, is not there to provision right now (a
		// retire committed concurrently, say): left for the next tick, or for whatever superseded
		// this operation to settle it.
		return;
	}
	if (
		(await loadDirectoryEntry(deps, "team", precheckSnapshot.organization.mattermost.team)) === null
	) {
		log.info("agent provisioner: Mattermost team not resolved yet; waiting", {
			agent_id: operation.agentId,
		});
		return;
	}

	if (operation.state === "pending") {
		try {
			await markProvisioning(deps, operation.id, actor);
		} catch (error) {
			if (error instanceof StaleLifecycleOperationError) {
				return;
			}
			throw error;
		}
	}

	// Reloaded after claiming (or confirming) the operation: a config edit that committed before
	// the claim must be what this pass actually provisions, never a snapshot read before it.
	const agentConfig = await loadAgentConfig(deps, operation.agentId);
	const snapshot = await loadMattermostSnapshot(deps);
	if (agentConfig === null || snapshot === null) {
		log.warn("agent provisioner: agent or configuration vanished after claiming the operation", {
			agent_id: operation.agentId,
		});
		return;
	}
	const teamId = await loadDirectoryEntry(deps, "team", snapshot.organization.mattermost.team);
	if (teamId === null) {
		log.info("agent provisioner: Mattermost team not resolved yet; waiting", {
			agent_id: operation.agentId,
		});
		return;
	}

	let checkpoints = operation.checkpoints;
	// A `team_joined`/`channels_joined` checkpoint recorded for a Mattermost team this operation
	// already left behind (the organization's own team changed since, `commitChangeIn`'s own
	// `organizationTeamChanged` check having queued a fresh `reprovision` for every other
	// lifecycle-owned agent, but this one's own `create`/`restore`/`reprovision` was already
	// running) is stale: both are scoped to the team they were recorded against, so this operation
	// must rejoin the now-current team and its channels rather than skip steps already marked done
	// for one the agent is no longer meant to be in. The old team's own channels (and the team
	// itself) are left further down, once the bot has rejoined the current one.
	const staleTeam =
		checkpoints.team !== undefined && checkpoints.team !== snapshot.organization.mattermost.team
			? checkpoints.team
			: null;
	if (staleTeam !== null) {
		checkpoints = { ...checkpoints, team_joined: false, channels_joined: [] };
	}
	try {
		// Read once, before `ensureBot`, not only afterwards: this agent's own recorded identity (if
		// any) is exactly what lets `ensureBot` tell its own, previously-resolved bot apart from an
		// unrelated account that merely happens to share its username (`guard.knownUserId` below).
		const identity = await loadMattermostIdentity(deps, operation.agentId);
		let botUserId = checkpoints.bot_user_id;
		if (botUserId === undefined) {
			try {
				botUserId = await ensureBot(
					admin,
					{ username: agentConfig.mattermost.username, displayName: agentConfig.display_name },
					{ knownUserId: identity?.userId ?? null, adminUserId },
				);
			} catch (error) {
				if (error instanceof BootstrapError) {
					// `ensureBot` already refuses a username that is not plausibly the Gateway's own
					// plain bot (a regular user, a bot with elevated roles, or — for a fresh `create`,
					// `restore` or `reprovision` with no recorded identity yet of its own — a plain bot
					// this Gateway's own admin account did not create either) — never adopting a
					// stranger's account.
					throw new PermanentProvisioningError(
						`username '${agentConfig.mattermost.username}' is taken: ${error.message}`,
					);
				}
				throw error;
			}
			checkpoints = await checkpoint(deps, operation.id, checkpoints, { bot_user_id: botUserId });
		}
		// Bootstrap's own counterpart: the resolved account, recorded in `mattermost_identities`.
		// Checked and replayed idempotently every pass — not only right after `botUserId` is first
		// resolved above — so a crash between persisting the `bot_user_id` checkpoint and this write
		// completing can never leave the operation to finish with no identity ever recorded (a null
		// `mattermost_user_id` forever): the next pass sees the checkpoint, skips `ensureBot` again,
		// but still finds the identity unset and writes it.
		if (identity?.userId !== botUserId) {
			await setAgentBotUser(deps, operation.agentId, botUserId, actor);
		}

		if (checkpoints.token_ref === undefined) {
			const resolvedPath = resolveSecretPath(
				agentConfig.mattermost.token_secret_file,
				options.secretsDir,
			);
			await ensureBotToken(admin, options.baseUrl, botUserId, resolvedPath, resolveTokenOwner);
			checkpoints = await checkpoint(deps, operation.id, checkpoints, {
				token_ref: agentConfig.mattermost.token_secret_file,
			});
		}

		if (checkpoints.team_joined !== true) {
			await admin.addTeamMember(teamId, botUserId);
			checkpoints = await checkpoint(deps, operation.id, checkpoints, {
				team_joined: true,
				team: snapshot.organization.mattermost.team,
			});
		}

		const channelIdsByName = new Map(
			[...snapshot.channels].map(([channelId, name]) => [name, channelId]),
		);
		const joined = new Set(checkpoints.channels_joined ?? []);
		for (const name of agentConfig.mattermost.allowed_channels) {
			if (joined.has(name)) {
				continue;
			}
			const channelId = channelIdsByName.get(name);
			if (channelId === undefined) {
				log.info("agent provisioner: channel not resolved yet; waiting", {
					agent_id: operation.agentId,
					channel: name,
				});
				return;
			}
			await admin.addChannelMember(channelId, botUserId);
			joined.add(name);
			checkpoints = await checkpoint(deps, operation.id, checkpoints, {
				channels_joined: [...joined],
			});
		}

		// The old team is left once the bot has rejoined the current one above: every channel of it
		// the bot is still a member of, except one an owner or admin granted its bot directly (ADR-022,
		// checked fresh, never from a snapshot taken earlier in this pass — same rule as the
		// `reprovision` leaving-step just below), then the team itself — the same "one team only, as
		// a plain member" invariant `bootstrapMattermost` already keeps. Resolved by the old team's own
		// recorded name (`staleTeam`), never a live `userTeams` listing: a crash here leaves the bot in
		// both teams until the next pass, which recomputes `staleTeam` from the checkpoints the same
		// way and simply finishes the job.
		if (staleTeam !== null) {
			const oldTeamId = await loadDirectoryEntry(deps, "team", staleTeam);
			if (oldTeamId !== null) {
				for (const channel of await admin.userChannelsInTeam(botUserId, oldTeamId)) {
					const allowed = await loadAgentAllowedChannelIds(deps, operation.agentId);
					if (isExtraChannel(channel, allowed)) {
						await admin.removeChannelMember(channel.id, botUserId);
					}
				}
				await admin.removeTeamMember(oldTeamId, botUserId);
			}
		}

		// A `reprovision` operation's own membership step (ADR-026): channels the committed change
		// took away are left, except ones an owner or admin granted this agent's bot directly (an
		// ADR-022 grant). Checked fresh immediately before each removal — never once from `snapshot`
		// at the top of this pass — since this loop calls Mattermost once per channel and may take a
		// while; a grant made mid-pass (even after the operation started) must still be honored, so
		// the one read that decides a removal is never older than the removal itself.
		// `create`/`restore` never reach this with anything to leave: their bot has only ever joined
		// what the loop above just joined it to.
		if (operation.kind === "reprovision") {
			for (const channel of await admin.userChannelsInTeam(botUserId, teamId)) {
				const allowed = await loadAgentAllowedChannelIds(deps, operation.agentId);
				if (isExtraChannel(channel, allowed)) {
					await admin.removeChannelMember(channel.id, botUserId);
				}
			}
		}

		// A `create`/`restore` operation's own channel list (`agentConfig` above) was read once,
		// right after this operation was claimed; an edit to `allowed_channels` committed anywhere
		// between that read and here never queues its own `reprovision` (`queueMembershipReprovisioning`
		// only reprovisions a `ready` agent, never one still `reconciling`), so this is the only
		// chance to join a channel such an edit added before the operation completes and the agent
		// goes `ready` with a stale membership nothing will ever revisit. Reloaded fresh immediately
		// before completing, narrowing the race to the gap between this read and `completeOperation`
		// itself; an unresolved channel id is left for the next tick, exactly like the main loop
		// above, rather than completing with it silently unjoined.
		if (operation.kind === "create" || operation.kind === "restore") {
			const freshConfig = await loadAgentConfig(deps, operation.agentId);
			for (const name of freshConfig?.mattermost.allowed_channels ?? []) {
				if (joined.has(name)) {
					continue;
				}
				const channelId = channelIdsByName.get(name);
				if (channelId === undefined) {
					log.info("agent provisioner: channel not resolved yet; waiting", {
						agent_id: operation.agentId,
						channel: name,
					});
					return;
				}
				await admin.addChannelMember(channelId, botUserId);
				joined.add(name);
				checkpoints = await checkpoint(deps, operation.id, checkpoints, {
					channels_joined: [...joined],
				});
			}
		}

		await completeOperation(deps, operation.id, actor, checkpoints);
		log.info("agent provisioner: agent ready", { agent_id: operation.agentId });
	} catch (error) {
		await settleFailure(deps, operation, actor, error, log);
	}
}

/** Merges `patch` into `current` locally (for the rest of this tick) and persists it right away,
 * outside any transaction spanning the Mattermost call that just finished. */
async function checkpoint(
	deps: ControlPlaneDeps,
	operationId: string,
	current: AgentLifecycleCheckpoints,
	patch: AgentLifecycleCheckpoints,
): Promise<AgentLifecycleCheckpoints> {
	await checkpointOperation(deps, operationId, patch);
	return { ...current, ...patch };
}

/**
 * A bot's token file ends this holding a token that works for `userId`: kept as is when it
 * already does (including one written by an earlier attempt whose own checkpoint was never
 * reached — the crash this guards), replaced otherwise. Revokes every token the account has
 * before issuing a new one, like `bootstrapMattermost`'s own replacement does.
 */
async function ensureBotToken(
	admin: AdminMattermostClient,
	baseUrl: string,
	userId: string,
	resolvedPath: string,
	resolveTokenOwner: typeof tokenOwner,
): Promise<void> {
	const state = secretFileState(resolvedPath);
	if (state === "symlink") {
		throw new PermanentProvisioningError(
			`token file '${resolvedPath}' is a symlink; replace it with a file`,
		);
	}
	const stored = state === "private" ? readSecretFile(resolvedPath) : null;
	const works = stored !== null && (await resolveTokenOwner(baseUrl, stored)) === userId;
	if (works) {
		return;
	}
	await revokeAllTokens(admin, userId);
	const created = await admin.createUserAccessToken(userId, TOKEN_DESCRIPTION);
	writeSecretFile(resolvedPath, created.token);
}

/** What {@link recoverRetiringBotUserId} found. */
type RecoveredRetiringBot =
	| Readonly<{ kind: "found"; userId: MattermostId }>
	| Readonly<{ kind: "not_found" }>
	/** A plain bot exists at the agent's own configured username, but it is not plausibly this
	 * Gateway's own (`findPlausibleGatewayBot`'s own ownership guard): retirement must not adopt a
	 * stranger's account merely because nothing else claims the name, so its Mattermost-side
	 * cleanup is skipped instead of revoking that unrelated bot's tokens and disabling it. */
	| Readonly<{ kind: "skipped"; reason: string }>;

/**
 * Recovers a retiring agent's bot id when `mattermost_identities` never recorded one: a
 * create/restore operation can checkpoint `bot_user_id` and then be superseded by this very retire
 * (`cancelNonterminalOperations`, `agent-lifecycle.ts`) — or simply crash — before `setAgentBotUser`
 * ever wrote it, leaving a bot, and a working token, that nothing here would otherwise ever find:
 * retirement would wrongly conclude there is no Mattermost cleanup needed and leave both in place.
 * Checked first against every operation this agent ever had (newest first): a superseded
 * operation's checkpoints survive being cancelled, so the `create`/`restore` this retire just
 * superseded, or an earlier one, still names the account if it ever got that far — always `found`
 * this way, never subject to the ownership guard below, since this agent's own operation journal is
 * exactly what makes the account its own. Only as a last resort is the account looked up by
 * `username` (the agent's own last known configuration), and only when it is plausibly the
 * Gateway's own plain bot (`findPlausibleGatewayBot`'s own `owner_id` check against `adminUserId`):
 * a username-only match is never enough by itself — an agent whose own `create` genuinely failed on
 * "username taken" must not have this retire revoke an unrelated bot's tokens and disable it.
 */
async function recoverRetiringBotUserId(
	deps: ControlPlaneDeps,
	admin: AdminMattermostClient,
	agentId: AgentId,
	username: string | undefined,
	adminUserId: MattermostId,
): Promise<RecoveredRetiringBot> {
	const operations = await listLifecycleOperations(deps, agentId);
	for (const op of operations) {
		if (
			(op.kind === "create" || op.kind === "restore") &&
			op.checkpoints.bot_user_id !== undefined
		) {
			return { kind: "found", userId: op.checkpoints.bot_user_id };
		}
	}
	if (username === undefined) {
		return { kind: "not_found" };
	}
	const found = await findPlausibleGatewayBot(admin, username, adminUserId);
	if (found !== null) {
		return { kind: "found", userId: found };
	}
	// Looked up again, only to tell the two apart in the log line below: `findPlausibleGatewayBot`
	// already returned null whether nothing is there at all or something is but is not plausibly
	// ours, and only the latter is worth an operator's attention.
	const existing = await admin.userByUsername(username);
	return existing === null
		? { kind: "not_found" }
		: {
				kind: "skipped",
				reason: `a plain bot named '${username}' exists but is not plausibly this Gateway's own`,
			};
}

/**
 * Drives a `retire` operation's own Mattermost-side cleanup (ADR-026): every access token
 * revoked, the bot account deactivated, every channel it is currently a member of left, and —
 * only for a lifecycle-created agent's own `/run/bot-secrets/` file — that token file removed.
 * Deactivation and token revocation happen first, like `bootstrapMattermost`'s own retirement of
 * a replaced bot: once both are done the account has no access left at all, so a crash partway
 * through the remaining, merely cosmetic channel removals can never leave a bot with access
 * nobody meant it to keep. An agent whose identity was never resolved, and whose bot id cannot be
 * recovered either (`recoverRetiringBotUserId`) — retired while still genuinely `pending`, nothing
 * ever provisioned — has nothing Mattermost-side to clean up at all.
 */
async function processRetireOperation(
	deps: ControlPlaneDeps,
	admin: AdminMattermostClient,
	options: AgentProvisionerOptions,
	actor: string,
	operation: LifecycleOperation,
	log: Logger,
	adminUserId: MattermostId,
): Promise<void> {
	if (operation.state === "pending") {
		try {
			await markProvisioning(deps, operation.id, actor);
		} catch (error) {
			if (error instanceof StaleLifecycleOperationError) {
				return;
			}
			throw error;
		}
	}

	let checkpoints = operation.checkpoints;
	try {
		const identity = await loadMattermostIdentity(deps, operation.agentId);
		let botUserId = identity?.userId ?? null;
		if (botUserId === null) {
			const agentConfig = await loadAgentConfig(deps, operation.agentId);
			const recovered = await recoverRetiringBotUserId(
				deps,
				admin,
				operation.agentId,
				agentConfig?.mattermost.username,
				adminUserId,
			);
			if (recovered.kind === "found") {
				botUserId = recovered.userId;
				// Recorded now, the same write a crash between the `bot_user_id` checkpoint and this
				// would otherwise have skipped entirely: never left silently blank once recovered.
				await setAgentBotUser(deps, operation.agentId, botUserId, actor);
			} else if (recovered.kind === "skipped") {
				// A plain bot sharing this agent's own configured username exists, but nothing (not
				// this agent's own operation journal, not its `owner_id`) says it is actually the
				// Gateway's: never adopted, so there is nothing of this agent's own left to clean up
				// Mattermost-side — recorded here, not silently folded into the "nothing was ever
				// provisioned" case below, so an operator can tell the two apart.
				await completeOperation(deps, operation.id, actor, checkpoints);
				log.info("agent provisioner: agent retired; its Mattermost-side cleanup was skipped", {
					agent_id: operation.agentId,
					reason: recovered.reason,
				});
				return;
			}
		}
		if (botUserId === null) {
			await completeOperation(deps, operation.id, actor, checkpoints);
			log.info("agent provisioner: agent retired (no Mattermost identity had been provisioned)", {
				agent_id: operation.agentId,
			});
			return;
		}

		if (checkpoints.tokens_revoked !== true) {
			await revokeAllTokens(admin, botUserId);
			checkpoints = await checkpoint(deps, operation.id, checkpoints, { tokens_revoked: true });
		}

		if (checkpoints.bot_disabled !== true) {
			const account = await admin.user(botUserId);
			if (account.delete_at === 0) {
				await admin.disableBot(botUserId);
			}
			checkpoints = await checkpoint(deps, operation.id, checkpoints, { bot_disabled: true });
		}

		const snapshot = await loadMattermostSnapshot(deps);
		const teamId =
			snapshot === null
				? null
				: await loadDirectoryEntry(deps, "team", snapshot.organization.mattermost.team);
		if (teamId !== null) {
			const left = new Set(checkpoints.channels_left ?? []);
			for (const channel of await admin.userChannelsInTeam(botUserId, teamId)) {
				if (left.has(channel.id)) {
					continue;
				}
				try {
					await admin.removeChannelMember(channel.id, botUserId);
				} catch (error) {
					// The team's default channel cannot be left by any member; the account is already
					// deactivated and token-less, so this is cosmetic — reported, not retried forever.
					if (!(error instanceof MattermostApiError) || error.status !== 400) {
						throw error;
					}
					log.info(
						"agent provisioner: could not remove the retired bot from a channel; continuing",
						{
							agent_id: operation.agentId,
							channel_id: channel.id,
						},
					);
				}
				left.add(channel.id);
				checkpoints = await checkpoint(deps, operation.id, checkpoints, {
					channels_left: [...left],
				});
			}
		}

		// Only a lifecycle-created agent's own token file: never `/run/secrets/`, the CLI's own
		// read-write mount for a bootstrap-managed agent (ADR-026) — that file is left exactly as
		// it is, reported stale by `gateway doctor` rather than ever touched here.
		if (checkpoints.token_file_deleted !== true) {
			const agentConfig = await loadAgentConfig(deps, operation.agentId);
			const ref = agentConfig?.mattermost.token_secret_file;
			if (ref?.startsWith(BOT_SECRET_FILE_PREFIX)) {
				deleteSecretFile(resolveSecretPath(ref, options.secretsDir));
			}
			checkpoints = await checkpoint(deps, operation.id, checkpoints, { token_file_deleted: true });
		}

		await completeOperation(deps, operation.id, actor, checkpoints);
		log.info("agent provisioner: agent retired", { agent_id: operation.agentId });
	} catch (error) {
		await settleFailure(deps, operation, actor, error, log);
	}
}

/**
 * Settles a step's failure: superseded (a later request moved the agent on) is silent, a
 * permanent error (`PermanentProvisioningError`, `BootstrapError`, or a `MattermostApiError` that
 * is not retryable — the admin token invalid or lacking permission) fails the operation with a
 * redacted message (`failOperation` itself redacts it), and anything else (a retryable
 * `MattermostApiError`, or an unexpected error) is left `running` for the next tick.
 */
async function settleFailure(
	deps: ControlPlaneDeps,
	operation: LifecycleOperation,
	actor: string,
	error: unknown,
	log: Logger,
): Promise<void> {
	if (error instanceof StaleLifecycleOperationError) {
		return;
	}
	const permanent =
		error instanceof PermanentProvisioningError ||
		error instanceof BootstrapError ||
		(error instanceof MattermostApiError && !error.retryable);
	if (!permanent) {
		log.warn("agent provisioner: transient failure; retrying later", {
			agent_id: operation.agentId,
			...errorFields(error),
		});
		return;
	}
	const message = error instanceof Error ? error.message : String(error);
	try {
		await failOperation(deps, operation.id, actor, message);
		log.error("agent provisioner: operation failed permanently", {
			agent_id: operation.agentId,
			...errorFields(error),
		});
	} catch (failError) {
		if (!(failError instanceof StaleLifecycleOperationError)) {
			throw failError;
		}
	}
}
