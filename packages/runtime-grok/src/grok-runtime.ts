import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentTurnInput,
	JsonValue,
	RuntimeSessionHandle,
	RuntimeUsage,
} from "@agent-gateway/contracts";
import {
	asCount,
	asRecord,
	asString,
	confinedGrants,
	type NativeTool,
	type NativeToolGrants,
	nativeToolGrants,
	type ProcessResult,
	parseJson,
	parseJsonAnswer,
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
	SessionUnavailableError,
	type TurnOptions,
	tail,
	withheldToolsRisk,
	withoutUnanchoredPatterns,
	writeRuntimeFile,
} from "@agent-gateway/runtime-sdk";

export type GrokRuntimeOptions = Readonly<{
	/** Command that starts the Grok CLI: a pinned binary, or a fake in tests. */
	command?: Readonly<string[]>;
	/**
	 * `GROK_HOME` of the Gateway: the login (`GROK_HOME=<dir> grok login`), the sessions and the
	 * configuration this adapter writes. Never the operator's own `~/.grok`.
	 */
	grokHome: string;
	/** `XAI_API_KEY`; takes precedence over the login. */
	apiKey?: string;
	/** Agentic turns per call (`--max-turns`). */
	maxTurns?: number;
	/** Additional environment of the process, e.g. for a fake CLI in tests. */
	env?: Readonly<Record<string, string>>;
	maxOutputBytes?: number;
	killGraceMs?: number;
	/** How long a stored session may be offered again. */
	sessionTtlMs?: number;
}>;

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_MAX_TURNS = 40;
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Grok's sandbox confines the whole CLI process, so commands and file tools can read whatever
 * the CLI itself reads: its `GROK_HOME` with the login. On macOS it cannot block a command's
 * network either. Only the web tools, which run inside the CLI, are granted.
 */
const CONFINED_TOOLS: Readonly<NativeTool[]> = ["webSearch", "webFetch"];

/** Built-in tools never offered, also if a later CLI version stops honouring `--tools`. */
const DISALLOWED_TOOLS = [
	"run_terminal_command",
	"run_terminal_cmd",
	"read_file",
	"list_dir",
	"grep",
	"write",
	"write_file",
	"search_replace",
	"spawn_subagent",
	"get_command_or_subagent_output",
	"kill_command_or_subagent",
	"monitor",
	"scheduler_create",
	"scheduler_delete",
	"scheduler_list",
	"image_gen",
	"image_edit",
	"image_to_video",
	"reference_to_video",
	"video_gen",
	"memory_search",
	"session_search",
	"workflow",
	"lsp",
	"send_feedback",
	"ask_user_question",
	"update_goal",
	"Agent",
];

/** Everything the CLI would otherwise load or send besides the turn itself. */
const QUIET_ENV: Readonly<Record<string, string>> = {
	GROK_DISABLE_AUTOUPDATER: "1",
	GROK_TELEMETRY_ENABLED: "0",
	GROK_TELEMETRY_TRACE_UPLOAD: "0",
	GROK_TELEMETRY_MIXPANEL_ENABLED: "0",
	GROK_FEEDBACK_ENABLED: "0",
	GROK_MEMORY: "0",
	GROK_SUBAGENTS: "0",
	GROK_WORKFLOWS: "0",
	GROK_CAMPAIGNS: "0",
	GROK_MANAGED_MCPS_ENABLED: "0",
	GROK_RELAY_SYNC_ENABLED: "0",
	GROK_SESSION_REGISTRY: "0",
	GROK_SESSION_RECAP: "0",
	GROK_TURN_SUMMARY: "0",
	GROK_TITLE_REFRESH: "0",
	GROK_ASK_USER_QUESTION: "0",
	GROK_EXIT_TIMEOUT_SECS: "5",
	...Object.fromEntries(
		["CLAUDE", "CURSOR", "CODEX"].flatMap((vendor) =>
			["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS", "SESSIONS"].map((surface) => [
				`GROK_${vendor}_${surface}_ENABLED`,
				"false",
			]),
		),
	),
};

/**
 * The configuration of the Gateway's `GROK_HOME`, rewritten before use: no bundled skills
 * (they read other agents' sessions), memory, sub-agents, updates or telemetry, and commands
 * would inherit only core variables. Project files are not loaded: the workspace is not trusted.
 */
