import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { callGoogle, GoogleApiError, type GoogleEndpoints } from "./google-api.ts";

/**
 * The only scopes the connector asks for and accepts: reading mail, and pulling the mailbox's
 * Pub/Sub notifications. Nothing that sends, drafts, modifies or deletes mail.
 */
export const GMAIL_CONNECTOR_SCOPES: Readonly<string[]> = [
	"https://www.googleapis.com/auth/gmail.readonly",
	"https://www.googleapis.com/auth/pubsub",
];

/** Why the connector refuses a credential. */
export type AuthFailure = "revoked" | "scope";

/**
 * The credential cannot be used: revoked or expired (`invalid_grant`), or granting more (or less)
 * than {@link GMAIL_CONNECTOR_SCOPES}. Retrying does not help; the operator must authorize again.
 */
export class GoogleAuthError extends Error {
	readonly failure: AuthFailure;

	constructor(failure: AuthFailure, message: string) {
		super(message);
		this.name = "GoogleAuthError";
		this.failure = failure;
	}
}

/**
 * Scopes a token was granted that are not exactly the connector's: extra ones (a token that can
 * send mail is refused, even though the connector never would) and missing ones.
 */
export function scopeProblems(granted: string): Readonly<string[]> {
	const scopes = new Set(granted.split(/\s+/u).filter((scope) => scope !== ""));
	return [
		...[...scopes].filter((scope) => !GMAIL_CONNECTOR_SCOPES.includes(scope)).map((s) => `+${s}`),
		...GMAIL_CONNECTOR_SCOPES.filter((scope) => !scopes.has(scope)).map((s) => `-${s}`),
	];
}

function checkScopes(granted: string): void {
	const problems = scopeProblems(granted);
	if (problems.length > 0) {
		throw new GoogleAuthError(
			"scope",
			`the Google credential must grant exactly the connector's scopes; differs by ${problems.join(" ")}`,
		);
	}
}

export type OAuthClientCredentials = Readonly<{ clientId: string; clientSecret: string }>;

const TokenResponseSchema = z.object({
	access_token: z.string().min(1),
	expires_in: z.number().int().positive(),
	scope: z.string(),
	refresh_token: z.string().min(1).optional(),
});

/** Access tokens for the connector, refreshed before they expire. */
export type TokenSource = Readonly<{
	accessToken: () => Promise<string>;
	/** Drops the cached token, after an API refused it. */
	invalidate: () => void;
}>;

export type TokenSourceOptions = Readonly<{
	client: OAuthClientCredentials;
	/**
	 * Fixed for the process: a re-authorized credential applies at the next start, where the
	 * connector checks that it still belongs to the mailbox's account.
	 */
	refreshToken: string;
	endpoints: GoogleEndpoints;
	clock: () => Date;
}>;

/** Refresh this long before the token's expiry. */
const EXPIRY_MARGIN_MS = 120_000;

/**
 * Exchanges the refresh token for access tokens. Every refresh checks the granted scopes, so a
 * credential re-authorized with broader scopes stops working instead of being used.
 */
export function createTokenSource(options: TokenSourceOptions): TokenSource {
	let cached: Readonly<{ token: string; expiresAt: number }> | null = null;
	let refreshing: Promise<string> | null = null;
	const refresh = async (): Promise<string> => {
		let response: z.infer<typeof TokenResponseSchema>;
		try {
			response = await callGoogle(
				{
					what: "OAuth token refresh",
					url: options.endpoints.token,
					form: {
						grant_type: "refresh_token",
						client_id: options.client.clientId,
						client_secret: options.client.clientSecret,
						refresh_token: options.refreshToken,
					},
				},
				TokenResponseSchema,
			);
		} catch (error) {
			if (error instanceof GoogleApiError && error.reason === "invalid_grant") {
				throw new GoogleAuthError(
					"revoked",
					"the Google refresh token was revoked or expired; run 'gateway gmail authorize' and restart the connector",
				);
			}
			throw error;
		}
		checkScopes(response.scope);
		cached = {
			token: response.access_token,
			expiresAt: options.clock().getTime() + response.expires_in * 1000 - EXPIRY_MARGIN_MS,
		};
		return response.access_token;
	};
	return {
		accessToken: async () => {
			if (cached !== null && cached.expiresAt > options.clock().getTime()) {
				return cached.token;
			}
			// Concurrent callers share one refresh, bounded by the call timeout, not a caller's signal.
			refreshing ??= refresh().finally(() => {
				refreshing = null;
			});
			return refreshing;
		},
		invalidate: () => {
			cached = null;
		},
	};
}

/** PKCE verifier and challenge (RFC 7636, S256). */
export function pkcePair(): Readonly<{ verifier: string; challenge: string }> {
	const verifier = randomBytes(32).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export type AuthorizationRequest = Readonly<{
	clientId: string;
	/** A loopback address (`http://127.0.0.1:<port>/`), as Google allows for desktop clients. */
	redirectUri: string;
	state: string;
	codeChallenge: string;
}>;

/** The consent page the operator opens: offline access, exactly the connector's scopes. */
export function authorizationUrl(
	endpoints: GoogleEndpoints,
	request: AuthorizationRequest,
): string {
	const url = new URL(endpoints.authorize);
	url.search = new URLSearchParams({
		client_id: request.clientId,
		redirect_uri: request.redirectUri,
		response_type: "code",
		scope: GMAIL_CONNECTOR_SCOPES.join(" "),
		access_type: "offline",
		// Always ask, so Google issues a refresh token even for an earlier grant.
		prompt: "consent",
		state: request.state,
		code_challenge: request.codeChallenge,
		code_challenge_method: "S256",
	}).toString();
	return url.toString();
}

export type CodeExchange = Readonly<{
	client: OAuthClientCredentials;
	code: string;
	codeVerifier: string;
	redirectUri: string;
}>;

/** Trades the consent code for a refresh token; refuses a grant with other scopes. */
export async function exchangeAuthorizationCode(
	endpoints: GoogleEndpoints,
	exchange: CodeExchange,
): Promise<string> {
	const response = await callGoogle(
		{
			what: "OAuth code exchange",
			url: endpoints.token,
			form: {
				grant_type: "authorization_code",
				client_id: exchange.client.clientId,
				client_secret: exchange.client.clientSecret,
				code: exchange.code,
				code_verifier: exchange.codeVerifier,
				redirect_uri: exchange.redirectUri,
			},
		},
		TokenResponseSchema,
	);
	checkScopes(response.scope);
	if (response.refresh_token === undefined) {
		throw new GoogleAuthError("revoked", "Google returned no refresh token; authorize again");
	}
	return response.refresh_token;
}
