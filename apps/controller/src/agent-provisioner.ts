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
	loadKnownProvisioningAdminIds,
	loadMattermostIdentity,
	loadMattermostSnapshot,
	markProvisioning,
	PROVISIONING_ADMIN_DIRECTORY_NAME,
	releaseMattermostCredentialLock,
	StaleLifecycleOperationError,
	setAgentBotUser,
	setDirectoryEntry,
	tryAcquireMattermostCredentialLock,
} from "@agent-gateway/core";
import { errorFields, type Logger } from "@agent-gateway/logging";
import {
	type AdminMattermostClient,
	BootstrapError,
	ensureBot,
	findPlausibleGatewayBot,
	isElevatedMember,
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
	await runProvisionerPass(deps, admin, options, actor, log, stopped, tokenOwner, adminToken);
}

/** Advisory lock key of one provisioner pass (ADR-026): two overlapping controllers (one still
 * draining its old pass during an upgrade, say) must never drive the same operation's steps at
 * once — one revoking the fresh token the other just issued, say — so a pass that cannot claim
 * this lock skips this tick entirely, left for whichever controller is already running one. */
const PROVISIONER_PASS_LOCK = "agent-gateway:agent-provisioner";

/**
 * One pass over every operation this provisioner pursues, given an already-authenticated admin
 * client: validates the account, records it for routing exclusion, then drives each operation's
 * steps. Exported, and `admin`/`resolveTokenOwner` are parameters rather than built inside, so
 * tests can run this directly against a fake Mattermost client — `startAgentProvisioner`'s own
 * loop (`runTick`) is the only production caller, and it is the one that resolves the real admin
 * token and constructs the real client. `adminTokenAtStart`, also only ever given by `runTick`, is
 * the exact value it read before building `admin`: `settleFailure`'s own defence in depth (ADR-026)
 * compares it against a fresh read when a step fails with 401/403, never trusted by a test that
 * omits it (no spurious "transient" reclassification just because nothing was ever provided).
 *
 * Holds a session-level advisory lock (a dedicated pooled connection, held for the whole pass,
 * the same pattern `runRetentionIfDue` already uses) around every step below: a concurrent pass —
 * another controller, or this one's own next tick outlasting its interval — skips this tick
 * rather than interleaving its own steps with one already running. It also, on the very same
 * connection, tries the shared Mattermost credential lock (ADR-026, `MATTERMOST_CREDENTIAL_LOCK`):
 * `gateway mattermost bootstrap` or `admin-token set|rotate` running right now holds it for as
 * long as it creates, tokens or revokes a Mattermost account, and a pass that finds it held skips
 * this tick too, rather than interleaving its own steps with a bootstrap plan computed before
 * either of them ran, or racing a token mid-swap.
 */
export async function runProvisionerPass(
	deps: ControlPlaneDeps,
	admin: AdminMattermostClient,
	options: AgentProvisionerOptions,
	actor: string,
	log: Logger,
	stopped: () => boolean = () => false,
	resolveTokenOwner: typeof tokenOwner = tokenOwner,
	adminTokenAtStart?: string,
): Promise<void> {
	const lock = await deps.pool.connect();
	// A client whose unlock failed may still hold a lock: it is closed, not pooled (the same
	// margin `runRetentionIfDue` leaves).
	let unlocked = true;
	try {
		const locked = await lock.query<{ locked: boolean }>(
			"select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
			[PROVISIONER_PASS_LOCK],
		);
		if (locked.rows[0]?.locked !== true) {
			log.debug("agent provisioner: another pass is already running; skipping this tick");
			return;
		}
		try {
			if (!(await tryAcquireMattermostCredentialLock(lock))) {
				log.debug(
					"agent provisioner: a bootstrap or admin-token run holds the credential lock; " +
						"skipping this tick",
				);
				return;
			}
			try {
				await runLockedProvisionerPass(
					deps,
					admin,
					options,
					actor,
					log,
					stopped,
					resolveTokenOwner,
					adminTokenAtStart,
				);
			} finally {
				await releaseMattermostCredentialLock(lock);
			}
		} finally {
			unlocked = false;
			await lock.query("select pg_advisory_unlock(hashtextextended($1, 0))", [
				PROVISIONER_PASS_LOCK,
			]);
			unlocked = true;
		}
	} finally {
		lock.release(!unlocked);
	}
}

