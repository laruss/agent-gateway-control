import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTurnInput, JsonValue, RuntimeUsage } from "@agent-gateway/contracts";
import {
	asCount,
	asRecord,
	asString,
	confinedGrants,
	gitCheckoutOf,
	type NativeTool,
	type NativeToolGrants,
	nativeToolGrants,
	type ProcessResult,
	parseJson,
	parseJsonAnswer,
	parseJsonLines,
	RunProcesses,
	type RuntimeAdapter,
	RuntimeError,
	type RuntimeProbeResult,
	type RuntimeTurnOutput,
	removeRunWorkspace,
	renderRepairPrompt,
	renderTurnPrompt,
	runProcess,
	runtimeEnvironment,
	runtimeHome,
	type TurnOptions,
	tail,
	withheldToolsRisk,
} from "@agent-gateway/runtime-sdk";

export type OpencodeRuntimeOptions = Readonly<{
	/** Command that starts the OpenCode CLI: a pinned binary, or a fake in tests. */
	command?: Readonly<string[]>;
	/**
	 * The Gateway's own OpenCode directory: home, config, data (sessions) and cache of the CLI,
	 * never the operator's. Its config directory stays empty; each call brings its own settings.
	 */
	opencodeHome: string;
	/** `OPENCODE_API_KEY` of the OpenCode Go subscription. */
	apiKey?: string;
	/** Provider of model ids given without one. */
	provider?: string;
	/**
	 * Model of agents that name none. OpenCode's own default may belong to another provider, so
	 * a turn without either fails instead of guessing.
	 */
	defaultModel?: string;
	/** Additional environment of the process, e.g. for a fake CLI in tests. */
	env?: Readonly<Record<string, string>>;
	maxOutputBytes?: number;
	killGraceMs?: number;
}>;

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_PROVIDER = "opencode-go";
const NO_GRANTS: NativeToolGrants = {
	read: false,
	write: false,
	exec: false,
	webSearch: false,
	webFetch: false,
};

/**
 * OpenCode has no OS sandbox: its shell runs as the worker user, and commands leave the process
 * group. Its file tools stay inside the working directory (`external_directory` denied), and its
 * web tools run in the CLI; only those are granted.
 */
const CONFINED_TOOLS: Readonly<NativeTool[]> = ["read", "write", "webSearch", "webFetch"];

/** Everything the CLI would otherwise load or fetch besides the turn itself. */
const QUIET_ENV: Readonly<Record<string, string>> = {
	OPENCODE_DISABLE_PROJECT_CONFIG: "1",
	OPENCODE_DISABLE_CLAUDE_CODE: "1",
	OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
	OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
	OPENCODE_DISABLE_AUTOUPDATE: "1",
	OPENCODE_DISABLE_SHARE: "1",
	OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
	OPENCODE_DISABLE_MODELS_FETCH: "1",
	NO_COLOR: "1",
};

/**
 * The configuration of one call (`OPENCODE_CONFIG_CONTENT`). Permissions deny everything, then
 * allow the granted tools; the last matching rule wins, and a tool denied for every pattern is
 * not offered to the model at all. Nothing may leave the working directory.
 */
function callConfig(grants: NativeToolGrants): string {
	const allow = (tools: Readonly<string[]>, granted: boolean) =>
		granted ? tools.map((tool) => [tool, "allow"] as const) : [];
	return JSON.stringify({
		autoupdate: false,
		share: "disabled",
		snapshot: false,
		lsp: false,
		formatter: false,
		mcp: {},
		plugin: [],
		instructions: [],
		permission: Object.fromEntries([
			["*", "deny"],
			...allow(["read", "glob", "grep", "list"], grants.read),
			// `edit` covers the edit, write and patch tools.
			...allow(["edit"], grants.write),
			...allow(["websearch"], grants.webSearch),
			...allow(["webfetch"], grants.webFetch),
			["external_directory", "deny"],
			["doom_loop", "deny"],
		]),
	});
}

