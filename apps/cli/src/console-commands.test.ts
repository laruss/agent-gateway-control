import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingError, verifyConsolePassword } from "@agent-gateway/service";
import { describe, expect, it } from "vitest";
import {
	CONSOLE_PASSWORD_MAX_LENGTH,
	CONSOLE_PASSWORD_MIN_LENGTH,
	ConsoleCommandError,
	ConsolePasswordCancelled,
	consolePasswordSet,
	type HiddenLineReader,
	nodeHiddenReader,
	type TtyInput,
	type TtyOutput,
} from "./console-commands.ts";

function tempSecretPath(name = "console_password_hash"): string {
	return join(mkdtempSync(join(tmpdir(), "console-cmd-")), name);
}

/** A `HiddenLineReader` that hands back queued lines instead of reading a real terminal. */
function fakeReader(lines: readonly string[], isTTY = true): HiddenLineReader {
	const queue = [...lines];
	return {
		isTTY,
		readLine: async () => {
			const value = queue.shift();
			if (value === undefined) {
				throw new Error("fakeReader: no more lines queued");
			}
			return value;
		},
	};
}

/** A reader whose `readLine` always fails: proves a caller never reached it. */
function neverReads(isTTY: boolean): HiddenLineReader {
	return {
		isTTY,
		readLine: async () => {
			throw new Error("readLine should not have been called");
		},
	};
}

/** A fake terminal pair for `nodeHiddenReader`: tracks raw-mode transitions instead of a real tty. */
function fakeTty(isTTY = true) {
	const listeners = new Set<(chunk: string) => void>();
	const rawModeHistory: boolean[] = [];
	const written: string[] = [];
	const stdin: TtyInput = {
		isTTY,
		setRawMode: (mode) => rawModeHistory.push(mode),
		resume: () => undefined,
		pause: () => undefined,
		setEncoding: () => undefined,
		on: (_event, listener) => {
			listeners.add(listener);
		},
		off: (_event, listener) => {
			listeners.delete(listener);
		},
	};
	const stdout: TtyOutput = {
		write: (chunk) => {
			written.push(chunk);
		},
	};
	return {
		stdin,
		stdout,
		rawModeHistory,
		written,
		/** Simulates keystrokes arriving in one chunk. */
		type: (chunk: string) => {
			for (const listener of [...listeners]) {
				listener(chunk);
			}
		},
	};
}

const STRONG_PASSWORD = "Str0ng-Console-Pw!";

