import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { ROUTING_KEY_SECRET_FILE } from "@agent-gateway/contracts";
import {
	type ControlPlaneDeps,
	loadConfigGeneration,
	loadMattermostPlanSource,
	mattermostBootstrapStore,
	mattermostReconcileStore,
	withBootstrapLock,
} from "@agent-gateway/core";
import {
	bootstrapMattermost,
	mattermostPlan,
	reconcileMattermost,
	StaleConfigurationError,
	type TokenFiles,
} from "@agent-gateway/mattermost";
import {
	readSecretFile,
	readSetting,
	requireSetting,
	resolveSecretPath,
	secretFileState,
	writeSecretFile,
} from "@agent-gateway/service";

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
	const plan = mattermostPlan(
		source.organization,
		source.agents,
		(ref) => resolveSecretPath(ref, secretsDir),
		source.retired,
	);
	return { plan, version: source.version };
}

/** A configuration applied while bootstrap runs makes it run again, this often at most. */
const BOOTSTRAP_RUNS = 3;

function secretsDirOf(flagValue: string | null): string | undefined {
	const dir = flagValue ?? readSetting("SECRETS_DIR");
	return dir === undefined ? undefined : resolve(dir);
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
	const adminToken = requireSetting("MATTERMOST_ADMIN_TOKEN");
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
