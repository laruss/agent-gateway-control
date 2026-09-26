import { randomUUID } from "node:crypto";
import { z } from "zod";
import { GMAIL_CONNECTOR_SCOPES } from "./auth.ts";
import type { GoogleEndpoints } from "./google-api.ts";

/**
 * A fake of the Google APIs the connector calls (OAuth token, Gmail, Pub/Sub pull), speaking
 * their REST wire format, with controls to deliver mail, lose or duplicate notifications and
 * expire history. Test-only.
 */

export type FakeMail = Readonly<{
	from?: string;
	to?: string;
	subject?: string;
	text?: string;
	html?: string;
	/** A thread to add the message to; a new thread by default. */
	threadId?: string;
	labels?: Readonly<string[]>;
	attachments?: Readonly<{ filename: string; mimeType: string; size: number }[]>;
}>;

export type DeliverOptions = Readonly<{
	/** Gmail never publishes this change (a lost notification). */
	dropNotification?: boolean;
}>;

type StoredMessage = {
	id: string;
	threadId: string;
	labelIds: string[];
	internalDate: string;
	payload: object;
};

type PubsubEntry = {
	messageId: string;
	data: string;
	publishTime: string;
	ackId: string;
	/** Leased until this time; 0 when available. */
	leasedUntil: number;
	acked: boolean;
	deliveries: number;
};

export type FakeGoogleOptions = Readonly<{
	emailAddress?: string;
	refreshToken?: string;
	/** Scopes the token endpoint reports as granted. */
	grantedScopes?: Readonly<string[]>;
	/** How long a pulled, unacknowledged message stays leased. */
	ackDeadlineMs?: number;
	/** How long an empty pull waits. */
	pullWaitMs?: number;
}>;

export type FakeGoogle = Readonly<{
	endpoints: GoogleEndpoints;
	emailAddress: string;
	refreshToken: string;
	subscription: string;
	topic: string;
	deliver: (mail: FakeMail, options?: DeliverOptions) => string;
	/** Publishes a notification for the current history id (e.g. again, as Pub/Sub may). */
	publishNotification: () => string;
	/** Publishes arbitrary JSON (or text) as a message on the subscription. */
	publishRaw: (data: string) => string;
	/** Makes an acknowledged notification deliverable again (Pub/Sub at-least-once). */
	redeliver: (pubsubMessageId: string) => void;
	/** History before `historyId` is gone: an older start gets HTTP 404, as Gmail answers. */
	expireHistory: (historyId: string) => void;
	/** Deletes a message, as the user would. */
	deleteMessage: (id: string) => void;
	/**
	 * Replaces a message's labels (archive: drop INBOX; spam: add SPAM). Adding INBOX is a
	 * change Gmail records and notifies, as moving a message into the inbox.
	 */
	setLabels: (id: string, labels: Readonly<string[]>) => void;
	/** Watch calls fail (HTTP 403) while set. */
	failWatch: (failing: boolean) => void;
	/** Pub/Sub calls fail (HTTP 403, a missing subscriber role) while set. */
	failPubsub: (failing: boolean) => void;
	/** The token endpoint answers `invalid_grant` from now on. */
	revoke: () => void;
	setGrantedScopes: (scopes: Readonly<string[]>) => void;
	/** Every request as `METHOD path`, without query. */
	requests: () => Readonly<string[]>;
	watchCalls: () => number;
	pubsubEntries: () => Readonly<
		Readonly<{ messageId: string; acked: boolean; deliveries: number }>[]
	>;
	historyId: () => string;
	stop: () => Promise<void>;
}>;

const GMAIL_PREFIX = "/gmail/v1/users/me";

function base64url(text: string): string {
	return Buffer.from(text, "utf8").toString("base64url");
}

