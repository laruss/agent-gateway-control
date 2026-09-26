import { afterEach, describe, expect, it } from "vitest";
import {
	authorizationUrl,
	createTokenSource,
	exchangeAuthorizationCode,
	GMAIL_CONNECTOR_SCOPES,
	GoogleAuthError,
	pkcePair,
	scopeProblems,
} from "./auth.ts";
import { type FakeGoogle, startFakeGoogle } from "./fake-google.ts";

let google: FakeGoogle | null = null;
afterEach(async () => {
	await google?.stop();
	google = null;
});

const client = { clientId: "client-id", clientSecret: "client-secret" };

describe("scopes", () => {
	it("asks only for reading mail and pulling notifications", () => {
		expect(GMAIL_CONNECTOR_SCOPES).toEqual([
			"https://www.googleapis.com/auth/gmail.readonly",
			"https://www.googleapis.com/auth/pubsub",
		]);
		expect(
			GMAIL_CONNECTOR_SCOPES.some((scope) =>
				/send|compose|modify|insert|mail\.google/u.test(scope),
			),
		).toBe(false);
	});

	it("reports scopes beyond or missing from the connector's", () => {
		expect(scopeProblems(GMAIL_CONNECTOR_SCOPES.join(" "))).toEqual([]);
		expect(
			scopeProblems(
				`${GMAIL_CONNECTOR_SCOPES.join(" ")} https://www.googleapis.com/auth/gmail.send`,
			),
		).toEqual(["+https://www.googleapis.com/auth/gmail.send"]);
		expect(scopeProblems("https://www.googleapis.com/auth/gmail.readonly")).toEqual([
			"-https://www.googleapis.com/auth/pubsub",
		]);
	});
});

describe("createTokenSource", () => {
	const source = (fake: FakeGoogle, clock = () => new Date()) =>
		createTokenSource({
			client,
			refreshToken: fake.refreshToken,
			endpoints: fake.endpoints,
			clock,
		});

	it("refreshes once and caches the token until shortly before it expires", async () => {
		google = startFakeGoogle();
		let now = Date.now();
		const tokens = source(google, () => new Date(now));
		const [a, b] = await Promise.all([tokens.accessToken(), tokens.accessToken()]);
		expect(a).toBe(b);
		expect(google.requests().filter((r) => r === "POST /token")).toHaveLength(1);
		now += 3_500_000;
		expect(await tokens.accessToken()).not.toBe(a);
	});

	it("refuses a revoked credential and one that can do more than read", async () => {
		google = startFakeGoogle();
		await expect(source(google).accessToken()).resolves.toMatch(/^fake-access-/u);
		google.setGrantedScopes([
			...GMAIL_CONNECTOR_SCOPES,
			"https://www.googleapis.com/auth/gmail.send",
		]);
		const broad = source(google).accessToken();
		await expect(broad).rejects.toBeInstanceOf(GoogleAuthError);
		await expect(broad).rejects.toMatchObject({ failure: "scope" });
		google.setGrantedScopes(GMAIL_CONNECTOR_SCOPES);
		google.revoke();
		await expect(source(google).accessToken()).rejects.toMatchObject({ failure: "revoked" });
	});
});

describe("authorization", () => {
	it("builds an offline consent URL with PKCE for exactly the connector's scopes", () => {
		const pkce = pkcePair();
		const url = new URL(
			authorizationUrl(
				{
					token: "",
					authorize: "https://accounts.google.com/o/oauth2/v2/auth",
					gmail: "",
					pubsub: "",
				},
				{
					clientId: "client-id",
					redirectUri: "http://127.0.0.1:5000/",
					state: "s1",
					codeChallenge: pkce.challenge,
				},
			),
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: "client-id",
			redirect_uri: "http://127.0.0.1:5000/",
			response_type: "code",
			scope: GMAIL_CONNECTOR_SCOPES.join(" "),
			access_type: "offline",
			prompt: "consent",
			state: "s1",
			code_challenge: pkce.challenge,
			code_challenge_method: "S256",
		});
		expect(pkce.verifier).not.toBe(pkce.challenge);
	});

	it("exchanges the consent code for the refresh token", async () => {
		google = startFakeGoogle();
		const exchange = {
			client,
			code: "fake-code",
			codeVerifier: pkcePair().verifier,
			redirectUri: "http://127.0.0.1:5000/",
		};
		await expect(exchangeAuthorizationCode(google.endpoints, exchange)).resolves.toBe(
			google.refreshToken,
		);
		google.setGrantedScopes(["https://mail.google.com/"]);
		await expect(exchangeAuthorizationCode(google.endpoints, exchange)).rejects.toMatchObject({
			failure: "scope",
		});
	});
});
