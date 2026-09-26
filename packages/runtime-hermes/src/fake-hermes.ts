/**
 * Test double of Hermes Agent: the subset of `hermes` the adapter uses, with the same
 * `chat --format stream-json` event lines. Run as `bun fake-hermes.ts <hermes args>`. The
 * scenario comes from a `[fake:<name>]` directive in the trigger (see `fakeTurn`).
 *
 * FAKE_RECORD    append one JSON line per call: args, cwd, environment names, child pid
 * FAKE_SESSIONS  directory of known session ids; resume of any other id fails like Hermes does
 */
import { spawn } from "node:child_process";
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
const emit = (event: Readonly<Record<string, string | number | object | null>>) =>
	console.log(JSON.stringify(event));

if (args[0] === "--version") {
	console.log("Hermes Agent v9.9.9 (2026.1.1) · upstream fakefake");
	process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
	console.log(`${args[2]}: logged in as someone@example.com`);
	process.exit(0);
}
if (args[0] === "sessions" && args[1] === "prune") {
	record({ pruned: args.slice(2) });
	process.exit(0);
}
if (args[0] === "sessions" && args[1] === "delete") {
	record({ deleted: args.at(-1) ?? "" });
	const sessions = process.env.FAKE_SESSIONS;
	const id = args.at(-1);
	if (sessions !== undefined && id !== undefined && existsSync(join(sessions, id))) {
		writeFileSync(join(sessions, id), "deleted");
	}
	process.exit(0);
}
if (args[0] !== "chat" || option("--query-file") !== "-") {
	console.error(`fake hermes: unsupported command ${args.join(" ")}`);
	process.exit(2);
}

const prompt = await new Response(Bun.stdin.stream()).text();
record({ args, cwd: process.cwd(), env: Object.keys(process.env).sort() });
// Hermes prints some warnings to stdout ahead of the events.
console.log("Warning: a line that is not an event");
const sessions = process.env.FAKE_SESSIONS;
const resumed = option("--resume");
if (resumed !== null && (sessions === undefined || !existsSync(join(sessions, resumed)))) {
	emit({
		type: "result",
		session_id: null,
		exit_code: 1,
		text: "",
		error: `Session not found: ${resumed}`,
	});
	process.exit(1);
}
const sessionId = resumed ?? `20260101_000000_${Math.random().toString(16).slice(2, 8)}`;
emit({ type: "system", subtype: "init", model: "fake-model", session_id: sessionId });

const turn = fakeTurn(prompt, process.env, process.cwd());
if (turn.kind === "crash") {
	console.error("fake hermes: unexpected failure");
	process.exit(3);
}
if (turn.kind === "slow") {
	// A child in the same process group, as a tool would start; cancel must stop it.
	const child = spawn("sleep", ["600"], { stdio: "ignore" });
	record({ child: child.pid ?? -1 });
	await new Promise(() => undefined);
}
if (turn.kind === "output") {
	if (sessions !== undefined) {
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, sessionId), "");
	}
	const text = typeof turn.output === "string" ? turn.output : JSON.stringify(turn.output);
	emit({ type: "text", text });
	emit({
		type: "result",
		session_id: sessionId,
		exit_code: 0,
		text,
		tokens: { input: 100, output: 20, total: 120, cache_read: 7, cache_write: 0 },
		duration_ms: 5,
	});
}