function headers(mail: FakeMail, messageId: string) {
	return [
		{ name: "From", value: mail.from ?? "Sender <sender@example.com>" },
		{ name: "To", value: mail.to ?? "owner@example.org" },
		{ name: "Subject", value: mail.subject ?? "Hello" },
		{ name: "Message-ID", value: `<${messageId}@example.com>` },
	];
}

function payload(mail: FakeMail, messageId: string): object {
	const parts: object[] = [];
	if (mail.text !== undefined) {
		parts.push({
			mimeType: "text/plain",
			filename: "",
			headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }],
			body: { size: mail.text.length, data: base64url(mail.text) },
		});
	}
	if (mail.html !== undefined) {
		parts.push({
			mimeType: "text/html",
			filename: "",
			headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }],
			body: { size: mail.html.length, data: base64url(mail.html) },
		});
	}
	for (const attachment of mail.attachments ?? []) {
		parts.push({
			mimeType: attachment.mimeType,
			filename: attachment.filename,
			headers: [
				{ name: "Content-Disposition", value: `attachment; filename="${attachment.filename}"` },
			],
			body: { attachmentId: randomUUID(), size: attachment.size },
		});
	}
	return {
		mimeType: "multipart/mixed",
		filename: "",
		headers: headers(mail, messageId),
		body: { size: 0 },
		parts,
	};
}