function modelId(model: string, provider: string): string {
	return model.includes("/") ? model : `${provider}/${model}`;
}

/** The message of an `error` event, whose shape varies with the failure. */
function errorMessage(event: Readonly<Record<string, JsonValue>>): string {
	const error = asRecord(event.error);
	const data = asRecord(error?.data);
	return (
		asString(data?.message) ??
		asString(error?.message) ??
		asString(error?.name) ??
		asString(event.error) ??
		"unknown error"
	);
}

const SESSION_ID = /^ses_\w{1,64}$/u;
/** The longest a run may take (`timeout_seconds` is at most a day). */
const MAX_CALL_MS = 24 * 3_600_000;
const PERMANENT_REASONS = ["length", "content-filter"];
/** Checked first: throttling passes, whatever else the message says. */
const RATE_LIMITED = /\b429\b|rate.?limit|too many requests|overloaded|quota/iu;
const AUTH_FAILURE = /\b401\b|unauthori[sz]ed|invalid api key|missing api key|no credentials/iu;
/** Failures a retry repeats: an unknown model or options the CLI rejects. */
const CONFIG_FAILURE = /model .*not found|providermodelnotfound|unknown model|invalid config/iu;

/**
 * OpenCode through `opencode run --format json`: the prompt on stdin, JSON events on stdout,
 * the model (an OpenCode Go model by default) chosen per agent. The CLI runs with the Gateway's
 * own home and config directories, no project config, plugins, MCP servers, skills or
 * `AGENTS.md`/`CLAUDE.md`, and the tools the call's permissions allow. It has no native
 * structured output: the prompt carries the result schema, and the Gateway validates the answer.
 * Sessions are not resumed (a session cannot be continued from another working directory, and
 * every attempt has its own); each turn's session is deleted afterwards.
 */
