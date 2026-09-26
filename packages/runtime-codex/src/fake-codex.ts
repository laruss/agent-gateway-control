/**
 * Test double of the Codex CLI: the subset of `codex` the adapter uses, speaking the same
 * JSONL events. Run as `bun fake-codex.ts <codex args>`. The scenario comes from a
 * `[fake:<name>]` directive in the trigger (see `fakeTurn`).
 *
 * FAKE_RECORD    append one JSON line per call: args, cwd, environment names, child pid
 * FAKE_SESSIONS  directory of known session ids; resume of any other id fails like Codex does
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeTurn } from "@agent-gateway/runtime-sdk";

const args = process.argv.slice(2);
const record = (entry: Readonly<Record<string, string | number | Readonly<string[]>>>) => {
	const path = process.env.FAKE_RECORD;
	if (path !== undefined) {
		appendFileSync(path, `${JSON.stringify(entry)}\n`);
	}
};
const emit = (event: object) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (args[0] === "--version") {
	console.log("codex-cli 0.0.0-fake");
	process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
	console.log("Logged in using an API key");
	process.exit(0);
}
if (args[0] !== "exec") {
	console.error(`fake codex: unsupported command ${args.join(" ")}`);
	process.exit(2);
}

const prompt = await new Response(Bun.stdin.stream()).text();
record({ args, cwd: process.cwd(), env: Object.keys(process.env).sort() });
const sessions = process.env.FAKE_SESSIONS;
const resumeIndex = args[1] === "resume" ? args.length - 2 : -1;
const resumed = resumeIndex >= 0 ? (args[resumeIndex] ?? "") : null;
if (resumed !== null && (sessions === undefined || !existsSync(join(sessions, resumed)))) {
	console.error(
		`Error: thread/resume: thread/resume failed: no rollout found for thread id ${resumed} (code -32600)`,
	);
	process.exit(1);
}

const turn = fakeTurn(prompt, process.env, process.cwd());
if (turn.kind === "crash") {
	console.error("fake codex: unexpected failure");
	process.exit(3);
}
const threadId = resumed ?? randomUUID();
emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });
if (turn.kind === "slow") {
	// A child in the same process group, as a real shell tool would start; cancel must stop it.
	const child = spawn("sleep", ["600"], { stdio: "ignore" });
	record({ child: child.pid ?? -1 });
	await new Promise(() => undefined);
}
if (turn.kind === "output") {
	if (!args.includes("--ephemeral") && sessions !== undefined) {
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, threadId), "");
	}
	const text = typeof turn.output === "string" ? turn.output : JSON.stringify(turn.output);
	const answerFile = args[args.indexOf("-o") + 1];
	if (args.includes("-o") && answerFile !== undefined) {
		writeFileSync(answerFile, text);
	}
	emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });
	emit({
		type: "turn.completed",
		usage: {
			input_tokens: 100,
			cached_input_tokens: 10,
			output_tokens: 20,
			reasoning_output_tokens: 5,
		},
	});
}
