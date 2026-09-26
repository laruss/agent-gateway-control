import type { JsonObject, JsonValue, MattermostId } from "@agent-gateway/contracts";
import { z } from "zod";
import {
	type ApiBot,
	ApiBotSchema,
	type ApiChannel,
	ApiChannelSchema,
	ApiErrorSchema,
	type ApiMember,
	ApiMemberSchema,
	type ApiPost,
	type ApiPostList,
	ApiPostListSchema,
	ApiPostSchema,
	type ApiTeam,
	ApiTeamSchema,
	type ApiUser,
	ApiUserAccessTokenSchema,
	ApiUserSchema,
} from "./api-schemas.ts";

/**
 * A failed Mattermost API call. `status` 0 means the request never got an HTTP answer (network,
 * timeout). The message names the endpoint and the server's error id, never the token.
 */
export class MattermostApiError extends Error {
	constructor(
		readonly status: number,
		readonly errorId: string | null,
		message: string,
	) {
		super(message);
		this.name = "MattermostApiError";
	}

	/** Worth retrying later: no answer, rate limited, or a server-side failure. */
	get retryable(): boolean {
		return this.status === 0 || this.status === 429 || this.status >= 500;
	}
}

export type MattermostClientOptions = Readonly<{
	/** Server base URL, e.g. `http://mattermost:8065`. */
	baseUrl: string;
	token: string;
	timeoutMs?: number;
}>;

export type NewPost = Readonly<{
	channel_id: MattermostId;
	root_id?: MattermostId;
	message: string;
	props: JsonObject;
	/** The server drops a second create with the same value for a short while. */
	pending_post_id: string;
}>;

/** Most posts `GET /channels/{id}/posts?since=` returns; beyond that it keeps the newest. */
export const POSTS_SINCE_LIMIT = 1000;

const DEFAULT_TIMEOUT_MS = 15_000;

