import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
	AgentTurnInput,
	JsonObject,
	JsonValue,
	RuntimeSessionHandle,
	RuntimeUsage,
} from "@agent-gateway/contracts";
import {
	ALL_NATIVE_TOOLS,
	asCount,
	asRecord,
	asString,
	type NativeToolGrants,
	nativeToolGrants,
	type ProcessResult,
	parseJson,
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
	SessionUnavailableError,
	sandboxPath,
	type TurnOptions,
	tail,
} from "@agent-gateway/runtime-sdk";

export type ClaudeRuntimeOptions = Readonly<{
	/** Command that starts the Claude Code CLI: a pinned binary, or a fake in tests. */
	command?: Readonly<string[]>;
	/** `CLAUDE_CONFIG_DIR` with the login and the session files; `~/.claude` if unset. */
	configDir?: string;
	/** `ANTHROPIC_API_KEY`; takes precedence over any login. */
	apiKey?: string;
	/** `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. */
	oauthToken?: string;
	/** Agentic turns per call (`--max-turns`). */
	maxTurns?: number;
	/** Spend limit per call (`--max-budget-usd`). */
	maxBudgetUsd?: number;
	/** Additional environment of the process, e.g. for a fake CLI in tests. */
	env?: Readonly<Record<string, string>>;
	maxOutputBytes?: number;
	killGraceMs?: number;
	/** How long a stored session may be offered again. */
	sessionTtlMs?: number;
}>;

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
/** Where the worker keeps its secret files in a deployment. */
const SECRETS_DIR = "/run/secrets";
/** Parent of the per-call temp directories; short on purpose (see `execute`). */
const SHORT_TEMP_ROOT = "/tmp";
const DEFAULT_MAX_TURNS = 40;
const PROBE_TIMEOUT_MS = 20_000;

/** Built-in tools per grant; everything else (sub-agents, MCP, skills) stays unavailable. */
function allowedTools(grants: NativeToolGrants): string[] {
	return [
		...(grants.read ? ["Read", "Grep", "Glob"] : []),
		...(grants.write ? ["Edit", "Write", "NotebookEdit"] : []),
		...(grants.exec ? ["Bash"] : []),
		...(grants.webSearch ? ["WebSearch"] : []),
		...(grants.webFetch ? ["WebFetch"] : []),
	];
}

/** The provider schema without `$schema`: Claude Code rejects the 2020-12 meta-schema id. */
function claudeSchema(schema: JsonObject): JsonObject {
	const { $schema: _, ...rest } = schema;
	return rest;
}

/**
 * Settings of the Bash sandbox (Seatbelt on macOS, bubblewrap on Linux; without it the CLI
 * refuses to start). Commands may read the system and the run workspace only: not the home
 * directory, the config dir with the login, other runs' workspaces or the worker's secrets; they
 * write only into the workspace and reach no network.
 */
function bashSandbox(
	workspacePath: string,
	callTemp: string,
	configDir: string | undefined,
): string {
	// The account's home, also when HOME is unset or points elsewhere.
	const homes = [...new Set([homedir(), process.env.HOME ?? ""].filter((home) => home !== ""))];
	const denyRead = [
		...homes,
		...(configDir === undefined ? [] : [configDir]),
		// The worker's own temp directory (other adapters' call files) and /tmp (other runs'
		// temp directories): only this call's own temp directory is readable.
		tmpdir(),
		SHORT_TEMP_ROOT,
		dirname(dirname(workspacePath)),
		SECRETS_DIR,
	].map(sandboxPath);
	return JSON.stringify({
		sandbox: {
			enabled: true,
			failIfUnavailable: true,
			allowUnsandboxedCommands: false,
			autoAllowBashIfSandboxed: true,
			filesystem: { denyRead, allowRead: [workspacePath, sandboxPath(callTemp)] },
		},
	});
}

const AUTH_FAILURE = /\b401\b|invalid api key|please run \/login|not logged in|oauth token/iu;
const UNKNOWN_SESSION = /no conversation found with session id/iu;
/** Failures a retry repeats: an unknown model or options the CLI rejects. */
const CONFIG_FAILURE =
	/model .*not (supported|found|available)|invalid model|not a valid json schema|unknown option/iu;
/** Limits that a retry would hit again: turns, budget, repeated structured-output failures. */
const PERMANENT_SUBTYPES = [
	"error_max_turns",
	"error_max_budget_usd",
	"error_max_structured_output_retries",
];

