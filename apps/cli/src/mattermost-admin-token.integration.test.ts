import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireMattermostCredentialLock,
	releaseMattermostCredentialLock,
} from "@agent-gateway/core";
import { createPool } from "@agent-gateway/db";
import { secretFileState, writeSecretFile } from "@agent-gateway/service";
import { startTestPostgres, type TestPostgres } from "@agent-gateway/testkit";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
	const tokens = new Map<string, { value: string; userId: string; description: string }>();
	const tokensByUser = new Map<string, Set<string>>();

	/** The description a token this fake creates carries unless told otherwise: the Gateway's own
	 * (`ADMIN_TOKEN_DESCRIPTION`, `mattermost-commands.ts`) — every existing test's own tokens stay
	 * exactly as before; a test for an *unrelated* token on the account passes its own description
	 * explicitly instead. */
	const DEFAULT_DESCRIPTION = "agent-gateway-admin";

	const addAccount = (
		token: string,
		account: FakeAccount,
		description: string = DEFAULT_DESCRIPTION,
	): void => {
		accountsById.set(account.id, account);
		accountByTokenValue.set(token, account.id);
		// Registered as a real, revocable token too (not just a lookup shortcut): `rotate` must be
		// able to find and revoke this one through `users/{id}/tokens`, exactly like any other.
		const tokenId = randomUUID();
		tokens.set(tokenId, { value: token, userId: account.id, description });
		const ids = tokensByUser.get(account.id) ?? new Set<string>();
		ids.add(tokenId);
		tokensByUser.set(account.id, ids);
	};

	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

	// Set by a test to simulate a server bug/race where the very next minted token ends up usable
	// by a *different* account than the one it was requested for — the one case
	// `mattermostAdminTokenSet`/`mattermostAdminTokenRotate` must catch (`verified.id !== me.id`) and
	// must revoke rather than leave stranded. Consumed once, like `failures` elsewhere in this repo's
	// own fakes.
	let rigNextTokenOwner: string | null = null;

	// Set by a test (`stallNextMe`) to hold the *next* `users/me` request open until released: both
	// commands call `client.me()` as their very first Mattermost call, right after already holding
	// the admin-token lock (ADR-026) — stalling it there lets a test deterministically observe a
	// concurrent run failing fast against a lock the first call already holds, rather than racing a
	// fixed delay. Consumed once.
	let stalledMe: Readonly<{ notifyStarted: () => void; gate: Promise<void> }> | null = null;

	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			const auth = request.headers.get("authorization");
			const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
			const callerId = token === null ? undefined : accountByTokenValue.get(token);
			const caller = callerId === undefined ? undefined : accountsById.get(callerId);

			if (url.pathname === "/api/v4/users/me" && request.method === "GET" && stalledMe !== null) {
				const { notifyStarted, gate } = stalledMe;
				stalledMe = null;
				notifyStarted();
				await gate;
			}

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
				const requestedUserId = createOrList[1] ?? "";
				const owner = rigNextTokenOwner ?? requestedUserId;
				rigNextTokenOwner = null;
				const body = (await request.json()) as { description?: string };
				const tokenId = randomUUID();
				const value = `tok-${randomUUID()}`;
				const description = body.description ?? DEFAULT_DESCRIPTION;
				tokens.set(tokenId, { value, userId: owner, description });
				accountByTokenValue.set(value, owner);
				const ids = tokensByUser.get(owner) ?? new Set<string>();
				ids.add(tokenId);
				tokensByUser.set(owner, ids);
				return json({ id: tokenId, token: value, user_id: owner, description });
			}
			if (createOrList !== null && request.method === "GET") {
				if (caller === undefined) {
					return json({}, 401);
				}
				const userId = createOrList[1] ?? "";
				// Paged, like the real endpoint: a listing of more than one page's worth of tokens
				// must take more than one request to see in full.
				const page = Number(url.searchParams.get("page") ?? "0");
				const perPage = Number(url.searchParams.get("per_page") ?? "60");
				const ids = [...(tokensByUser.get(userId) ?? [])].slice(
					page * perPage,
					(page + 1) * perPage,
				);
				return json(
					ids.flatMap((id) => {
						const entry = tokens.get(id);
						return entry === undefined
							? []
							: [{ id, description: entry.description, is_active: true }];
					}),
				);
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

	/** Seeds `count` more revocable tokens on `userId`, standing in for a stray pile of old ones
	 * (a crashed earlier rotate, say) — only their count and revocation matter here, never their
	 * values, so `me()` never needs to look any of them up by value. Each carries the Gateway's own
	 * description by default, same as `addAccount`'s own seed token. */
	const addTokens = (
		userId: string,
		count: number,
		description: string = DEFAULT_DESCRIPTION,
	): void => {
		for (let i = 0; i < count; i += 1) {
			const tokenId = randomUUID();
			const value = `extra-${randomUUID()}`;
			tokens.set(tokenId, { value, userId, description });
			accountByTokenValue.set(value, userId);
			const ids = tokensByUser.get(userId) ?? new Set<string>();
			ids.add(tokenId);
			tokensByUser.set(userId, ids);
		}
	};

	return {
		baseUrl: `http://127.0.0.1:${server.port}`,
		addAccount,
		addTokens,
		tokenCount: (userId: string): number => tokensByUser.get(userId)?.size ?? 0,
		worksNow: (tokenValue: string) => accountByTokenValue.has(tokenValue),
		rigNextTokenOwner: (userId: string): void => {
			rigNextTokenOwner = userId;
		},
		/** Holds the *next* `users/me` request open: `started` resolves once that request actually
		 * arrives (the point a test can be sure the admin-token lock is already held), `release` lets
		 * it proceed. */
		stallNextMe: (): Readonly<{ started: Promise<void>; release: () => void }> => {
			let notifyStarted: () => void = () => undefined;
			const started = new Promise<void>((resolve) => {
				notifyStarted = resolve;
			});
			let release: () => void = () => undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			stalledMe = { notifyStarted, gate };
			return { started, release };
		},
		stop: () => server.stop(true),
	};
}

