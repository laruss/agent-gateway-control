import type { GatewayEvent } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical.ts";
import { contentHash, eventTargets, internalEvent, payloadHash } from "./envelope.ts";

function post(
	message: string,
	overrides: Partial<Record<string, string | null | string[]>> = {},
): GatewayEvent {
	return {
		specversion: "1.0",
		id: `mattermost:post:${message}`,
		source: "mattermost://test",
		type: "mattermost.post.created",
		time: "2026-09-25T10:00:00.000Z",
		datacontenttype: "application/json",
		correlationid: "thread:x",
		causationid: null,
		trustlevel: "internal-untrusted",
		hop: 1,
		data: {
			post_id: "p0000000000000000000000001",
			root_id: null,
			channel_id: "channe1000000000000000000a",
			user_id: "b0tdeve1oper00000000000000",
			sender_agent_id: "developer",
			target_agent_ids: ["finance"],
			message,
			...overrides,
		},
	};
}

describe("canonical JSON", () => {
	it("sorts keys at every level and is stable", () => {
		expect(canonicalJson({ b: 1, a: { d: [3, { f: null, e: "x" }], c: true } })).toBe(
			'{"a":{"c":true,"d":[3,{"e":"x","f":null}]},"b":1}',
		);
	});
});

describe("event hashes", () => {
	it("payload hash ignores time and id but not data", () => {
		const a = post("hello");
		expect(payloadHash({ ...a, id: "other", time: "2027-01-01T00:00:00.000Z" })).toBe(
			payloadHash(a),
		);
		expect(payloadHash(post("hello!"))).not.toBe(payloadHash(a));
		expect(payloadHash({ ...a, hop: 2 })).not.toBe(payloadHash(a));
		expect(payloadHash({ ...a, trustlevel: "human-trusted" })).not.toBe(payloadHash(a));
	});

	it("content hash normalizes text and ignores post ids", () => {
		const a = contentHash(post("Please  check the  BUDGET"));
		const b = contentHash(
			post("please check the budget", { post_id: "p0000000000000000000000002" }),
		);
		expect(a).not.toBeNull();
		expect(a).toBe(b);
		expect(
			contentHash(post("please check the budget", { target_agent_ids: ["research"] })),
		).not.toBe(a);
	});

	it("has no content hash or targets for non-post events", () => {
		const timeout = internalEvent({
			id: "wait-timeout:1",
			type: "agent.wait.timeout",
			time: new Date("2026-09-25T10:00:00.000Z"),
			correlationid: "thread:x",
			causationid: null,
			hop: 0,
			data: { agent_id: "developer", wait_id: "7f6c1b3e-2f55-4f7c-9c38-0b1f8a2b9d01" },
		});
		expect(timeout.trustlevel).toBe("system-trusted");
		expect(contentHash(timeout)).toBeNull();
		expect(eventTargets(timeout)).toEqual([]);
	});
});
