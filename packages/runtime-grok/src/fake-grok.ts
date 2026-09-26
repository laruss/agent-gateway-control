/**
 * Test double of the Grok CLI: the subset of `grok` the adapter uses, with the same
 * `--output-format json` result object. Run as `bun fake-grok.ts <grok args>`. The scenario
 * comes from a `[fake:<name>]` directive in the trigger (see `fakeTurn`).
 *
 * FAKE_RECORD    append one JSON line per call: args, cwd, environment names, child pid
 * FAKE_SESSIONS  directory of known session ids; resume of any other id fails like Grok does
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
const option = (name: string): string | null => {
	const index = args.indexOf(name);
	return index < 0 ? null : (args[index + 1] ?? null);
};

if (args[0] === "--version") {
	console.log("grok 9.9.9 (fakefake) [stable]");
	process.exit(0);
}
if (args[0] === "models") {
	console.log("You are logged in with grok.com.\n\nAvailable models:\n  * grok-fake (default)");
	process.exit(0);
}
if (option("--prompt-file") !== "/dev/stdin") {
	console.error(`fake grok: unsupported command ${args.join(" ")}`);
	process.exit(2);
}

const prompt = await new Response(Bun.stdin.stream()).text();
record({ args, cwd: process.cwd(), env: Object.keys(process.env).sort() });
const sessions = process.env.FAKE_SESSIONS;
const resumed = option("--resume");
if (resumed !== null && (sessions === undefined || !existsSync(join(sessions, resumed)))) {
	console.error(
		"Error: Failed to restore session from remote: fetching session record: session get failed: 404 Not Found",
	);
	process.exit(1);
}

const turn = fakeTurn(prompt, process.env, process.cwd());
if (turn.kind === "crash") {
	console.error("fake grok: unexpected failure");
	process.exit(3);
}
if (turn.kind === "slow") {
	// A child in the same process group, as a tool would start; cancel must stop it.
	const child = spawn("sleep", ["600"], { stdio: "ignore" });
	record({ child: child.pid ?? -1 });
	await new Promise(() => undefined);
}
if (turn.kind === "output") {
	const sessionId = resumed ?? option("--session-id") ?? randomUUID();
	if (sessions !== undefined) {
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, sessionId), "");
	}
	// Where the real CLI keeps the transcript: grouped by working directory.
	const home = process.env.GROK_HOME;
	if (home !== undefined) {
		mkdirSync(join(home, "sessions", "fake-group", sessionId), { recursive: true });
	}
	const structured = typeof turn.output === "string" ? null : turn.output;
	console.log(
		JSON.stringify({
			text: typeof turn.output === "string" ? turn.output : JSON.stringify(turn.output),
			stopReason: "end_turn",
			sessionId,
			requestId: randomUUID(),
			thought: "private reasoning",
			usage: {
				input_tokens: 3,
				cache_read_input_tokens: 7,
				cache_creation_input_tokens: 90,
				output_tokens: 20,
				reasoning_tokens: 5,
				total_tokens: 125,
			},
			num_turns: 1,
			total_cost_usd: 0.01,
			modelUsage: { "grok-fake": { inputTokens: 3, outputTokens: 20 } },
			...(structured === null ? {} : { structuredOutput: structured }),
		}),
	);
}
