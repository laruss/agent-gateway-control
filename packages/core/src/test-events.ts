import type { GatewayEvent } from "@agent-gateway/contracts";

export const CHANNEL = "channe1000000000000000000a";
export const ROOT = "r00tp0st000000000000000000";
export const HUMAN = "human0000000000000000000aa";
export const BOT_DEVELOPER = "b0tdeve1oper00000000000000";
export const BOT_FINANCE = "b0tfinance0000000000000000";

let counter = 0;

type PostInit = Readonly<{
	type?: GatewayEvent["type"];
	sender?: "developer" | "finance" | null;
	targets?: Readonly<string[]>;
	message?: string;
	rootId?: string | null;
	hop?: number;
	correlation?: string;
}>;

/** A normalized Mattermost post event for routing tests. */
export function postEvent(init: PostInit = {}): GatewayEvent {
	counter += 1;
	const postId = `p${String(counter).padStart(25, "0")}`;
	const sender = init.sender ?? null;
	const rootId = init.rootId === undefined ? ROOT : init.rootId;
	return {
		specversion: "1.0",
		id: `mattermost:post:${postId}`,
		source: "mattermost://test",
		type: init.type ?? (rootId === null ? "mattermost.agent.mentioned" : "mattermost.thread.reply"),
		time: "2026-09-25T10:00:00.000Z",
		datacontenttype: "application/json",
		correlationid: init.correlation ?? `thread:${rootId ?? postId}`,
		causationid: null,
		trustlevel: sender === null ? "human-trusted" : "internal-untrusted",
		hop: init.hop ?? (sender === null ? 0 : 1),
		data: {
			post_id: postId,
			root_id: rootId,
			channel_id: CHANNEL,
			user_id: sender === "developer" ? BOT_DEVELOPER : sender === "finance" ? BOT_FINANCE : HUMAN,
			sender_agent_id: sender,
			target_agent_ids: [...(init.targets ?? [])],
			message: init.message ?? "hello",
		},
	};
}
