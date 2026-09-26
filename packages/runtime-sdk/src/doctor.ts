import { randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeAdapterId, RuntimeSessionHandle, ToolPattern } from "@agent-gateway/contracts";
import type { RuntimeAdapter } from "./adapter.ts";
import { createRunWorkspace, removeRunWorkspace } from "./environment.ts";
import { type ExecuteOptions, executeTurn, type TurnExecution } from "./execute.ts";
import { contractTurnInput } from "./testing.ts";

export type DoctorStatus = "pass" | "fail" | "warn" | "skip";

export type DoctorCheck = Readonly<{ name: string; status: DoctorStatus; detail: string }>;

export type DoctorReport = Readonly<{
	adapter: RuntimeAdapterId;
	runtimeVersion: string;
	platform: string;
	/** No check failed; warnings are policy risks to review. */
	ok: boolean;
	checks: Readonly<DoctorCheck[]>;
}>;

export type DoctorOptions = Readonly<{
	/** Absolute directory for the doctor's run workspaces. */
	workspaceRoot: string;
	model: string | null;
	/** Budget of each real turn. */
	turnTimeoutMs?: number;
	/** When to cancel the long turn of the cancellation check. */
	cancelAfterMs?: number;
}>;

const REPLY_TASK =
	"@developer Reply in this thread with one short greeting, then finish with nextState idle.";
const SANDBOX_TASK =
	'@developer Run the shell commands `cat word.txt > echo.txt` and `echo "$TMPDIR" > tmpdir.txt` in your working directory (word.txt holds a harmless test word), then reply that it is done and finish with nextState idle.';
/** Written by the sandbox check's command; only a shell can create it (no file-write grant). */
const SANDBOX_ECHO = "echo.txt";
const LONG_TASK =
	"@developer Write a detailed 3000-word essay on the history of distributed consensus, then reply with it.";

/** A harmless-looking random word: a model refuses to post anything that looks like a token. */
export function testWord(): string {
	return `lighthouse${randomInt(100_000, 999_999)}`;
}

function describeFailure(execution: TurnExecution): string {
	return execution.kind === "failed"
		? `${execution.error.code}: ${execution.error.detail}`
		: "completed";
}

/**
 * Preflight of one runtime installation, for `gateway runtime doctor`: installation, version
 * and authentication (probe), a real non-interactive turn with structured output, cancellation
 * and session resume. Spends a few real turns. Never prints model output.
 */