export function createOpencodeRuntime(options: OpencodeRuntimeOptions): RuntimeAdapter {
	const [command = "opencode", ...prefix] = options.command ?? ["opencode"];
	const processes = new RunProcesses(options.killGraceMs);
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const provider = options.provider ?? DEFAULT_PROVIDER;
	const root = runtimeHome(options.opencodeHome);
	const home = join(root, "home");
	const dataDir = join(root, "data");
	const baseEnv = runtimeEnvironment({
		HOME: home,
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_DATA_HOME: dataDir,
		XDG_CACHE_HOME: join(root, "cache"),
		XDG_STATE_HOME: join(root, "state"),
		OPENCODE_API_KEY: options.apiKey,
		...QUIET_ENV,
		...options.env,
	});
	let version: Promise<string | null> | null = null;

	const prepare = async (): Promise<void> => {
		for (const dir of [root, home]) {
			await mkdir(dir, { recursive: true, mode: 0o700 });
		}
	};

	const simple = async (
		args: Readonly<string[]>,
		cwd: string,
		env: Readonly<Record<string, string>> = baseEnv,
	): Promise<ProcessResult> =>
		runProcess({
			command,
			args: [...prefix, ...args],
			cwd,
			env: { ...env, OPENCODE_CONFIG_CONTENT: callConfig(NO_GRANTS) },
			stdin: "",
			maxOutputBytes: 64 * 1024,
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});

	/** `opencode/<version>`, read once. */
	const readVersion = (): Promise<string | null> => {
		version ??= simple(["--version"], tmpdir()).then(
			(result) => {
				const match = /^(\d+\.\d+\.\d+\S*)\s*$/mu.exec(result.stdout);
				return result.exitCode === 0 && match?.[1] !== undefined ? `opencode/${match[1]}` : null;
			},
			() => null,
		);
		return version;
	};

	const probe = async (): Promise<RuntimeProbeResult> => {
		const risks = [
			process.getuid?.() === 0 ? "the worker runs as root" : null,
			withheldToolsRisk("opencode", CONFINED_TOOLS),
			"file tools are confined by OpenCode's own permission check (external_directory), not by an OS sandbox",
			"the probe does not verify the credential; the doctor's turn does",
		].filter((risk) => risk !== null);
		const fail = (runtimeVersion: string, detail: string): RuntimeProbeResult => ({
			ok: false,
			runtimeVersion,
			detail,
			risks,
		});
		version = null;
		try {
			await prepare();
		} catch (error) {
			return fail("", `cannot create ${root}: ${String(error)}`);
		}
		const runtimeVersion = await readVersion();
		if (runtimeVersion === null) {
			return fail("", `'${command} --version' did not report an OpenCode version`);
		}
		// Also while the credential is missing: stale sessions go regardless.
		await pruneSessions();
		const stored = existsSync(join(dataDir, "opencode", "auth.json"));
		if (options.apiKey === undefined && !stored) {
			return fail(
				runtimeVersion,
				`no credential: set OPENCODE_API_KEY or run \`opencode auth login\` with XDG_DATA_HOME=${dataDir}`,
			);
		}
		const models = await simple(["models", provider], home);
		if (models.exitCode !== 0 || models.stdout.trim() === "") {
			return fail(runtimeVersion, `provider '${provider}' lists no models`);
		}
		const method = options.apiKey === undefined ? "stored login" : "API key";
		return { ok: true, runtimeVersion, detail: `${runtimeVersion}, ${provider}, ${method}`, risks };
	};

	/**
	 * Deletes sessions a call could not delete itself (one stopped before its first event): no
	 * session is ever resumed, and none is older than a day while its call still runs.
	 */
	const pruneSessions = async (): Promise<void> => {
		const listed = await simple(["session", "list", "--format", "json"], home).catch(() => null);
		const sessions = parseJson(listed?.stdout ?? "");
		const cutoff = Date.now() - MAX_CALL_MS;
		for (const entry of Array.isArray(sessions) ? sessions : []) {
			const session = asRecord(entry);
			const id = asString(session?.id);
			const updated = session?.updated;
			if (id !== null && SESSION_ID.test(id) && typeof updated === "number" && updated < cutoff) {
				await simple(["session", "delete", id], home).catch(() => undefined);
			}
		}
	};

	const execute = async (
		input: AgentTurnInput,
		prompt: string,
		turnOptions: TurnOptions,
	): Promise<RuntimeTurnOutput> => {
		await prepare();
		const checkout = gitCheckoutOf(turnOptions.workspacePath);
		if (checkout !== null) {
			// OpenCode treats the whole checkout as the project its file tools may reach.
			throw new RuntimeError(
				`the run workspace is inside the git checkout ${checkout}; move WORKER_WORKSPACE_ROOT out of it`,
				false,
			);
		}
		const grants = confinedGrants(nativeToolGrants(input.toolPolicy), CONFINED_TOOLS);
		const chosen = turnOptions.model ?? options.defaultModel ?? null;
		if (chosen === null) {
			throw new RuntimeError(
				"no model: set the agent's runtime.model or OPENCODE_MODEL for this worker",
				false,
			);
		}
		const model = modelId(chosen, provider);
		const callTemp = await mkdtemp(join(tmpdir(), "agw-opencode-"));
		const env = { ...baseEnv, TMPDIR: callTemp };
		try {
			const result = await processes.run(input.runId, {
				command,
				args: [...prefix, "run", "--pure", "--format", "json", "--model", model],
				cwd: turnOptions.workspacePath,
				env: { ...env, OPENCODE_CONFIG_CONTENT: callConfig(grants) },
				stdin: prompt,
				maxOutputBytes,
				signal: turnOptions.signal,
			});
			const events = parseJsonLines(result.stdout);
			const sessionId =
				events.map((event) => asString(event.sessionID)).find((id) => id !== null) ?? null;
			if (sessionId !== null && SESSION_ID.test(sessionId)) {
				// Transcripts are not kept: no turn resumes them.
				// From the Gateway's home: after a cancel the workspace may already be gone.
				await simple(["session", "delete", sessionId], home, env).catch(() => undefined);
			}
			return interpret(result, events, model);
		} finally {
			await removeRunWorkspace(callTemp);
		}
	};

	const interpret = (
		result: ProcessResult,
		events: Readonly<Readonly<Record<string, JsonValue>>[]>,
		model: string,
	): RuntimeTurnOutput => {
		if (result.aborted) {
			throw new RuntimeError("opencode was stopped", false);
		}
		const errors = events.filter((event) => event.type === "error").map(errorMessage);
		if (errors.length > 0 || result.exitCode !== 0) {
			// Only the CLI's own messages: stdout text events would be the model's answer.
			const detail =
				errors.length > 0
					? tail(errors.join("; "))
					: `${tail(result.stderr)} (stdout: ${result.stdout.length} characters${result.truncated ? ", truncated" : ""})`;
			throw new RuntimeError(
				`opencode exited with ${result.exitCode ?? result.exitSignal}: ${detail}`,
				RATE_LIMITED.test(detail) || (!AUTH_FAILURE.test(detail) && !CONFIG_FAILURE.test(detail)),
			);
		}
		const steps = events.filter((event) => event.type === "step_finish");
		const last = asRecord(steps.at(-1)?.part);
		const reason = asString(last?.reason) ?? "no step";
		if (reason !== "stop") {
			// Running out of output tokens happens again on a retry of the same turn.
			throw new RuntimeError(
				`opencode finished without a final answer (${reason})`,
				!PERMANENT_REASONS.includes(reason),
			);
		}
		// The answer is the text of the last step; earlier steps' text came before tool calls.
		const lastStart = events.findLastIndex((event) => event.type === "step_start");
		const text = events
			.slice(lastStart + 1)
			.filter((event) => event.type === "text")
			.map((event) => asString(asRecord(event.part)?.text) ?? "")
			.join("");
		const tokens = steps.map((step) => asRecord(asRecord(step.part)?.tokens));
		const cacheRead = tokens.reduce((sum, t) => sum + asCount(asRecord(t?.cache)?.read), 0);
		const costs = steps
			.map((step) => asRecord(step.part)?.cost)
			.filter((value) => typeof value === "number");
		// No step reported a cost: unknown, not free.
		const cost = costs.length === 0 ? null : costs.reduce((sum, value) => sum + value, 0);
		const usage: RuntimeUsage = {
			inputTokens:
				tokens.reduce((sum, t) => sum + asCount(t?.input) + asCount(asRecord(t?.cache)?.write), 0) +
				cacheRead,
			outputTokens: tokens.reduce((sum, t) => sum + asCount(t?.output) + asCount(t?.reasoning), 0),
			cachedInputTokens: cacheRead,
			costUsd: cost,
			durationMs: result.durationMs,
			model,
		};
		return { modelOutput: parseJsonAnswer(text), usage, session: null };
	};

	return {
		id: "opencode-go",
		capabilities: { sessionResume: false, confinedTools: CONFINED_TOOLS },
		probe,
		health: async () => {
			const result = await probe();
			return { healthy: result.ok, detail: result.detail };
		},
		startTurn: (input, turnOptions) =>
			execute(input, renderTurnPrompt(input, CONFINED_TOOLS), turnOptions),
		continueTurn: (_session, input, turnOptions) =>
			execute(input, renderTurnPrompt(input, CONFINED_TOOLS), turnOptions),
		repairTurn: (input, repair, turnOptions) =>
			execute(input, renderRepairPrompt(input, repair, CONFINED_TOOLS), turnOptions),
		cancel: async (runId) => {
			const cancelled = await processes.cancel(runId);
			return { cancelled, detail: cancelled ? "process group stopped" : "no running process" };
		},
		collectArtifacts: async () => [],
	};
}
