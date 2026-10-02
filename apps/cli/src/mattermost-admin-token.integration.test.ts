import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secretFileState } from "@agent-gateway/service";
import { afterEach, describe, expect, it } from "vitest";
import type { HiddenLineReader } from "./console-commands.ts";
import {
	MattermostCommandError,
	mattermostAdminTokenRotate,
	mattermostAdminTokenSet,
} from "./mattermost-commands.ts";

/** A `HiddenLineReader` that hands back queued lines instead of reading a real terminal. */
function fakeReader(lines: readonly string[], isTTY = true): HiddenLineReader {
	const queue = [...lines];
	return {
		isTTY,
		readLine: async () => {
			const value = queue.shift();
			if (value === undefined) {
				throw new Error("fakeReader: no more lines queued");
			}
			return value;
		},
	};
}

/** A valid-looking Mattermost id (26 lowercase alphanumerics): `prefix`, padded with zeros. */
function mmId(prefix: string): string {
	return `${prefix}${"0".repeat(26)}`.slice(0, 26);
}

type FakeAccount = Readonly<{
	id: string;
	username: string;
	is_bot: boolean;
	roles: string;
	delete_at: number;
}>;

/**
 * A fake of the Mattermost REST endpoints `admin-token set|rotate` call (`users/me`,
 * `users/{id}/tokens`, `users/{id}/tokens` listing, `users/tokens/revoke`), speaking their wire
 * format, with no real Mattermost server. Test-only.
 */
function startFakeMattermost() {
	const accountsById = new Map<string, FakeAccount>();
	const accountByTokenValue = new Map<string, string>();
	const tokens = new Map<string, { value: string; userId: string }>();
	const tokensByUser = new Map<string, Set<string>>();

	const addAccount = (token: string, account: FakeAccount): void => {
		accountsById.set(account.id, account);
		accountByTokenValue.set(token, account.id);
		// Registered as a real, revocable token too (not just a lookup shortcut): `rotate` must be
		// able to find and revoke this one through `users/{id}/tokens`, exactly like any other.
		const tokenId = randomUUID();
		tokens.set(tokenId, { value: token, userId: account.id });
		const ids = tokensByUser.get(account.id) ?? new Set<string>();
		ids.add(tokenId);
		tokensByUser.set(account.id, ids);
	};

	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			const auth = request.headers.get("authorization");
			const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
			const callerId = token === null ? undefined : accountByTokenValue.get(token);
			const caller = callerId === undefined ? undefined : accountsById.get(callerId);

			if (url.pathname === "/api/v4/users/me" && request.method === "GET") {
				return caller === undefined
					? json({ id: "api.context.invalid_token.error", message: "invalid token" }, 401)
					: json(caller);
			}
			const createOrList = /^\/api\/v4\/users\/([^/]+)\/tokens$/.exec(url.pathname);
			if (createOrList !== null && request.method === "POST") {
				if (caller === undefined) {
					return json({}, 401);
				}
				const userId = createOrList[1] ?? "";
				const tokenId = randomUUID();
				const value = `tok-${randomUUID()}`;
				tokens.set(tokenId, { value, userId });
				accountByTokenValue.set(value, userId);
				const ids = tokensByUser.get(userId) ?? new Set<string>();
				ids.add(tokenId);
				tokensByUser.set(userId, ids);
				return json({
					id: tokenId,
					token: value,
					user_id: userId,
					description: "agent-gateway-admin",
				});
			}
			if (createOrList !== null && request.method === "GET") {
				if (caller === undefined) {
					return json({}, 401);
				}
				const userId = createOrList[1] ?? "";
				const ids = [...(tokensByUser.get(userId) ?? [])];
				return json(ids.map((id) => ({ id, description: "agent-gateway-admin", is_active: true })));
			}
			if (url.pathname === "/api/v4/users/tokens/revoke" && request.method === "POST") {
				if (caller === undefined) {
					return json({}, 401);
				}
				const body = (await request.json()) as { token_id?: string };
				const tokenId = body.token_id;
				const entry = tokenId === undefined ? undefined : tokens.get(tokenId);
				if (entry !== undefined && tokenId !== undefined) {
					tokens.delete(tokenId);
					accountByTokenValue.delete(entry.value);
					tokensByUser.get(entry.userId)?.delete(tokenId);
				}
				return json({ status: "OK" });
			}
			return json({ message: `no fake route for ${request.method} ${url.pathname}` }, 404);
		},
	});

	return {
		baseUrl: `http://127.0.0.1:${server.port}`,
		addAccount,
		worksNow: (tokenValue: string) => accountByTokenValue.has(tokenValue),
		stop: () => server.stop(true),
	};
}

