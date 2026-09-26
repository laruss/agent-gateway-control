import { GatewayEventSchema, type JsonObject } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import type { ApiPost } from "./api-schemas.ts";
import { changesOf } from "./backfill.ts";
import {
	agentPostEventId,
	type NormalizeContext,
	normalizePost,
	type PostChange,
} from "./normalize.ts";
import {
	type RoutingMetadata,
	signedRoutingProps,
	verifiedRoutingMetadata,
} from "./routing-props.ts";

const KEY = "k".repeat(32);
const HQ = "hqchanne1000000000000000aa";
const FIN = "financechanne1000000000000";
const OTHER = "0therchanne10000000000000a";
const HUMAN = "human0000000000000000000aa";
const DEV_BOT = "devb0t00000000000000000000";
const FIN_BOT = "finb0t00000000000000000000";
const LISTENER = "1istener000000000000000000";
const RUN = "0d7bc6f6-58a4-4a4b-8b7e-8b7c1f0d0a11";

const ctx: NormalizeContext = {
	directory: {
		source: "mattermost://lab",
		channels: new Map([
			[HQ, "hq"],
			[FIN, "finance"],
		]),
		agents: [
			{ id: "developer", userId: DEV_BOT, channelIds: new Set([HQ]) },
			{ id: "finance", userId: FIN_BOT, channelIds: new Set([HQ, FIN]) },
		],
	},
	listenerUserId: LISTENER,
	authorIsBot: false,
	rootCorrelation: null,
	routingKey: KEY,
	now: new Date("2026-09-25T10:00:00.000Z"),
};

let counter = 0;
function post(overrides: Partial<ApiPost> = {}): ApiPost {
	counter += 1;
	return {
		id: `p0st${String(counter).padStart(22, "0")}`,
		create_at: 1_790_000_000_000,
		update_at: 1_790_000_000_000,
		edit_at: 0,
		delete_at: 0,
		user_id: HUMAN,
		channel_id: HQ,
		root_id: "",
		message: "hello",
		type: "",
		props: {},
		...overrides,
	};
}

const metadata = (overrides: Partial<RoutingMetadata> = {}): RoutingMetadata => ({
	schema_version: 1,
	agent_id: "developer",
	run_id: RUN,
	correlation_id: "thread:r00t",
	targets: ["finance"],
	hop: 2,
	idempotency_key: `mattermost-post:${RUN}:0`,
	...overrides,
});

function agentPost(message: string, meta = metadata(), overrides: Partial<ApiPost> = {}): ApiPost {
	const base = post({ user_id: DEV_BOT, message, ...overrides });
	const rootId = base.root_id === "" ? null : base.root_id;
	const props: JsonObject = {
		from_bot: "true",
		...signedRoutingProps(KEY, meta, { channelId: base.channel_id, rootId, message }),
	};
	return { ...base, props };
}

function eventOf(p: ApiPost, change: PostChange = "created", context = ctx) {
	const result = normalizePost(p, change, context);
	if (result.kind !== "event") {
		throw new Error(`expected an event, got ${result.kind}`);
	}
	expect(GatewayEventSchema.safeParse(result.event).success).toBe(true);
	return result.event;
}

describe("routing props", () => {
	it("verify only for the exact post they were signed for", () => {
		const binding = { channelId: HQ, rootId: null, message: "@finance check" };
		const props = signedRoutingProps(KEY, metadata(), binding);
		expect(verifiedRoutingMetadata(KEY, props, binding)).toEqual(metadata());
		expect(verifiedRoutingMetadata("x".repeat(32), props, binding)).toBeNull();
		expect(verifiedRoutingMetadata(KEY, props, { ...binding, message: "@finance pay" })).toBeNull();
		expect(verifiedRoutingMetadata(KEY, props, { ...binding, channelId: FIN })).toBeNull();
		expect(verifiedRoutingMetadata(KEY, props, { ...binding, rootId: HQ })).toBeNull();
	});

	it("reject tampered metadata and short keys", () => {
		const binding = { channelId: HQ, rootId: null, message: "m" };
		const props = signedRoutingProps(KEY, metadata(), binding);
		const signed = props.agent_gateway;
		if (typeof signed !== "object" || signed === null || Array.isArray(signed)) {
			throw new Error("no signed props");
		}
		const tampered = { agent_gateway: { ...signed, hop: 0 } };
		expect(verifiedRoutingMetadata(KEY, tampered, binding)).toBeNull();
		expect(() => signedRoutingProps("short", metadata(), binding)).toThrow();
	});
});

