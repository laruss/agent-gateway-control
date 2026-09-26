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

	it("covers the config version and every carried conversation", () => {
		const single = { trigger: a, pendingInbox: [] };
		expect(sessionScope("v1", single)).not.toBe(sessionScope("v2", single));
		const mixed = sessionScope("v1", { trigger: a, pendingInbox: [b] });
		expect(mixed).not.toBe(sessionScope("v1", single));
		expect(mixed).toBe(sessionScope("v1", { trigger: b, pendingInbox: [a, a] }));
	});
});
