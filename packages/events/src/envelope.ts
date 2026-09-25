import {
	type AgentId,
	type GatewayEvent,
	type GatewayEventType,
	type JsonObject,
	MATTERMOST_POST_EVENT_TYPES,
	type MattermostPostData,
	MattermostPostDataSchema,
} from "@agent-gateway/contracts";
import { canonicalHash } from "./canonical.ts";

/** Source of events the Gateway emits itself (timeouts, lifecycle). */
export const GATEWAY_SOURCE = "gateway://controller";

/**
 * Hash of everything that must not change on redelivery: type, subject, data and the routing
 * and trust fields (correlation, causation, hop, trust level). A redelivery with the same
 * `(source, id)` and a different hash is a conflict worth an alert, not a new event. `time`
 * and `traceparent` may differ between deliveries.
 */
export function payloadHash(event: GatewayEvent): string {
	return canonicalHash({
		type: event.type,
		subject: event.subject ?? null,
		correlationid: event.correlationid,
		causationid: event.causationid,
		hop: event.hop,
		trustlevel: event.trustlevel,
		data: event.data,
	});
}

/** Typed data of a Mattermost post event, or null for other event types. */
export function mattermostPost(event: GatewayEvent): MattermostPostData | null {
	if (!MATTERMOST_POST_EVENT_TYPES.includes(event.type)) {
		return null;
	}
	const parsed = MattermostPostDataSchema.safeParse(event.data);
	return parsed.success ? parsed.data : null;
}

/** Agents the Gateway resolved as addressees of the event (structured targets only). */
export function eventTargets(event: GatewayEvent): Readonly<AgentId[]> {
	return mattermostPost(event)?.target_agent_ids ?? [];
}

/** The Gateway-managed agent that authored the event, if any. */
export function eventSenderAgentId(event: GatewayEvent): AgentId | null {
	return mattermostPost(event)?.sender_agent_id ?? null;
}

function normalizeMessage(message: string): string {
	return message.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * Hash of the normalized content of a post: sender, place, addressees and text, without ids.
 * Repeating the same content in the same place is the duplicate-payload loop signal.
 * Null for events that are not Mattermost posts.
 */
export function contentHash(event: GatewayEvent): string | null {
	const post = mattermostPost(event);
	if (post === null) {
		return null;
	}
	return canonicalHash({
		sender: post.sender_agent_id ?? post.user_id,
		channel: post.channel_id,
		root: post.root_id,
		targets: [...post.target_agent_ids].sort(),
		message: normalizeMessage(post.message),
	});
}

export type InternalEventInit = Readonly<{
	id: string;
	type: GatewayEventType;
	time: Date;
	subject?: string;
	correlationid: string;
	causationid: string | null;
	hop: number;
	data: JsonObject;
}>;

/** An event emitted by the Gateway itself; always system-trusted. */
export function internalEvent(init: InternalEventInit): GatewayEvent {
	return {
		specversion: "1.0",
		id: init.id,
		source: GATEWAY_SOURCE,
		type: init.type,
		time: init.time.toISOString(),
		...(init.subject === undefined ? {} : { subject: init.subject }),
		datacontenttype: "application/json",
		correlationid: init.correlationid,
		causationid: init.causationid,
		trustlevel: "system-trusted",
		hop: init.hop,
		data: init.data,
	};
}
