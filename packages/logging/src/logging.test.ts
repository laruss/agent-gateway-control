import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.ts";
import { REDACTED, redactForStorage, redactText, redactValue } from "./redact.ts";

describe("redaction", () => {
	it("redacts secret-looking substrings", () => {
		expect(redactText("Authorization: Bearer abcdefghijklmnop")).toBe(`Authorization: ${REDACTED}`);
		expect(redactText("key sk-abcdefghijklmnopqrstuv end")).toBe(`key ${REDACTED} end`);
		expect(redactText("postgres://gateway:hunter2@db:5432/x")).toBe(
			`postgres://${REDACTED}@db:5432/x`,
		);
		expect(redactText("nothing secret here")).toBe("nothing secret here");
	});

	it("redacts secret fields at any depth", () => {
		expect(redactValue({ user: "a", nested: { api_key: "x", list: [{ token: "y" }] } })).toEqual({
			user: "a",
			nested: { api_key: REDACTED, list: [{ token: REDACTED }] },
		});
	});

	it("truncates stored details", () => {
		expect(redactForStorage("x".repeat(10), 5)).toBe("xxxx…");
	});

	it("writes redacted JSON lines with the standard fields", () => {
		const lines: string[] = [];
		const log = createLogger({
			service: "test",
			version: "1",
			environment: "test",
			write: (l) => lines.push(l),
		});
		log
			.child({ run_id: "r1" })
			.info("posting", { authorization: "Bearer abcdefghijkl", agent_id: "developer" });
		log.debug("hidden");
		expect(lines).toHaveLength(1);
		const line = JSON.parse(lines[0] ?? "{}");
		expect(line).toMatchObject({
			level: "info",
			service: "test",
			message: "posting",
			run_id: "r1",
			agent_id: "developer",
			authorization: REDACTED,
		});
	});
});
