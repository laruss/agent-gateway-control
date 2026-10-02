import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { ROUTING_KEY_SECRET_FILE } from "@agent-gateway/contracts";
import {
	acquireMattermostCredentialLock,
	type ControlPlaneDeps,
	loadConfigGeneration,
	loadLifecycleOwnedAgentIds,
	loadMattermostPlanSource,
	mattermostBootstrapStore,
	mattermostReconcileStore,
	releaseMattermostCredentialLock,
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
import type pg from "pg";
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
	// One bootstrap at a time; one that ran on a configuration replaced meanwhile runs again, so
	// no membership of the old plan outlives the new one.
	await withBootstrapLock(deps, async () => {
		// `requireSettingPreferEnv`, not `requireSetting`: `gateway-cli` also names
		// `MATTERMOST_ADMIN_TOKEN_FILE` (for `gateway doctor`'s own read), which does not exist yet on
		// a fresh install — the temporary token this command's own workflow exports must never be
		// shadowed by that absent file. Read under the credential lock: an `admin-token rotate` this
		// run waited behind has replaced the file and revoked the token it held before.
		const adminToken = requireSettingPreferEnv("MATTERMOST_ADMIN_TOKEN");
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

/** Advisory lock key serializing `admin-token set`/`rotate`'s own create-verify-write-revoke
 * sequence (ADR-026): run concurrently against the same account — two operators, or a stray
 * second process — either could revoke the other's freshly minted token before it is ever
 * written, leaving the file holding one already revoked. One key for both commands, since either
 * can revoke the other's own in-flight token. */
const ADMIN_TOKEN_LOCK = "agent-gateway:admin-token";

/**
 * Runs `work` holding the admin-token lock (a session-level advisory lock on its own connection),
 * so a concurrent `admin-token set`/`rotate` never interleaves its own create-verify-write-revoke
 * steps with this one. Fails fast, rather than waiting, when another run already holds it.
 *
 * Also holds the shared Mattermost credential lock (ADR-026, `MATTERMOST_CREDENTIAL_LOCK`) for the
 * same duration, nested on this very connection rather than a second `pool.connect()` (this
 * command's own pool holds exactly one): a provisioner pass or a `gateway mattermost bootstrap` run
 * in flight must never revoke the fresh token this sequence is about to write, or see it revoked
 * out from under a token it is mid-way through using. Unlike `ADMIN_TOKEN_LOCK` itself, this one
 * waits (bounded, `MattermostCredentialLockTimeoutError`) rather than failing fast: a provisioner
 * pass already holding it finishes in at most a few Mattermost calls, worth a short wait rather
 * than refusing outright.
 */
async function withAdminTokenLock<T>(pool: pg.Pool, work: () => Promise<T>): Promise<T> {
	const client = await pool.connect();
	// A client whose unlock failed may still hold a lock: it is closed, not pooled (the same
	// margin `withBootstrapLock`/`runRetentionIfDue` leave).
	let unlocked = true;
	// Likewise when the shared credential lock's own release failed, whatever the outer unlock did.
	let credentialHeld = false;
	try {
		const locked = await client.query<{ locked: boolean }>(
			"select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
			[ADMIN_TOKEN_LOCK],
		);
		if (locked.rows[0]?.locked !== true) {
			throw new MattermostCommandError(
				"another 'admin-token set' or 'rotate' is already running against this account; wait for it to finish",
			);
		}
		try {
			await acquireMattermostCredentialLock(client);
			try {
				return await work();
			} finally {
				credentialHeld = true;
				await releaseMattermostCredentialLock(client);
				credentialHeld = false;
			}
		} finally {
			unlocked = false;
			await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [ADMIN_TOKEN_LOCK]);
			unlocked = true;
		}
	} finally {
		client.release(!unlocked || credentialHeld);
	}
}

export type MattermostAdminTokenSetOptions = Readonly<{
	baseUrl: string;
	/** The controller secret file, already resolved against the secrets directory in effect. */
	secretPath: string;
	reader: HiddenLineReader;
	/** Where the admin-token lock is taken (ADR-026): never the controller's own `ControlPlaneDeps`,
	 * which this CLI-only command has no other reason to build. */
	pool: pg.Pool;
}>;

/**
 * `gateway mattermost admin-token set`: hidden entry of a personal access token an operator
 * already created in Mattermost for a dedicated, non-bot system-admin account (ADR-026) —
 * validated (`users/me`: a non-bot account with the `system_admin` role), then converted into a
 * gateway-tagged token the same way `rotate` always has: create-verify-switch-revoke, with the
 * pasted token itself the credential that creates its own replacement. Refuses anything but an
 * interactive terminal, and never prints either token; only the account's own username confirms
 * which one was just set.
 *
 * A token entered by hand carries whatever description the operator gave it in Mattermost (often
 * not `ADMIN_TOKEN_DESCRIPTION`), so `rotate`'s own revoke loop — which only ever touches tokens
 * carrying its own description — would otherwise never revoke it: this command's own first run was
 * the one gap in that scheme (ADR-026's own "Rotation" section used to document it as accepted,
 * one-time edge; this closes it instead). Minting a tagged token right away, before the pasted one
 * is ever written to the file, means the file always holds a token `rotate` can account for from
 * the very first `set` onward.
 *
 * The pasted token is revoked once the minted one is safely written, never before (the crash
 * boundary: a crash between these two steps leaves the pasted token — which still works — as the
 * one credential in the file, never neither working). Revoking it specifically needs its own token
 * id, which Mattermost never exposes by value — only by listing the account's existing tokens. On
 * the dedicated, freshly prepared account this command is meant for (ADR-026), that listing holds
 * exactly one token before this call ever mints its own: the one just pasted, safely identified
 * and revoked. An account that already held more than one is left alone instead and named in a
 * warning — an unrelated personal token the account's admin also happens to hold (`rotate`'s own
 * documented concern) must never be revoked on a guess.
 */
export async function mattermostAdminTokenSet(
	options: MattermostAdminTokenSetOptions,
	print: (line: string) => void,
): Promise<void> {
	if (!options.reader.isTTY) {
		throw new MattermostCommandError("stdin is not a terminal; run this from an interactive shell");
	}
	const pasted = await options.reader.readLine("Mattermost admin token: ");
	if (pasted.length === 0) {
		throw new MattermostCommandError("the token must not be empty");
	}
	await withAdminTokenLock(options.pool, async () => {
		const client = new MattermostClient({ baseUrl: options.baseUrl, token: pasted });
		const me = await client.me();
		if (me.is_bot) {
			throw new MattermostCommandError(
				`'${me.username}' is a bot account; Mattermost bots cannot create other bots, so the ` +
					"admin token must belong to a dedicated, non-bot human-managed account",
			);
		}
		if (!me.roles.split(/\s+/).includes("system_admin")) {
			throw new MattermostCommandError(`'${me.username}' does not have the 'system_admin' role`);
		}
		const existingBefore = await client.userAccessTokenIds(me.id);
		const created = await client.createUserAccessToken(me.id, ADMIN_TOKEN_DESCRIPTION);
		// Every call from here on authenticates with the newly minted token, never the pasted one
		// about to be revoked: see `mattermostAdminTokenRotate`'s own identical reasoning.
		const next = new MattermostClient({ baseUrl: options.baseUrl, token: created.token });
		const verified = await next.me();
		if (verified.id !== me.id) {
			// Revoked before throwing: a token minted but never written to the file must never be
			// left stranded, working, on the account — the same margin every other step here leaves
			// none of its own credentials unaccounted for.
			await next.revokeUserAccessToken(created.id);
			throw new MattermostCommandError(
				"the newly minted token did not verify against the same account; nothing was changed",
			);
		}
		writeSecretFile(options.secretPath, created.token);
		if (existingBefore.length === 1) {
			const [pastedTokenId] = existingBefore;
			if (pastedTokenId !== undefined) {
				await next.revokeUserAccessToken(pastedTokenId);
			}
			print(`admin token set for account '${me.username}'; the token you entered was revoked`);
		} else if (existingBefore.length === 0) {
			print(`admin token set for account '${me.username}'`);
		} else {
			print(
				`admin token set for account '${me.username}'; warning: it already held ` +
					`${existingBefore.length} token(s) before this one — the token you entered was left ` +
					"in place; revoke it by hand in Mattermost once you have confirmed the new one works",
			);
		}
	});
}

export type MattermostAdminTokenRotateOptions = Readonly<{
	baseUrl: string;
	secretPath: string;
	/** Where the admin-token lock is taken (ADR-026); see `MattermostAdminTokenSetOptions`. */
	pool: pg.Pool;
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
 *
 * The file's state and content are both read only once every lock this sequence takes is held
 * (`withAdminTokenLock`), never before: a read taken earlier could describe a token a concurrent
 * `admin-token rotate`/`set` or provisioner pass is itself about to rewrite or revoke, making this
 * run create-verify-switch against a value already stale by the time it ever used it.
 */
export async function mattermostAdminTokenRotate(
	options: MattermostAdminTokenRotateOptions,
	print: (line: string) => void,
): Promise<void> {
	await withAdminTokenLock(options.pool, async () => {
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
			// Revoked before throwing: see `mattermostAdminTokenSet`'s own identical guard.
			await next.revokeUserAccessToken(created.id);
			throw new MattermostCommandError(
				"the newly created token did not verify against the same account; nothing was changed",
			);
		}
		writeSecretFile(options.secretPath, created.token);
		// `userAccessTokens` already pages through every token the account has; listed and revoked
		// again, bounded, until none of its own (`ADMIN_TOKEN_DESCRIPTION`) remain but the one just
		// written — the same margin `revokeAllTokens` (bootstrap's own retirement cleanup) leaves for
		// a token appearing mid-revoke. Only a token carrying this description is ever touched: the
		// account may hold others of its own, unrelated to the Gateway, which must never be revoked
		// by a rotation that merely meant to replace its own.
		let revoked = 0;
		for (let round = 0; round < 1000; round += 1) {
			const remaining = (await next.userAccessTokens(me.id)).filter(
				(token) => token.id !== created.id && token.description === ADMIN_TOKEN_DESCRIPTION,
			);
			if (remaining.length === 0) {
				// 0 revoked is expected on a routine rotate that crashed right after writing its own new
				// token (nothing of this description was left stranded) — but it is also exactly what a
				// stale, never-tagged token left in the file would produce every time, forever: called
				// out plainly rather than folded into the same line as a normal rotate, so a token that
				// should have been revoked but structurally could not be (`admin-token set`'s own "more
				// than one token already" case, say) is never silently mistaken for "nothing needed
				// doing".
				print(
					revoked === 0
						? `admin token rotated for account '${me.username}'; warning: revoked 0 old token(s) — ` +
								"if a previous token is still meant to be retired, revoke it by hand in Mattermost"
						: `admin token rotated for account '${me.username}'; revoked ${revoked} old token(s)`,
				);
				return;
			}
			for (const token of remaining) {
				await next.revokeUserAccessToken(token.id);
				revoked += 1;
			}
		}
		throw new MattermostCommandError(
			`could not revoke every old token of account '${me.username}'`,
		);
	});
}
