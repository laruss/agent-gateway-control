import { createHash } from "node:crypto";
import type { JsonValue } from "@agent-gateway/contracts";

/**
 * Canonical JSON: object keys sorted by code unit, no whitespace, standard number formatting.
 * Equal values always produce equal strings, so hashes over it are stable.
 */
export function canonicalJson(value: JsonValue): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	const entries = Object.keys(value)
		.sort()
		.flatMap((key) => {
			const item = value[key];
			return item === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(item)}`];
		});
	return `{${entries.join(",")}}`;
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export function canonicalHash(value: JsonValue): string {
	return sha256Hex(canonicalJson(value));
}
