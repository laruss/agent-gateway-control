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
import { createKiroRuntime } from "./kiro-runtime.ts";

const FAKE = join(import.meta.dirname, "fake-kiro.ts");
let dir = "";

const fakeRuntime = (kiroHome = join(dir, "kiro-home")) =>
	createKiroRuntime({
		command: ["bun", FAKE],
		kiroHome,
		env: { FAKE_SESSIONS: join(dir, "sessions"), FAKE_RECORD: join(dir, "record.jsonl") },
		killGraceMs: 500,
	});

beforeAll(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "kiro-adapter-")));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

defineRuntimeContractSuite({
	name: "kiro (fake CLI)",
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
	agent?: string;
	child?: number;
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
	kiroHome = join(dir, "kiro-home"),
): Promise<Readonly<{ execution: TurnExecution; workspace: string; input: AgentTurnInput }>> {
	const base = contractTurnInput({ runId: randomUUID(), message, deadlineMs: 20_000 });
	const input = { ...base, toolPolicy: { ...base.toolPolicy, ...policy } };
	const workspace = await createRunWorkspace(join(dir, "ws"), "developer", input.runId);
	try {
		const execution = await executeTurn(fakeRuntime(kiroHome), input, {
			session: null,
			workspacePath: workspace,
			model: "kiro-test",
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

describe("kiro adapter", () => {
	it("runs in the run workspace with its own home and a pinned engine", async () => {
		const { execution, workspace } = await turn("@developer [fake:reply]");
		expect(execution.kind).toBe("completed");
		const call = await lastCall();
		expect(call?.cwd).toBe(workspace);
		const args = call?.args ?? [];
		expect(args.slice(0, 2)).toEqual(["chat", "--no-interactive"]);
		expect(optionOf(args, "--output-format")).toBe("stream-json");
		expect(optionOf(args, "--agent-engine")).toBe("v2");
		expect(optionOf(args, "--model")).toBe("kiro-test");
		expect(call?.env).toEqual(expect.arrayContaining(["KIRO_HOME", "KIRO_DISABLE_TELEMETRY"]));
		const settings = JSON.parse(
			await readFile(join(dir, "kiro-home", "settings", "cli.json"), "utf8"),
		);
		expect(settings).toMatchObject({ "telemetry.enabled": false, "chat.enableKnowledge": false });
	});

	it("uses an agent with only the granted web tools and nothing else", async () => {
		await turn("@developer [fake:reply]", {
			allow: ["mattermost.post", "repository.read", "workspace.write", "tests.run"],
		});
		const none = await lastCall();
		expect(optionOf(none?.args ?? [], "--agent")).toBe("gateway-none");
		expect(none?.args).toContain("--trust-tools=");
		expect(JSON.parse(none?.agent ?? "{}")).toMatchObject({
			tools: [],
			allowedTools: [],
			prompt: null,
			mcpServers: {},
			includeMcpJson: false,
			resources: [],
			hooks: {},
		});

		await turn("@developer [fake:reply]", {
			allow: ["mattermost.post", "web.search", "web.fetch"],
		});
		const web = await lastCall();
		expect(web?.args).toContain("--trust-tools=web_search,web_fetch");
		expect(JSON.parse(web?.agent ?? "{}").tools).toEqual(["web_search", "web_fetch"]);
	});

	it("restores a removed agent definition before the turn", async () => {
		const home = join(dir, "kiro-home-restore");
		await turn("@developer [fake:reply]", {}, undefined, false, home);
		await rm(join(home, "agents"), { recursive: true, force: true });
		const { execution } = await turn("@developer [fake:reply]", {}, undefined, false, home);
		expect(execution.kind).toBe("completed");
		expect(JSON.parse((await lastCall())?.agent ?? "{}")).toMatchObject({ tools: [] });
	});

	it("fails a turn the CLI ran on its default agent", async () => {
		const adapter = createKiroRuntime({
			command: ["bun", FAKE],
			kiroHome: join(dir, "kiro-home"),
			env: { FAKE_RECORD: join(dir, "record.jsonl"), FAKE_DEFAULT_AGENT: "1" },
		});
		const base = contractTurnInput({
			runId: randomUUID(),
			message: "@developer [fake:reply]",
			deadlineMs: 20_000,
		});
		const workspace = await createRunWorkspace(join(dir, "ws"), "developer", base.runId);
		try {
			const execution = await executeTurn(adapter, base, {
				session: null,
				workspacePath: workspace,
				model: null,
				persistSession: false,
			});
			expect(execution.kind === "failed" ? execution.error : null).toMatchObject({
				retryable: false,
			});
		} finally {
			await removeRunWorkspace(workspace);
		}
	});

	it("removes the transcript of a run that keeps no session", async () => {
		const home = join(dir, "kiro-home-sessions");
		const transcripts = join(home, "sessions", "cli");
		await turn("@developer [fake:reply]", {}, undefined, false, home);
		expect(await readdir(transcripts)).toEqual([]);
		const persisted = await turn("@developer [fake:reply]", {}, undefined, true, home);
		const session =
			persisted.execution.kind === "completed" ? persisted.execution.result.session : null;
		expect(session).toMatchObject({ adapter: "kiro", runtimeVersion: "kiro-cli/9.9.9" });
		expect(await readdir(transcripts)).toEqual([`${session?.providerSessionId}.json`]);
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

	it("reports the login type but not the account", async () => {
		const probe = await fakeRuntime().probe();
		expect(probe).toMatchObject({ ok: true, runtimeVersion: "kiro-cli/9.9.9" });
		expect(probe.detail).toContain("Fake");
		expect(probe.detail).not.toContain("example.com");
		expect(probe.risks.join("\n")).toContain("repository.read");
	});

	it("fails the probe for a missing binary", async () => {
		const probe = await createKiroRuntime({
			command: [join(dir, "no-such-kiro")],
			kiroHome: join(dir, "kiro-home"),
		}).probe();
		expect(probe.ok).toBe(false);
	});
});
