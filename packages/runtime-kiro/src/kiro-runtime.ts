import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentTurnInput,
	JsonValue,
	RuntimeSessionHandle,
	RuntimeUsage,
} from "@agent-gateway/contracts";
import {
	asRecord,
	asString,
	confinedGrants,
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

export type KiroRuntimeOptions = Readonly<{
	/** Command that starts the Kiro CLI: a pinned binary, or a fake in tests. */
	command?: Readonly<string[]>;
	/**
	 * `KIRO_HOME` of the Gateway: the agent definitions and settings this adapter writes, and the
	 * sessions. Never the operator's own `~/.kiro`.
	 */
	kiroHome: string;
	/** `KIRO_API_KEY`; without it the CLI uses the login of the worker user. */
	apiKey?: string;
	/** Additional environment of the process, e.g. for a fake CLI in tests. */
	env?: Readonly<Record<string, string>>;
	maxOutputBytes?: number;
	killGraceMs?: number;
	/** How long a stored session may be offered again. */
	sessionTtlMs?: number;
}>;

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const PROBE_TIMEOUT_MS = 30_000;
/** The engine the adapter was verified with; others resolve agents and sessions differently. */
const ENGINE = "v2";

/**
 * Kiro has no OS sandbox for its shell, and its path settings do not keep the file tools inside
 * the workspace (reads anywhere succeed). Only the web tools, which run in the CLI, are granted.
 */
const CONFINED_TOOLS: Readonly<NativeTool[]> = ["webSearch", "webFetch"];

/** Everything the CLI would otherwise load or send besides the turn itself. */
const QUIET_ENV: Readonly<Record<string, string>> = {
	KIRO_DISABLE_TELEMETRY: "1",
	KIRO_NO_AUTO_UPDATE: "1",
	KIRO_NO_REMOTE_CHANGELOG: "1",
	NO_COLOR: "1",
	TERM: "dumb",
};

const SETTINGS = {
	"telemetry.enabled": false,
	"app.disableAutoupdates": true,
	"chat.disableInheritingDefaultResources": true,
	"chat.enableKnowledge": false,
	"chat.enableThinking": false,
	"chat.enableTodoList": false,
	"chat.enableCheckpoint": false,
	"chat.enableDelegate": false,
};

/** The built-in tools of one grant set. */
function toolsOf(grants: NativeToolGrants): string[] {
	return [...(grants.webSearch ? ["web_search"] : []), ...(grants.webFetch ? ["web_fetch"] : [])];
}

/** One agent per grant set, so concurrent runs with different grants never share a file. */
function agentName(tools: Readonly<string[]>): string {
	return tools.length === 0 ? "gateway-none" : `gateway-${tools.join("-").replaceAll("_", "")}`;
}

/** The agent definition: only these tools, all trusted, and no prompt, MCP, resources or hooks. */
function agentDefinition(tools: Readonly<string[]>): string {
	return JSON.stringify({
		name: agentName(tools),
		description: "Agent Gateway turn",
		prompt: null,
		tools,
		allowedTools: tools,
		mcpServers: {},
		includeMcpJson: false,
		resources: [],
		hooks: {},
	});
}

const GRANT_SETS: Readonly<NativeToolGrants[]> = [false, true].flatMap((webSearch) =>
	[false, true].map((webFetch) => ({
		read: false,
		write: false,
		exec: false,
		webSearch,
		webFetch,
	})),
);

const SESSION_ID = /^[0-9a-f-]{36}$/u;
/** Checked first: throttling passes, whatever else the message says. */
const RATE_LIMITED = /\b429\b|rate.?limit|too many requests|overloaded|quota/iu;
const AUTH_FAILURE =
	/not logged in|please log in|login required|\b401\b|unauthori[sz]ed|invalid api key/iu;
const UNKNOWN_SESSION = /session not found|failed to start session|load_session failed/iu;
/** The CLI falls back to its default agent, with its default tools, when ours is missing. */
const AGENT_MISSING = /agent "[^"]*" not found/iu;
/** Failures a retry repeats: an unknown model or options the CLI rejects. */
const CONFIG_FAILURE =
	/model .*not (found|supported|available)|invalid model|unexpected argument/iu;

/**
 * Kiro through `kiro-cli chat --no-interactive --output-format stream-json`: the prompt on
 * stdin, ACP events on stdout. The CLI runs with the Gateway's own `KIRO_HOME` (no global
 * steering, skills, agents, MCP servers or settings of the operator) and one of the adapter's
 * agents, which have no prompt, MCP servers, resources or hooks and only the granted web tools.
 * Kiro has no structured output: the prompt carries the result schema, and the Gateway
 * validates the answer.
 */
