import {
	type GatewayEvent,
	type GmailAttachment,
	type GmailMailboxId,
	type GmailMessageData,
	GmailMessageDataSchema,
	type GmailNotificationData,
	MAX_MAIL_BODY,
	withoutUnsafeCharacters,
} from "@agent-gateway/contracts";
import type { GmailMessage } from "./gmail-client.ts";
import { htmlToText } from "./html.ts";
import { headerValue, mimeContent } from "./mime.ts";

/** The event source of a mailbox. */
export function gmailSource(mailboxId: GmailMailboxId): string {
	return `gmail://${mailboxId}`;
}

/** Labels that keep a message out: not received mail, or mail Gmail itself distrusts. */
const EXCLUDED_LABELS: Readonly<string[]> = ["SPAM", "TRASH", "DRAFT", "CHAT"];

/** Whether a message is inbox mail the Gateway should see, judging by its current labels. */
export function isInboxMail(labelIds: Readonly<string[]> | undefined): boolean {
	const labels = labelIds ?? [];
	return labels.includes("INBOX") && !isExcludedMail(labels);
}

/**
 * Mail kept out whatever its history: spam, trash, drafts, chats. A message history reports as
 * added to the inbox counts even when it was archived before it was read (only its current
 * labels are known then).
 */
export function isExcludedMail(labelIds: Readonly<string[]> | undefined): boolean {
	const labels = labelIds ?? [];
	return (
		labels.some((label) => EXCLUDED_LABELS.includes(label)) ||
		// The owner's own sent mail, should history ever report it under the inbox filter.
		(labels.includes("SENT") && !labels.includes("INBOX"))
	);
}

/** Most attachments described per message. */
const MAX_ATTACHMENTS = 50;

/** Text safe to store: no unsafe characters, CRLF as LF, bounded runs of blank lines. */
function clean(text: string): string {
	return withoutUnsafeCharacters(text.replace(/\r\n?/gu, "\n"))
		.replace(/[ \t]+\n/gu, "\n")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
}

/** A single-line value: whitespace runs, line breaks included, become one space. */
function line(text: string, max: number): string {
	return truncate(clean(text).replace(/\s+/gu, " "), max).text;
}

function truncate(text: string, max: number): Readonly<{ text: string; truncated: boolean }> {
	const chars = [...text];
	if (chars.length <= max) {
		return { text, truncated: false };
	}
	return {
		text: chars
			.slice(0, max - 1)
			.join("")
			.trimEnd(),
		truncated: true,
	};
}

function body(
	message: GmailMessage,
): Pick<
	GmailMessageData,
	"body_text" | "body_format" | "body_truncated" | "hidden_text_removed" | "hidden_text_suspected"
> & { attachments: Readonly<GmailAttachment[]>; omitted: number } {
	const content = mimeContent(message.payload);
	const attachments = content.attachments.map((a) => ({
		filename: line(a.filename, 255),
		mime_type: line(a.mimeType, 255),
		size_bytes: a.sizeBytes,
	}));
	const listed = attachments.slice(0, MAX_ATTACHMENTS);
	const omitted = attachments.length - listed.length;
	// The HTML part is what a person reading the mail sees, so the model gets the same: a sender
	// cannot show a harmless HTML version to the reader and put instructions in the plain one.
	// Plain text is used only when there is no HTML part; an HTML part without text (images
	// only) gives an empty body, since that is what the reader reads.
	if (content.html !== null) {
		const converted = htmlToText(content.html);
		const text = truncate(clean(converted.text), MAX_MAIL_BODY);
		return {
			body_text: text.text,
			body_format: "html",
			body_truncated: text.truncated || converted.truncated,
			hidden_text_removed: converted.hiddenRemoved,
			hidden_text_suspected: converted.hiddenSuspected,
			attachments: listed,
			omitted,
		};
	}
	if (content.plain !== null) {
		const text = truncate(clean(content.plain), MAX_MAIL_BODY);
		return {
			body_text: text.text,
			body_format: "plain",
			body_truncated: text.truncated,
			hidden_text_removed: false,
			hidden_text_suspected: false,
			attachments: listed,
			omitted,
		};
	}
	return {
		body_text: "",
		body_format: "none",
		body_truncated: false,
		hidden_text_removed: false,
		hidden_text_suspected: false,
		attachments: listed,
		omitted,
	};
}

/**
 * The event of a received message: deterministic id `gmail-message:<mailbox>:<message>`, one
 * correlation per Gmail thread, external-untrusted, and only fields that never change after
 * delivery, so every sync of the same message yields the same event.
 */
export function messageEvent(mailboxId: GmailMailboxId, message: GmailMessage): GatewayEvent {
	const headers = message.payload.headers;
	const content = body(message);
	const receivedAt = new Date(Number(message.internalDate)).toISOString();
	const data: GmailMessageData = GmailMessageDataSchema.parse({
		mailbox_id: mailboxId,
		message_id: message.id,
		thread_id: message.threadId,
		received_at: receivedAt,
		from: line(headerValue(headers, "From"), 1000),
		reply_to: line(headerValue(headers, "Reply-To"), 1000),
		to: line(headerValue(headers, "To"), 4000),
		cc: line(headerValue(headers, "Cc"), 4000),
		subject: line(headerValue(headers, "Subject"), 1000),
		rfc822_message_id: line(headerValue(headers, "Message-ID"), 1000),
		body_text: content.body_text,
		body_format: content.body_format,
		body_truncated: content.body_truncated,
		hidden_text_removed: content.hidden_text_removed,
		hidden_text_suspected: content.hidden_text_suspected,
		attachments: content.attachments,
		attachments_omitted: content.omitted,
	});
	return {
		specversion: "1.0",
		id: `gmail-message:${mailboxId}:${message.id}`,
		source: gmailSource(mailboxId),
		type: "google.gmail.message.received",
		time: receivedAt,
		subject: `message/${message.id}`,
		datacontenttype: "application/json",
		correlationid: `gmail-thread:${mailboxId}:${message.threadId}`,
		causationid: null,
		trustlevel: "external-untrusted",
		hop: 0,
		data,
	};
}

/** The event of one Pub/Sub notification, deduplicated by its Pub/Sub message id. */
export function notificationEvent(
	mailboxId: GmailMailboxId,
	pubsubMessageId: string,
	publishTime: string,
	historyId: string,
): GatewayEvent {
	const data: GmailNotificationData = { mailbox_id: mailboxId, history_id: historyId };
	const time = new Date(publishTime);
	return {
		specversion: "1.0",
		id: `pubsub:${pubsubMessageId}`,
		source: gmailSource(mailboxId),
		type: "google.gmail.notification.received",
		time: Number.isNaN(time.getTime()) ? new Date(0).toISOString() : time.toISOString(),
		datacontenttype: "application/json",
		correlationid: `gmail-notification:${mailboxId}:${pubsubMessageId}`,
		causationid: null,
		trustlevel: "external-untrusted",
		hop: 0,
		data,
	};
}
