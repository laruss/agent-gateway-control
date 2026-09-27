import { createHash } from "node:crypto";
import type { ActionParam } from "@agent-gateway/contracts";
import { canonicalHash } from "@agent-gateway/events";

/**
 * Immutable hash of an approval: action type and parameters, canonical JSON with parameters
 * sorted by name. The controller, `begin` and the tool runner each recompute it and must get
 * the value stored with the request.
 */
export function approvalActionHash(
	action: Readonly<{ actionType: string; actionParams: Readonly<ActionParam[]> }>,
): string {
	const params = [...action.actionParams].sort((a, b) => (a.name < b.name ? -1 : 1));
	return canonicalHash({
		actionType: action.actionType,
		actionParams: params.map((p) => ({ name: p.name, value: p.value })),
	});
}

/** Crockford Base32: no I, L, O or U, so a code survives being read aloud and retyped. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;
const CODE_DOMAIN = "agent-gateway/approval-code/v1";

/**
 * The code an owner replies with, `XXXX-XXXX-XXXX`: 60 bits of a domain-separated SHA-256 over
 * the request id, its random nonce and its action hash. It binds a reply to exactly one request;
 * the author's identity is what authorizes it.
 */
export function approvalCode(
	request: Readonly<{ id: string; nonce: string; immutableActionHash: string }>,
): string {
	const digest = createHash("sha256")
		.update([CODE_DOMAIN, request.id, request.nonce, request.immutableActionHash].join("\0"))
		.digest();
	let bits = 0n;
	for (const byte of digest.subarray(0, 8)) {
		bits = (bits << 8n) | BigInt(byte);
	}
	let code = "";
	for (let i = 0; i < CODE_LENGTH; i++) {
		// The top 60 of the 64 bits, five at a time.
		code += CROCKFORD[Number((bits >> BigInt(59 - i * 5)) & 31n)];
	}
	return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

export type ApprovalCommand =
	| Readonly<{ kind: "approve" | "deny"; code: string }>
	/** Starts like a command but is not exactly one: it decides nothing. */
	| Readonly<{ kind: "malformed" }>;

/** A post that starts like a command, also quoted or in code as copied from the card. */
const ATTEMPT = /^[\s>`*_~]*(approve|deny)\b/i;
const COMMAND =
	/^[ \t]*(approve|deny)[ \t]+([0-9A-Za-z]{4}-?[0-9A-Za-z]{4}-?[0-9A-Za-z]{4})[ \t]*$/i;

/**
 * Reads an approval card reply. Null when the post is not a command attempt at all (a remark
 * in the thread). A command must be the whole message, one line: `approve <code>` or
 * `deny <code>`, the code in any case, grouped or not. Anything more or less is malformed.
 * Pure.
 */
export function parseApprovalCommand(message: string): ApprovalCommand | null {
	if (!ATTEMPT.test(message)) {
		return null;
	}
	const match = COMMAND.exec(message);
	if (match === null || match[1] === undefined || match[2] === undefined) {
		return { kind: "malformed" };
	}
	return {
		kind: match[1].toLowerCase() === "approve" ? "approve" : "deny",
		code: normalizeApprovalCode(match[2]),
	};
}

/** `ab12cd34ef56` and `AB12-CD34-EF56` are the same code. */
export function normalizeApprovalCode(code: string): string {
	const plain = code.replaceAll("-", "").toUpperCase();
	return `${plain.slice(0, 4)}-${plain.slice(4, 8)}-${plain.slice(8)}`;
}
