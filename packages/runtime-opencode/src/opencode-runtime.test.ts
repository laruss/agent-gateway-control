import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
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
import { createOpencodeRuntime } from "./opencode-runtime.ts";

const FAKE = join(import.meta.dirname, "fake-opencode.ts");
let dir = "";

const fakeRuntime = () =>
	createOpencodeRuntime({
		command: ["bun", FAKE],
		opencodeHome: join(dir, "opencode-home"),
		apiKey: "test-key",
		defaultModel: "kimi-default",
		env: { FAKE_RECORD: join(dir, "record.jsonl") },
		killGraceMs: 500,
	});

beforeAll(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "opencode-adapter-")));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

defineRuntimeContractSuite({
	name: "opencode-go (fake CLI)",
	createAdapter: () => fakeRuntime(),
	prompts: {
		reply: "@developer please reply [fake:reply]",
		wait: "@developer ask finance [fake:wait]",
		invalid: "@developer [fake:invalid]",
		slow: "@developer [fake:slow]",
	},
});

type Recorded = Readonly<{
	args?: string[];
	cwd?: string;
	env?: string[];
	child?: number;
	deleted?: string;
	config?: string;
}>;

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
	model: string | null = "kimi-test",
): Promise<Readonly<{ execution: TurnExecution; workspace: string; input: AgentTurnInput }>> {
	const base = contractTurnInput({ runId: randomUUID(), message, deadlineMs: 20_000 });
	const input = { ...base, toolPolicy: { ...base.toolPolicy, ...policy } };
	const workspace = await createRunWorkspace(join(dir, "ws"), "developer", input.runId);
	try {
		const execution = await executeTurn(fakeRuntime(), input, {
			session: null,
			workspacePath: workspace,
			model,
			persistSession: true,
			...(signal === undefined ? {} : { signal }),
		});
		return { execution, workspace, input };
	} finally {
		await removeRunWorkspace(workspace);
	}
}

const lastCall = async () => (await recorded()).findLast((entry) => entry.args !== undefined);

const optionOf = (args: Readonly<string[]>, name: string) => args[args.indexOf(name) + 1];

/** The permission rules of the last call, in order. */
async function permissions(): Promise<Readonly<[string, string][]>> {
	const config = JSON.parse((await lastCall())?.config ?? "{}");
	return Object.entries(config.permission ?? {});
}

describe("opencode adapter", () => {
	it("runs in the run workspace with its own directories, customizations off", async () => {
		const { execution, workspace } = await turn("@developer [fake:reply]");
		expect(execution.kind).toBe("completed");
		const call = await lastCall();
		expect(call?.cwd).toBe(workspace);
		const args = call?.args ?? [];
		expect(args.slice(0, 4)).toEqual(["run", "--pure", "--format", "json"]);
		expect(optionOf(args, "--model")).toBe("opencode-go/kimi-test");
		const env = call?.env ?? [];
		for (const name of [
			"HOME",
			"XDG_CONFIG_HOME",
			"XDG_DATA_HOME",
			"OPENCODE_API_KEY",
			"OPENCODE_DISABLE_PROJECT_CONFIG",
			"OPENCODE_DISABLE_CLAUDE_CODE",
		]) {
			expect(env).toContain(name);
		}
	});

	it("reads the fenced answer of the last step and deletes the session", async () => {
		const { execution } = await turn("@developer [fake:reply]");
		expect(
			execution.kind === "completed" ? execution.result.publicMessages[0]?.markdown : null,
		).toBe("Done.");
		expect(execution.kind === "completed" ? execution.result.session : "failed").toBeNull();
		expect((await recorded()).at(-1)?.deleted).toBe("ses_fake0001");
	});

	it("maps the tool policy onto permissions and never grants the shell", async () => {
		await turn("@developer [fake:reply]");
		expect(await permissions()).toEqual([
			["*", "deny"],
			["external_directory", "deny"],
			["doom_loop", "deny"],
		]);
		await turn("@developer [fake:reply]", {
			allow: ["mattermost.post", "workspace.write", "tests.run", "web.fetch"],
		});
		const granted = await permissions();
		expect(granted[0]).toEqual(["*", "deny"]);
		expect(granted.at(-2)).toEqual(["external_directory", "deny"]);
		expect(Object.fromEntries(granted)).toMatchObject({
			read: "allow",
			glob: "allow",
			grep: "allow",
			edit: "allow",
			webfetch: "allow",
		});
		expect(Object.fromEntries(granted)).not.toHaveProperty("bash");
		expect(Object.fromEntries(granted)).not.toHaveProperty("websearch");
		const config = JSON.parse((await lastCall())?.config ?? "{}");
		expect(config).toMatchObject({ mcp: {}, plugin: [], instructions: [], share: "disabled" });
	});

	it("refuses a turn without a model or inside a git checkout", async () => {
		const base = contractTurnInput({
			runId: randomUUID(),
			message: "@developer [fake:reply]",
			deadlineMs: 20_000,
		});
		const plain = await createRunWorkspace(join(dir, "ws"), "developer", base.runId);
		try {
			const unset = await executeTurn(
				createOpencodeRuntime({
					command: ["bun", FAKE],
					opencodeHome: join(dir, "opencode-home"),
					apiKey: "test-key",
				}),
				base,
				{ session: null, workspacePath: plain, model: null, persistSession: false },
			);
			expect(unset.kind === "failed" ? unset.error : null).toMatchObject({
				retryable: false,
				detail: expect.stringContaining("no model"),
			});
		} finally {
			await removeRunWorkspace(plain);
		}
		const checkout = join(dir, "checkout");
		await mkdir(join(checkout, ".git"), { recursive: true });
		const workspace = await createRunWorkspace(join(checkout, "ws"), "developer", base.runId);
		try {
			const inside = await executeTurn(fakeRuntime(), base, {
				session: null,
				workspacePath: workspace,
				model: "kimi-test",
				persistSession: false,
			});
			expect(inside.kind === "failed" ? inside.error.detail : null).toContain("git checkout");
		} finally {
			await removeRunWorkspace(workspace);
		}
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

	it("sums usage and cost over the steps", async () => {
		const { execution } = await turn("@developer [fake:reply]");
		expect(execution.kind === "completed" ? execution.result.usage : null).toMatchObject({
			inputTokens: 200,
			cachedInputTokens: 14,
			outputTokens: 50,
			costUsd: 0.01,
			model: "opencode-go/kimi-test",
		});
	});

	it("reports the version, the provider and the withheld tools", async () => {
		const probe = await fakeRuntime().probe();
		expect(probe).toMatchObject({ ok: true, runtimeVersion: "opencode/9.9.9" });
		expect(probe.detail).toContain("opencode-go");
		expect(probe.risks.join("\n")).toContain("tests.run");
	});

	it("fails the probe without a credential or a binary", async () => {
		const home = join(dir, "no-credential");
		expect(
			(await createOpencodeRuntime({ command: ["bun", FAKE], opencodeHome: home }).probe()).ok,
		).toBe(false);
		expect(
			(
				await createOpencodeRuntime({
					command: [join(dir, "no-such-opencode")],
					opencodeHome: home,
					apiKey: "k",
				}).probe()
			).ok,
		).toBe(false);
	});
});
