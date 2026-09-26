/**
 * Test double of the Kiro CLI: the subset of `kiro-cli` the adapter uses, with the same
 * `chat --output-format stream-json` event lines. Run as `bun fake-kiro.ts <kiro-cli args>`.
 * The scenario comes from a `[fake:<name>]` directive in the trigger (see `fakeTurn`).
 *
 * FAKE_RECORD    append one JSON line per call: args, cwd, environment names, the agent's
 *                definition, child pid
 * FAKE_SESSIONS  directory of known session ids; resume of any other id fails like Kiro does
 * FAKE_DEFAULT_AGENT=1  report the agent missing and fall back to the default, as Kiro does
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const emit = (
	type: string,
	data: Readonly<Record<string, string | number | boolean | object | null>>,
) => console.log(JSON.stringify({ type, data }));

if (args[0] === "--version") {
	console.log("kiro-cli 9.9.9");
	process.exit(0);
}
if (args[0] === "whoami") {
	console.log(JSON.stringify({ accountType: "Fake", email: "someone@example.com" }));
	process.exit(0);
}
if (args[0] !== "chat" || !args.includes("--no-interactive")) {
	console.error(`fake kiro: unsupported command ${args.join(" ")}`);
	process.exit(2);
}

const prompt = await new Response(Bun.stdin.stream()).text();
const agentFile = join(process.env.KIRO_HOME ?? "", "agents", `${option("--agent")}.json`);
const agent = existsSync(agentFile) ? readFileSync(agentFile, "utf8") : "";
record({ args, cwd: process.cwd(), env: Object.keys(process.env).sort(), agent });
if (agent === "" || process.env.FAKE_DEFAULT_AGENT === "1") {
	console.error(`[warn] agent "${option("--agent")}" not found, using "default"`);
}
emit("runStarted", { payloadSchema: "acp", acpProtocolVersion: 1, engine: "v2" });
const sessions = process.env.FAKE_SESSIONS;
const resumed = option("--resume-id");
if (resumed !== null && (sessions === undefined || !existsSync(join(sessions, resumed)))) {
	emit("runError", {
		sessionId: null,
		stage: "init",
		message: `Internal error: "Failed to start session: Session not found: ${resumed}"`,
	});
	console.error("error: ACP load_session failed");
	process.exit(1);
}

const turn = fakeTurn(prompt, process.env, process.cwd());
if (turn.kind === "crash") {
	console.error("fake kiro: unexpected failure");
	process.exit(3);
}
if (turn.kind === "slow") {
	// A child in the same process group, as a tool would start; cancel must stop it.
	const child = spawn("sleep", ["600"], { stdio: "ignore" });
	record({ child: child.pid ?? -1 });
	await new Promise(() => undefined);
}
if (turn.kind === "output") {
	const sessionId = resumed ?? randomUUID();
	if (sessions !== undefined) {
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, sessionId), "");
	}
	const home = process.env.KIRO_HOME;
	if (home !== undefined) {
		mkdirSync(join(home, "sessions", "cli"), { recursive: true });
		writeFileSync(join(home, "sessions", "cli", `${sessionId}.json`), "{}");
	}
	const text = typeof turn.output === "string" ? turn.output : JSON.stringify(turn.output);
	emit("metadata", { sessionId, meteringUsage: [{ value: 0.05, unit: "credit" }] });
	emit("sessionUpdate", {
		sessionId,
		update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
	});
	emit("runFinished", {
		sessionId,
		status: "success",
		stopReason: "end_turn",
		finalText: text,
		finalTextTruncated: false,
	});
}
