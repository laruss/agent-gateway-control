import { describe, expect, it } from "vitest";
import { hashConsolePassword, verifyConsolePassword } from "./console-auth.ts";

describe("console password hashing", () => {
	it("hashes as argon2id and verifies only the matching password", async () => {
		const hash = await hashConsolePassword("correct horse battery staple");
		expect(hash.startsWith("$argon2id$")).toBe(true);
		expect(await verifyConsolePassword("correct horse battery staple", hash)).toBe(true);
		expect(await verifyConsolePassword("wrong password", hash)).toBe(false);
	});

	it("fails closed on a hash it cannot parse, instead of throwing", async () => {
		expect(await verifyConsolePassword("anything", "not-a-real-hash")).toBe(false);
	});
});
