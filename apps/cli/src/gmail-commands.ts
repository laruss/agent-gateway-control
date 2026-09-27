import { randomBytes } from "node:crypto";
import {
	authorizationUrl,
	connectorScopes,
	exchangeAuthorizationCode,
	type GoogleEndpoints,
	type OAuthClientCredentials,
	pkcePair,
} from "@agent-gateway/connector-gmail";
import { writeSecretFile } from "@agent-gateway/service";

export type GmailAuthorizeOptions = Readonly<{
	client: OAuthClientCredentials;
	/** Where the refresh token is written (mode 0600, atomically). */
	out: string;
	endpoints: GoogleEndpoints;
	/** Also consent to pulling Pub/Sub notifications (the connector's optional push mode). */
	pubsub: boolean;
	/** Loopback port for Google's redirect; 0 picks a free one. */
	port?: number;
	timeoutMs?: number;
}>;

const PAGE = (text: string) =>
	new Response(`<!doctype html><meta charset="utf-8"><title>Agent Gateway</title><p>${text}</p>`, {
		headers: { "content-type": "text/html; charset=utf-8" },
	});

/**
 * The operator's consent for the Gmail connector: prints Google's consent page, receives the
 * code on a loopback address (PKCE, checked state), exchanges it and stores the refresh token.
 * The token is never printed. Refuses a grant with any scope beyond reading mail (and, with
 * `pubsub`, pulling its notifications).
 */
export async function gmailAuthorize(
	options: GmailAuthorizeOptions,
	print: (line: string) => void,
): Promise<void> {
	const scopes = connectorScopes(options.pubsub ? "pubsub" : "poll");
	const state = randomBytes(16).toString("base64url");
	const pkce = pkcePair();
	let settle: (result: Readonly<{ code: string } | { error: string }>) => void = () => undefined;
	const received = new Promise<Readonly<{ code: string } | { error: string }>>((resolve) => {
		settle = resolve;
	});
	const server = Bun.serve({
		port: options.port ?? 0,
		hostname: "127.0.0.1",
		fetch: (request) => {
			const url = new URL(request.url);
			if (url.pathname !== "/") {
				return new Response("not found", { status: 404 });
			}
			// A request without our state is not Google's redirect for this run: ignore it.
			if (url.searchParams.get("state") !== state) {
				return new Response("unexpected request", { status: 400 });
			}
			const error = url.searchParams.get("error");
			const code = url.searchParams.get("code");
			if (error !== null || code === null) {
				settle({ error: error ?? "no code" });
				return PAGE("Authorization failed. You can close this tab.");
			}
			settle({ code });
			return PAGE("Authorized. You can close this tab and return to the terminal.");
		},
	});
	const redirectUri = `http://127.0.0.1:${server.port}/`;
	try {
		print("Open this address in a browser and sign in to the mailbox the connector reads:");
		print(
			authorizationUrl(options.endpoints, {
				clientId: options.client.clientId,
				redirectUri,
				state,
				codeChallenge: pkce.challenge,
				scopes,
			}),
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<{ error: string }>((resolve) => {
			timer = setTimeout(() => resolve({ error: "timed out" }), options.timeoutMs ?? 10 * 60_000);
		});
		const result = await Promise.race([received, timeout]);
		clearTimeout(timer);
		if ("error" in result) {
			throw new Error(`Google authorization did not complete: ${result.error}`);
		}
		const refreshToken = await exchangeAuthorizationCode(options.endpoints, {
			client: options.client,
			code: result.code,
			codeVerifier: pkce.verifier,
			redirectUri,
			scopes,
		});
		writeSecretFile(options.out, refreshToken);
		print(
			`refresh token stored in ${options.out}; scopes: read mail${options.pubsub ? ", pull notifications" : ""}`,
		);
	} finally {
		// Graceful: the browser still gets the page answering its redirect.
		await server.stop();
	}
}
