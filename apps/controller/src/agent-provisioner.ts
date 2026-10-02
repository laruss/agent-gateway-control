import type {
	AgentLifecycleCheckpoints,
	AgentLifecycleOperationKind,
} from "@agent-gateway/contracts";
import {
	type ControlPlaneDeps,
	checkpointOperation,
	completeOperation,
	failOperation,
	listPendingLifecycleOperations,
	listRunningLifecycleOperations,
	loadAgentConfig,
	loadDirectoryEntry,
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
	MattermostApiError,
	MattermostClient,
	revokeAllTokens,
	TOKEN_DESCRIPTION,
	tokenOwner,
} from "@agent-gateway/mattermost";
import {
	readOptionalFileSetting,
	readSecretFile,
	resolveSecretPath,
	secretFileState,
	writeSecretFile,
} from "@agent-gateway/service";

/**
 * Lifecycle operation kinds this provisioner pursues: never `retire` (cancelling runs, waits and
 * approvals and deactivating a bot is other work's own) or `adopt` (written only `succeeded`, by
 * the startup backfill, never left `pending`/`running`).
 */
const PROVISIONING_KINDS: ReadonlyArray<AgentLifecycleOperationKind> = [
	"create",
	"restore",
	"reprovision",
];

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
	// restart.
	await setDirectoryEntry(deps, "user", PROVISIONING_ADMIN_DIRECTORY_NAME, me.id, actor);

	const running = (await listRunningLifecycleOperations(deps)).filter((operation) =>
		PROVISIONING_KINDS.includes(operation.kind),
	);
	const pending = await listPendingLifecycleOperations(deps, PROVISIONING_KINDS);
	for (const operation of [...running, ...pending]) {
		if (stopped()) {
			return;
		}
		await processOperation(deps, admin, options, actor, operation, log, resolveTokenOwner);
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
): Promise<void> {
	const agentConfig = await loadAgentConfig(deps, operation.agentId);
	const snapshot = await loadMattermostSnapshot(deps);
	if (agentConfig === null || snapshot === null) {
		// The agent, or the whole active configuration, is not there to provision right now (a
		// retire committed concurrently, say): left for the next tick, or for whatever superseded
		// this operation to settle it.
		return;
	}
	const teamId = await loadDirectoryEntry(deps, "team", snapshot.organization.mattermost.team);
	if (teamId === null) {
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

	let checkpoints = operation.checkpoints;
	try {
		let botUserId = checkpoints.bot_user_id;
		if (botUserId === undefined) {
			try {
				botUserId = await ensureBot(admin, {
					username: agentConfig.mattermost.username,
					displayName: agentConfig.display_name,
				});
			} catch (error) {
				if (error instanceof BootstrapError) {
					// `ensureBot` already refuses a username that is not plausibly the Gateway's own
					// plain bot (a regular user, or a bot with elevated roles) — never adopting a
					// stranger's account.
					throw new PermanentProvisioningError(
						`username '${agentConfig.mattermost.username}' is taken: ${error.message}`,
					);
				}
				throw error;
			}
			checkpoints = await checkpoint(deps, operation.id, checkpoints, { bot_user_id: botUserId });
			// Bootstrap's own counterpart: the resolved account, recorded as soon as it is known,
			// independent of whether the rest of provisioning finishes this tick.
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
			checkpoints = await checkpoint(deps, operation.id, checkpoints, { team_joined: true });
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
