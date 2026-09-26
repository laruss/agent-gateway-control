import { TextDecoder } from "node:util";
import type { GmailHeader, GmailMessagePart } from "./gmail-client.ts";

function decodeBytes(bytes: Uint8Array, charset: string): string {
	try {
		return new TextDecoder(charset.trim().toLowerCase() || "utf-8").decode(bytes);
	} catch {
		// An unknown charset: UTF-8 with replacement characters rather than nothing.
		return new TextDecoder("utf-8").decode(bytes);
	}
}

/** `=?charset?B|Q?text?=` words (RFC 2047); adjacent words join without the space between. */
const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/gu;

function decodeWord(charset: string, encoding: string, text: string): string {
	if (encoding.toUpperCase() === "B") {
		return decodeBytes(Buffer.from(text, "base64"), charset);
	}
	const bytes: number[] = [];
	const source = text.replace(/_/gu, " ");
	for (let i = 0; i < source.length; i += 1) {
		const hex = source.slice(i + 1, i + 3);
		if (source[i] === "=" && /^[0-9a-f]{2}$/iu.test(hex)) {
			bytes.push(Number.parseInt(hex, 16));
			i += 2;
		} else {
			bytes.push(source.charCodeAt(i) & 0xff);
		}
	}
	return decodeBytes(Uint8Array.from(bytes), charset);
}

/** A header value with its MIME encoded words decoded. */
export function decodeHeaderValue(value: string): string {
	return value
		.replace(/(\?=)\s+(=\?)/gu, "$1$2")
		.replace(ENCODED_WORD, (_match, charset: string, encoding: string, text: string) =>
			decodeWord(charset, encoding, text),
		);
}

export function headerValue(headers: Readonly<GmailHeader[]> | undefined, name: string): string {
	const lower = name.toLowerCase();
	const values = (headers ?? [])
		.filter((header) => header.name.toLowerCase() === lower)
		.map((header) => decodeHeaderValue(header.value));
	return values.join(", ");
}

function contentParameter(contentType: string, name: string): string | null {
	const match = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "iu").exec(contentType);
	return match === null ? null : (match[1] ?? match[2] ?? null);
}

/** A part the sender marked as an attachment, or one with a file name. */
function isAttachment(part: GmailMessagePart): boolean {
	const disposition = headerValue(part.headers, "Content-Disposition").toLowerCase();
	return (part.filename ?? "") !== "" || disposition.startsWith("attachment");
}

export type MimeAttachment = Readonly<{ filename: string; mimeType: string; sizeBytes: number }>;

export type MimeContent = Readonly<{
	/** The first inline text/plain part, decoded. */
	plain: string | null;
	/** The first inline text/html part, decoded. */
	html: string | null;
	attachments: Readonly<MimeAttachment[]>;
}>;

function partText(part: GmailMessagePart): string | null {
	const data = part.body?.data;
	if (data === undefined) {
		return null;
	}
	const charset = contentParameter(headerValue(part.headers, "Content-Type"), "charset") ?? "utf-8";
	return decodeBytes(Buffer.from(data, "base64url"), charset);
}

/**
 * The readable content of a message: its first plain and HTML body, and its attachments by name,
 * type and size. Attachment content is never read.
 */
export function mimeContent(payload: GmailMessagePart): MimeContent {
	let plain: string | null = null;
	let html: string | null = null;
	const attachments: MimeAttachment[] = [];
	const visit = (part: GmailMessagePart, depth: number) => {
		const mimeType = (part.mimeType ?? "").toLowerCase();
		if (isAttachment(part)) {
			attachments.push({
				filename: part.filename ?? "",
				mimeType,
				sizeBytes: part.body?.size ?? 0,
			});
			return;
		}
		if (mimeType === "text/plain" && plain === null) {
			plain = partText(part);
		} else if (mimeType === "text/html" && html === null) {
			html = partText(part);
		}
		// Bounded: a message nests a few levels, a crafted one must not recurse without end.
		if (depth < 16) {
			for (const child of part.parts ?? []) {
				visit(child, depth + 1);
			}
		}
	};
	visit(payload, 0);
	return { plain, html, attachments };
}