function managedConfig(grokHome: string, apiKey: boolean): string {
	return [
		"# Written by the Agent Gateway grok adapter; local changes are overwritten.",
		"[cli]",
		"auto_update = false",
		"use_leader = false",
		"show_tips = false",
		"session_registry = false",
		"",
		"[features]",
		"telemetry = false",
		"feedback = false",
		"campaigns = false",
		"session_recap = false",
		"turn_summary = false",
		"title_refresh = false",
		"ask_user_question = false",
		"image_gen = false",
		"video_gen = false",
		"session_search = false",
		"lsp_tools = false",
		"",
		"[memory]",
		"enabled = false",
		"",
		"[memory_v2]",
		"enabled = false",
		"",
		"[subagents]",
		"enabled = false",
		"",
		"[skills]",
		`ignore = [${JSON.stringify(join(grokHome, "bundled"))}]`,
		"",
		"[shell_environment_policy]",
		'inherit = "core"',
		"",
		"[storage]",
		"cleanup_ttl_days = 7",
		...(apiKey ? ["", "[auth]", 'preferred_method = "api_key"'] : []),
		"",
	].join("\n");
}

/** `--tools` and the flags around it. An empty `--tools` would mean every tool. */
function toolArgs(grants: NativeToolGrants): string[] {
	const tools = [
		...(grants.webSearch ? ["web_search"] : []),
		...(grants.webFetch ? ["web_fetch"] : []),
	];
	return [
		"--tools",
		// Nothing granted: the one web tool, then disabled, leaves only the MCP meta-tools, and
		// no MCP server is configured.
		tools.length === 0 ? "web_search" : tools.join(","),
		...(tools.length === 0 ? ["--disable-web-search"] : []),
		// `dontAsk` runs search as read-only, but refuses a fetch that no rule allows.
		...(grants.webFetch ? ["--allow", "WebFetch"] : []),
		"--disallowed-tools",
		DISALLOWED_TOOLS.join(","),
	];
}

const SESSION_ID = /^[0-9a-f-]{36}$/u;
/** Checked first: throttling passes, whatever else the message says. */
const RATE_LIMITED = /\b429\b|rate.?limit|too many requests|overloaded|quota/iu;
const AUTH_FAILURE = /not signed in|not authenticated|\b401\b|unauthori[sz]ed|invalid api key/iu;
const UNKNOWN_SESSION = /failed to restore session|session get failed|session .*not found/iu;
/** Failures a retry repeats: an unknown model or options the CLI rejects. */
const CONFIG_FAILURE =
	/unknown model|model .*not (supported|found|available)|--json-schema|output_schema|unexpected argument|invalid value '|sandbox profile/iu;
/** Stop reasons a retry would hit again. */
const PERMANENT_STOPS = ["max_turn_requests", "max_tokens", "refusal"];

/**
 * Grok Build through `grok --prompt-file /dev/stdin --output-format json`: the prompt on stdin,
 * the result schema through `--json-schema`. The CLI runs with the Gateway's own `GROK_HOME` and
 * an empty per-call `HOME`, so none of the operator's settings, rules, skills, plugins or
 * other agents' files load; the run workspace is not trusted, so its files never become
 * instructions. Only the granted web tools are available.
 */
