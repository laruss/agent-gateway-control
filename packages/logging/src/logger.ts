import { type LogValue, redactText, redactValue, truncateText } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

/** Correlation fields every log line may carry. */
export type LogFields = Readonly<{
	event_id?: string;
	run_id?: string;
	agent_id?: string;
	job_id?: string;
	correlation_id?: string;
	trace_id?: string;
	error_code?: string;
	[key: string]: LogValue;
}>;

export type Logger = Readonly<{
	debug: (message: string, fields?: LogFields) => void;
	info: (message: string, fields?: LogFields) => void;
	warn: (message: string, fields?: LogFields) => void;
	error: (message: string, fields?: LogFields) => void;
	child: (fields: LogFields) => Logger;
}>;

export type LoggerOptions = Readonly<{
	service: string;
	version: string;
	environment: string;
	level?: LogLevel;
	/** Line sink; stdout by default. */
	write?: (line: string) => void;
}>;

/** Longest serialized log line; a longer one keeps only its standard and correlation fields. */
export const MAX_LOG_LINE = 32 * 1024;

/** Fields a line cut for its size still carries. */
const KEPT_FIELDS: Readonly<string[]> = [
	"timestamp",
	"level",
	"service",
	"version",
	"environment",
	"message",
	"event_id",
	"run_id",
	"agent_id",
	"job_id",
	"correlation_id",
	"trace_id",
	"span_id",
	"error_code",
];

/** Describes an error for a log line without its stack's local values. */
export function errorFields(error: unknown): LogFields {
	if (error instanceof Error) {
		const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
		return {
			error_name: error.name,
			error_message: redactText(error.message),
			...(code === undefined ? {} : { error_code: truncateText(redactText(code), 64) }),
		};
	}
	return { error_message: redactText(String(error)) };
}

/** The line as JSON, cut to its standard and correlation fields when it is too long. */
function serializeLine(line: LogValue): string {
	const json = JSON.stringify(line);
	if (
		json.length <= MAX_LOG_LINE ||
		line === null ||
		typeof line !== "object" ||
		Array.isArray(line)
	) {
		return json;
	}
	const kept: { [key: string]: LogValue } = { truncated: true };
	for (const [key, value] of Object.entries(line)) {
		if (KEPT_FIELDS.includes(key)) {
			kept[key] = value;
		}
	}
	return JSON.stringify(kept);
}

/** JSON lines logger with mandatory redaction. */
export function createLogger(options: LoggerOptions, bound: LogFields = {}): Logger {
	const minimum = LEVEL_ORDER[options.level ?? "info"];
	const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));

	const log = (level: LogLevel, message: string, fields: LogFields = {}) => {
		if (LEVEL_ORDER[level] < minimum) {
			return;
		}
		const line = redactValue({
			...bound,
			...fields,
			timestamp: new Date().toISOString(),
			level,
			service: options.service,
			version: options.version,
			environment: options.environment,
			message,
		});
		write(serializeLine(line));
	};

	return {
		debug: (message, fields) => log("debug", message, fields),
		info: (message, fields) => log("info", message, fields),
		warn: (message, fields) => log("warn", message, fields),
		error: (message, fields) => log("error", message, fields),
		child: (fields) => createLogger(options, { ...bound, ...fields }),
	};
}

/** A logger that drops everything; for tests. */
export const silentLogger: Logger = createLogger({
	service: "test",
	version: "0",
	environment: "test",
	write: () => {},
});
