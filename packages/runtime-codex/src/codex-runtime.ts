import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentTurnInput,
	JsonValue,
	RuntimeSessionHandle,
	RuntimeUsage,
} from "@agent-gateway/contracts";
import {
	type NativeToolGrants,
	nativeToolGrants,
	type ProcessResult,
	RunProcesses,
	type RuntimeAdapter,
	RuntimeError,
	type RuntimeProbeResult,
	type RuntimeTurnOutput,
	renderRepairPrompt,
	renderTurnPrompt,
	runProcess,
	runTempDir,
	runtimeEnvironment,
	SessionUnavailableError,
	sandboxPath,
	type TurnOptions,
} from "@agent-gateway/runtime-sdk";

export type CodexRuntimeOptions = Readonly<{
	/** Command that starts the Codex CLI: a pinned binary, or a fake in tests. */
	command?: Readonly<string[]>;
	/** `CODEX_HOME` with the login (`auth.json`) and the session files; `~/.codex` if unset. */
	codexHome?: string;
	/** API key for `codex exec` (`CODEX_API_KEY`); the login in `CODEX_HOME` otherwise. */
	apiKey?: string;
	/** Additional environment of the process, e.g. for a fake CLI in tests. */
	env?: Readonly<Record<string, string>>;
	/** Output kept per stream. */
	maxOutputBytes?: number;
	killGraceMs?: number;
	/** How long a stored session may be offered again. */
	sessionTtlMs?: number;
}>;

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 20_000;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
/** Name of the permission profile the adapter defines for its commands. */
const PROFILE = "gateway";

/**
 * Codex features that reach beyond the run workspace or the structured result: connectors,
 * browsers, desktop control, sub-agents, hooks. Unknown names fail the run (`--strict-config`),
 * which pins the adapter to the Codex versions it was verified against.
 */
const DISABLED_FEATURES = [
	"apps",
	"plugins",
	"browser_use",
	"browser_use_external",
	"computer_use",
	"multi_agent",
	"hooks",
	"image_generation",
	// Reads image files by path in the CLI itself, outside the command sandbox.
	"view_image",
];

/**
 * Features that run commands. Codex reads files only through them, but they run any program:
 * they are enabled only when `tests.run` is granted, so `repository.read` alone gives Codex no
 * file access (fail-closed).
 */
const SHELL_FEATURES = ["shell_tool", "unified_exec"];

type CodexEvent = Readonly<{
	type: string;
	threadId: string | null;
	text: string | null;
	usage: CodexUsage | null;
	error: string | null;
}>;

type CodexUsage = Readonly<{ input: number; cached: number; output: number }>;

function asRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function asString(value: JsonValue | undefined): string | null {
	return typeof value === "string" ? value : null;
}

function asCount(value: JsonValue | undefined): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** One line of `codex exec --json`; lines that are not events are skipped. */
function parseEvent(line: string): CodexEvent | null {
	let value: JsonValue;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	const event = asRecord(value);
	const type = asString(event?.type);
	if (event === null || type === null) {
		return null;
	}
	const item = asRecord(event.item);
	const usage = asRecord(event.usage);
	const error = asRecord(event.error);
	return {
		type,
		threadId: asString(event.thread_id),
		text: item !== null && asString(item.type) === "agent_message" ? asString(item.text) : null,
		usage:
			usage === null
				? null
				: {
						input: asCount(usage.input_tokens),
						cached: asCount(usage.cached_input_tokens),
						// Reasoning tokens are part of `output_tokens`, reported separately as well.
						output: asCount(usage.output_tokens),
					},
		error: asString(error?.message) ?? (type === "error" ? asString(event.message) : null),
	};
}