export async function runtimeDoctor(
	adapter: RuntimeAdapter,
	options: DoctorOptions,
): Promise<DoctorReport> {
	const checks: DoctorCheck[] = [];
	const check = (name: string, status: DoctorStatus, detail: string) =>
		checks.push({ name, status, detail });
	const platform = `${process.platform}/${process.arch}`;
	const turnMs = options.turnTimeoutMs ?? 180_000;

	const turn = async (
		message: string,
		ms: number,
		extra: Partial<Pick<ExecuteOptions, "session" | "signal" | "persistSession">> = {},
		allow: Readonly<ToolPattern[]> | null = null,
		/** Files placed in the workspace before the turn. */
		files: Readonly<Record<string, string>> = {},
		/** Called with the workspace after the turn, before it is removed. */
		inspect: (workspacePath: string) => Promise<void> = async () => undefined,
	): Promise<TurnExecution> => {
		const base = contractTurnInput({ runId: randomUUID(), message, deadlineMs: ms });
		const input =
			allow === null ? base : { ...base, toolPolicy: { ...base.toolPolicy, allow: [...allow] } };
		const workspacePath = await createRunWorkspace(
			options.workspaceRoot,
			input.agent.agentId,
			input.runId,
		);
		for (const [name, content] of Object.entries(files)) {
			await writeFile(join(workspacePath, name), content);
		}
		try {
			const execution = await executeTurn(adapter, input, {
				session: null,
				model: options.model,
				persistSession: false,
				...extra,
				workspacePath,
			});
			await inspect(workspacePath);
			return execution;
		} finally {
			await removeRunWorkspace(workspacePath);
		}
	};

	const probe = await adapter.probe();
	check("installed, version and auth", probe.ok ? "pass" : "fail", probe.detail);
	check("platform", "pass", platform);
	for (const risk of probe.risks) {
		check("policy risk", "warn", risk);
	}
	if (!probe.ok) {
		for (const name of ["structured output", "sandboxed command", "cancel", "session resume"]) {
			check(name, "skip", "probe failed");
		}
		return {
			adapter: adapter.id,
			runtimeVersion: probe.runtimeVersion,
			platform,
			ok: false,
			checks,
		};
	}

	const reply = await turn(REPLY_TASK, turnMs, {
		persistSession: adapter.capabilities.sessionResume,
	});
	check(
		"non-interactive turn with structured output",
		reply.kind === "completed" ? "pass" : "fail",
		reply.kind === "completed"
			? `valid result, next state ${reply.result.nextState.kind}`
			: describeFailure(reply),
	);

	if (!adapter.capabilities.confinedTools.includes("exec")) {
		check(
			"sandboxed command (tests.run)",
			"skip",
			"withheld: this runtime cannot confine commands, so tests.run is never granted",
		);
	} else {
		// A granted command runs in the runtime's OS sandbox; without its dependencies (bubblewrap
		// on Linux) every run with tests.run would fail.
		// Only a command can copy the word into a new file: the grant has no file-write tool, and the
		// model's own words prove nothing.
		const token = testWord();
		let echoed = "";
		let commandTmp = "";
		let workspaceOfCheck = "";
		let tempGone = false;
		const sandboxed = await turn(
			SANDBOX_TASK,
			turnMs,
			{},
			["mattermost.post", "tests.run"],
			{ "word.txt": token },
			async (workspacePath) => {
				echoed = await readFile(join(workspacePath, SANDBOX_ECHO), "utf8").catch(() => "");
				commandTmp = (
					await readFile(join(workspacePath, "tmpdir.txt"), "utf8").catch(() => "")
				).trim();
				workspaceOfCheck = workspacePath;
				tempGone = commandTmp !== "" && !existsSync(commandTmp);
			},
		);
		const sandboxOutput = sandboxed.kind === "completed" && echoed.trim() === token;
		check(
			"sandboxed command (tests.run)",
			sandboxOutput ? "pass" : "fail",
			sandboxOutput ? "a granted command ran in the sandbox" : describeFailure(sandboxed),
		);

		if (sandboxOutput) {
			// Temp files that outlive the call are shared between runs: the directory must be the
			// run's own (inside its workspace) or removed with the call.
			const own = commandTmp.startsWith(`${workspaceOfCheck}/`) || tempGone;
			check(
				"command temp directory",
				own ? "pass" : "warn",
				own
					? "private to the run"
					: `commands use ${commandTmp || "an unknown directory"}, which outlives the run`,
			);
		}
	}

	const cancel = new AbortController();
	const started = Date.now();
	setTimeout(() => cancel.abort(), options.cancelAfterMs ?? 3_000);
	const cancelled = await turn(LONG_TASK, turnMs, { signal: cancel.signal });
	const cancelledOk = cancelled.kind === "failed" && cancelled.error.code === "cancelled";
	check(
		"cancel",
		cancelledOk ? "pass" : "fail",
		cancelledOk
			? `stopped after ${Date.now() - started} ms`
			: `expected cancelled, got ${describeFailure(cancelled)}`,
	);

	const session: RuntimeSessionHandle | null =
		reply.kind === "completed" ? reply.result.session : null;
	if (!adapter.capabilities.sessionResume) {
		check("session resume", "skip", "not supported by this adapter; every turn starts fresh");
	} else if (session === null) {
		check("session resume", "fail", "the first turn returned no session");
	} else {
		const resumed = await turn(REPLY_TASK, turnMs, { session });
		check(
			"session resume",
			resumed.kind === "completed" && resumed.resume === "resumed" ? "pass" : "fail",
			`resume ${resumed.resume}, ${describeFailure(resumed)}`,
		);
	}
	return {
		adapter: adapter.id,
		runtimeVersion: probe.runtimeVersion,
		platform,
		ok: checks.every((c) => c.status !== "fail"),
		checks,
	};
}
