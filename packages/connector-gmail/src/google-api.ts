import type { JsonValue } from "@agent-gateway/contracts";
import type { z } from "zod";

/** Google endpoints; overridden only by tests, which point them at a fake. */
export type GoogleEndpoints = Readonly<{
	/** OAuth token endpoint. */
	token: string;
	/** OAuth consent page. */
	authorize: string;
	/** Gmail REST base, up to and including `/gmail/v1`. */
	gmail: string;
	/** Pub/Sub REST base, up to and including `/v1`. */
	pubsub: string;
}>;

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
	token: "https://oauth2.googleapis.com/token",
	authorize: "https://accounts.google.com/o/oauth2/v2/auth",
	gmail: "https://gmail.googleapis.com/gmail/v1",
	pubsub: "https://pubsub.googleapis.com/v1",
};

/** A Google API answered with an error status. `reason` is Google's short error code. */
export class GoogleApiError extends Error {
	readonly status: number;
	readonly reason: string;

	constructor(what: string, status: number, reason: string) {
		super(`${what} failed with HTTP ${status}${reason === "" ? "" : ` (${reason})`}`);
		this.name = "GoogleApiError";
		this.status = status;
		this.reason = reason;
	}
}

/** Longest a single Google API call may take, unless the caller says otherwise. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export type GoogleRequest = Readonly<{
	/** Names the call in errors; never contains ids or addresses. */
	what: string;
	url: string;
	method?: "GET" | "POST";
	accessToken?: string;
	/** JSON body. */
	json?: object;
	/** Form body (OAuth). */
	form?: Readonly<Record<string, string>>;
	signal?: AbortSignal;
	timeoutMs?: number;
}>;

/** Google's error body: `{error: {status, message}}` for APIs, `{error: "invalid_grant"}` for OAuth. */
function errorReason(body: string): string {
	try {
		const parsed: { error?: string | { status?: string } } = JSON.parse(body);
		if (typeof parsed.error === "string") {
			return parsed.error;
		}
		return typeof parsed.error?.status === "string" ? parsed.error.status : "";
	} catch {
		return "";
	}
}

/**
 * One call to a Google API, parsed with `schema`. The response body of a failed call is reduced
 * to Google's error code: it may quote request data, and error messages end up in logs.
 */
export async function callGoogle<T>(request: GoogleRequest, schema: z.ZodType<T>): Promise<T> {
	const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const signal =
		request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
	const headers: Record<string, string> = { accept: "application/json" };
	let body: string | undefined;
	if (request.accessToken !== undefined) {
		headers.authorization = `Bearer ${request.accessToken}`;
	}
	if (request.json !== undefined) {
		headers["content-type"] = "application/json";
		body = JSON.stringify(request.json);
	} else if (request.form !== undefined) {
		headers["content-type"] = "application/x-www-form-urlencoded";
		body = new URLSearchParams({ ...request.form }).toString();
	}
	const response = await fetch(request.url, {
		method: request.method ?? (body === undefined ? "GET" : "POST"),
		headers,
		...(body === undefined ? {} : { body }),
		signal,
		redirect: "error",
	});
	const text = await response.text();
	if (!response.ok) {
		throw new GoogleApiError(request.what, response.status, errorReason(text));
	}
	let parsed: JsonValue;
	try {
		parsed = text === "" ? {} : JSON.parse(text);
	} catch {
		throw new GoogleApiError(request.what, response.status, "invalid_json");
	}
	const result = schema.safeParse(parsed);
	if (!result.success) {
		const issue = result.error.issues[0];
		throw new GoogleApiError(
			request.what,
			response.status,
			`unexpected_response at '${issue?.path.join(".") ?? ""}'`,
		);
	}
	return result.data;
}
