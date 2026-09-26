import { spawn } from "node:child_process";
import { RuntimeError } from "./adapter.ts";

export type ProcessSpec = Readonly<{
	command: string;
	args: Readonly<string[]>;
	cwd: string;
	/** The complete environment; nothing is inherited from the worker. */
	env: Readonly<Record<string, string>>;
	stdin: string;
	/**
	 * Bytes kept per stream: the first and the last half. What lies between is dropped and the
	 * result says so, so the final events of a long stream are never lost.
	 */
	maxOutputBytes: number;
	signal: AbortSignal;
	/** Time between SIGTERM and SIGKILL of the process group. */
	killGraceMs?: number;
}>;

export type ProcessResult = Readonly<{
	exitCode: number | null;
	/** The signal that ended the process, e.g. after an abort. */
	exitSignal: string | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	aborted: boolean;
	durationMs: number;
}>;

const DEFAULT_KILL_GRACE_MS = 5_000;
/**
 * How long output may stay open after the process exited. A descendant that left the process
 * group (`setsid`) can hold the pipes forever; the result must not wait for it.
 */
const OUTPUT_DRAIN_MS = 2_000;
/** Upper bound of `RunProcesses.cancel` beyond the kill grace. */
const CANCEL_SLACK_MS = 5_000;

/** Keeps the first and the last `max / 2` bytes of a stream. */
class HeadTailBuffer {
	private readonly head: Buffer[] = [];
	private headSize = 0;
	private tail: Buffer[] = [];
	private tailSize = 0;
	truncated = false;

	constructor(private readonly max: number) {}

	push(chunk: Buffer): void {
		const headRoom = Math.floor(this.max / 2) - this.headSize;
		if (headRoom > 0) {
			const kept = chunk.subarray(0, headRoom);
			this.head.push(kept);
			this.headSize += kept.length;
			if (kept.length === chunk.length) {
				return;
			}
			this.pushTail(chunk.subarray(kept.length));
			return;
		}
		this.pushTail(chunk);
	}

	private pushTail(chunk: Buffer): void {
		const limit = this.max - Math.floor(this.max / 2);
		this.tail.push(chunk);
		this.tailSize += chunk.length;
		while (this.tailSize > limit) {
			this.truncated = true;
			const first = this.tail[0];
			if (first === undefined) {
				break;
			}
			const excess = this.tailSize - limit;
			if (first.length <= excess) {
				this.tail = this.tail.slice(1);
				this.tailSize -= first.length;
			} else {
				this.tail[0] = first.subarray(excess);
				this.tailSize -= excess;
			}
		}
	}

	text(): string {
		const head = Buffer.concat(this.head).toString("utf8");
		const tail = Buffer.concat(this.tail).toString("utf8");
		// A newline keeps a line cut at the seam from gluing onto the next one.
		return this.truncated ? `${head}\n${tail}` : head + tail;
	}
}

/** Signals the whole process group; the group may already be gone. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// ESRCH: every process of the group has exited.
	}
}

/**
 * Runs a runtime CLI in its own process group, so an abort stops it together with every child
 * it started (shells, test runners). Resolves once the process has exited and its output is
 * drained (bounded, see `OUTPUT_DRAIN_MS`); never rejects for a non-zero exit, only when the
 * command cannot start.
 */
export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
	const started = Date.now();
	return new Promise<ProcessResult>((resolve, reject) => {
		if (spec.signal.aborted) {
			resolve({
				exitCode: null,
				exitSignal: null,
				stdout: "",
				stderr: "",
				truncated: false,
				aborted: true,
				durationMs: 0,
			});
			return;
		}
		const child = spawn(spec.command, [...spec.args], {
			cwd: spec.cwd,
			env: { ...spec.env },
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdout = new HeadTailBuffer(spec.maxOutputBytes);
		const stderr = new HeadTailBuffer(spec.maxOutputBytes);
		let aborted = false;
		let settled = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let drainTimer: ReturnType<typeof setTimeout> | undefined;

		const onAbort = () => {
			aborted = true;
			if (child.pid !== undefined) {
				const pid = child.pid;
				killGroup(pid, "SIGTERM");
				killTimer = setTimeout(
					() => killGroup(pid, "SIGKILL"),
					spec.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
				);
			}
		};
		spec.signal.addEventListener("abort", onAbort, { once: true });

		const finish = (code: number | null, signal: NodeJS.Signals | null) => {
			if (settled) {
				return;
			}
			settled = true;
			spec.signal.removeEventListener("abort", onAbort);
			clearTimeout(killTimer);
			clearTimeout(drainTimer);
			if (child.pid !== undefined) {
				// Children that outlived the leader (a daemonized helper) go with it.
				killGroup(child.pid, "SIGKILL");
			}
			child.stdout.destroy();
			child.stderr.destroy();
			resolve({
				exitCode: code,
				exitSignal: signal,
				stdout: stdout.text(),
				stderr: stderr.text(),
				truncated: stdout.truncated || stderr.truncated,
				aborted,
				durationMs: Date.now() - started,
			});
		};

		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		// A runtime that exits before reading its prompt closes stdin early; that is not an error.
		child.stdin.on("error", () => undefined);
		child.stdin.end(spec.stdin);

		child.on("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			spec.signal.removeEventListener("abort", onAbort);
			clearTimeout(killTimer);
			reject(new RuntimeError(`cannot start '${spec.command}': ${error.message}`, false));
		});
		child.on("exit", (code, signal) => {
			drainTimer = setTimeout(() => finish(code, signal), OUTPUT_DRAIN_MS);
		});
		child.on("close", (code, signal) => finish(code, signal));
	});
}

type Running = Readonly<{ abort: AbortController; done: Promise<void> }>;

/**
 * Processes of the runs an adapter is executing, so `cancel(runId)` can stop them and wait until
 * they are gone even after the turn's own promise was abandoned.
 */
export class RunProcesses {
	private readonly running = new Map<string, Set<Running>>();

	constructor(private readonly killGraceMs = DEFAULT_KILL_GRACE_MS) {}

	async run(runId: string, spec: ProcessSpec): Promise<ProcessResult> {
		const abort = new AbortController();
		const done = runProcess({
			killGraceMs: this.killGraceMs,
			...spec,
			signal: AbortSignal.any([spec.signal, abort.signal]),
		});
		const entry: Running = {
			abort,
			done: done.then(
				() => undefined,
				() => undefined,
			),
		};
		const set = this.running.get(runId) ?? new Set();
		set.add(entry);
		this.running.set(runId, set);
		try {
			return await done;
		} finally {
			set.delete(entry);
			if (set.size === 0) {
				this.running.delete(runId);
			}
		}
	}

	/** Stops the run's processes; resolves when they are gone or after a bounded wait. */
	async cancel(runId: string): Promise<boolean> {
		const set = this.running.get(runId);
		if (set === undefined) {
			return false;
		}
		const entries = [...set];
		for (const entry of entries) {
			entry.abort.abort();
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const bound = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, this.killGraceMs + OUTPUT_DRAIN_MS + CANCEL_SLACK_MS);
		});
		await Promise.race([Promise.all(entries.map((entry) => entry.done)), bound]);
		clearTimeout(timer);
		return true;
	}
}
