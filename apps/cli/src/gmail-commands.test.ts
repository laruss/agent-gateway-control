import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeGoogle, startFakeGoogle } from "@agent-gateway/connector-gmail/testing";
import { afterEach, describe, expect, it } from "vitest";
import { gmailAuthorize } from "./gmail-commands.ts";

let google: FakeGoogle | null = null;
afterEach(async () => {
	await google?.stop();
	google = null;
});

const client = { clientId: "client-id", clientSecret: "client-secret" };

/** Plays the browser: follows the printed consent URL back to the loopback redirect. */
async function consent(lines: string[], params: (state: string) => Record<string, string>) {
	for (;;) {
		const url = lines.find((line) => line.includes("/authorize?"));
		if (url !== undefined) {
			const request = new URL(url);
			const redirect = new URL(request.searchParams.get("redirect_uri") ?? "");
			redirect.search = new URLSearchParams(
				params(request.searchParams.get("state") ?? ""),
			).toString();
			return fetch(redirect);
		}
		await Bun.sleep(10);
	}
}

describe("gmailAuthorize", () => {
	it("stores the refresh token privately and never prints it", async () => {
		google = startFakeGoogle();
		const out = join(mkdtempSync(join(tmpdir(), "gmail-auth-")), "gmail_refresh_token");
		const lines: string[] = [];
		const done = gmailAuthorize({ client, out, endpoints: google.endpoints }, (line) =>
			lines.push(line),
		);
		// A request without the run's state is ignored.
		const forged = await consent(lines, () => ({ code: "fake-code", state: "forged" }));
		expect(forged.status).toBe(400);
		const answer = await consent(lines, (state) => ({ code: "fake-code", state }));
		expect(answer.status).toBe(200);
		await done;
		expect(readFileSync(out, "utf8").trim()).toBe(google.refreshToken);
		expect(statSync(out).mode & 0o077).toBe(0);
		expect(lines.join("\n")).not.toContain(google.refreshToken);
	});

	it("fails when the operator declines", async () => {
		google = startFakeGoogle();
		const out = join(mkdtempSync(join(tmpdir(), "gmail-auth-")), "token");
		const lines: string[] = [];
		const done = gmailAuthorize({ client, out, endpoints: google.endpoints }, (line) =>
			lines.push(line),
		);
		const outcome = done.then(
			() => null,
			(error: Error) => error.message,
		);
		const answer = await consent(lines, (state) => ({ error: "access_denied", state }));
		expect(await answer.text()).toContain("Authorization failed");
		expect(await outcome).toContain("access_denied");
	});
});