describe("gateway mattermost admin-token set|rotate (ADR-026)", () => {
	let fake: ReturnType<typeof startFakeMattermost> | null = null;
	let postgres: TestPostgres;
	let pool: pg.Pool;

	// The admin-token lock (ADR-026) needs a real, reachable Postgres: `pg_try_advisory_lock` is a
	// session-level primitive, needing no schema or migration of its own.
	beforeAll(async () => {
		postgres = await startTestPostgres();
		pool = createPool(postgres.connectionString, 8);
	});

	afterAll(async () => {
		await pool?.end();
		await postgres?.stop();
	});

	afterEach(() => {
		fake?.stop();
		fake = null;
	});

	const secretPath = () =>
		join(mkdtempSync(join(tmpdir(), "gateway-admin-token-")), "mattermost_admin_token");

	it("mints a gateway-tagged token from the pasted one, writes it, and revokes the pasted one", async () => {
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
			{ baseUrl: fake.baseUrl, secretPath: path, reader: fakeReader(["admin-token-value"]), pool },
			(line) => printed.push(line),
		);

		expect(secretFileState(path)).toBe("private");
		// Never the literal pasted value: a freshly minted, gateway-tagged token instead, exactly
		// like `rotate`'s own first call already produces.
		const written = readFileSync(path, "utf8").trim();
		expect(written).not.toBe("admin-token-value");
		expect(fake.worksNow(written)).toBe(true);
		// The pasted token itself is revoked right away (the account held exactly one token before
		// this call, unambiguously the one just entered): never left stranded, working forever,
		// until an operator happens to run `rotate` for the first time.
		expect(fake.worksNow("admin-token-value")).toBe(false);
		expect(printed.join("\n")).toContain("gateway-admin");
		expect(printed.join("\n")).toContain("revoked");
		expect(printed.join("\n")).not.toContain("admin-token-value");
		expect(printed.join("\n")).not.toContain(written);
	});

	it("mints and writes the new token but leaves the pasted one in place, with a warning, when the account already held more than one token", async () => {
		fake = startFakeMattermost();
		const adminId = mmId("admin");
		const account: FakeAccount = {
			id: adminId,
			username: "gateway-admin",
			is_bot: false,
			roles: "system_user system_admin",
			delete_at: 0,
		};
		fake.addAccount("admin-token-value", account);
		// A second, unrelated token already on this account: `set` must never guess which of the two
		// is the one just pasted, so it revokes neither.
		fake.addTokens(adminId, 1, "some other integration");
		const path = secretPath();
		const printed: string[] = [];

		await mattermostAdminTokenSet(
			{ baseUrl: fake.baseUrl, secretPath: path, reader: fakeReader(["admin-token-value"]), pool },
			(line) => printed.push(line),
		);

		expect(fake.worksNow("admin-token-value")).toBe(true);
		const written = readFileSync(path, "utf8").trim();
		expect(fake.worksNow(written)).toBe(true);
		expect(printed.join("\n")).toContain("warning");
		expect(printed.join("\n")).toContain("revoke it by hand");
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
				{ baseUrl: fake.baseUrl, secretPath: path, reader: fakeReader(["bot-token-value"]), pool },
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
				{
					baseUrl: fake.baseUrl,
					secretPath: path,
					reader: fakeReader(["plain-token-value"]),
					pool,
				},
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
			{ baseUrl: fake.baseUrl, secretPath: path, reader: fakeReader(["old-token-value"]), pool },
			() => undefined,
		);
		// Already revoked by `set` itself (the account held exactly this one token): rotate below has
		// only the token `set` just minted to deal with.
		expect(fake.worksNow("old-token-value")).toBe(false);

		const printed: string[] = [];
		await mattermostAdminTokenRotate({ baseUrl: fake.baseUrl, secretPath: path, pool }, (line) =>
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
			{ baseUrl: fake.baseUrl, secretPath: path, reader: fakeReader(["token-a"]), pool },
			() => undefined,
		);
		// A first rotate "crashes" conceptually right after writing the new token (simulated: the
		// file already holds a second, newer token, but the first one was never revoked).
		await mattermostAdminTokenRotate(
			{ baseUrl: fake.baseUrl, secretPath: path, pool },
			() => undefined,
		);
		expect(fake.worksNow("token-a")).toBe(false);
		const afterFirstRotate = readFileSync(path, "utf8").trim();

		await mattermostAdminTokenRotate(
			{ baseUrl: fake.baseUrl, secretPath: path, pool },
			() => undefined,
		);
		const afterSecondRotate = readFileSync(path, "utf8").trim();
		expect(afterSecondRotate).not.toBe(afterFirstRotate);
		expect(fake.worksNow(afterFirstRotate)).toBe(false);
		expect(fake.worksNow(afterSecondRotate)).toBe(true);
	});

	it("warns when it revokes 0 old tokens: the current one in the file was never tagged as the Gateway's own", async () => {
		fake = startFakeMattermost();
		// Never went through `admin-token set`'s own mint step (a file written some other way, or one
		// `set`'s own "more than one token already" case left pointing at an untagged token): the file
		// holds a token carrying a description other than the Gateway's own.
		fake.addAccount(
			"untagged-token",
			{
				id: mmId("admin"),
				username: "gateway-admin",
				is_bot: false,
				roles: "system_user system_admin",
				delete_at: 0,
			},
			"entered by hand in the Mattermost console",
		);
		const path = secretPath();
		writeSecretFile(path, "untagged-token");
		const printed: string[] = [];

		await mattermostAdminTokenRotate({ baseUrl: fake.baseUrl, secretPath: path, pool }, (line) =>
			printed.push(line),
		);

		expect(printed.join("\n")).toContain("warning");
		expect(printed.join("\n")).toContain("revoked 0 old token(s)");
		// The rotate itself still worked: a fresh, working, gateway-tagged token is now in the file.
		const written = readFileSync(path, "utf8").trim();
		expect(fake.worksNow(written)).toBe(true);
	});

	it("revokes every old token even when the account has more than one page of them", async () => {
		fake = startFakeMattermost();
		const adminId = mmId("admin");
		fake.addAccount("token-a", {
			id: adminId,
			username: "gateway-admin",
			is_bot: false,
			roles: "system_user system_admin",
			delete_at: 0,
		});
		// 250 stray tokens plus `token-a`: more than one page at the real client's own per_page
		// (200), so listing them all needs more than one request, and revoking them all needs more
		// than the first page's worth of revoke calls.
		fake.addTokens(adminId, 250);
		expect(fake.tokenCount(adminId)).toBe(251);

		const path = secretPath();
		await mattermostAdminTokenSet(
			{ baseUrl: fake.baseUrl, secretPath: path, reader: fakeReader(["token-a"]), pool },
			() => undefined,
		);

		await mattermostAdminTokenRotate(
			{ baseUrl: fake.baseUrl, secretPath: path, pool },
			() => undefined,
		);

		const newToken = readFileSync(path, "utf8").trim();
		expect(fake.worksNow("token-a")).toBe(false);
		expect(fake.worksNow(newToken)).toBe(true);
		// Nothing left but the one just written: every stray token, on every page, was revoked.
		expect(fake.tokenCount(adminId)).toBe(1);
	});

	it("never revokes an unrelated personal access token the admin account also happens to hold", async () => {
		fake = startFakeMattermost();
		const adminId = mmId("admin");
		const account: FakeAccount = {
			id: adminId,
			username: "gateway-admin",
			is_bot: false,
			roles: "system_user system_admin",
			delete_at: 0,
		};
		fake.addAccount("token-a", account);
		// A personal access token the admin uses for something else entirely, never created by
		// this command — rotate must leave it exactly alone, never folding it into "every other
		// token the account has".
		const unrelated = "a-totally-unrelated-integration-token";
		fake.addAccount(unrelated, account, "some other integration");
		// A stray token from an earlier crashed rotation, carrying the Gateway's own description:
		// this one must still be revoked, exactly like before.
		fake.addTokens(adminId, 1);
		expect(fake.tokenCount(adminId)).toBe(3);

		const path = secretPath();
		await mattermostAdminTokenSet(
			{ baseUrl: fake.baseUrl, secretPath: path, reader: fakeReader(["token-a"]), pool },
			() => undefined,
		);

		await mattermostAdminTokenRotate(
			{ baseUrl: fake.baseUrl, secretPath: path, pool },
			() => undefined,
		);

		expect(fake.worksNow("token-a")).toBe(false);
		expect(fake.worksNow(unrelated)).toBe(true);
		const newToken = readFileSync(path, "utf8").trim();
		expect(fake.worksNow(newToken)).toBe(true);
		// The unrelated token, plus the newly written one: the stray Gateway-tagged token is gone.
		expect(fake.tokenCount(adminId)).toBe(2);
	});

	it("admin-token set revokes a freshly minted token that fails to verify against the same account, rather than leaving it stranded", async () => {
		fake = startFakeMattermost();
		const adminId = mmId("admin");
		fake.addAccount("admin-token-value", {
			id: adminId,
			username: "gateway-admin",
			is_bot: false,
			roles: "system_user system_admin",
			delete_at: 0,
		});
		// A different, unrelated account the freshly minted token ends up usable by instead — the
		// one case nothing here ever expects: the created token's own `users/me` resolves to this
		// account, not the one it was requested for.
		const mallory = mmId("mallory");
		fake.addAccount("mallory-seed-token", {
			id: mallory,
			username: "mallory",
			is_bot: false,
			roles: "system_user",
			delete_at: 0,
		});
		expect(fake.tokenCount(mallory)).toBe(1);
		fake.rigNextTokenOwner(mallory);

		const path = secretPath();
		await expect(
			mattermostAdminTokenSet(
				{
					baseUrl: fake.baseUrl,
					secretPath: path,
					reader: fakeReader(["admin-token-value"]),
					pool,
				},
				() => undefined,
			),
		).rejects.toThrow(MattermostCommandError);

		expect(secretFileState(path)).toBe("missing");
		// The pasted token is untouched (nothing was changed) — and the poisoned token minted for
		// "mallory" was revoked right away, not left stranded, working, on her account.
		expect(fake.worksNow("admin-token-value")).toBe(true);
		expect(fake.tokenCount(mallory)).toBe(1);
	});

	it("admin-token rotate revokes a freshly created token that fails to verify against the same account, rather than leaving it stranded", async () => {
		fake = startFakeMattermost();
		const adminId = mmId("admin");
		fake.addAccount("admin-token-value", {
			id: adminId,
			username: "gateway-admin",
			is_bot: false,
			roles: "system_user system_admin",
			delete_at: 0,
		});
		const mallory = mmId("mallory");
		fake.addAccount("mallory-seed-token", {
			id: mallory,
			username: "mallory",
			is_bot: false,
			roles: "system_user",
			delete_at: 0,
		});
		const path = secretPath();
		writeSecretFile(path, "admin-token-value");

		fake.rigNextTokenOwner(mallory);
		await expect(
			mattermostAdminTokenRotate(
				{ baseUrl: fake.baseUrl, secretPath: path, pool },
				() => undefined,
			),
		).rejects.toThrow(MattermostCommandError);

		expect(readFileSync(path, "utf8").trim()).toBe("admin-token-value");
		expect(fake.worksNow("admin-token-value")).toBe(true);
		expect(fake.tokenCount(mallory)).toBe(1);
	});

	it("a concurrent admin-token set/rotate against the same account fails fast rather than racing create-verify-write-revoke (ADR-026)", async () => {
		fake = startFakeMattermost();
		const adminId = mmId("admin");
		fake.addAccount("admin-token-value", {
			id: adminId,
			username: "gateway-admin",
			is_bot: false,
			roles: "system_user system_admin",
			delete_at: 0,
		});
		const path = secretPath();

		// Stalls the first call right after it must already hold the admin-token lock (`client.me()`
		// is the very first Mattermost call either command makes, once it holds the lock): a second
		// run started while it is stalled there deterministically races a lock the first call already
		// holds, never merely one it might hold by then. Both calls go through `set` (never `rotate`,
		// which refuses outright before ever touching Mattermost or the lock when no token file
		// exists yet) so the race is purely over the lock itself.
		const stall = fake.stallNextMe();
		const first = mattermostAdminTokenSet(
			{ baseUrl: fake.baseUrl, secretPath: path, reader: fakeReader(["admin-token-value"]), pool },
			() => undefined,
		);
		await stall.started;

		await expect(
			mattermostAdminTokenSet(
				{
					baseUrl: fake.baseUrl,
					secretPath: path,
					reader: fakeReader(["admin-token-value"]),
					pool,
				},
				() => undefined,
			),
		).rejects.toThrow(/already running/);
		// The second run never touched the account at all: still exactly the one token it started
		// with (the lock refused it before it ever called Mattermost).
		expect(fake.tokenCount(adminId)).toBe(1);

		stall.release();
		await first;

		// The first call, uninterrupted by the second, completed its own create-verify-write-revoke
		// sequence normally.
		expect(secretFileState(path)).toBe("private");
		const written = readFileSync(path, "utf8").trim();
		expect(fake.worksNow(written)).toBe(true);
		expect(fake.worksNow("admin-token-value")).toBe(false);
	});

	it("rotate reads the token file only once every lock it takes is held, never a value read before queuing behind another run (ADR-026)", async () => {
		fake = startFakeMattermost();
		// Two distinct accounts, so which one `rotate` actually authenticates as is unambiguous:
		// account A's own token is what the file holds before this call is ever blocked, account B's
		// is what it holds once unblocked.
		fake.addAccount("token-a", {
			id: mmId("admina"),
			username: "gateway-admin-a",
			is_bot: false,
			roles: "system_user system_admin",
			delete_at: 0,
		});
		fake.addAccount("token-b", {
			id: mmId("adminb"),
			username: "gateway-admin-b",
			is_bot: false,
			roles: "system_user system_admin",
			delete_at: 0,
		});
		const path = secretPath();
		writeSecretFile(path, "token-a");

		// Stands in for a bootstrap run or a provisioner pass already holding the shared Mattermost
		// credential lock (ADR-026): `rotate` must block behind it rather than racing it, and — the
		// point of this test — must not have already read the file before it ever got here.
		const holder = await pool.connect();
		await acquireMattermostCredentialLock(holder);

		const printed: string[] = [];
		const rotating = mattermostAdminTokenRotate(
			{ baseUrl: fake.baseUrl, secretPath: path, pool },
			(line) => printed.push(line),
		);

		// `rotating` claims its own `ADMIN_TOKEN_LOCK` at once (nothing else holds it) and then
		// blocks waiting for the credential lock `holder` has: the file is changed to account B's
		// token while it waits there, exactly like a concurrent `admin-token set` switching it would,
		// before it is ever released.
		await new Promise((resolve) => setTimeout(resolve, 200));
		writeSecretFile(path, "token-b");
		await releaseMattermostCredentialLock(holder);
		holder.release();

		await rotating;

		// Rotated account B's token, never account A's stale, pre-block one: proof the read happened
		// after every lock was held, not before.
		expect(fake.worksNow("token-a")).toBe(true);
		const newToken = readFileSync(path, "utf8").trim();
		expect(fake.worksNow(newToken)).toBe(true);
		expect(fake.worksNow("token-b")).toBe(false);
		expect(printed.join("\n")).toContain("gateway-admin-b");
	});
});
