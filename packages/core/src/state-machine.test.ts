import { AGENT_STATES } from "@agent-gateway/db";
import { describe, expect, it } from "vitest";
import { InvalidTransitionError, nextAgentState, requireTransition } from "./state-machine.ts";

describe("agent state machine", () => {
	it("follows the documented happy paths", () => {
		expect(nextAgentState("disabled", "enable")).toBe("idle");
		expect(nextAgentState("idle", "schedule")).toBe("queued");
		expect(nextAgentState("queued", "start")).toBe("running");
		expect(nextAgentState("running", "complete_idle")).toBe("idle");
		expect(nextAgentState("running", "complete_waiting")).toBe("waiting");
		expect(nextAgentState("waiting", "wait_resolved")).toBe("queued");
		expect(nextAgentState("running", "fail")).toBe("failed");
		expect(nextAgentState("failed", "redrive")).toBe("queued");
		expect(nextAgentState("running", "pause")).toBe("paused");
		expect(nextAgentState("paused", "resume_idle")).toBe("idle");
		expect(nextAgentState("idle", "disable")).toBe("disabled");
	});

	it("accepts a result that arrives before the started report", () => {
		expect(nextAgentState("queued", "complete_idle")).toBe("idle");
		expect(nextAgentState("queued", "fail")).toBe("failed");
	});

	it("rejects shortcuts", () => {
		expect(nextAgentState("idle", "start")).toBeNull();
		expect(nextAgentState("waiting", "schedule")).toBeNull();
		expect(nextAgentState("failed", "schedule")).toBeNull();
		expect(nextAgentState("running", "disable")).toBeNull();
		expect(nextAgentState("disabled", "schedule")).toBeNull();
		expect(() => requireTransition("developer", "paused", "start")).toThrow(InvalidTransitionError);
	});

	it("can pause every active state and never leaves disabled except by enable", () => {
		for (const state of AGENT_STATES) {
			if (state !== "disabled" && state !== "paused" && state !== "failed") {
				expect(nextAgentState(state, "pause")).toBe("paused");
			}
		}
		expect(nextAgentState("disabled", "pause")).toBeNull();
	});

	it("leaves FAILED only by redrive, also through disable and enable", () => {
		expect(nextAgentState("failed", "pause")).toBeNull();
		expect(nextAgentState("failed", "resume_idle")).toBeNull();
		expect(nextAgentState("failed", "disable")).toBe("disabled");
		expect(nextAgentState("disabled", "enable_failed")).toBe("failed");
	});
});
