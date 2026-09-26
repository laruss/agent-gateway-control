import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
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
import { createHermesRuntime } from "./hermes-runtime.ts";

const FAKE = join(import.meta.dirname, "fake-hermes.ts");
let dir = "";

const fakeRuntime = () =>
	createHermesRuntime({
		command: ["bun", FAKE],
		hermesHome: join(dir, "hermes-home"),
		provider: "fake-provider",
		env: { FAKE_SESSIONS: join(dir, "sessions"), FAKE_RECORD: join(dir, "record.jsonl") },
		killGraceMs: 500,
	});

beforeAll(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "hermes-adapter-")));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

defineRuntimeContractSuite({
	name: "hermes (fake CLI)",
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
	persistSession = false,
): Promise<Readonly<{ execution: TurnExecution; workspace: string; input: AgentTurnInput }>> {
	const base = contractTurnInput({ runId: randomUUID(), message, deadlineMs: 20_000 });
	const input = { ...base, toolPolicy: { ...base.toolPolicy, ...policy } };
	const workspace = await createRunWorkspace(join(dir, "ws"), "developer", input.runId);
	try {
		const execution = await executeTurn(fakeRuntime(), input, {
			session: null,
			workspacePath: workspace,
			model: "hermes-test",
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

describe("hermes adapter", () => {
	it("runs in the run workspace with its own home, customizations off", async () => {
		const { execution, workspace } = await turn("@developer [fake:reply]");
		expect(execution.kind).toBe("completed");
		const call = await lastCall();
		expect(call?.cwd).toBe(workspace);
		const args = call?.args ?? [];
		expect(optionOf(args, "--query-file")).toBe("-");
		expect(optionOf(args, "--format")).toBe("stream-json");
		expect(optionOf(args, "--source")).toBe("tool");
		expect(optionOf(args, "--provider")).toBe("fake-provider");
		expect(optionOf(args, "--model")).toBe("hermes-test");
		expect(args).toContain("--ignore-rules");
		expect(call?.env).toEqual(
			expect.arrayContaining(["HERMES_HOME", "HERMES_IGNORE_RULES", "HERMES_SAFE_MODE", "HOME"]),
		);
		const config = await readFile(join(dir, "hermes-home", "config.yaml"), "utf8");
		expect(config).toContain("adopt_external_logins: false");
		expect(config).toContain("  cli: []");
		expect(config).toContain("    - terminal");
	});

	it("names only the web toolsets that match the grants", async () => {
		await turn("@developer [fake:reply]", {
			allow: ["mattermost.post", "repository.read", "workspace.write", "tests.run", "web.fetch"],
		});
		expect((await lastCall())?.args).not.toContain("--toolsets");
		await turn("@developer [fake:reply]", { allow: ["mattermost.post", "web.search"] });
		expect(optionOf((await lastCall())?.args ?? [], "--toolsets")).toBe("search");
		await turn("@developer [fake:reply]", {
			allow: ["mattermost.post", "web.search", "web.fetch"],
		});
		expect(optionOf((await lastCall())?.args ?? [], "--toolsets")).toBe("web");
	});

	it("deletes the session of a run that keeps none", async () => {
		const { execution } = await turn("@developer [fake:reply]");
		expect(execution.kind === "completed" ? execution.result.session : "failed").toBeNull();
		expect((await recorded()).at(-1)?.deleted).toMatch(/^20260101_000000_/u);
		const persisted = await turn("@developer [fake:reply]", {}, undefined, true);
		expect(
			persisted.execution.kind === "completed" ? persisted.execution.result.session : null,
		).toMatchObject({ adapter: "hermes", runtimeVersion: "hermes/9.9.9" });
		expect((await recorded()).at(-1)?.deleted).toBeUndefined();
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

	it("reports token usage", async () => {
		const { execution } = await turn("@developer [fake:reply]");
		expect(execution.kind === "completed" ? execution.result.usage : null).toMatchObject({
			inputTokens: 100,
			cachedInputTokens: 7,
			outputTokens: 20,
			model: "hermes-test",
		});
	});

	it("reports the provider but not the account", async () => {
		const probe = await fakeRuntime().probe();
		expect(probe).toMatchObject({ ok: true, runtimeVersion: "hermes/9.9.9" });
		expect(probe.detail).toContain("fake-provider");
		expect(probe.detail).not.toContain("example.com");
		expect(probe.risks.join("\n")).toContain("tests.run");
	});

	it("fails the probe for a missing binary", async () => {
		const probe = await createHermesRuntime({
			command: [join(dir, "no-such-hermes")],
			hermesHome: join(dir, "hermes-home"),
		}).probe();
		expect(probe.ok).toBe(false);
	});
});
