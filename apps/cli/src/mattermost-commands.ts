import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { ROUTING_KEY_SECRET_FILE } from "@agent-gateway/contracts";
import {
	type ControlPlaneDeps,
	loadConfigGeneration,
	loadLifecycleOwnedAgentIds,
	loadMattermostPlanSource,
	mattermostBootstrapStore,
	mattermostReconcileStore,
	withBootstrapLock,
} from "@agent-gateway/core";
import {
	bootstrapMattermost,
	MattermostClient,
	mattermostPlan,
	reconcileMattermost,
	StaleConfigurationError,
	type TokenFiles,
} from "@agent-gateway/mattermost";
import {
	readSecretFile,
	readSetting,
	requireSetting,
	requireSettingPreferEnv,
	resolveSecretPath,
	secretFileState,
	writeSecretFile,
} from "@agent-gateway/service";
import type { HiddenLineReader } from "./console-commands.ts";

export class MattermostCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MattermostCommandError";
	}
}

const tokenFiles: TokenFiles = {
	state: secretFileState,
	read: readSecretFile,
	write: writeSecretFile,
};

async function activePlan(deps: ControlPlaneDeps, secretsDir: string | undefined) {
	return (await versionedPlan(deps, secretsDir)).plan;
}

async function versionedPlan(deps: ControlPlaneDeps, secretsDir: string | undefined) {
	const source = await loadMattermostPlanSource(deps);
	if (source === null) {
		throw new MattermostCommandError("no active configuration; run 'gateway config apply' first");
	}
	// `mattermostPlan` already skips every agent the lifecycle owns (its token is the
	// provisioner's own, under bot-secrets); `botSecretsDirOf()` is passed regardless, so any
	// reference this resolver does see under `/run/bot-secrets/` still maps into the gateway-cli
	// container's own mount of that directory, never into `secretsDir`.
	const lifecycleOwnedAgentIds = await loadLifecycleOwnedAgentIds(deps);
	const plan = mattermostPlan(
		source.organization,
		source.agents,
		(ref) => resolveSecretPath(ref, secretsDir, botSecretsDirOf()),
		source.retired,
		lifecycleOwnedAgentIds,
	);
	return { plan, version: source.version };
}

/** A configuration applied while bootstrap runs makes it run again, this often at most. */
const BOOTSTRAP_RUNS = 3;

function secretsDirOf(flagValue: string | null): string | undefined {
	const dir = flagValue ?? readSetting("SECRETS_DIR");
	return dir === undefined ? undefined : resolve(dir);
}

/** Where a `/run/bot-secrets/<name>` reference is looked up instead: `BOT_SECRETS_DIR`, defaulting
 * to the mount itself (`/run/bot-secrets`) — distinct from `secretsDir`/`SECRETS_DIR`, which only
 * ever overrides `/run/secrets/` (`resolveSecretPath`, `@agent-gateway/service`). */
function botSecretsDirOf(): string {
	return resolve(readSetting("BOT_SECRETS_DIR") ?? "/run/bot-secrets");
}

export type BootstrapArgs = Readonly<{
	secretsDir: string | null;
	rotateTokens: boolean;
	actor: string;
}>;

/**
 * `gateway mattermost bootstrap`: needs `MATTERMOST_URL` and a temporary
 * `MATTERMOST_ADMIN_TOKEN`. Tokens go straight into secret files; nothing secret is printed.
 * Also creates the routing key when there is none yet.
 */
