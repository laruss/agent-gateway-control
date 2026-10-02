import type { WakeRule } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import { NO_SPECIFIC_TARGET, ruleWithTarget } from "./assignments-tab.tsx";

describe("ruleWithTarget", () => {
	it("sets a specific target", () => {
		const rule: WakeRule = { event_type: "mattermost.agent.mentioned", target_agent_id: "a" };
		expect(ruleWithTarget(rule, "b")).toEqual({
			event_type: "mattermost.agent.mentioned",
			target_agent_id: "b",
		});
	});

	it("drops target_agent_id entirely for 'no specific target', never carrying the old one through", () => {
		const rule: WakeRule = { event_type: "mattermost.agent.mentioned", target_agent_id: "a" };
		const next = ruleWithTarget(rule, NO_SPECIFIC_TARGET);
		expect(next).toEqual({ event_type: "mattermost.agent.mentioned" });
		expect(next).not.toHaveProperty("target_agent_id");
	});

	it("is a no-op shape-wise for a rule that already has no target", () => {
		const rule: WakeRule = { event_type: "timer.fired" };
		expect(ruleWithTarget(rule, NO_SPECIFIC_TARGET)).toEqual({ event_type: "timer.fired" });
	});
});