export function createKiroRuntime(options: KiroRuntimeOptions): RuntimeAdapter {
	const [command = "kiro-cli", ...prefix] = options.command ?? ["kiro-cli"];
	const processes = new RunProcesses(options.killGraceMs);
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const kiroHome = runtimeHome(options.kiroHome);
	const env = runtimeEnvironment({
		KIRO_HOME: kiroHome,
		KIRO_API_KEY: options.apiKey,
		...QUIET_ENV,
		...options.env,
	});
	let version: Promise<string | null> | null = null;
	/**
	 * Brings the settings and agent definitions to their expected content before every call,
	 * atomically: the CLI never sees a missing, partial or edited definition.
	 */
	const configure = async (): Promise<void> => {
		await writeRuntimeFile(join(kiroHome, "settings", "cli.json"), JSON.stringify(SETTINGS));
		for (const grants of GRANT_SETS) {
			const tools = toolsOf(grants);
			await writeRuntimeFile(
				join(kiroHome, "agents", `${agentName(tools)}.json`),
				agentDefinition(tools),
			);
		}
	};

	const simple = (args: Readonly<string[]>, cwd = tmpdir()): Promise<ProcessResult> =>
		runProcess({
			command,
			args: [...prefix, ...args],
			cwd,
			env,
			stdin: "",
			maxOutputBytes: 64 * 1024,
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});

	/** `kiro-cli/<version>`, read once. */
	const readVersion = (): Promise<string | null> => {
		version ??= simple(["--version"]).then(
			(result) => {
				const match = /^kiro-cli (\d+\.\d+\.\d+\S*)/mu.exec(result.stdout);
				return result.exitCode === 0 && match?.[1] !== undefined ? `kiro-cli/${match[1]}` : null;
			},
			() => null,
		);
		return version;
	};

	const probe = async (): Promise<RuntimeProbeResult> => {
		const risks = [
			process.getuid?.() === 0 ? "the worker runs as root" : null,
			withheldToolsRisk("kiro", CONFINED_TOOLS),
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
			return fail("", `cannot write the configuration of ${kiroHome}: ${String(error)}`);
		}
		const runtimeVersion = await readVersion();
		if (runtimeVersion === null) {
			return fail("", `'${command} --version' did not report a Kiro CLI version`);
		}
		// Also while the login fails: expired transcripts go regardless.
		await pruneSessions();
		const whoami = await simple(["whoami", "--format", "json"]);
		if (whoami.exitCode !== 0) {
			return fail(
				runtimeVersion,
				options.apiKey === undefined
					? "not logged in: run `kiro-cli login` as the worker user, or set KIRO_API_KEY"
					: "KIRO_API_KEY was not accepted",
			);
		}
		// The answer also names the account; only its type is reported.
		const account = asString(
			asRecord(parseJson(whoami.stdout.split("\n")[0] ?? "") ?? undefined)?.accountType,
		);
		const method =
			options.apiKey === undefined ? `login (${account ?? "unknown type"})` : "API key";
		return { ok: true, runtimeVersion, detail: `${runtimeVersion}, ${method}`, risks };
	};

	/** Removes sessions older than the session lifetime: no run can resume them any more. */
	const pruneSessions = async (): Promise<void> => {
		const sessions = join(kiroHome, "sessions", "cli");
		const cutoff = Date.now() - (options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS);
		for (const name of await readdir(sessions).catch(() => [])) {
			const path = join(sessions, name);
			const info = await stat(path).catch(() => null);
			if (info?.isFile() && info.mtimeMs < cutoff) {
				await rm(path, { force: true });
			}
		}
	};

	/** Removes a session the run should not keep. */
	const forgetSession = async (sessionId: string): Promise<void> => {
		const sessions = join(kiroHome, "sessions", "cli");
		for (const suffix of [".json", ".jsonl"]) {
			await rm(join(sessions, `${sessionId}${suffix}`), { force: true });
		}
	};

	const execute = async (
		input: AgentTurnInput,
		prompt: string,
		turnOptions: TurnOptions,
		resume: RuntimeSessionHandle | null,
	): Promise<RuntimeTurnOutput> => {
		await configure();
		// The version this call runs under, read before it: a probe may reset it meanwhile.
		const runtimeVersion = await readVersion();
		const grants = confinedGrants(nativeToolGrants(input.toolPolicy), CONFINED_TOOLS);
		const tools = toolsOf(grants);
		const result = await processes.run(input.runId, {
			command,
			args: [
				...prefix,
				"chat",
				"--no-interactive",
				"--output-format",
				"stream-json",
				"--agent",
				agentName(tools),
				"--agent-engine",
				ENGINE,
				`--trust-tools=${tools.join(",")}`,
				"--wrap",
				"never",
				...(turnOptions.model === null ? [] : ["--model", turnOptions.model]),
				...(resume === null ? [] : ["--resume-id", resume.providerSessionId]),
			],
			cwd: turnOptions.workspacePath,
			env,
			stdin: prompt,
			maxOutputBytes,
			signal: turnOptions.signal,
		});
		const events = parseJsonLines(result.stdout);
		const finished = asRecord(events.findLast((event) => event.type === "runFinished")?.data);
		// Any event names the session, also of a turn that failed or was stopped.
		const sessionId =
			events
				.map((event) => asString(asRecord(event.data)?.sessionId))
				.find((id) => id !== null && SESSION_ID.test(id)) ?? null;
		let kept = false;
		try {
			const output = interpret(result, events, finished, resume, turnOptions, runtimeVersion);
			kept = output.session !== null;
			return output;
		} finally {
			// Only a session handed back to the Gateway may be resumed; any other is removed (a
			// resumed one stays: the Gateway still holds it).
			if (!kept && sessionId !== null && sessionId !== resume?.providerSessionId) {
				await forgetSession(sessionId);
			}
		}
	};

	const interpret = (
		result: ProcessResult,
		events: Readonly<Readonly<Record<string, JsonValue>>[]>,
		finished: Readonly<Record<string, JsonValue>> | null,
		resume: RuntimeSessionHandle | null,
		turnOptions: TurnOptions,
		runtimeVersion: string | null,
	): RuntimeTurnOutput => {
		if (result.aborted) {
			throw new RuntimeError("kiro was stopped", false);
		}
		if (AGENT_MISSING.test(result.stderr)) {
			// Never run a turn on the default agent and its default tools.
			throw new RuntimeError("kiro did not find the Gateway's agent definition", false);
		}
		const errors = events
			.filter((event) => event.type === "runError")
			.map((event) => asString(asRecord(event.data)?.message) ?? "unknown error");
		// Only the CLI's own messages: other stdout events would be the model's answer.
		const failure = errors.length > 0 ? errors.join("; ") : tail(result.stderr);
		if (resume !== null && UNKNOWN_SESSION.test(failure) && finished === null) {
			throw new SessionUnavailableError(`kiro cannot resume session ${resume.providerSessionId}`);
		}
		const status = asString(finished?.status);
		if (result.exitCode !== 0 || finished === null || status !== "success") {
			const detail = `${status ?? "no result"}: ${tail(failure)}`;
			throw new RuntimeError(
				`kiro exited with ${result.exitCode ?? result.exitSignal}: ${detail}`,
				RATE_LIMITED.test(detail) || (!AUTH_FAILURE.test(detail) && !CONFIG_FAILURE.test(detail)),
			);
		}
		const text =
			finished.finalTextTruncated === true
				? events
						.map((event) => asRecord(asRecord(event.data)?.update))
						.filter((update) => update?.sessionUpdate === "agent_message_chunk")
						.map((update) => asString(asRecord(update?.content)?.text) ?? "")
						.join("")
				: (asString(finished.finalText) ?? "");
		// Kiro meters credits, not tokens.
		const usage: RuntimeUsage = {
			inputTokens: null,
			outputTokens: null,
			cachedInputTokens: null,
			costUsd: null,
			durationMs: result.durationMs,
			model: turnOptions.model,
		};
		const sessionId = asString(finished.sessionId);
		if (resume !== null && sessionId !== null && sessionId !== resume.providerSessionId) {
			// The CLI started a new session instead of resuming: the earlier context is gone.
			throw new SessionUnavailableError(
				`kiro started session ${sessionId} instead of resuming ${resume.providerSessionId}`,
			);
		}
		const session: RuntimeSessionHandle | null =
			turnOptions.persistSession && sessionId !== null && runtimeVersion !== null
				? {
						adapter: "kiro",
						providerSessionId: sessionId,
						runtimeVersion,
						expiresAt: new Date(
							Date.now() + (options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS),
						).toISOString(),
					}
				: null;
		return { modelOutput: parseJsonAnswer(text), usage, session };
	};

	return {
		id: "kiro",
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
