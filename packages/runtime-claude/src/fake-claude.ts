/**
 * Test double of the Claude Code CLI: the subset of `claude` the adapter uses, with the same
 * `--output-format json` result object. Run as `bun fake-claude.ts <claude args>`. The scenario
 * comes from a `[fake:<name>]` directive in the trigger (see `fakeTurn`).
 *
 * FAKE_RECORD    append one JSON line per call: args, cwd, environment names, child pid
 * FAKE_SESSIONS  directory of known session ids; resume of any other id fails like Claude does
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
	console.log("9.9.9 (Claude Code)");
	process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
	console.log(JSON.stringify({ loggedIn: true, authMethod: "fake", email: "someone@example.com" }));
	process.exit(0);
}
if (args[0] !== "-p") {
	console.error(`fake claude: unsupported command ${args.join(" ")}`);
	process.exit(2);
}

const prompt = await new Response(Bun.stdin.stream()).text();
record({ args, cwd: process.cwd(), env: Object.keys(process.env).sort() });
const sessions = process.env.FAKE_SESSIONS;
const resumed = option("--resume");
if (resumed !== null && (sessions === undefined || !existsSync(join(sessions, resumed)))) {
	console.log(`No conversation found with session ID: ${resumed}`);
	process.exit(1);
}

const turn = fakeTurn(prompt, process.env, process.cwd());
if (turn.kind === "crash") {
	console.error("fake claude: unexpected failure");
	process.exit(3);
}
if (turn.kind === "slow") {
	// A child in the same process group, as the Bash tool would start; cancel must stop it.
	const child = spawn("sleep", ["600"], { stdio: "ignore" });
	record({ child: child.pid ?? -1 });
	await new Promise(() => undefined);
}
if (turn.kind === "output") {
	const sessionId = resumed ?? randomUUID();
	if (!args.includes("--no-session-persistence") && sessions !== undefined) {
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, sessionId), "");
	}
	const structured = typeof turn.output === "string" ? null : turn.output;
	console.log(
		JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			result: typeof turn.output === "string" ? turn.output : JSON.stringify(turn.output),
			...(structured === null ? {} : { structured_output: structured }),
			session_id: sessionId,
			total_cost_usd: 0.01,
			duration_ms: 5,
			usage: {
				input_tokens: 3,
				cache_creation_input_tokens: 90,
				cache_read_input_tokens: 7,
				output_tokens: 20,
			},
			modelUsage: { "claude-fake": { inputTokens: 3, outputTokens: 20 } },
		}),
	);
}
