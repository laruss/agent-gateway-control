import { mkdtemp } from "node:fs/promises";
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
	SessionUnavailableError,
	type TurnOptions,
	tail,
	withheldToolsRisk,
	writeRuntimeFile,
} from "@agent-gateway/runtime-sdk";

export type HermesRuntimeOptions = Readonly<{
	/** Command that starts Hermes: a pinned install, or a fake in tests. */
	command?: Readonly<string[]>;
	/**
	 * `HERMES_HOME` of the Gateway: the provider login (`HERMES_HOME=<dir> hermes auth add`), the
	 * session database and the configuration this adapter writes. Never the operator's own
	 * `~/.hermes`, whose messaging gateway, memory and skills must stay out of the Gateway's runs.
	 */
	hermesHome: string;
	/** Inference provider (`--provider`), e.g. `openai-codex`; Hermes' own choice if unset. */
	provider?: string;
	/** Tool-calling iterations per turn (`--max-turns`). */
	maxTurns?: number;
	/** Additional environment of the process, e.g. provider keys or a fake CLI in tests. */
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
 * Hermes runs its terminal and file tools on the host: reads are not restricted at all, and
 * commands start their own sessions. Only its web tools, which run in the Hermes process, are
 * granted.
 */
const CONFINED_TOOLS: Readonly<NativeTool[]> = ["webSearch", "webFetch"];

/** Toolsets never enabled, a second guard behind the explicit per-turn list. */
const DISABLED_TOOLSETS = [
	"terminal",
	"file",
	"browser",
	"code_execution",
	"delegation",
	"cronjob",
	"memory",
	"skills",
	"session_search",
	"messaging",
	"discord",
	"kanban",
	"computer_use",
	"clarify",
	"todo",
	"vision",
	"image_gen",
	"video_gen",
	"tts",
	"homeassistant",
	"connections",
	"desktop_ui",
	"x_search",
];

/** Rules files, memory, skills, plugins, MCP servers and hooks are all skipped. */
const QUIET_ENV: Readonly<Record<string, string>> = {
	HERMES_IGNORE_RULES: "1",
	HERMES_SAFE_MODE: "1",
	HERMES_SIGTERM_GRACE: "2",
	NO_COLOR: "1",
	TERM: "dumb",
};

/**
 * The configuration of the Gateway's `HERMES_HOME`, rewritten before use: no borrowed logins
 * of other CLIs, memory, self-review, curator, updates, telemetry, MCP servers or checkpoints,
 * dangerous commands refused, and no tools unless a turn names its toolsets.
 */
function managedConfig(): string {
	return [
		"# Written by the Agent Gateway hermes adapter; local changes are overwritten.",
		"auth:",
		"  adopt_external_logins: false",
		"memory:",
		"  memory_enabled: false",
		"  user_profile_enabled: false",
		"auxiliary:",
		"  background_review:",
		"    enabled: false",
		"  title_generation:",
		"    enabled: false",
		"curator:",
		"  enabled: false",
		"honcho: {}",
		"updates:",
		"  check: false",
		"telemetry:",
		"  shared_metrics:",
		"    enabled: false",
		"mcp_servers: {}",
		"tool_search:",
		"  enabled: off",
		"approvals:",
		"  single_query_mode: deny",
		"checkpoints:",
		"  enabled: false",
		"web:",
		"  keyless_fallback: false",
		"platform_toolsets:",
		"  cli: []",
		"agent:",
		"  disabled_toolsets:",
		...DISABLED_TOOLSETS.map((toolset) => `    - ${toolset}`),
		"",
	].join("\n");
}

/**
 * The toolsets of a turn and the tools they really give. Hermes fetches pages only in the `web`
 * toolset, which also searches, so a fetch grant alone gives nothing.
 */
function toolsetsOf(grants: NativeToolGrants): Readonly<{
	toolsets: Readonly<string[]>;
	confinable: Readonly<NativeTool[]>;
}> {
	if (grants.webSearch && grants.webFetch) {
		return { toolsets: ["web"], confinable: CONFINED_TOOLS };
	}
	if (grants.webSearch) {
		return { toolsets: ["search"], confinable: ["webSearch"] };
	}
	return { toolsets: [], confinable: [] };
}

/** Hermes session ids, e.g. `20260926_182717_6fbd17`. */
const SESSION_ID = /^[\w-]{1,64}$/u;
/** Checked first: throttling passes, whatever else the message says. */
const RATE_LIMITED = /\b429\b|rate.?limit|too many requests|overloaded|quota/iu;
const AUTH_FAILURE =
	/logged out|not logged in|no .*credentials|\b401\b|unauthori[sz]ed|invalid api key|authentication/iu;
const UNKNOWN_SESSION = /session .*not found|no session|unknown session/iu;
/** Failures a retry repeats: an unknown model or provider, or options Hermes rejects. */
const CONFIG_FAILURE = /unknown provider|model .*not (found|supported|available)|invalid model/iu;

/**
 * Hermes Agent through `hermes chat --query-file - --format stream-json`: the prompt on stdin,
 * JSON events on stdout. It runs with the Gateway's own `HERMES_HOME` and an empty per-call
 * `HOME`; rules files, memory, skills, plugins, MCP servers and hooks are skipped, and the
 * messaging gateway of Hermes is never started. Hermes has no structured output: the prompt
 * carries the result schema, and the Gateway validates the answer.
 */
export function createHermesRuntime(options: HermesRuntimeOptions): RuntimeAdapter {
	const [command = "hermes", ...prefix] = options.command ?? ["hermes"];
	const processes = new RunProcesses(options.killGraceMs);
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const hermesHome = runtimeHome(options.hermesHome);
	const baseEnv = runtimeEnvironment({
		HERMES_HOME: hermesHome,
		...QUIET_ENV,
		...options.env,
	});
	let version: Promise<string | null> | null = null;
	/** Brings `config.yaml` to its expected content before every call, atomically. */
	const configure = (): Promise<void> =>
		writeRuntimeFile(join(hermesHome, "config.yaml"), managedConfig());

	/** Runs `use` with an empty HOME of its own, removed afterwards. */
	const withCallHome = async <T>(use: (home: string) => Promise<T>): Promise<T> => {
		const home = await mkdtemp(join(tmpdir(), "agw-hermes-"));
		try {
			return await use(home);
		} finally {
			await removeRunWorkspace(home);
		}
	};

	const simple = (args: Readonly<string[]>, cwd?: string): Promise<ProcessResult> =>
		withCallHome((home) =>
			runProcess({
				command,
				args: [...prefix, ...args],
				cwd: cwd ?? home,
				env: { ...baseEnv, HOME: home, TMPDIR: home },
				stdin: "",
				maxOutputBytes: 64 * 1024,
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			}),
		);

	/** `hermes/<version>`, read once. */
	const readVersion = (): Promise<string | null> => {
		version ??= simple(["--version"]).then(
			(result) => {
				const match = /^Hermes Agent v(\d+\.\d+\.\d+\S*)/mu.exec(result.stdout);
				return result.exitCode === 0 && match?.[1] !== undefined ? `hermes/${match[1]}` : null;
			},
			() => null,
		);
		return version;
	};

	const probe = async (): Promise<RuntimeProbeResult> => {
		const risks = [
			process.getuid?.() === 0 ? "the worker runs as root" : null,
			withheldToolsRisk("hermes", CONFINED_TOOLS),
			options.provider === undefined
				? "no HERMES_PROVIDER: the probe cannot check the login; the doctor's turn does"
				: null,
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
			return fail("", `cannot write the configuration of ${hermesHome}: ${String(error)}`);
		}
		const runtimeVersion = await readVersion();
		if (runtimeVersion === null) {
			return fail("", `'${command} --version' did not report a Hermes version`);
		}
		// Sessions past their lifetime can no longer be resumed; the Gateway's runs are tagged.
		// Also while the login fails: expired transcripts go regardless.
		const days = Math.max(
			1,
			Math.ceil((options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS) / 86_400_000),
		);
		await simple([
			"sessions",
			"prune",
			"--older-than",
			String(days),
			"--source",
			"tool",
			"--yes",
		]).catch(() => undefined);
		if (options.provider !== undefined) {
			const status = await simple(["auth", "status", options.provider]);
			if (status.exitCode !== 0 || AUTH_FAILURE.test(`${status.stdout}\n${status.stderr}`)) {
				return fail(
					runtimeVersion,
					`not logged in to ${options.provider}: run \`HERMES_HOME=${hermesHome} hermes auth add ${options.provider}\``,
				);
			}
		}
		const provider = options.provider ?? "provider chosen by Hermes";
		return { ok: true, runtimeVersion, detail: `${runtimeVersion}, ${provider}`, risks };
	};

	const execute = async (
		input: AgentTurnInput,
		render: (confinable: Readonly<NativeTool[]>) => string,
		turnOptions: TurnOptions,
		resume: RuntimeSessionHandle | null,
	): Promise<RuntimeTurnOutput> => {
		await configure();
		// The version this call runs under, read before it: a probe may reset it meanwhile.
		const runtimeVersion = await readVersion();
		const { toolsets, confinable } = toolsetsOf(
			confinedGrants(nativeToolGrants(input.toolPolicy), CONFINED_TOOLS),
		);
		const args = [
			"chat",
			"--query-file",
			"-",
			"--format",
			"stream-json",
			"--source",
			"tool",
			"--ignore-rules",
			"--max-turns",
			String(options.maxTurns ?? DEFAULT_MAX_TURNS),
			...(options.provider === undefined ? [] : ["--provider", options.provider]),
			...(turnOptions.model === null ? [] : ["--model", turnOptions.model]),
			// No toolsets named: the configuration's empty list applies.
			...(toolsets.length === 0 ? [] : ["--toolsets", toolsets.join(",")]),
			...(resume === null ? [] : ["--resume", resume.providerSessionId, "--no-restore-cwd"]),
		];
		const result = await withCallHome((home) =>
			processes.run(input.runId, {
				command,
				args: [...prefix, ...args],
				cwd: turnOptions.workspacePath,
				env: { ...baseEnv, HOME: home, TMPDIR: home },
				stdin: render(confinable),
				maxOutputBytes,
				signal: turnOptions.signal,
			}),
		);
		const events = parseJsonLines(result.stdout);
		const final = events.findLast((event) => event.type === "result") ?? null;
		const sessionId =
			asString(final?.session_id) ??
			events.map((event) => asString(event.session_id)).find((id) => id !== null) ??
			null;
		let kept = false;
		try {
			const output = interpret(result, final, sessionId, resume, turnOptions, runtimeVersion);
			kept = output.session !== null;
			return output;
		} finally {
			// Only a session handed back to the Gateway may be resumed; any other is removed (a
			// resumed one stays: the Gateway still holds it), from
			// a home of its own (after a cancel the workspace may already be gone).
			if (
				!kept &&
				sessionId !== null &&
				sessionId !== resume?.providerSessionId &&
				SESSION_ID.test(sessionId)
			) {
				await simple(["sessions", "delete", "--yes", "--", sessionId]).catch(() => undefined);
			}
		}
	};

	const interpret = (
		result: ProcessResult,
		final: Readonly<Record<string, JsonValue>> | null,
		sessionId: string | null,
		resume: RuntimeSessionHandle | null,
		turnOptions: TurnOptions,
		runtimeVersion: string | null,
	): RuntimeTurnOutput => {
		if (result.aborted) {
			throw new RuntimeError("hermes was stopped", false);
		}
		// Only Hermes' own messages: the result text would be the model's answer.
		const error = asString(final?.error) ?? tail(result.stderr);
		if (resume !== null && final?.exit_code !== 0 && UNKNOWN_SESSION.test(error)) {
			throw new SessionUnavailableError(`hermes cannot resume session ${resume.providerSessionId}`);
		}
		if (final === null || result.exitCode !== 0 || final.exit_code !== 0) {
			const detail =
				final === null
					? `${tail(result.stderr)} (stdout: ${result.stdout.length} characters${result.truncated ? ", truncated" : ""})`
					: tail(error);
			throw new RuntimeError(
				`hermes exited with ${result.exitCode ?? result.exitSignal}: ${detail}`,
				RATE_LIMITED.test(detail) || (!AUTH_FAILURE.test(detail) && !CONFIG_FAILURE.test(detail)),
			);
		}
		const tokens = asRecord(final.tokens);
		const usage: RuntimeUsage = {
			inputTokens: asCount(tokens?.input),
			outputTokens: asCount(tokens?.output),
			cachedInputTokens: asCount(tokens?.cache_read),
			costUsd: null,
			durationMs: result.durationMs,
			model: turnOptions.model,
		};
		if (resume !== null && sessionId !== null && sessionId !== resume.providerSessionId) {
			// The CLI started a new session instead of resuming: the earlier context is gone.
			throw new SessionUnavailableError(
				`hermes started session ${sessionId} instead of resuming ${resume.providerSessionId}`,
			);
		}
		const session: RuntimeSessionHandle | null =
			turnOptions.persistSession && sessionId !== null && runtimeVersion !== null
				? {
						adapter: "hermes",
						providerSessionId: sessionId,
						runtimeVersion,
						expiresAt: new Date(
							Date.now() + (options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS),
						).toISOString(),
					}
				: null;
		return { modelOutput: parseJsonAnswer(asString(final.text) ?? ""), usage, session };
	};

	return {
		id: "hermes",
		capabilities: { sessionResume: true, confinedTools: CONFINED_TOOLS },
		probe,
		health: async () => {
			const result = await probe();
			return { healthy: result.ok, detail: result.detail };
		},
		startTurn: (input, turnOptions) =>
			execute(input, (tools) => renderTurnPrompt(input, tools), turnOptions, null),
		continueTurn: (session, input, turnOptions) =>
			execute(input, (tools) => renderTurnPrompt(input, tools), turnOptions, session),
		repairTurn: (input, repair, turnOptions) =>
			execute(input, (tools) => renderRepairPrompt(input, repair, tools), turnOptions, null),
		cancel: async (runId) => {
			const cancelled = await processes.cancel(runId);
			return { cancelled, detail: cancelled ? "process group stopped" : "no running process" };
		},
		collectArtifacts: async () => [],
	};
}
