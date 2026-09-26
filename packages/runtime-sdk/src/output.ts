import type { JsonValue } from "@agent-gateway/contracts";

/** Helpers for reading the untrusted output of a runtime CLI. */

export function asRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

export function asString(value: JsonValue | undefined): string | null {
	return typeof value === "string" ? value : null;
}

/** A token count; anything but a non-negative safe integer counts as zero. */
export function asCount(value: JsonValue | undefined): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** JSON, or null for anything that does not parse. */
export function parseJson(text: string): JsonValue | null {
	try {
		const value: JsonValue = JSON.parse(text);
		return value;
	} catch {
		return null;
	}
}

/** The JSON objects of a JSON Lines stream; other lines (warnings, partial lines) are skipped. */
export function parseJsonLines(text: string): Readonly<Readonly<Record<string, JsonValue>>[]> {
	return text
		.split("\n")
		.map((line) => asRecord(parseJson(line.trim()) ?? undefined))
		.filter((event) => event !== null);
}

/** The end of a diagnostic output, for error details. */
export function tail(text: string, max = 600): string {
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

const FENCED = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u;

/**
 * The model output in a final message of a runtime without native structured output: the JSON
 * value the prompt asked for, also when the model wrapped it in a Markdown code fence. Anything
 * else is returned as the text itself; validation then rejects it and asks for the one repair,
 * and the text is never posted.
 */
export function parseJsonAnswer(text: string): JsonValue {
	const trimmed = text.trim();
	return parseJson(FENCED.exec(trimmed)?.[1] ?? trimmed) ?? text;
}

/**
 * The result schema without unanchored `pattern` keywords, for runtimes whose constrained
 * decoding matches a pattern against the whole string (JSON Schema matches anywhere): there
 * `\S` ("not blank") would allow exactly one character. Anchored patterns mean the same in both
 * readings and stay; the Gateway's own validation still checks every dropped one.
 */
export function withoutUnanchoredPatterns(schema: JsonValue): JsonValue {
	if (Array.isArray(schema)) {
		return schema.map(withoutUnanchoredPatterns);
	}
	if (typeof schema !== "object" || schema === null) {
		return schema;
	}
	return Object.fromEntries(
		Object.entries(schema)
			.filter(([key, value]) => key !== "pattern" || typeof value !== "string" || anchored(value))
			.map(([key, value]) => [
				key,
				// A property named "pattern" is a schema, not the keyword; instance values stay.
				key === "properties"
					? propertiesWithout(value)
					: INSTANCE_VALUES.includes(key)
						? value
						: withoutUnanchoredPatterns(value),
			]),
	);
}

/** Keywords whose value is data, not a schema. */
const INSTANCE_VALUES = ["const", "enum", "default", "examples"];

/** Anchored at both ends with no alternation, so whole-string and anywhere matching agree. */
function anchored(pattern: string): boolean {
	return pattern.startsWith("^") && pattern.endsWith("$") && !pattern.includes("|");
}

function propertiesWithout(properties: JsonValue): JsonValue {
	const record = asRecord(properties);
	return record === null
		? properties
		: Object.fromEntries(
				Object.entries(record).map(([name, value]) => [name, withoutUnanchoredPatterns(value)]),
			);
}
