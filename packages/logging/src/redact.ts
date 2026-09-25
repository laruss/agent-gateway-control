/** Field names whose values are never logged. Matched case-insensitively as a substring. */
const SECRET_FIELD_PARTS: Readonly<string[]> = [
	"authorization",
	"password",
	"secret",
	"token",
	"api_key",
	"apikey",
	"cookie",
	"credential",
	"private_key",
];

/** Secret-looking substrings inside free text. */
const SECRET_PATTERNS: Readonly<RegExp[]> = [
	/\b(bearer|basic)\s+[a-z0-9._~+/=-]{8,}/giu,
	/\b(sk|pk|rk)-[a-z0-9_-]{16,}/giu,
	/\bgh[pousr]_[a-z0-9]{20,}/giu,
	/\bxox[abprs]-[a-z0-9-]{10,}/giu,
	/\bAKIA[0-9A-Z]{16}\b/gu,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
];

/** Credentials inside connection URLs; the scheme and host stay readable. */
const URL_CREDENTIALS = /\b(postgres(?:ql)?|mysql|redis|amqps?|https?):\/\/[^\s:@/]+:[^\s@/]+@/giu;

export const REDACTED = "[redacted]";

export function isSecretField(name: string): boolean {
	const lower = name.toLowerCase();
	return SECRET_FIELD_PARTS.some((part) => lower.includes(part));
}

/** Replaces secret-looking substrings in free text. */
export function redactText(text: string): string {
	return SECRET_PATTERNS.reduce(
		(current, pattern) => current.replace(pattern, REDACTED),
		text.replace(URL_CREDENTIALS, `$1://${REDACTED}@`),
	);
}

/** Redacts and truncates text for storage, e.g. an error detail. */
export function redactForStorage(text: string, maxLength = 2000): string {
	const redacted = redactText(text);
	return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 1)}…` : redacted;
}

export type LogValue = string | number | boolean | null | undefined | LogArray | LogObject;
export interface LogArray extends ReadonlyArray<LogValue> {}
export interface LogObject {
	readonly [key: string]: LogValue;
}

/** Deep copy with secret fields and secret-looking strings redacted. */
export function redactValue(value: LogValue, depth = 0): LogValue {
	if (typeof value === "string") {
		return redactText(value);
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	if (depth > 8) {
		return "[truncated]";
	}
	if (Array.isArray(value)) {
		return value.map((item: LogValue) => redactValue(item, depth + 1));
	}
	const result: { [key: string]: LogValue } = {};
	for (const [key, item] of Object.entries(value)) {
		result[key] = isSecretField(key) ? REDACTED : redactValue(item, depth + 1);
	}
	return result;
}
