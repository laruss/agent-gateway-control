import { createHmac, timingSafeEqual } from "node:crypto";
import {
	AgentIdSchema,
	type JsonObject,
	type MattermostId,
	UuidSchema,
} from "@agent-gateway/contracts";
import { canonicalJson, sha256Hex } from "@agent-gateway/events";
import { z } from "zod";

/** The post props key the Gateway's routing metadata lives under. */
export const ROUTING_PROPS_KEY = "agent_gateway";

/** Shortest routing key accepted: 32 characters (e.g. 16 random bytes as hex). */
export const MIN_ROUTING_KEY_LENGTH = 32;

/**
 * Routing metadata of a post by an agent's bot. The listener trusts it only when the signature
 * verifies; the message text is never a source of routing or authority.
 */
export const RoutingMetadataSchema = z.strictObject({
	schema_version: z.literal(1),
	agent_id: AgentIdSchema,
	run_id: UuidSchema,
	correlation_id: z.string().min(1).max(512),
	targets: z.array(AgentIdSchema).max(8),
	hop: z.int().min(0).max(1000),
	idempotency_key: z.string().min(1).max(512),
});
export type RoutingMetadata = z.infer<typeof RoutingMetadataSchema>;

const SignedPropsSchema = z.looseObject({
	[ROUTING_PROPS_KEY]: z.strictObject({
		...RoutingMetadataSchema.shape,
		signature: z.string().regex(/^[a-f0-9]{64}$/),
	}),
});

/**
 * What the signature binds the metadata to: the post's place and exact text. Copying signed
 * props onto another post, into another thread or next to other text breaks verification.
 */
export type PostBinding = Readonly<{
	channelId: MattermostId;
	rootId: MattermostId | null;
	message: string;
}>;

export class RoutingKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RoutingKeyError";
	}
}

export function assertRoutingKey(key: string): void {
	if (key.length < MIN_ROUTING_KEY_LENGTH) {
		throw new RoutingKeyError(
			`the routing key must be at least ${MIN_ROUTING_KEY_LENGTH} characters long`,
		);
	}
}

function signature(key: string, metadata: RoutingMetadata, binding: PostBinding): string {
	const signed = canonicalJson({
		...metadata,
		channel_id: binding.channelId,
		root_id: binding.rootId,
		message_sha256: sha256Hex(binding.message),
	});
	return createHmac("sha256", key).update(signed, "utf8").digest("hex");
}

/** Post props carrying signed routing metadata. */
export function signedRoutingProps(
	key: string,
	metadata: RoutingMetadata,
	binding: PostBinding,
): JsonObject {
	assertRoutingKey(key);
	return {
		[ROUTING_PROPS_KEY]: {
			...metadata,
			targets: [...metadata.targets],
			signature: signature(key, metadata, binding),
		},
	};
}

/** The routing metadata of a post, or null when it is missing, malformed or not signed by `key`. */
export function verifiedRoutingMetadata(
	key: string,
	props: JsonObject,
	binding: PostBinding,
): RoutingMetadata | null {
	const parsed = SignedPropsSchema.safeParse(props);
	if (!parsed.success) {
		return null;
	}
	const { signature: claimed, ...metadata } = parsed.data[ROUTING_PROPS_KEY];
	const expected = Buffer.from(signature(key, metadata, binding), "hex");
	const actual = Buffer.from(claimed, "hex");
	return expected.length === actual.length && timingSafeEqual(expected, actual) ? metadata : null;
}