export function startFakeGoogle(options: FakeGoogleOptions = {}): FakeGoogle {
	const emailAddress = options.emailAddress ?? "owner@example.org";
	const refreshToken = options.refreshToken ?? "fake-refresh-token";
	const ackDeadlineMs = options.ackDeadlineMs ?? 1000;
	const pullWaitMs = options.pullWaitMs ?? 200;
	let grantedScopes = [...(options.grantedScopes ?? GMAIL_CONNECTOR_SCOPES)];
	let revoked = false;
	const accessTokens = new Set<string>();
	const log: string[] = [];
	let history = 1000n;
	let oldestHistory = 0n;
	let nextMessage = 0x18c0000000000000n;
	const messages = new Map<string, StoredMessage>();
	const records: {
		id: bigint;
		kind: "added" | "labelled";
		messageId: string;
		threadId: string;
		labelIds: string[];
	}[] = [];
	const pubsub: PubsubEntry[] = [];
	let watches = 0;
	let watchFails = false;
	let pubsubFails = false;
	const project = "fake-project";
	const topic = `projects/${project}/topics/gmail-inbox`;
	const subscription = `projects/${project}/subscriptions/gmail-inbox-pull`;

	const publishData = (data: string): string => {
		const messageId = String(1_000_000 + pubsub.length);
		pubsub.push({
			messageId,
			data: Buffer.from(data).toString("base64"),
			publishTime: new Date().toISOString(),
			ackId: randomUUID(),
			leasedUntil: 0,
			acked: false,
			deliveries: 0,
		});
		return messageId;
	};
	const publish = (historyId: bigint): string =>
		publishData(JSON.stringify({ emailAddress, historyId: Number(historyId) }));

	const authorized = (request: Request) => {
		const header = request.headers.get("authorization") ?? "";
		return header.startsWith("Bearer ") && accessTokens.has(header.slice(7));
	};
	const error = (status: number, reason: string) =>
		Response.json({ error: { code: status, status: reason, message: reason } }, { status });

	const token = async (request: Request) => {
		const form = new URLSearchParams(await request.text());
		const grant = form.get("grant_type");
		if (grant === "authorization_code") {
			if (form.get("code") !== "fake-code" || (form.get("code_verifier") ?? "") === "") {
				return Response.json({ error: "invalid_grant" }, { status: 400 });
			}
		} else if (grant !== "refresh_token" || revoked || form.get("refresh_token") !== refreshToken) {
			return Response.json({ error: "invalid_grant" }, { status: 400 });
		}
		const access = `fake-access-${randomUUID()}`;
		accessTokens.add(access);
		return Response.json({
			access_token: access,
			expires_in: 3599,
			scope: grantedScopes.join(" "),
			token_type: "Bearer",
			...(grant === "authorization_code" ? { refresh_token: refreshToken } : {}),
		});
	};

	const gmail = async (request: Request, path: string, url: URL) => {
		if (path === "/profile") {
			return Response.json({
				emailAddress,
				historyId: String(history),
				messagesTotal: messages.size,
			});
		}
		if (path === "/watch" && request.method === "POST" && watchFails) {
			return error(403, "PERMISSION_DENIED");
		}
		if (path === "/watch" && request.method === "POST") {
			const body = z.object({ topicName: z.string() }).parse(await request.json());
			if (body.topicName !== topic) {
				return error(400, "INVALID_ARGUMENT");
			}
			watches += 1;
			return Response.json({
				historyId: String(history),
				expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
			});
		}
		if (path === "/history") {
			const start = BigInt(url.searchParams.get("startHistoryId") ?? "0");
			if (start < oldestHistory) {
				return error(404, "NOT_FOUND");
			}
			const max = Number(url.searchParams.get("maxResults") ?? "100");
			const offset = Number(url.searchParams.get("pageToken") ?? "0");
			const label = url.searchParams.get("labelId");
			// Changes of messages carrying the label when they happened.
			const after = records.filter(
				(record) => record.id > start && (label === null || record.labelIds.includes(label)),
			);
			const page = after.slice(offset, offset + max);
			return Response.json({
				...(page.length === 0
					? {}
					: {
							history: page.map((record) => ({
								id: String(record.id),
								messages: [{ id: record.messageId, threadId: record.threadId }],
								// As Gmail usually answers: ids only, no labels.
								...(record.kind === "added"
									? {
											messagesAdded: [
												{ message: { id: record.messageId, threadId: record.threadId } },
											],
										}
									: {
											labelsAdded: [
												{
													message: { id: record.messageId, threadId: record.threadId },
													labelIds: ["INBOX"],
												},
											],
										}),
							})),
						}),
				...(offset + max < after.length ? { nextPageToken: String(offset + max) } : {}),
				historyId: String(history),
			});
		}
		if (path === "/messages" && request.method === "GET") {
			const after = /after:(\d+)/u.exec(url.searchParams.get("q") ?? "")?.[1];
			const since = after === undefined ? 0 : Number(after) * 1000;
			const all = [...messages.values()]
				.filter((m) => m.labelIds.includes("INBOX") && Number(m.internalDate) >= since)
				.reverse()
				.map((m) => ({ id: m.id, threadId: m.threadId }));
			const max = Number(url.searchParams.get("maxResults") ?? "100");
			const offset = Number(url.searchParams.get("pageToken") ?? "0");
			const listed = all.slice(offset, offset + max);
			return Response.json({
				...(listed.length === 0 ? { resultSizeEstimate: 0 } : { messages: listed }),
				...(offset + max < all.length ? { nextPageToken: String(offset + max) } : {}),
			});
		}
		const single = /^\/messages\/([0-9a-f]+)$/u.exec(path);
		if (single !== null && request.method === "GET") {
			const message = messages.get(single[1] ?? "");
			return message === undefined ? error(404, "NOT_FOUND") : Response.json(message);
		}
		return error(404, "NOT_FOUND");
	};

	const pull = async (request: Request, path: string) => {
		if (pubsubFails) {
			return error(403, "PERMISSION_DENIED");
		}
		if (path === `/${subscription}:pull`) {
			const body = z.object({ maxMessages: z.number() }).parse(await request.json());
			const until = Date.now() + pullWaitMs;
			for (;;) {
				const now = Date.now();
				const ready = pubsub.filter((entry) => !entry.acked && entry.leasedUntil <= now);
				if (ready.length > 0 || now >= until) {
					const batch = ready.slice(0, body.maxMessages);
					for (const entry of batch) {
						entry.leasedUntil = now + ackDeadlineMs;
						entry.deliveries += 1;
						entry.ackId = randomUUID();
					}
					return Response.json(
						batch.length === 0
							? {}
							: {
									receivedMessages: batch.map((entry) => ({
										ackId: entry.ackId,
										message: {
											data: entry.data,
											messageId: entry.messageId,
											publishTime: entry.publishTime,
										},
									})),
								},
					);
				}
				await Bun.sleep(20);
			}
		}
		if (path === `/${subscription}:acknowledge`) {
			const body = z.object({ ackIds: z.array(z.string()) }).parse(await request.json());
			for (const entry of pubsub) {
				if (body.ackIds.includes(entry.ackId) && entry.leasedUntil > Date.now()) {
					entry.acked = true;
				}
			}
			return Response.json({});
		}
		return error(404, "NOT_FOUND");
	};

	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (request) => {
			const url = new URL(request.url);
			log.push(`${request.method} ${url.pathname}`);
			if (url.pathname === "/token") {
				return token(request);
			}
			if (!authorized(request)) {
				return error(401, "UNAUTHENTICATED");
			}
			if (url.pathname.startsWith(GMAIL_PREFIX)) {
				return gmail(request, url.pathname.slice(GMAIL_PREFIX.length), url);
			}
			if (url.pathname.startsWith("/pubsub/v1/")) {
				return pull(request, url.pathname.slice("/pubsub/v1".length));
			}
			return error(404, "NOT_FOUND");
		},
	});
	const base = `http://127.0.0.1:${server.port}`;

	return {
		endpoints: {
			token: `${base}/token`,
			authorize: `${base}/authorize`,
			gmail: `${base}/gmail/v1`,
			pubsub: `${base}/pubsub/v1`,
		},
		emailAddress,
		refreshToken,
		subscription,
		topic,
		deliver: (mail, deliverOptions = {}) => {
			nextMessage += 1n;
			const id = nextMessage.toString(16);
			const threadId = mail.threadId ?? id;
			const labelIds = [...(mail.labels ?? ["INBOX", "UNREAD"])];
			messages.set(id, {
				id,
				threadId,
				labelIds,
				internalDate: String(Date.now()),
				payload: payload(mail, id),
			});
			history += 1n;
			records.push({ id: history, kind: "added", messageId: id, threadId, labelIds });
			if (deliverOptions.dropNotification !== true) {
				publish(history);
			}
			return id;
		},
		publishNotification: () => publish(history),
		publishRaw: publishData,
		redeliver: (pubsubMessageId) => {
			const entry = pubsub.find((e) => e.messageId === pubsubMessageId);
			if (entry !== undefined) {
				entry.acked = false;
				entry.leasedUntil = 0;
			}
		},
		expireHistory: (historyId) => {
			oldestHistory = BigInt(historyId);
		},
		deleteMessage: (id) => {
			messages.delete(id);
		},
		setLabels: (id, labels) => {
			const message = messages.get(id);
			if (message === undefined) {
				return;
			}
			const intoInbox = !message.labelIds.includes("INBOX") && labels.includes("INBOX");
			message.labelIds = [...labels];
			if (intoInbox) {
				history += 1n;
				records.push({
					id: history,
					kind: "labelled",
					messageId: id,
					threadId: message.threadId,
					labelIds: [...labels],
				});
				publish(history);
			}
		},
		failWatch: (failing) => {
			watchFails = failing;
		},
		failPubsub: (failing) => {
			pubsubFails = failing;
		},
		revoke: () => {
			revoked = true;
			accessTokens.clear();
		},
		setGrantedScopes: (scopes) => {
			grantedScopes = [...scopes];
			accessTokens.clear();
		},
		requests: () => [...log],
		watchCalls: () => watches,
		pubsubEntries: () =>
			pubsub.map((entry) => ({
				messageId: entry.messageId,
				acked: entry.acked,
				deliveries: entry.deliveries,
			})),
		historyId: () => String(history),
		stop: async () => {
			await server.stop(true);
		},
	};
}
