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

/** Header-like `name: value` pairs inside free text; the name stays, the value goes. */
const HEADER_VALUES =
	/\b((?:proxy-)?authorization|x-api-key|api-key|x-auth-token|x-goog-api-key)(\s*[:=]\s*)(?:(?:bearer|basic|token|digest)\s+)?[^\s,;"']+/giu;

/** Cookies carry several values: everything up to the end of the line goes. */
const COOKIE_VALUES = /\b(set-cookie|cookie)(\s*:\s*)[^\r\n]+/giu;

/** Secret-looking substrings inside free text. */
const SECRET_PATTERNS: Readonly<RegExp[]> = [
	/\b(bearer|basic)\s+[a-z0-9._~+/=-]{8,}/giu,
	/\b(sk|pk|rk)-[a-z0-9_-]{16,}/giu,
	/\bgh[pousr]_[a-z0-9]{20,}/giu,
	/\bgithub_pat_[a-z0-9_]{20,}/giu,
	/\bxox[abprs]-[a-z0-9-]{10,}/giu,
	/\bAKIA[0-9A-Z]{16}\b/gu,
	// Google OAuth refresh and access tokens.
	/(?<![\w/])1\/\/0[a-z0-9_-]{20,}/giu,
	/\bya29\.[a-z0-9._-]{20,}/giu,
	// JSON Web Tokens: header.payload.signature, the header always starts with `{"`.
	/\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]*/giu,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
];

/** Credentials inside connection URLs; the scheme and host stay readable. */
const URL_CREDENTIALS = /\b(postgres(?:ql)?|mysql|redis|amqps?|https?):\/\/[^\s:@/]+:[^\s@/]+@/giu;

/** Secret query parameters; the parameter name stays readable. */
const URL_QUERY_SECRETS =
	/([?&](?:token|access_token|refresh_token|id_token|key|api_key|code|signature|sig|password|secret|client_secret)=)[^&\s#"'<>]+/giu;

/** Email addresses are personal data: the whole address goes. */
const EMAIL_ADDRESSES = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/giu;

export const REDACTED = "[redacted]";
export const REDACTED_EMAIL = "[email]";

/** Longest string value a log line keeps. */
export const MAX_LOG_STRING = 4096;
/** Most items an array in a log line keeps. */
export const MAX_LOG_ARRAY = 100;

export function isSecretField(name: string): boolean {
	const lower = name.toLowerCase();
	return SECRET_FIELD_PARTS.some((part) => lower.includes(part));
}

/** Replaces secret-looking substrings and email addresses in free text. */
export function redactText(text: string): string {
	const structured = text
		.replace(URL_CREDENTIALS, `$1://${REDACTED}@`)
		.replace(URL_QUERY_SECRETS, `$1${REDACTED}`)
		.replace(COOKIE_VALUES, `$1$2${REDACTED}`)
		.replace(HEADER_VALUES, `$1$2${REDACTED}`);
	return SECRET_PATTERNS.reduce(
		(current, pattern) => current.replace(pattern, REDACTED),
		structured,
	).replace(EMAIL_ADDRESSES, REDACTED_EMAIL);
}

/** Cuts text to `maxLength` characters, marking the cut. */
export function truncateText(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Redacts and truncates text for storage, e.g. an error detail. */
export function redactForStorage(text: string, maxLength = 2000): string {
	return truncateText(redactText(text), maxLength);
}

export type LogValue = string | number | boolean | null | undefined | LogArray | LogObject;
export interface LogArray extends ReadonlyArray<LogValue> {}
export interface LogObject {
	readonly [key: string]: LogValue;
}

/**
 * Deep copy with secret fields and secret-looking strings redacted, strings cut to
 * `MAX_LOG_STRING` and arrays to `MAX_LOG_ARRAY` items.
 */
export function redactValue(value: LogValue, depth = 0): LogValue {
	if (typeof value === "string") {
		return truncateText(redactText(value), MAX_LOG_STRING);
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	if (depth > 8) {
		return "[truncated]";
	}
	if (Array.isArray(value)) {
		const kept = value
			.slice(0, MAX_LOG_ARRAY)
			.map((item: LogValue) => redactValue(item, depth + 1));
		return value.length > MAX_LOG_ARRAY
			? [...kept, `[${value.length - MAX_LOG_ARRAY} more]`]
			: kept;
	}
	const result: { [key: string]: LogValue } = {};
	for (const [key, item] of Object.entries(value)) {
		result[key] = isSecretField(key) ? REDACTED : redactValue(item, depth + 1);
	}
	return result;
}
