/**
 * Test double of the OpenCode CLI: the subset of `opencode` the adapter uses, with the same
 * `run --format json` event lines. Run as `bun fake-opencode.ts <opencode args>`. The scenario
 * comes from a `[fake:<name>]` directive in the trigger (see `fakeTurn`).
 *
 * FAKE_RECORD  append one JSON line per call: args, cwd, environment names, the call's config,
 *              child pid
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fakeTurn } from "@agent-gateway/runtime-sdk";

const args = process.argv.slice(2);
const record = (entry: Readonly<Record<string, string | number | Readonly<string[]>>>) => {
	const path = process.env.FAKE_RECORD;
	if (path !== undefined) {
		appendFileSync(path, `${JSON.stringify(entry)}\n`);
	}
};

if (args[0] === "--version") {
	console.log("9.9.9");
	process.exit(0);
}
if (args[0] === "models") {
	console.log(`${args[1]}/fake-model`);
	process.exit(0);
}
if (args[0] === "session" && args[1] === "delete") {
	record({ deleted: args[2] ?? "" });
	process.exit(0);
}
if (args[0] !== "run") {
	console.error(`fake opencode: unsupported command ${args.join(" ")}`);
	process.exit(2);
}

const prompt = await new Response(Bun.stdin.stream()).text();
record({
	args,
	cwd: process.cwd(),
	env: Object.keys(process.env).sort(),
	config: process.env.OPENCODE_CONFIG_CONTENT ?? "",
});
const sessionID = "ses_fake0001";
const emit = (type: string, part: Readonly<Record<string, string | number | object>>) =>
	console.log(JSON.stringify({ type, timestamp: Date.now(), sessionID, part }));

const turn = fakeTurn(prompt, process.env, process.cwd());
if (turn.kind === "crash") {
	console.error("fake opencode: unexpected failure");
	process.exit(3);
}
if (turn.kind === "slow") {
	// A child in the same process group, as a tool would start; cancel must stop it.
	const child = spawn("sleep", ["600"], { stdio: "ignore" });
	record({ child: child.pid ?? -1 });
	await new Promise(() => undefined);
}
if (turn.kind === "output") {
	const tokens = { total: 130, input: 3, output: 20, reasoning: 5, cache: { read: 7, write: 90 } };
	// A first step whose text precedes a tool call is not part of the answer.
	emit("step_start", { type: "step-start" });
	emit("text", { type: "text", text: "Let me look first." });
	emit("step_finish", { type: "step-finish", reason: "tool-calls", tokens, cost: 0.004 });
	emit("step_start", { type: "step-start" });
	const text = typeof turn.output === "string" ? turn.output : JSON.stringify(turn.output);
	emit("text", { type: "text", text: `\`\`\`json\n${text}\n\`\`\`` });
	emit("step_finish", { type: "step-finish", reason: "stop", tokens, cost: 0.006 });
}
