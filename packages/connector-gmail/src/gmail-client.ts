import { z } from "zod";
import type { TokenSource } from "./auth.ts";
import {
	callGoogle,
	GoogleApiError,
	type GoogleEndpoints,
	type GoogleRequest,
} from "./google-api.ts";

const HistoryIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/);

const ProfileSchema = z.object({ emailAddress: z.string().min(1), historyId: HistoryIdSchema });
export type GmailProfile = z.infer<typeof ProfileSchema>;

const WatchSchema = z.object({
	historyId: HistoryIdSchema,
	/** Milliseconds since the epoch, as a string. */
	expiration: z.string().regex(/^[0-9]{1,16}$/),
});

const MessageRefSchema = z.object({
	id: z.string().min(1),
	threadId: z.string().min(1),
	labelIds: z.array(z.string()).optional(),
});
export type GmailMessageRef = z.infer<typeof MessageRefSchema>;

const HistoryPageSchema = z.object({
	history: z
		.array(
			z.object({
				id: HistoryIdSchema,
				messagesAdded: z.array(z.object({ message: MessageRefSchema })).optional(),
				labelsAdded: z
					.array(z.object({ message: MessageRefSchema, labelIds: z.array(z.string()) }))
					.optional(),
			}),
		)
		.optional(),
	nextPageToken: z.string().min(1).optional(),
	historyId: HistoryIdSchema,
});
export type GmailHistoryPage = z.infer<typeof HistoryPageSchema>;

const MessageListSchema = z.object({
	messages: z.array(MessageRefSchema).optional(),
	nextPageToken: z.string().min(1).optional(),
});
export type GmailMessageList = z.infer<typeof MessageListSchema>;

export type GmailHeader = Readonly<{ name: string; value: string }>;

/** A MIME part of a message as `format=full` returns it; bodies are base64url. */
export type GmailMessagePart = Readonly<{
	mimeType?: string | undefined;
	filename?: string | undefined;
	headers?: Readonly<GmailHeader[]> | undefined;
	body?:
		| Readonly<{
				attachmentId?: string | undefined;
				size?: number | undefined;
				data?: string | undefined;
		  }>
		| undefined;
	parts?: Readonly<GmailMessagePart[]> | undefined;
}>;

const MessagePartSchema: z.ZodType<GmailMessagePart> = z.lazy(() =>
	z.object({
		mimeType: z.string().optional(),
		filename: z.string().optional(),
		headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
		body: z
			.object({
				attachmentId: z.string().optional(),
				size: z.number().int().min(0).optional(),
				data: z.string().optional(),
			})
			.optional(),
		parts: z.array(MessagePartSchema).optional(),
	}),
);

const MessageSchema = z.object({
	id: z.string().min(1),
	threadId: z.string().min(1),
	labelIds: z.array(z.string()).optional(),
	/** Milliseconds since the epoch, as a string. */
	internalDate: z.string().regex(/^[0-9]{1,16}$/),
	payload: MessagePartSchema,
});
export type GmailMessage = z.infer<typeof MessageSchema>;

/**
 * The Gmail calls the connector needs, all read-only apart from `watch` (which only asks Gmail to
 * publish change notifications). There is deliberately no call that sends, drafts or changes
 * mail, and the credential's scopes would refuse one.
 */
export type GmailClient = Readonly<{
	profile: () => Promise<GmailProfile>;
	watch: (topicName: string) => Promise<Readonly<{ historyId: string; expiresAt: Date }>>;
	/**
	 * Messages added to the inbox after `startHistoryId` (new, or labelled INBOX later); null
	 * when that history is gone (full sync).
	 */
	history: (startHistoryId: string, pageToken: string | null) => Promise<GmailHistoryPage | null>;
	/** The message, or null when it was deleted meanwhile. */
	message: (id: string) => Promise<GmailMessage | null>;
	/** Inbox messages matching a Gmail search query, newest first. */
	listInbox: (query: string, pageToken: string | null) => Promise<GmailMessageList>;
}>;

/** History records and listed messages per page. */
const PAGE_SIZE = 100;

export function createGmailClient(
	endpoints: GoogleEndpoints,
	tokens: TokenSource,
	signal?: AbortSignal,
): GmailClient {
	const base = `${endpoints.gmail}/users/me`;
	const call = async <T>(
		request: Omit<GoogleRequest, "accessToken">,
		schema: z.ZodType<T>,
	): Promise<T> => {
		const withSignal = signal === undefined ? request : { ...request, signal };
		try {
			return await callGoogle({ ...withSignal, accessToken: await tokens.accessToken() }, schema);
		} catch (error) {
			if (!(error instanceof GoogleApiError) || error.status !== 401) {
				throw error;
			}
			// An access token revoked before its expiry: refresh once.
			tokens.invalidate();
			return callGoogle({ ...withSignal, accessToken: await tokens.accessToken() }, schema);
		}
	};
	const orNullOn404 = async <T>(work: () => Promise<T>): Promise<T | null> => {
		try {
			return await work();
		} catch (error) {
			if (error instanceof GoogleApiError && error.status === 404) {
				return null;
			}
			throw error;
		}
	};
	return {
		profile: () => call({ what: "Gmail profile", url: `${base}/profile` }, ProfileSchema),
		watch: async (topicName) => {
			const watch = await call(
				{
					what: "Gmail watch",
					url: `${base}/watch`,
					json: { topicName, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" },
				},
				WatchSchema,
			);
			return { historyId: watch.historyId, expiresAt: new Date(Number(watch.expiration)) };
		},
		history: (startHistoryId, pageToken) => {
			// New mail, and mail moved into the inbox later (a filter that skipped it, a message
			// taken back from the archive or spam).
			const query = new URLSearchParams([
				["startHistoryId", startHistoryId],
				["historyTypes", "messageAdded"],
				["historyTypes", "labelAdded"],
				["labelId", "INBOX"],
				["maxResults", String(PAGE_SIZE)],
			]);
			if (pageToken !== null) {
				query.set("pageToken", pageToken);
			}
			return orNullOn404(() =>
				call({ what: "Gmail history", url: `${base}/history?${query}` }, HistoryPageSchema),
			);
		},
		message: (id) =>
			orNullOn404(() =>
				call(
					{
						what: "Gmail message",
						url: `${base}/messages/${encodeURIComponent(id)}?format=full`,
					},
					MessageSchema,
				),
			),
		listInbox: (q, pageToken) => {
			const query = new URLSearchParams({ labelIds: "INBOX", q, maxResults: String(PAGE_SIZE) });
			if (pageToken !== null) {
				query.set("pageToken", pageToken);
			}
			return call(
				{ what: "Gmail message list", url: `${base}/messages?${query}` },
				MessageListSchema,
			);
		},
	};
}
