import { describe, expect, it } from "vitest";
import { createLogger, errorFields, MAX_LOG_LINE } from "./logger.ts";
import {
	MAX_LOG_ARRAY,
	MAX_LOG_STRING,
	REDACTED,
	REDACTED_EMAIL,
	redactText,
	redactValue,
} from "./redact.ts";
import { DEVELOPMENT_VERSION, releaseVersion, serviceVersion } from "./version.ts";

describe("redactText", () => {
	it.each([
		["a Google refresh token", `got 1//0${"g".repeat(40)} back`, `got ${REDACTED} back`],
		["a Google access token", `ya29.${"a0Ad".repeat(10)}`, REDACTED],
		[
			"a JWT",
			`id ${["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiIxMjM0In0", "c2lnbmF0dXJlLXZhbHVl"].join(".")} done`,
			`id ${REDACTED} done`,
		],
		["a fine-grained GitHub token", `github_pat_${"A1".repeat(20)}`, REDACTED],
		["an Authorization header", "Authorization: Bearer abc", `Authorization: ${REDACTED}`],
		["an authorization assignment", "authorization=abc123", `authorization=${REDACTED}`],
		["an API key header", "x-api-key: k-123", `x-api-key: ${REDACTED}`],
		["a cookie header", "Cookie: a=1; b=2\nnext", `Cookie: ${REDACTED}\nnext`],
		[
			"secret query parameters",
			"GET https://h.example/cb?code=4/abc&state=s1&access_token=t&sig=x",
			`GET https://h.example/cb?code=${REDACTED}&state=s1&access_token=${REDACTED}&sig=${REDACTED}`,
		],
		["an email address", "from Jane.Doe+x@mail.example.org today", `from ${REDACTED_EMAIL} today`],
	])("redacts %s", (_, text, expected) => {
		expect(redactText(text)).toBe(expected);
	});

	it.each([
		["a Mattermost id", "post 8xk3rq9g7tbzmbj5s1wz4ha6ce"],
		["a UUID", "run 0b6f0b7e-8a36-4a45-9d9c-2ad1f1c0a001"],
		["a sha256", `hash ${"ab12".repeat(16)}`],
		["an approval code", "approve 7F3K-92QA-M4TX"],
		["a mention", "@developer please look"],
		["a path with two slashes", "file://1//0abc and a//0b"],
		["a query without secrets", "https://h.example/x?page=2&keyword=abc"],
		["a word next to a header name", "authorization failed for the agent"],
		["a host without a domain", "user@localhost"],
	])("keeps %s", (_, text) => {
		expect(redactText(text)).toBe(text);
	});

	it("keeps connection URLs readable after their credentials go", () => {
		expect(redactText("postgres://gateway:hunter2@db.example.com:5432/x")).toBe(
			`postgres://${REDACTED}@db.example.com:5432/x`,
		);
	});
});

describe("bounds", () => {
	it("cuts long strings and arrays", () => {
		const cut = redactValue("x".repeat(MAX_LOG_STRING + 10));
		expect(typeof cut === "string" && cut.length).toBe(MAX_LOG_STRING);
		expect(cut).toMatch(/…$/u);
		const list = redactValue(Array.from({ length: MAX_LOG_ARRAY + 5 }, (_, i) => i));
		expect(Array.isArray(list) && list.length).toBe(MAX_LOG_ARRAY + 1);
		expect(Array.isArray(list) && list.at(-1)).toBe("[5 more]");
	});

	it("keeps only the standard and correlation fields of a line that is too long", () => {
		const lines: string[] = [];
		const log = createLogger({
			service: "test",
			version: "1",
			environment: "test",
			write: (l) => lines.push(l),
		});
		const wide = Object.fromEntries(
			Array.from({ length: 20 }, (_, i) => [`field_${i}`, "y".repeat(MAX_LOG_STRING)]),
		);
		log.info("big", { ...wide, run_id: "r1" });
		const line = lines[0] ?? "";
		expect(line.length).toBeLessThanOrEqual(MAX_LOG_LINE);
		expect(JSON.parse(line)).toEqual({
			truncated: true,
			run_id: "r1",
			timestamp: expect.any(String),
			level: "info",
			service: "test",
			version: "1",
			environment: "test",
			message: "big",
		});
	});
});

describe("errorFields", () => {
	it("carries an error's string code, redacted and bounded", () => {
		const error = Object.assign(new Error("connect failed for a@b.example.com"), {
			code: "ECONNREFUSED",
		});
		expect(errorFields(error)).toEqual({
			error_name: "Error",
			error_message: `connect failed for ${REDACTED_EMAIL}`,
			error_code: "ECONNREFUSED",
		});
		const numeric = Object.assign(new Error("x"), { code: 42 });
		expect(errorFields(numeric)).not.toHaveProperty("error_code");
		const long = Object.assign(new Error("x"), { code: "C".repeat(200) });
		expect(String(errorFields(long).error_code).length).toBe(64);
	});
});

describe("serviceVersion", () => {
	it("reports the release version with its commit, or the development version", () => {
		expect(serviceVersion({})).toBe(DEVELOPMENT_VERSION);
		expect(serviceVersion({ GATEWAY_VERSION: "1.2.3" })).toBe("1.2.3");
		expect(
			serviceVersion({ GATEWAY_VERSION: "1.2.3", GATEWAY_COMMIT: "0123456789abcdef0123" }),
		).toBe("1.2.3+0123456789ab");
		expect(serviceVersion({ GATEWAY_VERSION: " ", GATEWAY_COMMIT: "" })).toBe(DEVELOPMENT_VERSION);
	});
});

describe("releaseVersion", () => {
	it("is the release version, or the development version when unset", () => {
		expect(releaseVersion({})).toBe(DEVELOPMENT_VERSION);
		expect(releaseVersion({ GATEWAY_VERSION: " 1.2.3 ", GATEWAY_COMMIT: "abc" })).toBe("1.2.3");
	});

	it("refuses a version that could match another release's certificate by mistake", () => {
		for (const version of ["v1.2.3", "1.2", "01.2.3", "1.2.3-rc.1", "1.2.3+abc"]) {
			expect(() => releaseVersion({ GATEWAY_VERSION: version })).toThrow("not a release version");
		}
	});
});
