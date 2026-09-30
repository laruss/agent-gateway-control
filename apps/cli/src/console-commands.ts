import {
	CONSOLE_PASSWORD_MAX_LENGTH,
	CONSOLE_PASSWORD_MIN_LENGTH,
	hashConsolePassword,
	writeSecretFile,
} from "@agent-gateway/service";

export class ConsoleCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConsoleCommandError";
	}
}

/** Raised when the owner cancels hidden entry (Ctrl-C) instead of finishing it. */
export class ConsolePasswordCancelled extends Error {
	constructor() {
		super("cancelled");
		this.name = "ConsolePasswordCancelled";
	}
}

/** One line of hidden input, and whether the source is an interactive terminal at all. */
export type HiddenLineReader = Readonly<{
	readonly isTTY: boolean;
	readLine: (prompt: string) => Promise<string>;
}>;

/**
 * The minimal terminal surface hidden entry needs. `process.stdin`/`process.stdout` satisfy this
 * directly; tests inject a small fake instead of mocking the real streams.
 */
export type TtyInput = Readonly<{
	readonly isTTY: boolean;
	setRawMode: (mode: boolean) => void;
	resume: () => void;
	pause: () => void;
	setEncoding: (encoding: "utf8") => void;
	on: (event: "data", listener: (chunk: string) => void) => void;
	off: (event: "data", listener: (chunk: string) => void) => void;
}>;

export type TtyOutput = Readonly<{
	write: (chunk: string) => void;
}>;

const CTRL_C = "\u0003";
const CTRL_U = "\u0015";
const BACKSPACE = "\u007f";
/** C0 controls, DEL and C1 controls: never part of a password a login dialog can reproduce. */
function isControl(ch: string): boolean {
	const code = ch.codePointAt(0) ?? 0;
	return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/**
 * Reads one line with the terminal's echo off. Raw mode is restored whichever way the line
 * ends: Enter, Ctrl-C, or an error partway through. Backspace removes a whole character and
 * Ctrl-U the whole entry; any other control key (arrows and other escape sequences included)
 * ends the entry with an error rather than storing bytes an HTTP Basic dialog cannot type.
 */
function readHiddenLine(stdin: TtyInput, stdout: TtyOutput, prompt: string): Promise<string> {
	return new Promise((resolve, reject) => {
		// Code points, not UTF-16 units, so a backspace never leaves half a surrogate pair.
		let value: string[] = [];
		let settled = false;
		const onData = (chunk: string) => {
			for (const ch of chunk) {
				if (ch === CTRL_C) {
					finish(() => {
						stdout.write("\n");
						reject(new ConsolePasswordCancelled());
					});
					return;
				}
				if (ch === "\r" || ch === "\n") {
					finish(() => {
						stdout.write("\n");
						resolve(value.join(""));
					});
					return;
				}
				if (ch === BACKSPACE || ch === "\b") {
					value = value.slice(0, -1);
					continue;
				}
				if (ch === CTRL_U) {
					value = [];
					continue;
				}
				if (isControl(ch)) {
					finish(() => {
						stdout.write("\n");
						reject(
							new ConsoleCommandError(
								"unsupported key in the password (only Backspace and Ctrl-U edit it); nothing was changed",
							),
						);
					});
					return;
				}
				value.push(ch);
			}
		};
		const finish = (run: () => void) => {
			if (settled) {
				return;
			}
			settled = true;
			// Restore the terminal before running the callback, so a reject/resolve that throws
			// (or a caller that reads the terminal again right away) never sees raw mode left on.
			stdin.off("data", onData);
			stdin.setRawMode(false);
			stdin.pause();
			run();
		};
		stdout.write(prompt);
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding("utf8");
		stdin.on("data", onData);
	});
}

/** The real terminal: `process.stdin`/`process.stdout`, or another pair injected for tests. */
export function nodeHiddenReader(
	stdin: TtyInput = process.stdin,
	stdout: TtyOutput = process.stdout,
): HiddenLineReader {
	return {
		isTTY: stdin.isTTY,
		readLine: (prompt) => readHiddenLine(stdin, stdout, prompt),
	};
}

export type ConsolePasswordSetOptions = Readonly<{
	/** The console's secret file, already resolved against the secrets directory in effect. */
	secretPath: string;
	reader: HiddenLineReader;
}>;

/**
 * `gateway console password set`: hidden entry, confirmed, hashed as Argon2id and written to the
 * console's secret file. Refuses anything but an interactive terminal, so the password can never
 * arrive as a command argument or an environment variable; the password and its hash are never
 * printed or included in an error.
 */
export async function consolePasswordSet(
	options: ConsolePasswordSetOptions,
	print: (line: string) => void,
): Promise<void> {
	if (!options.reader.isTTY) {
		throw new ConsoleCommandError("stdin is not a terminal; run this from an interactive shell");
	}
	const password = await options.reader.readLine("Console password: ");
	if (password.length < CONSOLE_PASSWORD_MIN_LENGTH) {
		throw new ConsoleCommandError(
			`the password must be at least ${CONSOLE_PASSWORD_MIN_LENGTH} characters`,
		);
	}
	if (password.length > CONSOLE_PASSWORD_MAX_LENGTH) {
		throw new ConsoleCommandError(
			`the password must be at most ${CONSOLE_PASSWORD_MAX_LENGTH} characters`,
		);
	}
	const confirmation = await options.reader.readLine("Confirm password: ");
	if (password !== confirmation) {
		throw new ConsoleCommandError("the two entries did not match; nothing was changed");
	}
	const hash = await hashConsolePassword(password);
	writeSecretFile(options.secretPath, hash);
	print(
		`console password set at ${options.secretPath}; restart the controller (bin/agw restart gateway-controller) to apply it`,
	);
}
