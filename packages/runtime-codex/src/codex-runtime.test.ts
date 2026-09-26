import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { createCodexRuntime } from "./codex-runtime.ts";

const FAKE = join(import.meta.dirname, "fake-codex.ts");
let dir = "";

const fakeRuntime = (extraEnv: Readonly<Record<string, string>> = {}) =>
	createCodexRuntime({
		command: ["bun", FAKE],
		codexHome: join(dir, "codex-home"),
		env: {
			FAKE_SESSIONS: join(dir, "sessions"),
			FAKE_RECORD: join(dir, "record.jsonl"),
			...extraEnv,
		},
		killGraceMs: 500,
	});

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "codex-adapter-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

defineRuntimeContractSuite({
	name: "codex (fake CLI)",
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

describe("codex adapter", () => {
	it("runs in the run workspace with the user config, rules and connectors off", async () => {
		const { execution, workspace } = await turn("@developer [fake:reply]");
		expect(execution.kind).toBe("completed");
		const call = await lastCall();
		expect(call?.cwd).toBe(workspace);
		const args = call?.args ?? [];
		for (const flag of ["--json", "--strict-config", "--ignore-user-config", "--ignore-rules"]) {
			expect(args).toContain(flag);
		}
		expect(args.slice(args.indexOf("-C"), args.indexOf("-C") + 2)).toEqual(["-C", workspace]);
		expect(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2)).toEqual(["-m", "gpt-test"]);
		expect(args).toContain("--ephemeral");
		expect(args).toContain("project_doc_max_bytes=0");
		expect(args).toContain("skills.include_instructions=false");
		expect(args.join(" ")).toContain("--disable view_image");
		expect(args).toContain(
			`shell_environment_policy.set.TMPDIR=${JSON.stringify(join(workspace, ".tmp"))}`,
		);
		expect(args).toContain('default_permissions="gateway"');
		expect(args.slice(args.indexOf("-o"), args.indexOf("-o") + 1)).toEqual(["-o"]);
		expect(args[args.indexOf("-o") + 1]?.startsWith(workspace)).toBe(false);
		expect(args.join(" ")).toContain("--disable apps");
	});

	it("maps the tool policy onto the permission profile, the shell and web search", async () => {
		const profile = (args: Readonly<string[]>) =>
			args.find((arg) => arg.startsWith("permissions.gateway.filesystem=")) ?? "";

		await turn("@developer [fake:reply]");
		const denied = (await lastCall())?.args ?? [];
		expect(profile(denied)).toContain('":workspace_roots"={"."="read"}');
		expect(profile(denied)).toContain(`${JSON.stringify(join(dir, "codex-home"))}="deny"`);
		for (const denial of ['":slash_tmp"="deny"', '":tmpdir"="deny"']) {
			expect(profile(denied)).toContain(denial);
		}
		expect(denied).toContain('web_search="disabled"');
		expect(denied.join(" ")).toContain("--disable shell_tool --disable unified_exec");

		// Reading and writing grant no shell: commands need tests.run.
		await turn("@developer [fake:reply]", { allow: ["mattermost.post", "workspace.write"] });
		const write = (await lastCall())?.args ?? [];
		expect(profile(write)).toContain('":workspace_roots"={"."="write"}');
		expect(write.join(" ")).toContain("--disable shell_tool");

		await turn("@developer [fake:reply]", {
			allow: ["mattermost.post", "workspace.write", "tests.run", "web.search"],
		});
		const granted = (await lastCall())?.args ?? [];
		expect(granted).toContain('web_search="live"');
		expect(granted).not.toContain("shell_tool");
	});

	it("passes none of the worker's environment to the runtime", async () => {
		process.env.DATABASE_URL = "postgres://gateway:secret@db/gateway";
		process.env.MM_LISTENER_TOKEN = "secret-token";
		try {
			const { execution } = await turn("@developer [fake:env]");
			expect(execution.kind).toBe("completed");
			const env = (await lastCall())?.env ?? [];
			expect(env).toContain("CODEX_HOME");
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

	it("reports usage and the model", async () => {
		const { execution } = await turn("@developer [fake:reply]");
		expect(execution.kind === "completed" ? execution.result.usage : null).toMatchObject({
			inputTokens: 100,
			cachedInputTokens: 10,
			outputTokens: 20,
			model: "gpt-test",
		});
	});

	it("fails the probe for a missing binary", async () => {
		const probe = await createCodexRuntime({ command: [join(dir, "no-such-codex")] }).probe();
		expect(probe.ok).toBe(false);
	});
});