describe("consolePasswordSet", () => {
	it("hashes the confirmed password as argon2id, mode 0600, verifiable by the shared verifier", async () => {
		const secretPath = tempSecretPath();
		const lines: string[] = [];
		await consolePasswordSet(
			{ secretPath, reader: fakeReader([STRONG_PASSWORD, STRONG_PASSWORD]) },
			(line) => lines.push(line),
		);
		const hash = readFileSync(secretPath, "utf8").trim();
		expect(hash.startsWith("$argon2id$")).toBe(true);
		expect(statSync(secretPath).mode & 0o777).toBe(0o600);
		expect(await verifyConsolePassword(STRONG_PASSWORD, hash)).toBe(true);
		expect(await verifyConsolePassword("something else entirely", hash)).toBe(false);
		const output = lines.join("\n");
		expect(output).toContain("restart the controller");
		expect(output).not.toContain(STRONG_PASSWORD);
		expect(output).not.toContain(hash);
	});

	it("rejects a mismatched confirmation and writes nothing", async () => {
		const secretPath = tempSecretPath();
		const error = await consolePasswordSet(
			{ secretPath, reader: fakeReader([STRONG_PASSWORD, "a-different-password-1"]) },
			() => undefined,
		).then(
			() => null,
			(caught: Error) => caught,
		);
		expect(error).toBeInstanceOf(ConsoleCommandError);
		expect((error as Error).message).not.toContain(STRONG_PASSWORD);
		expect(() => readFileSync(secretPath)).toThrow();
	});

	it("rejects a password shorter than the minimum length", async () => {
		const secretPath = tempSecretPath();
		await expect(
			consolePasswordSet({ secretPath, reader: fakeReader(["short1"]) }, () => undefined),
		).rejects.toThrow(`at least ${CONSOLE_PASSWORD_MIN_LENGTH}`);
		expect(() => readFileSync(secretPath)).toThrow();
	});

	it("rejects a password longer than the maximum length", async () => {
		const secretPath = tempSecretPath();
		const tooLong = "a".repeat(CONSOLE_PASSWORD_MAX_LENGTH + 1);
		await expect(
			consolePasswordSet({ secretPath, reader: fakeReader([tooLong]) }, () => undefined),
		).rejects.toThrow(`at most ${CONSOLE_PASSWORD_MAX_LENGTH}`);
	});

	it("refuses when stdin is not a terminal, without reading a line", async () => {
		const secretPath = tempSecretPath();
		await expect(
			consolePasswordSet({ secretPath, reader: neverReads(false) }, () => undefined),
		).rejects.toThrow(ConsoleCommandError);
		expect(() => readFileSync(secretPath)).toThrow();
	});

	it("replaces an existing hash: only the new password verifies afterwards", async () => {
		const secretPath = tempSecretPath();
		await consolePasswordSet(
			{ secretPath, reader: fakeReader(["first-strong-password", "first-strong-password"]) },
			() => undefined,
		);
		await consolePasswordSet(
			{ secretPath, reader: fakeReader(["second-strong-password", "second-strong-password"]) },
			() => undefined,
		);
		const hash = readFileSync(secretPath, "utf8").trim();
		expect(await verifyConsolePassword("first-strong-password", hash)).toBe(false);
		expect(await verifyConsolePassword("second-strong-password", hash)).toBe(true);
		expect(statSync(secretPath).mode & 0o777).toBe(0o600);
	});

	it("refuses to write through a symlink and leaves its target untouched", async () => {
		const dir = mkdtempSync(join(tmpdir(), "console-cmd-"));
		const target = join(dir, "elsewhere");
		writeFileSync(target, "untouched");
		const link = join(dir, "console_password_hash");
		symlinkSync(target, link);
		const error = await consolePasswordSet(
			{ secretPath: link, reader: fakeReader([STRONG_PASSWORD, STRONG_PASSWORD]) },
			() => undefined,
		).then(
			() => null,
			(caught: Error) => caught,
		);
		expect(error).toBeInstanceOf(SettingError);
		expect((error as Error).message).not.toContain(STRONG_PASSWORD);
		expect(readFileSync(target, "utf8")).toBe("untouched");
	});

	it("propagates cancellation without writing a secret", async () => {
		const secretPath = tempSecretPath();
		const cancelling: HiddenLineReader = {
			isTTY: true,
			readLine: async () => {
				throw new ConsolePasswordCancelled();
			},
		};
		await expect(
			consolePasswordSet({ secretPath, reader: cancelling }, () => undefined),
		).rejects.toThrow(ConsolePasswordCancelled);
		expect(() => readFileSync(secretPath)).toThrow();
	});
});

describe("nodeHiddenReader", () => {
	it("hides input and resolves without the trailing newline", async () => {
		const tty = fakeTty(true);
		const reader = nodeHiddenReader(tty.stdin, tty.stdout);
		const pending = reader.readLine("Console password: ");
		tty.type(`${STRONG_PASSWORD}\n`);
		expect(await pending).toBe(STRONG_PASSWORD);
		expect(tty.rawModeHistory).toEqual([true, false]);
		expect(tty.written.join("")).not.toContain(STRONG_PASSWORD);
	});

	it("restores the terminal and rejects on Ctrl-C", async () => {
		const tty = fakeTty(true);
		const reader = nodeHiddenReader(tty.stdin, tty.stdout);
		const pending = reader.readLine("Console password: ");
		tty.type("partial-entry\u0003");
		await expect(pending).rejects.toThrow(ConsolePasswordCancelled);
		expect(tty.rawModeHistory).toEqual([true, false]);
		expect(tty.written.join("")).not.toContain("partial-entry");
	});

	it("reports a non-TTY stream without touching raw mode", () => {
		const tty = fakeTty(false);
		const reader = nodeHiddenReader(tty.stdin, tty.stdout);
		expect(reader.isTTY).toBe(false);
		expect(tty.rawModeHistory).toEqual([]);
	});
});