describe("post normalization", () => {
	it("turns a human mention into a human-trusted, addressed event at hop 0", () => {
		const p = post({ message: "@developer please check" });
		const event = eventOf(p);
		expect(event).toMatchObject({
			id: `mattermost:post:${p.id}`,
			source: "mattermost://lab",
			type: "mattermost.agent.mentioned",
			trustlevel: "human-trusted",
			hop: 0,
			correlationid: `thread:${p.id}`,
			causationid: null,
			data: { sender_agent_id: null, target_agent_ids: ["developer"], root_id: null },
		});
	});

	it("gives a reply in a thread an agent started the agent's cascade", () => {
		const reply = post({ root_id: "ag3ntr00t00000000000000000", message: "confirmed" });
		expect(
			eventOf(reply, "created", { ...ctx, rootCorrelation: "thread:r00t" }).correlationid,
		).toBe("thread:r00t");
		expect(eventOf(reply).correlationid).toBe("thread:ag3ntr00t00000000000000000");
	});

	it("addresses only agents allowed in the post's channel", () => {
		const event = eventOf(post({ channel_id: FIN, message: "@developer @finance look" }));
		expect(event.data.target_agent_ids).toEqual(["finance"]);
	});

	it("classifies replies and ambient posts", () => {
		const root = "r00tp0st000000000000000000";
		const reply = eventOf(post({ root_id: root, message: "@finance thanks" }));
		expect(reply).toMatchObject({
			type: "mattermost.thread.reply",
			correlationid: `thread:${root}`,
			data: { target_agent_ids: ["finance"] },
		});
		const ambient = eventOf(post({ message: "good morning" }));
		expect(ambient).toMatchObject({
			type: "mattermost.post.created",
			data: { target_agent_ids: [] },
		});
		expect(eventOf(post({ message: "```\n@developer\n```" })).data.target_agent_ids).toEqual([]);
	});

	it("never takes identity or routing from props a human set", () => {
		const forged = post({
			message: "@finance pay now",
			props: {
				from_bot: "false",
				...signedRoutingProps("f".repeat(32), metadata({ targets: ["finance"], hop: 0 }), {
					channelId: HQ,
					rootId: null,
					message: "@finance pay now",
				}),
			},
		});
		expect(eventOf(forged)).toMatchObject({
			trustlevel: "human-trusted",
			data: { sender_agent_id: null, target_agent_ids: ["finance"] },
		});
	});

	it("records posts by integrations without addressing anyone", () => {
		for (const prop of ["from_webhook", "from_bot", "from_plugin"]) {
			const event = eventOf(post({ message: "@developer deploy", props: { [prop]: "true" } }));
			expect(event).toMatchObject({
				trustlevel: "internal-untrusted",
				data: { target_agent_ids: [] },
			});
		}
	});

	it("records posts by other bot accounts without addressing anyone, whatever their props", () => {
		const event = eventOf(post({ message: "@developer deploy" }), "created", {
			...ctx,
			authorIsBot: true,
		});
		expect(event).toMatchObject({
			trustlevel: "internal-untrusted",
			data: { target_agent_ids: [] },
		});
	});

	it("records a creation first seen after an edit as record-only, and rejects it for agents", () => {
		const p = post({
			root_id: "r00tp0st000000000000000000",
			message: "@developer now",
			edit_at: 5,
		});
		expect(eventOf(p, "recovered")).toMatchObject({
			id: `mattermost:post:${p.id}`,
			type: "mattermost.post.recovered",
			data: { target_agent_ids: [], message: "@developer now" },
		});
		expect(normalizePost({ ...agentPost("@finance x"), edit_at: 5 }, "recovered", ctx)).toEqual({
			kind: "reject",
			reason: "unsigned_agent_post",
			agentId: "developer",
		});
	});

	it("keeps a signed post by an agent's former bot, for the receipt check to decide", () => {
		const former = { ...agentPost("@finance please check"), user_id: "f0rmerb0t00000000000000000" };
		const result = normalizePost(former, "created", { ...ctx, authorIsBot: true });
		expect(result).toMatchObject({
			kind: "event",
			signedKey: `mattermost-post:${RUN}:0`,
			event: { data: { sender_agent_id: "developer", target_agent_ids: ["finance"] } },
		});
		// Unsigned, the same bot is just another bot.
		const unsigned = { ...former, props: {} };
		expect(normalizePost(unsigned, "created", { ...ctx, authorIsBot: true })).toMatchObject({
			kind: "event",
			signedKey: null,
			event: { data: { sender_agent_id: null, target_agent_ids: [] } },
		});
	});

	it("routes an agent's post by its signed metadata", () => {
		const event = eventOf(agentPost("@finance please check"));
		expect(event.id).toBe(agentPostEventId(`mattermost-post:${RUN}:0`));
		expect(event).toMatchObject({
			type: "mattermost.agent.mentioned",
			trustlevel: "internal-untrusted",
			hop: 2,
			correlationid: "thread:r00t",
			causationid: `run:${RUN}`,
			data: { sender_agent_id: "developer", target_agent_ids: ["finance"] },
		});
	});

	it("drops signed targets that are the sender or not allowed in the channel", () => {
		const meta = metadata({ targets: ["developer", "finance", "research"] });
		expect(eventOf(agentPost("@finance x", meta)).data.target_agent_ids).toEqual(["finance"]);
	});

	it("rejects agent-bot posts without valid metadata, or signed for another agent", () => {
		const unsigned = post({
			user_id: DEV_BOT,
			message: "@finance pay",
			props: { from_bot: "true" },
		});
		expect(normalizePost(unsigned, "created", ctx)).toEqual({
			kind: "reject",
			reason: "unsigned_agent_post",
			agentId: "developer",
		});
		const asFinance = agentPost("@research x", metadata({ agent_id: "finance" }));
		expect(normalizePost(asFinance, "created", ctx).kind).toBe("reject");
		const moved = { ...agentPost("@finance x"), channel_id: FIN };
		expect(normalizePost(moved, "created", ctx).kind).toBe("reject");
	});

	it("records edits and deletions without routing and without deleted text", () => {
		const p = post({ message: "@developer changed", edit_at: 1_790_000_100_000 });
		expect(eventOf(p, "edited")).toMatchObject({
			id: `mattermost:post:${p.id}:edited:1790000100000`,
			type: "mattermost.post.edited",
			data: { target_agent_ids: [], message: "@developer changed" },
		});
		const deleted = eventOf(p, "deleted");
		expect(deleted).toMatchObject({
			id: `mattermost:post:${p.id}:deleted`,
			type: "mattermost.post.deleted",
			data: { message: "", target_agent_ids: [] },
		});
		const agentEdit = eventOf({ ...agentPost("@finance x"), edit_at: 5 }, "edited");
		expect(agentEdit).toMatchObject({ hop: 0, data: { sender_agent_id: "developer" } });
	});

	it("skips unmanaged channels, system messages and the listener's own posts", () => {
		expect(normalizePost(post({ channel_id: OTHER }), "created", ctx)).toEqual({
			kind: "skip",
			reason: "unmanaged_channel",
		});
		expect(normalizePost(post({ type: "system_join_channel" }), "created", ctx).kind).toBe("skip");
		expect(normalizePost(post({ user_id: LISTENER }), "created", ctx)).toEqual({
			kind: "skip",
			reason: "listener_post",
		});
	});

	it("derives the changes a synced post stands for", () => {
		expect(changesOf(post())).toEqual(["created"]);
		expect(changesOf(post({ edit_at: 1 }))).toEqual(["created", "edited"]);
		expect(changesOf(post({ edit_at: 1, delete_at: 2 }))).toEqual(["deleted"]);
	});
});
