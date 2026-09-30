import type { GatewayEvent } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import { sessionScope } from "./scheduler.ts";

function event(id: string, correlationid: string): GatewayEvent {
	return {
		specversion: "1.0",
		id,
		source: "test://session-scope",
		type: "timer.fired",
		time: "2026-09-26T00:00:00.000Z",
		datacontenttype: "application/json",
		correlationid,
		causationid: null,
		trustlevel: "system-trusted",
		hop: 0,
		data: {},
	};
}

describe("sessionScope", () => {
	const a = event("a", "thread:a");
	const b = event("b", "thread:b");

	const channels = [{ channelId: "hq" }];

	it("covers the config version and every carried conversation", () => {
		const single = { trigger: a, pendingInbox: [], channels };
		expect(sessionScope("v1", single)).not.toBe(sessionScope("v2", single));
		const mixed = sessionScope("v1", { trigger: a, pendingInbox: [b], channels });
		expect(mixed).not.toBe(sessionScope("v1", single));
		expect(mixed).toBe(sessionScope("v1", { trigger: b, pendingInbox: [a, a], channels }));
	});

	it("covers the agent's channels: a channel given or taken away is another scope", () => {
		const hq = sessionScope("v1", { trigger: a, pendingInbox: [], channels });
		const more = sessionScope("v1", {
			trigger: a,
			pendingInbox: [],
			channels: [{ channelId: "lab" }, ...channels],
		});
		expect(more).not.toBe(hq);
	});
});