async function runLockedProvisionerPass(
	deps: ControlPlaneDeps,
	admin: AdminMattermostClient,
	options: AgentProvisionerOptions,
	actor: string,
	log: Logger,
	stopped: () => boolean,
	resolveTokenOwner: typeof tokenOwner,
	adminTokenAtStart: string | undefined,
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
		await processOperation(
			deps,
			admin,
			options,
			actor,
			operation,
			log,
			resolveTokenOwner,
			me.id,
			adminTokenAtStart,
		);
	}

	const retiring = (await listRunningLifecycleOperations(deps)).filter((operation) =>
		RETIRE_KINDS.includes(operation.kind),
	);
	const pendingRetires = await listPendingLifecycleOperations(deps, RETIRE_KINDS);
	for (const operation of [...retiring, ...pendingRetires]) {
		if (stopped()) {
			return;
		}
		await processRetireOperation(
			deps,
			admin,
			options,
			actor,
			operation,
			log,
			me.id,
			adminTokenAtStart,
		);
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
	adminTokenAtStart: string | undefined,
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
	try {
		// Read once, before `ensureBot`, not only afterwards: this agent's own recorded identity (if
		// any) is exactly what lets `ensureBot` tell its own, previously-resolved bot apart from an
		// unrelated account that merely happens to share its username (`guard.knownUserId` below).
		const identity = await loadMattermostIdentity(deps, operation.agentId);
		let botUserId = checkpoints.bot_user_id;
		if (botUserId === undefined) {
			try {
				// The current admin account plus every one this Gateway has ever recorded for itself
				// (`loadKnownProvisioningAdminIds`): a resumed `create` whose bot was created under an
				// admin account an operator has since rotated away from (`gateway mattermost
				// admin-token set` pointed at a different account) must still be recognized as this
				// Gateway's own, the same history retirement's own recovery already trusts.
				const knownAdminIds = new Set([
					adminUserId,
					...(await loadKnownProvisioningAdminIds(deps)),
				]);
				botUserId = await ensureBot(
					admin,
					{ username: agentConfig.mattermost.username, displayName: agentConfig.display_name },
					{ knownUserId: identity?.userId ?? null, knownAdminIds },
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

		const channelIdsByName = new Map(
			[...snapshot.channels].map(([channelId, name]) => [name, channelId]),
		);
		const converged = await convergeMembership(
			deps,
			admin,
			operation,
			botUserId,
			teamId,
			snapshot.organization.mattermost.team,
			channelIdsByName,
			agentConfig.mattermost.allowed_channels,
			log,
		);
		// Merged onto `checkpoints`, never replacing it outright: `convergeMembership` keeps its own,
		// separate running total (reset at the start of its own call), which only ever covers
		// `team_joined`/`team`/`channels_joined` — `bot_user_id`/`token_ref`, checkpointed above,
		// must survive into what `completeOperation` below finally records.
		checkpoints = { ...checkpoints, ...converged.checkpoints };
		if (!converged.complete) {
			return;
		}

		await completeOperation(deps, operation.id, actor, checkpoints);
		log.info("agent provisioner: agent ready", { agent_id: operation.agentId });
	} catch (error) {
		await settleFailure(deps, operation, actor, error, log, adminTokenAtStart);
	}
}

/**
 * Converges the bot's team and channel membership onto desired state, computed fresh from live
 * Mattermost state every call (ADR-026) — crash-safe without a cleanup
 * checkpoint of its own, since nothing here is ever decided from one: `team_joined`/
 * `channels_joined` are written purely as this pass's own progress markers (`checkpoint`, below),
 * reset at the start of every call and read by nothing in this function — only by
 * `completeOperation`'s own fence, once this operation finishes. The same convergence runs for
 * every operation kind (`create`, `restore`, `reprovision` alike): there is no "join only" step
 * distinct from a "trim" step any more, so a channel a committed edit took away mid-flight is left
 * exactly like one a `reprovision` already removes, and a channel a committed edit added mid-flight
 * is joined the same way — neither needs its own special case here, since any drift a single pass
 * does not happen to observe is still caught by `completeOperation`'s own fence on the next one.
 *
 * Joins the configured team if the bot is not already a live member of it (`admin.userTeams`), then
 * leaves every *other* team the bot is a live member of — straight to `removeTeamMember`, the same
 * way `bootstrapMattermost`'s own "one team only" step already does, without leaving the old team's
 * channels first: Mattermost ends a user's membership in every channel of a team the moment it ends
 * their membership in the team itself, the behaviour this step relies on — confirmed against a
 * real server by `agent-provisioner.e2e.test.ts`'s own "leaves a team the bot is a live member of"
 * case: a second team, a bot added to one of its channels by hand, `removeTeamMember`, then the
 * channel membership gone too, with no removal of its own ever asked for. ADR-022 grants are
 * never consulted for a team being left this way, only for the configured one (below), since a
 * grant only ever means anything within the team the organization actually manages. Then joins
 * every channel `allowedChannelNames` names that the bot is not already a live member of
 * (`admin.userChannelsInTeam`), and leaves every channel the bot is a live member of that
 * `loadAgentAllowedChannelIds` — checked fresh immediately before each removal, never once at the
 * start of this call — does not currently allow (configured or actively granted, ADR-022). Finally
 * normalizes the bot's own team and channel membership roles back to a plain member wherever an
 * existing membership somehow carries more (`team_admin`/`channel_admin`), the same role
 * normalization `bootstrapMattermost` already applies to a bulk-managed bot, before this operation
 * is ever allowed to declare the agent ready.
 *
 * `channelIdsByName` only names channels already resolved in the configured team (the Mattermost
 * bridge's own snapshot); an `allowedChannelNames` entry missing from it is left unresolved for a
 * later tick to pick up once the bridge resolves it — `complete: false` leaves the rest of this
 * call's own work (the trim step, role normalization) for that later tick too, rather than finish
 * against a channel list this call cannot yet check in full.
 */
async function convergeMembership(
	deps: ControlPlaneDeps,
	admin: AdminMattermostClient,
	operation: LifecycleOperation,
	botUserId: MattermostId,
	teamId: MattermostId,
	teamName: string,
	channelIdsByName: ReadonlyMap<string, MattermostId>,
	allowedChannelNames: Readonly<string[]>,
	log: Logger,
): Promise<Readonly<{ checkpoints: AgentLifecycleCheckpoints; complete: boolean }>> {
	// Reset at the start of every pass: a live check below, never this, decides whether a step still
	// needs doing.
	let checkpoints: AgentLifecycleCheckpoints = { team_joined: false, channels_joined: [] };

	const liveTeams = await admin.userTeams(botUserId);
	if (!liveTeams.some((team) => team.id === teamId)) {
		await admin.addTeamMember(teamId, botUserId);
	}
	checkpoints = await checkpoint(deps, operation.id, checkpoints, {
		team_joined: true,
		team: teamName,
		// Reset here, unconditionally, rather than only once the loop below first has a channel to
		// record: a configuration with zero currently-allowed channels would otherwise never again
		// overwrite whatever a much earlier pass last stored here (the loop's own checkpoint call
		// never runs at all), leaving a stale, non-empty array `completeOperation`'s own fence would
		// keep comparing against forever — a mismatch nothing could ever actually clear.
		channels_joined: [],
	});
	const teamMember = await admin.teamMember(teamId, botUserId);
	if (teamMember !== null && isElevatedMember(teamMember)) {
		await admin.setTeamMemberRoles(teamId, botUserId, "team_user");
	}
	for (const other of liveTeams) {
		if (other.id !== teamId) {
			await admin.removeTeamMember(other.id, botUserId);
		}
	}

	const memberChannels = await admin.userChannelsInTeam(botUserId, teamId);
	const memberIds = new Set(memberChannels.map((channel) => channel.id));
	const joined = new Set<MattermostId>();
	for (const name of allowedChannelNames) {
		const channelId = channelIdsByName.get(name);
		if (channelId === undefined) {
			log.info("agent provisioner: channel not resolved yet; waiting", {
				agent_id: operation.agentId,
				channel: name,
			});
			return { checkpoints, complete: false };
		}
		if (!memberIds.has(channelId)) {
			await admin.addChannelMember(channelId, botUserId);
		}
		joined.add(channelId);
		checkpoints = await checkpoint(deps, operation.id, checkpoints, {
			channels_joined: [...joined],
		});
	}

	for (const channel of memberChannels) {
		const allowed = await loadAgentAllowedChannelIds(deps, operation.agentId);
		if (isExtraChannel(channel, allowed)) {
			await admin.removeChannelMember(channel.id, botUserId);
			continue;
		}
		const member = await admin.channelMember(channel.id, botUserId);
		if (member !== null && isElevatedMember(member)) {
			await admin.setChannelMemberRoles(channel.id, botUserId, "channel_user");
		}
	}
	return { checkpoints, complete: true };
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
	/** A plain bot exists at the agent's own configured username, but its `owner_id` names none of
	 * `knownAdminIds` (`findPlausibleGatewayBot`'s own ownership guard): retirement must not adopt a
	 * stranger's account merely because nothing else claims the name, so its Mattermost-side cleanup
	 * is skipped instead of revoking that unrelated bot's tokens and disabling it — logged visibly
	 * (the caller) rather than quietly, since this Gateway's own admin-rotation history, if any was
	 * ever lost, could in principle have vindicated it instead. */
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
 * Gateway's own plain bot (`findPlausibleGatewayBot`'s own `owner_id` check against
 * `knownAdminIds` — the current provisioning admin account plus every one this Gateway has ever
 * recorded for itself, `loadKnownProvisioningAdminIds`, so a bot created under an admin account
 * since rotated away from is still recognized): a username-only match is never enough by itself —
 * an agent whose own `create` genuinely failed on "username taken" must not have this retire revoke
 * an unrelated bot's tokens and disable it.
 */
async function recoverRetiringBotUserId(
	deps: ControlPlaneDeps,
	admin: AdminMattermostClient,
	agentId: AgentId,
	username: string | undefined,
	knownAdminIds: ReadonlySet<MattermostId>,
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
	const found = await findPlausibleGatewayBot(admin, username, knownAdminIds);
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
	adminTokenAtStart: string | undefined,
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
			const knownAdminIds = new Set([adminUserId, ...(await loadKnownProvisioningAdminIds(deps))]);
			const recovered = await recoverRetiringBotUserId(
				deps,
				admin,
				operation.agentId,
				agentConfig?.mattermost.username,
				knownAdminIds,
			);
			if (recovered.kind === "found") {
				botUserId = recovered.userId;
				// Recorded now, the same write a crash between the `bot_user_id` checkpoint and this
				// would otherwise have skipped entirely: never left silently blank once recovered.
				await setAgentBotUser(deps, operation.agentId, botUserId, actor);
			} else if (recovered.kind === "skipped") {
				// A plain bot sharing this agent's own configured username exists, but its `owner_id`
				// names none of this Gateway's known admin accounts (current or historical): never
				// adopted, so there is nothing of this agent's own left to clean up Mattermost-side —
				// recorded here, not silently folded into the "nothing was ever provisioned" case
				// below, so an operator can tell the two apart. Logged visibly (`warn`, not `info`)
				// and left on a checkpoint `gateway doctor` surfaces, since this Gateway's own
				// admin-rotation history — had any of it been lost — could in principle have
				// vindicated this same bot instead of leaving it skipped.
				const finalCheckpoints = await checkpoint(deps, operation.id, checkpoints, {
					owner_unverified: true,
				});
				await completeOperation(deps, operation.id, actor, finalCheckpoints);
				log.warn("agent provisioner: agent retired; its Mattermost-side cleanup was skipped", {
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
		await settleFailure(deps, operation, actor, error, log, adminTokenAtStart);
	}
}

/**
 * Settles a step's failure: superseded (a later request moved the agent on) is silent, a
 * permanent error (`PermanentProvisioningError`, `BootstrapError`, or a `MattermostApiError` that
 * is not retryable — the admin token invalid or lacking permission) fails the operation with a
 * redacted message (`failOperation` itself redacts it), and anything else (a retryable
 * `MattermostApiError`, or an unexpected error) is left `running` for the next tick.
 *
 * A 401/403 is reclassified from permanent to transient when `adminTokenAtStart` (the value
 * `runTick` read before this pass's own admin client was built, passed down from
 * `runProvisionerPass`; `undefined` when a test built its own client with no such value) no longer
 * matches a fresh read of the same setting: defence in depth (ADR-026) for the one gap the shared
 * Mattermost credential lock cannot close by itself — an `admin-token rotate|set` run that starts
 * and finishes entirely in the gap between that read and this pass's own lock acquisition leaves
 * the pass holding a now-revoked token for the rest of its run, which must never fail an operation
 * permanently merely because the account's admin rotated its credential in the meantime.
 */
async function settleFailure(
	deps: ControlPlaneDeps,
	operation: LifecycleOperation,
	actor: string,
	error: unknown,
	log: Logger,
	adminTokenAtStart?: string,
): Promise<void> {
	if (error instanceof StaleLifecycleOperationError) {
		return;
	}
	const authRejected =
		error instanceof MattermostApiError && (error.status === 401 || error.status === 403);
	const adminTokenRotatedMidPass =
		adminTokenAtStart !== undefined &&
		readOptionalFileSetting("MATTERMOST_ADMIN_TOKEN") !== adminTokenAtStart;
	const permanent =
		!(authRejected && adminTokenRotatedMidPass) &&
		(error instanceof PermanentProvisioningError ||
			error instanceof BootstrapError ||
			(error instanceof MattermostApiError && !error.retryable));
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
