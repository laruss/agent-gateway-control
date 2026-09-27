import { afterEach, describe, expect, it } from "vitest";
import {
	authorizationUrl,
	connectorScopes,
	createTokenSource,
	exchangeAuthorizationCode,
	GMAIL_READ_SCOPE,
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
const PUBSUB_SCOPES = connectorScopes("pubsub");

describe("scopes", () => {
	it("asks only for reading mail, and pulling notifications in the push mode", () => {
		expect(connectorScopes("poll")).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
		expect(PUBSUB_SCOPES).toEqual([
			"https://www.googleapis.com/auth/gmail.readonly",
			"https://www.googleapis.com/auth/pubsub",
		]);
		expect(
			PUBSUB_SCOPES.some((scope) => /send|compose|modify|insert|mail\.google/u.test(scope)),
		).toBe(false);
	});

	it("reports scopes beyond or missing from the connector's", () => {
		expect(scopeProblems(PUBSUB_SCOPES.join(" "), PUBSUB_SCOPES)).toEqual([]);
		expect(
			scopeProblems(
				`${PUBSUB_SCOPES.join(" ")} https://www.googleapis.com/auth/gmail.send`,
				PUBSUB_SCOPES,
			),
		).toEqual(["+https://www.googleapis.com/auth/gmail.send"]);
		expect(scopeProblems(GMAIL_READ_SCOPE, PUBSUB_SCOPES)).toEqual([
			"-https://www.googleapis.com/auth/pubsub",
		]);
		// A polling connector refuses a token that could also manage Pub/Sub.
		expect(scopeProblems(PUBSUB_SCOPES.join(" "), connectorScopes("poll"))).toEqual([
			"+https://www.googleapis.com/auth/pubsub",
		]);
	});
});

describe("createTokenSource", () => {
	const source = (fake: FakeGoogle, clock = () => new Date()) =>
		createTokenSource({
			client,
			refreshToken: fake.refreshToken,
			scopes: PUBSUB_SCOPES,
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
		google.setGrantedScopes([...PUBSUB_SCOPES, "https://www.googleapis.com/auth/gmail.send"]);
		const broad = source(google).accessToken();
		await expect(broad).rejects.toBeInstanceOf(GoogleAuthError);
		await expect(broad).rejects.toMatchObject({ failure: "scope" });
		google.setGrantedScopes(PUBSUB_SCOPES);
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
					scopes: PUBSUB_SCOPES,
				},
			),
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: "client-id",
			redirect_uri: "http://127.0.0.1:5000/",
			response_type: "code",
			scope: PUBSUB_SCOPES.join(" "),
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
			scopes: PUBSUB_SCOPES,
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
