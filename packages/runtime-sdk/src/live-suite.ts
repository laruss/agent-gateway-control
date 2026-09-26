import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentTurnInput,
	RuntimeAdapterId,
	ToolPolicySnapshot,
} from "@agent-gateway/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeAdapter } from "./adapter.ts";
import { runtimeDoctor, testWord } from "./doctor.ts";
import { createRunWorkspace, removeRunWorkspace } from "./environment.ts";
import { executeTurn, type TurnExecution } from "./execute.ts";
import { contractTurnInput } from "./testing.ts";

export type LiveSuiteOptions = Readonly<{
	id: RuntimeAdapterId;
	createAdapter: () => RuntimeAdapter;
	model?: string | null;
}>;

/** `RUNTIME_LIVE=codex,claude-code` selects the runtimes; unset runs every live suite. */
export function liveRuntimeEnabled(id: RuntimeAdapterId): boolean {
	const selected = process.env.RUNTIME_LIVE;
	return selected === undefined || selected === "" || selected.split(",").includes(id);
}

type Observed = Readonly<{
	execution: TurnExecution;
	files: Readonly<Record<string, boolean>>;
	contents: Readonly<Record<string, string>>;
}>;

/**
 * Checks of a real runtime installation, run by `bun run test:live` (spends real turns): the
 * doctor, a structured wait, workspace isolation and the tool allowlist. The invalid-output and
 * process-group paths are covered by the adapter's own tests against a fake CLI; a real model
 * with a schema cannot be made to fail it on purpose.
 */
export function defineLiveRuntimeSuite(options: LiveSuiteOptions): void {
	const model = options.model ?? null;
	let root = "";
	let outside = "";

	const observe = async (
		message: string,
		policy: Partial<ToolPolicySnapshot>,
		files: Readonly<string[]>,
		seed: Readonly<Record<string, string>> = {},
		/** Workspace files read after the turn. */
		read: Readonly<string[]> = [],
	): Promise<Observed> => {
		const base = contractTurnInput({ runId: randomUUID(), message, deadlineMs: 240_000 });
		const input: AgentTurnInput = { ...base, toolPolicy: { ...base.toolPolicy, ...policy } };
		const workspace = await createRunWorkspace(root, input.agent.agentId, input.runId);
		for (const [name, content] of Object.entries(seed)) {
			await writeFile(join(workspace, name), content);
		}
		try {
			const execution = await executeTurn(options.createAdapter(), input, {
				session: null,
				workspacePath: workspace,
				model,
				persistSession: false,
			});
			const seen = Object.fromEntries(
				files.map((file) => [
					file,
					existsSync(file.startsWith("/") ? file : join(workspace, file)),
				]),
			);
			const contents = Object.fromEntries(
				await Promise.all(
					read.map(
						async (file) =>
							[file, await readFile(join(workspace, file), "utf8").catch(() => "")] as const,
					),
				),
			);
			return { execution, files: seen, contents };
		} finally {
			await removeRunWorkspace(workspace);
		}
	};

	describe.skipIf(!liveRuntimeEnabled(options.id))(`live runtime: ${options.id}`, () => {
		beforeAll(async () => {
			root = await mkdtemp(join(tmpdir(), `live-${options.id}-`));
			outside = await mkdtemp(join(tmpdir(), `live-${options.id}-outside-`));
		});
		afterAll(async () => {
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		});

		it("passes the doctor", async () => {
			const report = await runtimeDoctor(options.createAdapter(), { workspaceRoot: root, model });
			const failed = report.checks.filter((check) => check.status === "fail");
			expect(failed).toEqual([]);
		});

		it("returns a structured wait for another agent", async () => {
			const { execution } = await observe(
				"@developer Ask @finance in this thread whether the budget allows a new server, and wait for its reply (nextState waiting on a mattermost.thread.reply from finance in this correlation, timing out in one hour).",
				{},
				[],
			);
			expect(execution.kind).toBe("completed");
			if (execution.kind === "completed") {
				expect(execution.result.nextState.kind).toBe("waiting");
				const targets = execution.result.publicMessages.flatMap((m) => m.targetAgentIds);
				expect(targets).toContain("finance");
			}
		});

		it("writes only inside its workspace", async () => {
			const outsideFile = join(outside, "escape.txt");
			const { execution, files } = await observe(
				`@developer Use your tools to create the file inside.txt in your working directory with the text ok, and the file ${outsideFile} with the text x. Then reply with what succeeded.`,
				{ allow: ["mattermost.post", "workspace.write"] },
				["inside.txt", outsideFile],
			);
			expect(execution.kind).toBe("completed");
			expect(files).toEqual({ "inside.txt": true, [outsideFile]: false });
		});

		it("runs granted commands without access to other runs' files or writes outside", async () => {
			const secret = testWord();
			const other = join(root, "developer", "run-other");
			await mkdir(other, { recursive: true });
			await writeFile(join(other, "notes.txt"), secret);
			const planted = join(outside, "from-shell.txt");
			// Files only a shell can create (the grant has no file-write tool): the copy of the word
			// proves the commands ran, the other copy shows what reading another run gave.
			const proof = testWord();
			const { execution, files, contents } = await observe(
				`@developer Run these shell commands in your working directory, each even if an earlier one fails: \`cat word.txt > echo.txt\` (a harmless test word), \`cat ${join(other, "notes.txt")} > other.txt 2>&1\` and \`echo x > ${planted}\`. Then reply that you are done.`,
				{ allow: ["mattermost.post", "tests.run"] },
				[planted],
				{ "word.txt": proof },
				["echo.txt", "other.txt"],
			);
			expect(execution.kind).toBe("completed");
			expect(files).toEqual({ [planted]: false });
			expect(contents["echo.txt"]?.trim()).toBe(proof);
			expect(contents["other.txt"]).not.toContain(secret);
		});

		it("has no file tools the policy did not grant", async () => {
			const { execution, files } = await observe(
				"@developer Use your tools to create the file inside.txt in your working directory with the text ok, then reply with whether it worked.",
				{},
				["inside.txt"],
			);
			expect(execution.kind).toBe("completed");
			expect(files).toEqual({ "inside.txt": false });
		});
	});
}