export async function mattermostBootstrap(
	deps: ControlPlaneDeps,
	args: BootstrapArgs,
	print: (line: string) => void,
): Promise<void> {
	const secretsDir = secretsDirOf(args.secretsDir);
	if (secretsDir === undefined) {
		throw new MattermostCommandError("pass --secrets-dir <dir> (or set SECRETS_DIR)");
	}
	const baseUrl = requireSetting("MATTERMOST_URL");
	// `requireSettingPreferEnv`, not `requireSetting`: `gateway-cli` also names
	// `MATTERMOST_ADMIN_TOKEN_FILE` (for `gateway doctor`'s own read), which does not exist yet on a
	// fresh install — the temporary token this command's own workflow exports must never be
	// shadowed by that absent file.
	const adminToken = requireSettingPreferEnv("MATTERMOST_ADMIN_TOKEN");
	// One bootstrap at a time; one that ran on a configuration replaced meanwhile runs again, so
	// no membership of the old plan outlives the new one.
	await withBootstrapLock(deps, async () => {
		for (let run = 1; ; run += 1) {
			// The generation, not the version: a configuration changed and changed back is a new
			// generation with the old version, and its interim membership changes still count.
			const generation = await loadConfigGeneration(deps);
			const { plan } = await versionedPlan(deps, secretsDir);
			let stale = false;
			try {
				await bootstrapMattermost({
					baseUrl,
					adminToken,
					plan,
					store: mattermostBootstrapStore(deps, args.actor),
					tokens: tokenFiles,
					rotateTokens: args.rotateTokens && run === 1,
					report: print,
					generation,
				});
			} catch (error) {
				if (!(error instanceof StaleConfigurationError)) {
					throw error;
				}
				stale = true;
			}
			if (!stale && (await loadConfigGeneration(deps)) === generation) {
				return;
			}
			if (run >= BOOTSTRAP_RUNS) {
				throw new MattermostCommandError(
					"the configuration keeps changing during bootstrap; run it again when it is stable",
				);
			}
			print("the configuration changed during bootstrap; running it again");
		}
	});
	const keyPath = resolveSecretPath(ROUTING_KEY_SECRET_FILE, secretsDir);
	const keyState = secretFileState(keyPath);
	if (keyState === "symlink" || keyState === "exposed") {
		throw new MattermostCommandError(
			`routing key '${keyPath}' is ${keyState === "symlink" ? "a symlink" : "readable by others"}; replace it with a new key (mode 0600) and restart the controller`,
		);
	}
	if (keyState === "missing") {
		writeSecretFile(keyPath, randomBytes(32).toString("hex"));
		print(`routing key created at ${keyPath}`);
	}
	print("bootstrap done; revoke the admin token now");
}

/** `gateway mattermost reconcile`: checks the bootstrap result with the bots' own tokens. */
export async function mattermostReconcile(
	deps: ControlPlaneDeps,
	secretsDirFlag: string | null,
	print: (line: string) => void,
): Promise<boolean> {
	const secretsDir = secretsDirOf(secretsDirFlag);
	const plan = await activePlan(deps, secretsDir);
	const problems = await reconcileMattermost({
		baseUrl: requireSetting("MATTERMOST_URL"),
		plan,
		tokens: tokenFiles,
		store: mattermostReconcileStore(deps),
	});
	if (problems.length === 0) {
		print(`Mattermost is consistent: ${plan.bots.length} bots checked`);
		return true;
	}
	print(`Mattermost problems:\n- ${problems.join("\n- ")}`);
	return false;
}

/** The description every personal access token `admin-token set|rotate` issues or looks for
 * carries: not a secret, just a marker distinct from a bot's own tokens (`TOKEN_DESCRIPTION`). */
const ADMIN_TOKEN_DESCRIPTION = "agent-gateway-admin";

export type MattermostAdminTokenSetOptions = Readonly<{
	baseUrl: string;
	/** The controller secret file, already resolved against the secrets directory in effect. */
	secretPath: string;
	reader: HiddenLineReader;
}>;

/**
 * `gateway mattermost admin-token set`: hidden entry of a personal access token an operator
 * already created in Mattermost for a dedicated, non-bot system-admin account (ADR-026) —
 * validated (`users/me`: a non-bot account with the `system_admin` role) and written atomically,
 * 0600, into the controller's secrets directory. Refuses anything but an interactive terminal, and
 * never prints the token; only the account's own username confirms which one was just set.
 */
