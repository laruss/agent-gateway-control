import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { createClaudeRuntime } from "./claude-runtime.ts";

const FAKE = join(import.meta.dirname, "fake-claude.ts");
let dir = "";

const fakeRuntime = (extraEnv: Readonly<Record<string, string>> = {}) =>
	createClaudeRuntime({
		command: ["bun", FAKE],
		configDir: join(dir, "claude-config"),
		env: {
			FAKE_SESSIONS: join(dir, "sessions"),
			FAKE_RECORD: join(dir, "record.jsonl"),
			...extraEnv,
		},
		killGraceMs: 500,
	});

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "claude-adapter-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

defineRuntimeContractSuite({
	name: "claude-code (fake CLI)",
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
): Promise<Readonly<{ execution: TurnExecution; workspace: string; input: AgentTurnInput }>> {
	const base = contractTurnInput({ runId: randomUUID(), message, deadlineMs: 20_000 });
	const input = { ...base, toolPolicy: { ...base.toolPolicy, ...policy } };
	const workspace = await createRunWorkspace(join(dir, "ws"), "developer", input.runId);
	try {
		const execution = await executeTurn(fakeRuntime(), input, {
			session: null,
			workspacePath: workspace,
			model: "gpt-test",
			persistSession: false,
			...(signal === undefined ? {} : { signal }),
		});
		return { execution, workspace, input };
	} finally {
		await removeRunWorkspace(workspace);
	}
}

const lastCall = async () => (await recorded()).findLast((entry) => entry.args !== undefined);

const optionOf = (args: Readonly<string[]>, name: string) => args[args.indexOf(name) + 1];

describe("claude adapter", () => {
	it("runs in the run workspace with customizations off and tools confined", async () => {
		const { execution, workspace } = await turn("@developer [fake:reply]");
		expect(execution.kind).toBe("completed");
		const call = await lastCall();
		expect(call?.cwd).toBe(workspace);
		const args = call?.args ?? [];
		for (const flag of ["-p", "--safe-mode", "--restricted", "--strict-mcp-config"]) {
			expect(args).toContain(flag);
		}
		expect(optionOf(args, "--output-format")).toBe("json");
		expect(optionOf(args, "--permission-mode")).toBe("dontAsk");
		expect(optionOf(args, "--permission-prompts")).toBe("none");
		expect(optionOf(args, "--model")).toBe("gpt-test");
		expect(args).toContain("--no-session-persistence");
		expect(optionOf(args, "--json-schema")).not.toContain("$schema");
	});

	it("maps the tool policy onto built-in tools", async () => {
		await turn("@developer [fake:reply]");
		const denied = (await lastCall())?.args ?? [];
		expect(optionOf(denied, "--tools")).toBe("");
		expect(denied).not.toContain("--allowedTools");

		await turn("@developer [fake:reply]", {
			allow: ["mattermost.post", "workspace.write", "tests.run", "web.fetch"],
		});
		const granted = (await lastCall())?.args ?? [];
		const tools = "Read,Grep,Glob,Edit,Write,NotebookEdit,Bash,WebFetch";
		expect(optionOf(granted, "--tools")).toBe(tools);
		expect(optionOf(granted, "--allowedTools")).toBe(tools);

		await turn("@developer [fake:reply]", { allow: ["mattermost.post", "repository.read"] });
		expect(optionOf((await lastCall())?.args ?? [], "--tools")).toBe("Read,Grep,Glob");
	});

	it("sandboxes Bash and scrubs its credentials when Bash is granted", async () => {
		await turn("@developer [fake:reply]");
		const denied = await lastCall();
		expect(denied?.env).not.toContain("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB");
		expect(denied?.args).not.toContain("--settings");

		const { workspace } = await turn("@developer [fake:reply]", {
			allow: ["mattermost.post", "tests.run"],
		});
		const granted = await lastCall();
		expect(granted?.env).toContain("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB");
		const settings = JSON.parse(optionOf(granted?.args ?? [], "--settings") ?? "{}");
		expect(settings.sandbox).toMatchObject({
			enabled: true,
			failIfUnavailable: true,
			allowUnsandboxedCommands: false,
			filesystem: { allowRead: [workspace, expect.stringContaining("/agw-")] },
		});
		expect(settings.sandbox.filesystem.denyRead).toEqual(
			expect.arrayContaining([
				join(dir, "claude-config"),
				dirname(dirname(workspace)),
				"/run/secrets",
			]),
		);
	});

	it("passes none of the worker's environment to the runtime", async () => {
		process.env.DATABASE_URL = "postgres://gateway:secret@db/gateway";
		process.env.MM_LISTENER_TOKEN = "secret-token";
		try {
			const { execution } = await turn("@developer [fake:env]");
			expect(execution.kind).toBe("completed");
			const env = (await lastCall())?.env ?? [];
			expect(env).toContain("CLAUDE_CONFIG_DIR");
			expect(env).toContain("CLAUDE_CODE_TMPDIR");
			expect(env).toContain("PATH");
			expect(env).not.toContain("DATABASE_URL");
			expect(env).not.toContain("MM_LISTENER_TOKEN");
		} finally {
			delete process.env.DATABASE_URL;
			delete process.env.MM_LISTENER_TOKEN;
		}
	});

	it("stops the whole process group on cancel", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 1_000);
		const { execution } = await turn("@developer [fake:slow]", {}, controller.signal);
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
			model: "claude-fake",
		});
	});

	it("reports the login method but not the account", async () => {
		const probe = await fakeRuntime().probe();
		expect(probe).toMatchObject({ ok: true, runtimeVersion: "claude-code/9.9.9" });
		expect(probe.detail).not.toContain("example.com");
	});

	it("fails the probe for a missing binary", async () => {
		const probe = await createClaudeRuntime({ command: [join(dir, "no-such-claude")] }).probe();
		expect(probe.ok).toBe(false);
	});
});
