import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRunWorkspace, removeRunWorkspace, runTempDir } from "./environment.ts";
import { RunProcesses, runProcess } from "./process.ts";

const RUN_ID = "7d1f2c3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
let dir = "";
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "runtime-process-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

const env = { PATH: process.env.PATH ?? "" };
const spec = (script: string, signal = new AbortController().signal) => ({
	command: "bun",
	args: ["-e", script],
	cwd: dir,
	env,
	stdin: "",
	maxOutputBytes: 1024,
	signal,
});

/** A child in a new session holding the parent's stdout: out of reach of a group kill. */
const ESCAPING_CHILD = `require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: ["ignore", "inherit", "inherit"] }).unref(); console.log("started");`;

describe("runProcess", () => {
	it("keeps the end of a long output", async () => {
		const result = await runProcess(
			spec(`for (let i = 0; i < 2000; i++) console.log("line " + i); console.log("FINAL");`),
		);
		expect(result.truncated).toBe(true);
		expect(result.stdout.startsWith("line 0\n")).toBe(true);
		expect(result.stdout.trimEnd().endsWith("FINAL")).toBe(true);
		expect(result.stdout.length).toBeLessThan(1100);
	});

	it("does not wait for a descendant that left the group and holds the output", async () => {
		const started = Date.now();
		const result = await runProcess(spec(ESCAPING_CHILD));
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("started");
		expect(Date.now() - started).toBeLessThan(6_000);
	});

	it("bounds cancel by the kill grace", async () => {
		const processes = new RunProcesses(200);
		const running = processes.run(
			RUN_ID,
			spec(`${ESCAPING_CHILD} process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`),
		);
		await new Promise((resolve) => setTimeout(resolve, 500));
		const started = Date.now();
		expect(await processes.cancel(RUN_ID)).toBe(true);
		expect(Date.now() - started).toBeLessThan(8_000);
		expect((await running).aborted).toBe(true);
	});
});

describe("createRunWorkspace", () => {
	it("gives every attempt an empty directory", async () => {
		const root = join(dir, "ws");
		const first = await createRunWorkspace(root, "developer", RUN_ID, 1);
		await writeFile(join(first, "left-over.txt"), "x");
		const again = await createRunWorkspace(root, "developer", RUN_ID, 1);
		expect(again).toBe(first);
		expect(await readdir(again)).toEqual([]);
		expect(await createRunWorkspace(root, "developer", RUN_ID, 2)).not.toBe(first);
	});

	it("refuses an agent directory that is a symlink", async () => {
		const root = join(dir, "linked");
		await mkdir(join(dir, "elsewhere"), { recursive: true });
		await mkdir(root, { recursive: true });
		await symlink(join(dir, "elsewhere"), join(root, "developer"));
		await expect(createRunWorkspace(root, "developer", RUN_ID)).rejects.toThrow(
			"is not a directory",
		);
	});
});

describe("removeRunWorkspace", () => {
	it("removes a workspace whose directories lost their write bit", async () => {
		const workspace = await createRunWorkspace(join(dir, "locked"), "developer", RUN_ID);
		const locked = join(workspace, "sub");
		await mkdir(locked);
		await writeFile(join(locked, "f.txt"), "x");
		await chmod(locked, 0o500);
		await removeRunWorkspace(workspace);
		await expect(readdir(workspace)).rejects.toThrow();
	});
});

describe("runTempDir", () => {
	it("does not bring back a workspace that was already removed", async () => {
		const workspace = await createRunWorkspace(join(dir, "gone"), "developer", RUN_ID);
		expect(await runTempDir(workspace)).toBe(join(workspace, ".tmp"));
		expect(await runTempDir(workspace)).toBe(join(workspace, ".tmp"));
		await removeRunWorkspace(workspace);
		await expect(runTempDir(workspace)).rejects.toThrow();
		await expect(readdir(workspace)).rejects.toThrow();
	});
});