function normalizeBaseUrl(baseUrl: string): URL {
	const url = new URL(baseUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Mattermost URL must be http(s), got '${url.protocol}'`);
	}
	if (url.username !== "" || url.password !== "") {
		throw new Error("Mattermost URL must not carry credentials");
	}
	if (!url.pathname.endsWith("/")) {
		url.pathname = `${url.pathname}/`;
	}
	return url;
}

/** The WebSocket endpoint of a Mattermost server. */
export function websocketUrl(baseUrl: string): string {
	const url = new URL("api/v4/websocket", normalizeBaseUrl(baseUrl));
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

const segment = encodeURIComponent;

/** A typed subset of the Mattermost REST API v4, authenticated with one bot or admin token. */
export class MattermostClient {
	private readonly base: URL;
	private readonly token: string;
	private readonly timeoutMs: number;

	constructor(options: MattermostClientOptions) {
		this.base = normalizeBaseUrl(options.baseUrl);
		this.token = options.token;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** The account the token belongs to. */
	me(): Promise<ApiUser> {
		return this.call("GET", "users/me", ApiUserSchema);
	}

	user(userId: MattermostId): Promise<ApiUser> {
		return this.call("GET", `users/${userId}`, ApiUserSchema);
	}

	userByUsername(username: string): Promise<ApiUser | null> {
		return this.optional(this.call("GET", `users/username/${segment(username)}`, ApiUserSchema));
	}

	teamByName(name: string): Promise<ApiTeam | null> {
		return this.optional(this.call("GET", `teams/name/${segment(name)}`, ApiTeamSchema));
	}

	channelByName(teamId: MattermostId, name: string): Promise<ApiChannel | null> {
		return this.optional(
			this.call("GET", `teams/${teamId}/channels/name/${segment(name)}`, ApiChannelSchema),
		);
	}

	/**
	 * Posts created, edited or deleted strictly after `sinceMs` (deleted ones with an empty
	 * message). At most {@link POSTS_SINCE_LIMIT}: past that the server keeps the newest.
	 */
	channelPostsSince(channelId: MattermostId, sinceMs: number): Promise<ApiPostList> {
		return this.call(
			"GET",
			// `since=0` is not a since query to the server (it pages instead): 1 means "all".
			`channels/${channelId}/posts?since=${Math.max(1, Math.floor(sinceMs))}`,
			ApiPostListSchema,
		);
	}

	/** One page of existing posts by offset, newest first; shifts when posts are deleted. */
	channelPostsPage(channelId: MattermostId, page: number, perPage: number): Promise<ApiPostList> {
		return this.call(
			"GET",
			`channels/${channelId}/posts?page=${page}&per_page=${perPage}`,
			ApiPostListSchema,
		);
	}

	/**
	 * Existing posts, newest first by creation time: the newest `perPage`, or those created just
	 * before `beforePostId`. Anchored at a post, pages do not shift when others are deleted.
	 */
	channelPostsBefore(
		channelId: MattermostId,
		beforePostId: MattermostId | null,
		perPage: number,
	): Promise<ApiPostList> {
		const before = beforePostId === null ? "" : `&before=${beforePostId}`;
		return this.call(
			"GET",
			`channels/${channelId}/posts?per_page=${perPage}${before}`,
			ApiPostListSchema,
		);
	}

	createPost(post: NewPost): Promise<ApiPost> {
		return this.call("POST", "posts", ApiPostSchema, post);
	}

	createBot(bot: Readonly<{ username: string; display_name: string; description: string }>) {
		return this.call("POST", "bots", ApiBotSchema, bot);
	}

	enableBot(userId: MattermostId): Promise<ApiBot> {
		return this.call("POST", `bots/${userId}/enable`, ApiBotSchema);
	}

	/** Deactivates a bot; its sessions and tokens stop working. */
	disableBot(userId: MattermostId): Promise<ApiBot> {
		return this.call("POST", `bots/${userId}/disable`, ApiBotSchema);
	}

	async addTeamMember(teamId: MattermostId, userId: MattermostId): Promise<void> {
		await this.call("POST", `teams/${teamId}/members`, null, {
			team_id: teamId,
			user_id: userId,
		});
	}

	async addChannelMember(channelId: MattermostId, userId: MattermostId): Promise<void> {
		await this.call("POST", `channels/${channelId}/members`, null, { user_id: userId });
	}

	teamMember(teamId: MattermostId, userId: MattermostId): Promise<ApiMember | null> {
		return this.optional(this.call("GET", `teams/${teamId}/members/${userId}`, ApiMemberSchema));
	}

	channelMember(channelId: MattermostId, userId: MattermostId): Promise<ApiMember | null> {
		return this.optional(
			this.call("GET", `channels/${channelId}/members/${userId}`, ApiMemberSchema),
		);
	}

	async setTeamMemberRoles(teamId: MattermostId, userId: MattermostId, roles: string) {
		await this.call("PUT", `teams/${teamId}/members/${userId}/roles`, null, { roles });
	}

	async setChannelMemberRoles(channelId: MattermostId, userId: MattermostId, roles: string) {
		await this.call("PUT", `channels/${channelId}/members/${userId}/roles`, null, { roles });
	}

	/** Every channel of a team the user belongs to (the token must see them). */
	userChannelsInTeam(userId: MattermostId, teamId: MattermostId): Promise<ApiChannel[]> {
		return this.call("GET", `users/${userId}/teams/${teamId}/channels`, z.array(ApiChannelSchema));
	}

	userTeams(userId: MattermostId): Promise<ApiTeam[]> {
		return this.call("GET", `users/${userId}/teams`, z.array(ApiTeamSchema));
	}

	async removeTeamMember(teamId: MattermostId, userId: MattermostId): Promise<void> {
		await this.call("DELETE", `teams/${teamId}/members/${userId}`, null);
	}

	async removeChannelMember(channelId: MattermostId, userId: MattermostId): Promise<void> {
		await this.call("DELETE", `channels/${channelId}/members/${userId}`, null);
	}

	/** True when `userId` is a member of the channel (the token must see the channel). */
	async isChannelMember(channelId: MattermostId, userId: MattermostId): Promise<boolean> {
		try {
			await this.call("GET", `channels/${channelId}/members/${userId}`, null);
			return true;
		} catch (error) {
			if (error instanceof MattermostApiError && (error.status === 404 || error.status === 403)) {
				return false;
			}
			throw error;
		}
	}

	/** Ids of the first page of an account's access tokens (values are never returned). */
	async userAccessTokenIds(userId: MattermostId): Promise<Readonly<string[]>> {
		const tokens = await this.call(
			"GET",
			`users/${userId}/tokens?page=0&per_page=200`,
			z.array(z.looseObject({ id: z.string() })),
		);
		return tokens.map((token) => token.id);
	}

	async revokeUserAccessToken(tokenId: string): Promise<void> {
		await this.call("POST", "users/tokens/revoke", null, { token_id: tokenId });
	}

	/** Creates a personal access token for `userId`; the value is returned once, never logged. */
	async createUserAccessToken(userId: MattermostId, description: string): Promise<string> {
		const created = await this.call("POST", `users/${userId}/tokens`, ApiUserAccessTokenSchema, {
			description,
		});
		return created.token;
	}

	/** Resolves 404 (and 403 for things the token may not see) to null. */
	private async optional<T>(request: Promise<T>): Promise<T | null> {
		try {
			return await request;
		} catch (error) {
			if (error instanceof MattermostApiError && (error.status === 404 || error.status === 403)) {
				return null;
			}
			throw error;
		}
	}

	private async call<S extends z.ZodType>(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		schema: S,
		body?: object,
	): Promise<z.infer<S>>;
	private async call(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		schema: null,
		body?: object,
	): Promise<null>;
	private async call<S extends z.ZodType>(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		schema: S | null,
		body?: object,
	): Promise<z.infer<S> | null> {
		const url = new URL(`api/v4/${path}`, this.base);
		const endpoint = `${method} /api/v4/${path.split("?")[0]}`;
		let response: Response;
		try {
			response = await fetch(url, {
				method,
				headers: {
					authorization: `Bearer ${this.token}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(this.timeoutMs),
				redirect: "error",
			});
		} catch (error) {
			const reason = error instanceof Error ? error.name : "request failed";
			throw new MattermostApiError(0, null, `${endpoint}: no response (${reason})`);
		}
		const text = await response.text();
		if (!response.ok) {
			const parsed = ApiErrorSchema.safeParse(safeJson(text));
			const errorId = parsed.success ? (parsed.data.id ?? null) : null;
			throw new MattermostApiError(
				response.status,
				errorId,
				`${endpoint}: HTTP ${response.status}${errorId === null ? "" : ` (${errorId})`}`,
			);
		}
		if (schema === null) {
			return null;
		}
		const parsed = schema.safeParse(safeJson(text));
		if (!parsed.success) {
			throw new MattermostApiError(
				response.status,
				null,
				`${endpoint}: unexpected response shape at '${parsed.error.issues[0]?.path.join(".") ?? ""}'`,
			);
		}
		return parsed.data;
	}
}

function safeJson(text: string): JsonValue | undefined {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