function tail(text: string, max = 600): string {
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

const AUTH_FAILURE = /\b401\b|unauthori[sz]ed|not logged in|login required|invalid api key/iu;
/** Failures a retry repeats: an unknown model or a config the CLI rejects. */
const CONFIG_FAILURE =
	/model .*not (supported|found)|unknown model|invalid model|error loading config|unknown (configuration field|variant|feature)/iu;
/** The messages of Codex versions for a session it does not have. */
const UNKNOWN_SESSION = /no rollout found|thread\/resume failed|thread \S+ not found/iu;

/** A TOML basic string (JSON string syntax is a subset of it). */
function tomlString(value: string): string {
	return JSON.stringify(value);
}

/**
 * The config overrides that confine a turn to its workspace and its granted tools. Commands run
 * under a permission profile: system paths readable, the workspace readable (writable with
 * `workspace.write` or `tests.run`), everything else, including `/tmp`, `$TMPDIR`, the home directory and
 * `CODEX_HOME` with the login, unreadable; no network.
 */
function sandboxArgs(
	grants: NativeToolGrants,
	codexHome: string | undefined,
	workspacePath: string,
	tempDir: string,
): string[] {
	// Commands (tests.run) write the workspace like file edits do.
	const workspaceAccess = grants.write || grants.exec ? "write" : "read";
	const filesystem = [
		`${tomlString(":minimal")}="read"`,
		`${tomlString(":slash_tmp")}="deny"`,
		`${tomlString(":tmpdir")}="deny"`,
		...(codexHome === undefined ? [] : [`${tomlString(sandboxPath(codexHome))}="deny"`]),
		`${tomlString(":workspace_roots")}={"."="${workspaceAccess}"}`,
		// The workspace by its own path too: it may lie under a denied /tmp, and the model reads
		// the profile, so the narrower rule has to be visible, not only win.
		`${tomlString(workspacePath)}="${workspaceAccess}"`,
		// The attempt's temp directory is writable even when the workspace is not.
		`${tomlString(tempDir)}="write"`,
	];
	const config = [
		`default_permissions="${PROFILE}"`,
		`permissions.${PROFILE}.filesystem={${filesystem.join(", ")}}`,
		'approval_policy="never"',
		`web_search="${grants.webSearch ? "live" : "disabled"}"`,
		// AGENTS.md files are not loaded: a file an earlier call wrote into the workspace would
		// otherwise become instructions of the next call (the repair).
		"project_doc_max_bytes=0",
		// Skills (the operator's in CODEX_HOME, and any a call wrote into the workspace) are not
		// listed to the model; --ignore-user-config alone keeps them.
		"skills.include_instructions=false",
		// Commands get the attempt's own temp directory; /tmp and $TMPDIR are denied.
		`shell_environment_policy.set.TMPDIR=${tomlString(tempDir)}`,
		// Commands see the core variables only, never the API key.
		'shell_environment_policy.inherit="core"',
	];
	const disabled = [...DISABLED_FEATURES, ...(grants.exec ? [] : SHELL_FEATURES)];
	return [
		...config.flatMap((entry) => ["-c", entry]),
		...disabled.flatMap((feature) => ["--disable", feature]),
	];
}

/**
 * Codex through `codex exec --json`: the prompt on stdin, the result schema through
 * `--output-schema`, events as JSONL on stdout, the final answer in a file (`-o`). The user
 * config, skills, execpolicy rules, AGENTS.md and connectors are not used; commands run under
 * a permission profile confined to the run workspace (see `sandboxArgs`).
 */
export function createCodexRuntime(options: CodexRuntimeOptions = {}): RuntimeAdapter {
	const [command = "codex", ...prefix] = options.command ?? ["codex"];
	const processes = new RunProcesses(options.killGraceMs);
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const env = runtimeEnvironment({
		CODEX_HOME: options.codexHome,
		CODEX_API_KEY: options.apiKey,
		...options.env,
	});
	let version: Promise<string | null> | null = null;

	const simple = async (args: Readonly<string[]>): Promise<ProcessResult> =>
		runProcess({
			command,
			args: [...prefix, ...args],
			cwd: tmpdir(),
			env,
			stdin: "",
			maxOutputBytes: 64 * 1024,
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});

	/** `codex-cli/<version>`, read once. */
	const readVersion = (): Promise<string | null> => {
		version ??= simple(["--version"]).then(
			(result) => {
				const match = /codex-cli\s+(\S+)/u.exec(result.stdout);
				return result.exitCode === 0 && match?.[1] !== undefined ? `codex-cli/${match[1]}` : null;
			},
			() => null,
		);
		return version;
	};

	const probe = async (): Promise<RuntimeProbeResult> => {
		const risks = [
			process.getuid?.() === 0 ? "the worker runs as root" : null,
			"granted commands (tests.run) can read the system paths of the Codex sandbox profile (`:minimal`); keep secrets out of them",
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
			return fail("", `'${command} --version' did not report a Codex CLI version`);
		}
		if (options.apiKey !== undefined) {
			return { ok: true, runtimeVersion, detail: `${runtimeVersion}, API key`, risks };
		}
		const login = await simple(["login", "status"]);
		if (login.exitCode !== 0) {
			return fail(runtimeVersion, "not logged in: run `codex login` with this CODEX_HOME");
		}
		const method = /Logged in using (.+)/u.exec(login.stdout + login.stderr)?.[1]?.trim();
		return {
			ok: true,
			runtimeVersion,
			detail: `${runtimeVersion}, logged in${method === undefined ? "" : ` (${method})`}`,
			risks,
		};
	};

	const execute = async (
		input: AgentTurnInput,
		prompt: string,
		turnOptions: TurnOptions,
		resume: RuntimeSessionHandle | null,
	): Promise<RuntimeTurnOutput> => {
		// Outside the workspace: the schema and the answer file are the adapter's, not the model's.
		const callDir = await mkdtemp(join(tmpdir(), "codex-call-"));
		try {
			const schemaPath = join(callDir, "output-schema.json");
			const answerPath = join(callDir, "last-message.txt");
			await writeFile(schemaPath, JSON.stringify(input.outputSchema), { mode: 0o600 });
			const common = [
				"--json",
				"--strict-config",
				"--skip-git-repo-check",
				"--ignore-user-config",
				"--ignore-rules",
				"--output-schema",
				schemaPath,
				"-o",
				answerPath,
				...sandboxArgs(
					nativeToolGrants(input.toolPolicy),
					options.codexHome,
					turnOptions.workspacePath,
					await runTempDir(turnOptions.workspacePath),
				),
				...(turnOptions.model === null ? [] : ["-m", turnOptions.model]),
				...(turnOptions.persistSession ? [] : ["--ephemeral"]),
			];
			const args =
				resume === null
					? ["exec", ...common, "-C", turnOptions.workspacePath, "-"]
					: ["exec", "resume", ...common, resume.providerSessionId, "-"];
			const result = await processes.run(input.runId, {
				command,
				args: [...prefix, ...args],
				cwd: turnOptions.workspacePath,
				env,
				stdin: prompt,
				maxOutputBytes,
				signal: turnOptions.signal,
			});
			const answer = await readFile(answerPath, "utf8").catch(() => null);
			return interpret(result, answer, resume, turnOptions, await readVersion());
		} finally {
			await rm(callDir, { recursive: true, force: true });
		}
	};

	const interpret = (
		result: ProcessResult,
		answer: string | null,
		resume: RuntimeSessionHandle | null,
		turnOptions: TurnOptions,
		runtimeVersion: string | null,
	): RuntimeTurnOutput => {
		if (result.aborted) {
			throw new RuntimeError("codex was stopped", false);
		}
		const events = result.stdout
			.split("\n")
			.map(parseEvent)
			.filter((event) => event !== null);
		const failure = events.findLast((event) => event.error !== null)?.error ?? null;
		const failed = result.exitCode !== 0 || events.some((event) => event.type === "turn.failed");
		// A successful turn is never thrown away over something its output mentions.
		if (failed && resume !== null && UNKNOWN_SESSION.test(`${result.stderr}\n${failure ?? ""}`)) {
			throw new SessionUnavailableError(`codex cannot resume session ${resume.providerSessionId}`);
		}
		if (failed) {
			const detail = failure ?? tail(result.stderr);
			throw new RuntimeError(
				`codex exited with ${result.exitCode ?? result.exitSignal}: ${detail}`,
				!AUTH_FAILURE.test(detail) && !CONFIG_FAILURE.test(detail),
			);
		}
		// The answer file holds the final message even when a long event stream was cut in the
		// middle; the stream's end (kept) must still show a completed turn.
		if (!events.some((event) => event.type === "turn.completed")) {
			throw new RuntimeError("codex finished without a completed turn", true);
		}
		const final = answer ?? events.findLast((event) => event.text !== null)?.text ?? null;
		if (final === null) {
			throw new RuntimeError("codex finished without a final message", true);
		}
		let modelOutput: JsonValue;
		try {
			modelOutput = JSON.parse(final);
		} catch {
			// Validation reports it and asks for the one repair; the text itself is never posted.
			modelOutput = final;
		}
		const threadId = events.find((event) => event.threadId !== null)?.threadId ?? null;
		const counted = events.filter((event) => event.usage !== null);
		const usage: RuntimeUsage = {
			inputTokens: counted.reduce((sum, event) => sum + (event.usage?.input ?? 0), 0),
			outputTokens: counted.reduce((sum, event) => sum + (event.usage?.output ?? 0), 0),
			cachedInputTokens: counted.reduce((sum, event) => sum + (event.usage?.cached ?? 0), 0),
			costUsd: null,
			durationMs: result.durationMs,
			model: turnOptions.model,
		};
		const expiresAt = new Date(
			Date.now() + (options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS),
		).toISOString();
		const session: RuntimeSessionHandle | null =
			turnOptions.persistSession && threadId !== null && runtimeVersion !== null
				? { adapter: "codex", providerSessionId: threadId, runtimeVersion, expiresAt }
				: null;
		return { modelOutput, usage, session };
	};

	return {
		id: "codex",
		capabilities: { sessionResume: true },
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