export function createGrokRuntime(options: GrokRuntimeOptions): RuntimeAdapter {
	const [command = "grok", ...prefix] = options.command ?? ["grok"];
	const processes = new RunProcesses(options.killGraceMs);
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	// The CLI refuses a symlinked GROK_HOME.
	const grokHome = runtimeHome(options.grokHome);
	const baseEnv = runtimeEnvironment({
		GROK_HOME: grokHome,
		XAI_API_KEY: options.apiKey,
		...QUIET_ENV,
		...options.env,
	});
	let version: Promise<string | null> | null = null;
	/** Brings `config.toml` to its expected content before every call, atomically. */
	const configure = (): Promise<void> =>
		writeRuntimeFile(
			join(grokHome, "config.toml"),
			managedConfig(grokHome, options.apiKey !== undefined),
		);

	/** Runs `use` with an empty HOME of its own, removed afterwards. */
	const withCallHome = async <T>(use: (home: string) => Promise<T>): Promise<T> => {
		const home = await mkdtemp(join(tmpdir(), "agw-grok-"));
		try {
			return await use(home);
		} finally {
			await removeRunWorkspace(home);
		}
	};

	const simple = (args: Readonly<string[]>): Promise<ProcessResult> =>
		withCallHome((home) =>
			runProcess({
				command,
				args: [...prefix, ...args],
				cwd: home,
				env: { ...baseEnv, HOME: home, TMPDIR: home },
				stdin: "",
				maxOutputBytes: 64 * 1024,
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			}),
		);

	/** `grok/<version>`, read once. */
	const readVersion = (): Promise<string | null> => {
		version ??= simple(["--version"]).then(
			(result) => {
				const match = /^grok (\d+\.\d+\.\d+\S*)/mu.exec(result.stdout);
				return result.exitCode === 0 && match?.[1] !== undefined ? `grok/${match[1]}` : null;
			},
			() => null,
		);
		return version;
	};

	const probe = async (): Promise<RuntimeProbeResult> => {
		const risks = [
			process.getuid?.() === 0 ? "the worker runs as root" : null,
			withheldToolsRisk("grok", CONFINED_TOOLS),
		].filter((risk) => risk !== null);
		const fail = (runtimeVersion: string, detail: string): RuntimeProbeResult => ({
			ok: false,
			runtimeVersion,
			detail,
			risks,
		});
		version = null;
		try {
			await configure();
		} catch (error) {
			return fail("", `cannot write the configuration of ${grokHome}: ${String(error)}`);
		}
		const runtimeVersion = await readVersion();
		if (runtimeVersion === null) {
			return fail("", `'${command} --version' did not report a Grok version`);
		}
		const models = await simple(["models"]);
		if (models.exitCode !== 0 || AUTH_FAILURE.test(`${models.stdout}\n${models.stderr}`)) {
			return fail(
				runtimeVersion,
				options.apiKey === undefined
					? `not logged in: run \`GROK_HOME=${grokHome} grok login\``
					: "XAI_API_KEY was not accepted",
			);
		}
		const method = options.apiKey === undefined ? "login" : "API key";
		return { ok: true, runtimeVersion, detail: `${runtimeVersion}, ${method}`, risks };
	};

	/** Removes a session the run should not keep; the CLI has no flag for that. */
	const forgetSession = async (sessionId: string): Promise<void> => {
		if (!SESSION_ID.test(sessionId)) {
			return;
		}
		const sessions = join(grokHome, "sessions");
		const entries = await readdir(sessions, { withFileTypes: true }).catch(() => []);
		for (const group of entries.filter((entry) => entry.isDirectory())) {
			const transcript = join(sessions, group.name, sessionId);
			if (existsSync(transcript)) {
				await rm(transcript, { recursive: true, force: true });
				// The group of this attempt's own workspace; empty now unless reused.
				await rmdir(join(sessions, group.name)).catch(() => undefined);
			}
		}
	};

	const execute = async (
		input: AgentTurnInput,
		prompt: string,
		turnOptions: TurnOptions,
		resume: RuntimeSessionHandle | null,
	): Promise<RuntimeTurnOutput> => {
		await configure();
		const grants = confinedGrants(nativeToolGrants(input.toolPolicy), CONFINED_TOOLS);
		// The version this call runs under, read before it: a probe may reset it meanwhile.
		const runtimeVersion = await readVersion();
		// A new session gets its id from the adapter, so its transcript can always be removed.
		const newSession = resume === null ? randomUUID() : null;
		const args = [
			"--prompt-file",
			"/dev/stdin",
			"--verbatim",
			"--output-format",
			"json",
			"--json-schema",
			JSON.stringify(withoutUnanchoredPatterns(input.outputSchema)),
			"--cwd",
			turnOptions.workspacePath,
			// Writes of the CLI itself stay in the workspace, GROK_HOME and temp directories.
			"--sandbox",
			"workspace",
			"--no-subagents",
			"--no-plan",
			"--permission-mode",
			"dontAsk",
			...toolArgs(grants),
			"--max-turns",
			String(options.maxTurns ?? DEFAULT_MAX_TURNS),
			...(turnOptions.model === null ? [] : ["--model", turnOptions.model]),
			...(resume === null ? [] : ["--resume", resume.providerSessionId]),
			...(newSession === null ? [] : ["--session-id", newSession]),
		];
		const output = await withCallHome((home) =>
			processes.run(input.runId, {
				command,
				args: [...prefix, ...args],
				cwd: turnOptions.workspacePath,
				env: {
					...baseEnv,
					HOME: home,
					TMPDIR: home,
					// Inline search on the xAI side and the fetch tool follow the grants.
					GROK_BACKEND_SEARCH: grants.webSearch ? "1" : "0",
					GROK_WEB_FETCH: grants.webFetch ? "1" : "0",
				},
				stdin: prompt,
				maxOutputBytes,
				signal: turnOptions.signal,
			}),
		);
		let kept = false;
		try {
			const result = interpret(output, resume, turnOptions, runtimeVersion).output;
			kept = result.session !== null;
			return result;
		} finally {
			// Only a session handed back to the Gateway may be resumed; any other is removed, also
			// after a failure, a timeout or a cancel (the id was chosen before the call).
			if (!kept && newSession !== null) {
				await forgetSession(newSession);
			}
		}
	};

	const interpret = (
		result: ProcessResult,
		resume: RuntimeSessionHandle | null,
		turnOptions: TurnOptions,
		runtimeVersion: string | null,
	): Readonly<{ output: RuntimeTurnOutput; sessionId: string | null }> => {
		if (result.aborted) {
			throw new RuntimeError("grok was stopped", false);
		}
		const output = asRecord(parseJson(result.stdout) ?? undefined);
		// Only the CLI's own error output counts: a successful answer may contain any text.
		const failure =
			output === null ? result.stderr : output.type === "error" ? asString(output.message) : null;
		if (resume !== null && failure !== null && UNKNOWN_SESSION.test(failure)) {
			throw new SessionUnavailableError(`grok cannot resume session ${resume.providerSessionId}`);
		}
		if (output === null || output.type === "error") {
			// stdout would be the model's answer: only its size goes into the report.
			const detail =
				output === null
					? `${tail(result.stderr)} (stdout: ${result.stdout.length} characters${result.truncated ? ", truncated" : ""})`
					: tail(failure ?? "");
			throw new RuntimeError(
				`grok exited with ${result.exitCode ?? result.exitSignal}: ${detail}`,
				RATE_LIMITED.test(detail) || (!AUTH_FAILURE.test(detail) && !CONFIG_FAILURE.test(detail)),
			);
		}
		const stopReason = asString(output.stopReason) ?? "unknown";
		if (result.exitCode !== 0 || stopReason !== "end_turn") {
			throw new RuntimeError(
				`grok stopped with ${stopReason} (exit ${result.exitCode ?? result.exitSignal})`,
				!PERMANENT_STOPS.includes(stopReason),
			);
		}
		const structured = output.structuredOutput;
		// Without structured output the text answer is validated (and repaired) instead; it is
		// never posted as it is.
		const modelOutput: JsonValue =
			structured !== undefined && structured !== null
				? structured
				: parseJsonAnswer(asString(output.text) ?? "");
		const usage = asRecord(output.usage);
		const cacheRead = asCount(usage?.cache_read_input_tokens);
		const runUsage: RuntimeUsage = {
			inputTokens:
				asCount(usage?.input_tokens) + asCount(usage?.cache_creation_input_tokens) + cacheRead,
			outputTokens: asCount(usage?.output_tokens),
			cachedInputTokens: cacheRead,
			costUsd: typeof output.total_cost_usd === "number" ? output.total_cost_usd : null,
			durationMs: result.durationMs,
			model: Object.keys(asRecord(output.modelUsage) ?? {})[0] ?? turnOptions.model,
		};
		const sessionId = asString(output.sessionId);
		if (resume !== null && sessionId !== null && sessionId !== resume.providerSessionId) {
			// The CLI started a new session instead of resuming: the earlier context is gone.
			throw new SessionUnavailableError(
				`grok started session ${sessionId} instead of resuming ${resume.providerSessionId}`,
			);
		}
		const session: RuntimeSessionHandle | null =
			turnOptions.persistSession && sessionId !== null && runtimeVersion !== null
				? {
						adapter: "grok",
						providerSessionId: sessionId,
						runtimeVersion,
						expiresAt: new Date(
							Date.now() + (options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS),
						).toISOString(),
					}
				: null;
		return { output: { modelOutput, usage: runUsage, session }, sessionId };
	};

	return {
		id: "grok",
		capabilities: { sessionResume: true, confinedTools: CONFINED_TOOLS },
		probe,
		health: async () => {
			const result = await probe();
			return { healthy: result.ok, detail: result.detail };
		},
		startTurn: (input, turnOptions) =>
			execute(input, renderTurnPrompt(input, CONFINED_TOOLS), turnOptions, null),
		continueTurn: (session, input, turnOptions) =>
			execute(input, renderTurnPrompt(input, CONFINED_TOOLS), turnOptions, session),
		repairTurn: (input, repair, turnOptions) =>
			execute(input, renderRepairPrompt(input, repair, CONFINED_TOOLS), turnOptions, null),
		cancel: async (runId) => {
			const cancelled = await processes.cancel(runId);
			return { cancelled, detail: cancelled ? "process group stopped" : "no running process" };
		},
		collectArtifacts: async () => [],
	};
}