/**
 * Claude Code through `claude -p --output-format json`: the prompt on stdin, the result schema
 * through `--json-schema`. `--safe-mode` drops CLAUDE.md, skills, plugins, hooks and MCP
 * servers; `--restricted` confines the file tools to the run workspace and ignores settings
 * files; `dontAsk` denies every tool the policy did not grant.
 */
export function createClaudeRuntime(options: ClaudeRuntimeOptions = {}): RuntimeAdapter {
	const [command = "claude", ...prefix] = options.command ?? ["claude"];
	const processes = new RunProcesses(options.killGraceMs);
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const env = runtimeEnvironment({
		CLAUDE_CONFIG_DIR: options.configDir,
		ANTHROPIC_API_KEY: options.apiKey,
		CLAUDE_CODE_OAUTH_TOKEN: options.oauthToken,
		...options.env,
	});
	let version: Promise<string | null> | null = null;

	const simple = (args: Readonly<string[]>): Promise<ProcessResult> =>
		runProcess({
			command,
			args: [...prefix, ...args],
			cwd: tmpdir(),
			env,
			stdin: "",
			maxOutputBytes: 64 * 1024,
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});

	/** `claude-code/<version>`, read once. */
	const readVersion = (): Promise<string | null> => {
		version ??= simple(["--version"]).then(
			(result) => {
				const match = /^(\d+\.\d+\.\d+\S*)\s+\(Claude Code\)/mu.exec(result.stdout);
				return result.exitCode === 0 && match?.[1] !== undefined ? `claude-code/${match[1]}` : null;
			},
			() => null,
		);
		return version;
	};

	const probe = async (): Promise<RuntimeProbeResult> => {
		const risks = [
			process.getuid?.() === 0 ? "the worker runs as root" : null,
			"granted Bash commands (tests.run) run in Claude Code's sandbox, which denies reads by list: everything except the home, config, secrets, temp and workspace-root directories is readable; keep other credentials of this user inside the home",
		].filter((risk) => risk !== null);
		const fail = (runtimeVersion: string, detail: string): RuntimeProbeResult => ({
			ok: false,
			runtimeVersion,
			detail,
			risks,
		});
		version = null;
		const runtimeVersion = await readVersion();
		if (runtimeVersion === null) {
			return fail("", `'${command} --version' did not report a Claude Code version`);
		}
		const status = await simple(["auth", "status"]);
		const state = asRecord(parseJson(status.stdout) ?? undefined);
		if (status.exitCode !== 0 || state?.loggedIn !== true) {
			return fail(runtimeVersion, "not logged in: run `claude auth login` with this config dir");
		}
		// The status also names the account; only the method is reported.
		const method = asString(state.authMethod) ?? "unknown method";
		return { ok: true, runtimeVersion, detail: `${runtimeVersion}, logged in (${method})`, risks };
	};

	const execute = async (
		input: AgentTurnInput,
		prompt: string,
		turnOptions: TurnOptions,
		resume: RuntimeSessionHandle | null,
	): Promise<RuntimeTurnOutput> => {
		const grants = nativeToolGrants(input.toolPolicy);
		// The CLI's scratch files and Bash's temp files go to a directory of this call only, removed
		// afterwards. It has to be short: for a long one Claude Code gives Bash the shared per-user
		// /tmp/claude-<uid> instead.
		const callTemp = await mkdtemp(join(SHORT_TEMP_ROOT, "agw-"));
		const callEnv = { ...env, TMPDIR: callTemp, CLAUDE_CODE_TMPDIR: callTemp };
		const tools = allowedTools(grants).join(",");
		const args = [
			"-p",
			"--output-format",
			"json",
			"--json-schema",
			JSON.stringify(claudeSchema(input.outputSchema)),
			"--safe-mode",
			"--restricted",
			"--strict-mcp-config",
			"--disable-slash-commands",
			"--permission-mode",
			"dontAsk",
			// Nobody answers a permission prompt: whatever is not allowed below is denied.
			"--permission-prompts",
			"none",
			"--tools",
			tools,
			...(tools === "" ? [] : ["--allowedTools", tools]),
			...(grants.exec
				? ["--settings", bashSandbox(turnOptions.workspacePath, callTemp, options.configDir)]
				: []),
			"--max-turns",
			String(options.maxTurns ?? DEFAULT_MAX_TURNS),
			...(options.maxBudgetUsd === undefined
				? []
				: ["--max-budget-usd", String(options.maxBudgetUsd)]),
			...(turnOptions.model === null ? [] : ["--model", turnOptions.model]),
			...(turnOptions.persistSession ? [] : ["--no-session-persistence"]),
			...(resume === null ? [] : ["--resume", resume.providerSessionId]),
		];
		try {
			const result = await processes.run(input.runId, {
				command,
				args: [...prefix, ...args],
				cwd: turnOptions.workspacePath,
				// Bash commands would inherit the credential variables; Claude Code scrubs them (on
				// Linux this needs bubblewrap, without it the CLI refuses to start: fail-closed).
				env: grants.exec ? { ...callEnv, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" } : callEnv,
				stdin: prompt,
				maxOutputBytes,
				signal: turnOptions.signal,
			});
			return interpret(result, resume, turnOptions, await readVersion());
		} finally {
			await removeRunWorkspace(callTemp);
		}
	};

	const interpret = (
		result: ProcessResult,
		resume: RuntimeSessionHandle | null,
		turnOptions: TurnOptions,
		runtimeVersion: string | null,
	): RuntimeTurnOutput => {
		if (result.aborted) {
			throw new RuntimeError("claude was stopped", false);
		}
		const output = asRecord(parseJson(result.stdout) ?? undefined);
		const text = asString(output?.result) ?? "";
		// Only the CLI's own error output counts: a successful answer may contain any text.
		const failedOutput = output === null ? result.stdout : output.is_error === true ? text : "";
		if (resume !== null && UNKNOWN_SESSION.test(`${failedOutput}\n${result.stderr}`)) {
			throw new SessionUnavailableError(`claude cannot resume session ${resume.providerSessionId}`);
		}
		if (output === null) {
			// stdout would be the model's answer: only its size goes into the report.
			const detail = `${tail(result.stderr)} (stdout: ${result.stdout.length} characters${result.truncated ? ", truncated" : ""})`;
			throw new RuntimeError(
				`claude exited with ${result.exitCode ?? result.exitSignal}: ${detail}`,
				!AUTH_FAILURE.test(detail) && !CONFIG_FAILURE.test(detail),
			);
		}
		const subtype = asString(output.subtype) ?? "unknown";
		if (output.is_error === true || subtype !== "success" || result.exitCode !== 0) {
			// `result` of an error is the CLI's own message, not the model's answer.
			const detail = `${subtype}: ${tail(text)}`;
			const permanent =
				AUTH_FAILURE.test(detail) ||
				CONFIG_FAILURE.test(detail) ||
				output.api_error_status === 401 ||
				PERMANENT_SUBTYPES.includes(subtype);
			throw new RuntimeError(`claude failed: ${detail}`, !permanent);
		}
		const structured = output.structured_output;
		// Without structured output the text answer is validated (and repaired) instead; it is
		// never posted as it is.
		const modelOutput: JsonValue =
			structured !== undefined && structured !== null ? structured : (parseJson(text) ?? text);
		const usage = asRecord(output.usage);
		const models = Object.keys(asRecord(output.modelUsage) ?? {});
		const cacheRead = asCount(usage?.cache_read_input_tokens);
		const runUsage: RuntimeUsage = {
			inputTokens:
				asCount(usage?.input_tokens) + asCount(usage?.cache_creation_input_tokens) + cacheRead,
			outputTokens: asCount(usage?.output_tokens),
			cachedInputTokens: cacheRead,
			costUsd: typeof output.total_cost_usd === "number" ? output.total_cost_usd : null,
			durationMs: result.durationMs,
			model: models[0] ?? turnOptions.model,
		};
		const sessionId = asString(output.session_id);
		const session: RuntimeSessionHandle | null =
			turnOptions.persistSession && sessionId !== null && runtimeVersion !== null
				? {
						adapter: "claude-code",
						providerSessionId: sessionId,
						runtimeVersion,
						expiresAt: new Date(
							Date.now() + (options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS),
						).toISOString(),
					}
				: null;
		return { modelOutput, usage: runUsage, session };
	};

	return {
		id: "claude-code",
		capabilities: { sessionResume: true, confinedTools: ALL_NATIVE_TOOLS },
		probe,
		health: async () => {
			const result = await probe();
			return { healthy: result.ok, detail: result.detail };
		},
		startTurn: (input, turnOptions) => execute(input, renderTurnPrompt(input), turnOptions, null),
		continueTurn: (session, input, turnOptions) =>
			execute(input, renderTurnPrompt(input), turnOptions, session),
		repairTurn: (input, repair, turnOptions) =>
			execute(input, renderRepairPrompt(input, repair), turnOptions, null),
		cancel: async (runId) => {
			const cancelled = await processes.cancel(runId);
			return { cancelled, detail: cancelled ? "process group stopped" : "no running process" };
		},
		collectArtifacts: async () => [],
	};
}