describe("gateway mattermost admin-token set|rotate (ADR-026)", () => {
	let fake: ReturnType<typeof startFakeMattermost> | null = null;

	afterEach(() => {
		fake?.stop();
		fake = null;
	});

	const secretPath = () =>
		join(mkdtempSync(join(tmpdir(), "gateway-admin-token-")), "mattermost_admin_token");

	it("stores a validated token (non-bot, system_admin) and prints only the username", async () => {
		fake = startFakeMattermost();
		fake.addAccount("admin-token-value", {
			id: mmId("admin"),
			username: "gateway-admin",
			is_bot: false,
			roles: "system_user system_admin",
			delete_at: 0,
		});
		const path = secretPath();
		const printed: string[] = [];

		await mattermostAdminTokenSet(
			{ baseUrl: fake.baseUrl, secretPath: path, reader: fakeReader(["admin-token-value"]) },
			(line) => printed.push(line),
		);

		expect(secretFileState(path)).toBe("private");
		expect(readFileSync(path, "utf8").trim()).toBe("admin-token-value");
		expect(printed.join("\n")).toContain("gateway-admin");
		expect(printed.join("\n")).not.toContain("admin-token-value");
	});

	it("refuses a bot account's token", async () => {
		fake = startFakeMattermost();
		fake.addAccount("bot-token-value", {
			id: mmId("bot"),
			username: "some-bot",
			is_bot: true,
			roles: "system_user",
			delete_at: 0,
		});
		const path = secretPath();

		await expect(
			mattermostAdminTokenSet(
				{ baseUrl: fake.baseUrl, secretPath: path, reader: fakeReader(["bot-token-value"]) },
				() => undefined,
			),
		).rejects.toThrow(MattermostCommandError);
		expect(secretFileState(path)).toBe("missing");
	});

	it("refuses an account without the system_admin role", async () => {
		fake = startFakeMattermost();
		fake.addAccount("plain-token-value", {
			id: mmId("plain"),
			username: "owner",
			is_bot: false,
			roles: "system_user",
			delete_at: 0,
		});
		const path = secretPath();

		await expect(
			mattermostAdminTokenSet(
				{ baseUrl: fake.baseUrl, secretPath: path, reader: fakeReader(["plain-token-value"]) },
				() => undefined,
			),
		).rejects.toThrow(MattermostCommandError);
		expect(secretFileState(path)).toBe("missing");
	});

	it("rotates: the old token stops working, the new one works, the file holds only the new one", async () => {
		fake = startFakeMattermost();
		fake.addAccount("old-token-value", {
			id: mmId("admin"),
			username: "gateway-admin",
			is_bot: false,
			roles: "system_user system_admin",
			delete_at: 0,
		});
		const path = secretPath();
		await mattermostAdminTokenSet(
			{ baseUrl: fake.baseUrl, secretPath: path, reader: fakeReader(["old-token-value"]) },
			() => undefined,
		);
		expect(fake.worksNow("old-token-value")).toBe(true);

		const printed: string[] = [];
		await mattermostAdminTokenRotate({ baseUrl: fake.baseUrl, secretPath: path }, (line) =>
			printed.push(line),
		);

		const newToken = readFileSync(path, "utf8").trim();
		expect(newToken).not.toBe("old-token-value");
		expect(fake.worksNow("old-token-value")).toBe(false);
		expect(fake.worksNow(newToken)).toBe(true);
		expect(printed.join("\n")).toContain("gateway-admin");
		expect(printed.join("\n")).not.toContain(newToken);
	});

	it("rotate is safe to re-run after a crash that left more than one token on the account", async () => {
		fake = startFakeMattermost();
		fake.addAccount("token-a", {
			id: mmId("admin"),
			username: "gateway-admin",
			is_bot: false,
			roles: "system_user system_admin",
			delete_at: 0,
		});
		const path = secretPath();
		await mattermostAdminTokenSet(
			{ baseUrl: fake.baseUrl, secretPath: path, reader: fakeReader(["token-a"]) },
			() => undefined,
		);
		// A first rotate "crashes" conceptually right after writing the new token (simulated: the
		// file already holds a second, newer token, but the first one was never revoked).
		await mattermostAdminTokenRotate({ baseUrl: fake.baseUrl, secretPath: path }, () => undefined);
		expect(fake.worksNow("token-a")).toBe(false);
		const afterFirstRotate = readFileSync(path, "utf8").trim();

		await mattermostAdminTokenRotate({ baseUrl: fake.baseUrl, secretPath: path }, () => undefined);
		const afterSecondRotate = readFileSync(path, "utf8").trim();
		expect(afterSecondRotate).not.toBe(afterFirstRotate);
		expect(fake.worksNow(afterFirstRotate)).toBe(false);
		expect(fake.worksNow(afterSecondRotate)).toBe(true);
	});
});