export async function mattermostAdminTokenSet(
	options: MattermostAdminTokenSetOptions,
	print: (line: string) => void,
): Promise<void> {
	if (!options.reader.isTTY) {
		throw new MattermostCommandError("stdin is not a terminal; run this from an interactive shell");
	}
	const token = await options.reader.readLine("Mattermost admin token: ");
	if (token.length === 0) {
		throw new MattermostCommandError("the token must not be empty");
	}
	const me = await new MattermostClient({ baseUrl: options.baseUrl, token }).me();
	if (me.is_bot) {
		throw new MattermostCommandError(
			`'${me.username}' is a bot account; Mattermost bots cannot create other bots, so the ` +
				"admin token must belong to a dedicated, non-bot human-managed account",
		);
	}
	if (!me.roles.split(/\s+/).includes("system_admin")) {
		throw new MattermostCommandError(`'${me.username}' does not have the 'system_admin' role`);
	}
	writeSecretFile(options.secretPath, token);
	print(`admin token set for account '${me.username}'`);
}

export type MattermostAdminTokenRotateOptions = Readonly<{
	baseUrl: string;
	secretPath: string;
}>;

/**
 * `gateway mattermost admin-token rotate`: create-verify-switch-revoke (ADR-026). With the
 * current token, creates a new personal access token for the same account, verifies it
 * authenticates as that account, writes it over the current file (the crash boundary: from here
 * the new token is the one in use), then revokes every other token the account has — the current
 * one (just superseded) and, if an earlier rotation crashed after writing its own new token but
 * before this step, every token stranded by that crash too. A token's value is never readable
 * back from Mattermost, so "every other token" (not a specifically remembered old id) is how this
 * stays correct however many times it was interrupted before.
 */
export async function mattermostAdminTokenRotate(
	options: MattermostAdminTokenRotateOptions,
	print: (line: string) => void,
): Promise<void> {
	const state = secretFileState(options.secretPath);
	if (state !== "private") {
		throw new MattermostCommandError(
			state === "missing"
				? "no admin token is set yet; run 'gateway mattermost admin-token set' first"
				: `admin token file '${options.secretPath}' is ${state === "symlink" ? "a symlink" : "readable by others"}; replace it and run 'admin-token set' again`,
		);
	}
	const current = readSecretFile(options.secretPath);
	const client = new MattermostClient({ baseUrl: options.baseUrl, token: current });
	const me = await client.me();
	const created = await client.createUserAccessToken(me.id, ADMIN_TOKEN_DESCRIPTION);
	// Every call from here on authenticates with the new token, never the one about to be
	// revoked: revoking the old token (and any other stray one) must never invalidate the
	// credential still doing the revoking.
	const next = new MattermostClient({ baseUrl: options.baseUrl, token: created.token });
	const verified = await next.me();
	if (verified.id !== me.id) {
		throw new MattermostCommandError(
			"the newly created token did not verify against the same account; nothing was changed",
		);
	}
	writeSecretFile(options.secretPath, created.token);
	// `userAccessTokenIds` already pages through every token the account has; listed and revoked
	// again, bounded, until only the one just written remains — the same margin `revokeAllTokens`
	// (bootstrap's own retirement cleanup) leaves for a token appearing mid-revoke.
	let revoked = 0;
	for (let round = 0; round < 1000; round += 1) {
		const remaining = (await next.userAccessTokenIds(me.id)).filter((id) => id !== created.id);
		if (remaining.length === 0) {
			print(`admin token rotated for account '${me.username}'; revoked ${revoked} old token(s)`);
			return;
		}
		for (const tokenId of remaining) {
			await next.revokeUserAccessToken(tokenId);
			revoked += 1;
		}
	}
	throw new MattermostCommandError(`could not revoke every old token of account '${me.username}'`);
}
