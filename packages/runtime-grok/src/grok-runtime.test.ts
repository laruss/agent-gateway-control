import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTurnInput, ToolPolicySnapshot } from "@agent-gateway/contracts";
import {
	contractTurnInput,
	createRunWorkspace,
	executeTurn,
	removeRunWorkspace,
	type TurnExecution,
} from "@agent-gateway/runtime-sdk";
import { defineRuntimeContractSuite } from "@agent-gateway/runtime-sdk/contract-suite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGrokRuntime } from "./grok-runtime.ts";

const FAKE = join(import.meta.dirname, "fake-grok.ts");
let dir = "";

const fakeRuntime = (grokHome = join(dir, "grok-home")) =>
	createGrokRuntime({
		command: ["bun", FAKE],
		grokHome,
		env: { FAKE_SESSIONS: join(dir, "sessions"), FAKE_RECORD: join(dir, "record.jsonl") },
		killGraceMs: 500,
	});

beforeAll(async () => {
	// Real path: the adapter resolves GROK_HOME, which the CLI requires to be no symlink.
	dir = await realpath(await mkdtemp(join(tmpdir(), "grok-adapter-")));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

defineRuntimeContractSuite({
	name: "grok (fake CLI)",
	createAdapter: () => fakeRuntime(),
	prompts: {
		reply: "@developer please reply [fake:reply]",
		wait: "@developer ask finance [fake:wait]",
		invalid: "@developer [fake:invalid]",
		slow: "@developer [fake:slow]",
	},
});

type Recorded = Readonly<{ args?: string[]; cwd?: string; env?: string[]; child?: number }>;

async function recorded(): Promise<Recorded[]> {
	const text = await readFile(join(dir, "record.jsonl"), "utf8").catch(() => "");
	return text
		.split("\n")
		.filter((line) => line !== "")
		.map((line): Recorded => JSON.parse(line));
}

async function turn(
	message: string,
	policy: Partial<ToolPolicySnapshot> = {},
	signal?: AbortSignal,
	persistSession = false,
	grokHome = join(dir, "grok-home"),
): Promise<Readonly<{ execution: TurnExecution; workspace: string; input: AgentTurnInput }>> {
	const base = contractTurnInput({ runId: randomUUID(), message, deadlineMs: 20_000 });
	const input = { ...base, toolPolicy: { ...base.toolPolicy, ...policy } };
	const workspace = await createRunWorkspace(join(dir, "ws"), "developer", input.runId);
	try {
		const execution = await executeTurn(fakeRuntime(grokHome), input, {
			session: null,
			workspacePath: workspace,
			model: "grok-test",
			persistSession,
			...(signal === undefined ? {} : { signal }),
		});
		return { execution, workspace, input };
	} finally {
		await removeRunWorkspace(workspace);
	}
}

const lastCall = async () => (await recorded()).findLast((entry) => entry.args !== undefined);

const optionOf = (args: Readonly<string[]>, name: string) => args[args.indexOf(name) + 1];

describe("grok adapter", () => {
	it("runs in the run workspace with its own home, customizations off", async () => {
		const { execution, workspace } = await turn("@developer [fake:reply]");
		expect(execution.kind).toBe("completed");
		const call = await lastCall();
		expect(call?.cwd).toBe(workspace);
		const args = call?.args ?? [];
		expect(optionOf(args, "--output-format")).toBe("json");
		expect(optionOf(args, "--cwd")).toBe(workspace);
		expect(optionOf(args, "--permission-mode")).toBe("dontAsk");
		expect(optionOf(args, "--sandbox")).toBe("workspace");
		expect(optionOf(args, "--model")).toBe("grok-test");
		expect(args).toContain("--no-subagents");
		expect(JSON.parse(optionOf(args, "--json-schema") ?? "null")).toMatchObject({
			type: "object",
		});
		const env = call?.env ?? [];
		for (const name of ["GROK_HOME", "HOME", "GROK_TELEMETRY_TRACE_UPLOAD", "GROK_MEMORY"]) {
			expect(env).toContain(name);
		}
		const config = await readFile(join(dir, "grok-home", "config.toml"), "utf8");
		expect(config).toContain(`ignore = [${JSON.stringify(join(dir, "grok-home", "bundled"))}]`);
		expect(config).toContain('inherit = "core"');
	});

	it("offers only the granted web tools, never an empty tool list", async () => {
		await turn("@developer [fake:reply]", {
			allow: ["mattermost.post", "repository.read", "workspace.write", "tests.run"],
		});
		const withheld = (await lastCall())?.args ?? [];
		expect(optionOf(withheld, "--tools")).toBe("web_search");
		expect(withheld).toContain("--disable-web-search");
		const disallowed = optionOf(withheld, "--disallowed-tools")?.split(",") ?? [];
		expect(disallowed).toEqual(
			expect.arrayContaining(["run_terminal_command", "read_file", "write_file"]),
		);

		await turn("@developer [fake:reply]", { allow: ["mattermost.post", "web.fetch"] });
		const fetch = await lastCall();
		expect(optionOf(fetch?.args ?? [], "--tools")).toBe("web_fetch");
		expect(fetch?.args).not.toContain("--disable-web-search");
		expect(optionOf(fetch?.args ?? [], "--allow")).toBe("WebFetch");

		await turn("@developer [fake:reply]", {
			allow: ["mattermost.post", "web.search", "web.fetch"],
		});
		expect(optionOf((await lastCall())?.args ?? [], "--tools")).toBe("web_search,web_fetch");
	});

	it("passes none of the worker's environment to the runtime", async () => {
		process.env.DATABASE_URL = "postgres://gateway:secret@db/gateway";
		process.env.MM_LISTENER_TOKEN = "secret-token";
		try {
			const { execution } = await turn("@developer [fake:env]");
			expect(execution.kind).toBe("completed");
			const env = (await lastCall())?.env ?? [];
			expect(env).toContain("PATH");
			expect(env).not.toContain("DATABASE_URL");
			expect(env).not.toContain("MM_LISTENER_TOKEN");
		} finally {
			delete process.env.DATABASE_URL;
			delete process.env.MM_LISTENER_TOKEN;
		}
	});

	it("removes the transcript of a run that keeps no session", async () => {
		const home = join(dir, "grok-home-sessions");
		const transcripts = join(home, "sessions", "fake-group");
		const { execution } = await turn("@developer [fake:reply]", {}, undefined, false, home);
		expect(execution.kind === "completed" ? execution.result.session : "failed").toBeNull();
		expect(await readdir(transcripts).catch(() => [])).toEqual([]);
		const persisted = await turn("@developer [fake:reply]", {}, undefined, true, home);
		const session =
			persisted.execution.kind === "completed" ? persisted.execution.result.session : null;
		expect(session).toMatchObject({ adapter: "grok", runtimeVersion: "grok/9.9.9" });
		expect(await readdir(transcripts)).toEqual([session?.providerSessionId]);
	});

	it("stops the whole process group on cancel", async () => {
		const controller = new AbortController();
		const before = (await recorded()).filter((entry) => entry.child !== undefined).length;
		// Abort once the fake started its child, however slow the machine is.
		const started = setInterval(async () => {
			const children = (await recorded()).filter((entry) => entry.child !== undefined);
			if (children.length > before) {
				clearInterval(started);
				controller.abort();
			}
		}, 100);
		const { execution } = await turn("@developer [fake:slow]", {}, controller.signal);
		clearInterval(started);
		expect(execution.kind === "failed" ? execution.error.code : null).toBe("cancelled");
		const child = (await recorded()).findLast((entry) => entry.child !== undefined)?.child;
		expect(child).toBeGreaterThan(0);
		expect(() => process.kill(child ?? 0, 0)).toThrow();
	});

	it("reports a crash as retryable without the prompt", async () => {
		const { execution } = await turn("@developer [fake:crash]");
		expect(execution.kind).toBe("failed");
		if (execution.kind === "failed") {
			expect(execution.error).toMatchObject({ code: "runtime_retryable", retryable: true });
			expect(execution.error.detail).toContain("unexpected failure");
			expect(execution.error.detail).not.toContain("fake:crash");
		}
	});

	it("reports usage, cost and the model that answered", async () => {
		const { execution } = await turn("@developer [fake:reply]");
		expect(execution.kind === "completed" ? execution.result.usage : null).toMatchObject({
			inputTokens: 100,
			cachedInputTokens: 7,
			outputTokens: 20,
			costUsd: 0.01,
			model: "grok-fake",
		});
	});

	it("reports the version and the withheld tools", async () => {
		const probe = await fakeRuntime().probe();
		expect(probe).toMatchObject({ ok: true, runtimeVersion: "grok/9.9.9" });
		expect(probe.risks.join("\n")).toContain("tests.run");
	});

	it("fails the probe for a missing binary", async () => {
		const probe = await createGrokRuntime({
			command: [join(dir, "no-such-grok")],
			grokHome: join(dir, "grok-home"),
		}).probe();
		expect(probe.ok).toBe(false);
	});
});
