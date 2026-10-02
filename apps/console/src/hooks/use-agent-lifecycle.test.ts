import type {
	ConsoleAgentLifecycleResponse,
	ConsoleLifecycleOperation,
} from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import { shouldPollLifecycle } from "./use-agent-lifecycle.ts";

function operation(state: ConsoleLifecycleOperation["state"]): ConsoleLifecycleOperation {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		kind: "retire",
		state,
		checkpoints: {},
		error: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		finishedAt: null,
	};
}

function response(
	status: ConsoleAgentLifecycleResponse["status"],
	operations: ConsoleAgentLifecycleResponse["operations"],
): ConsoleAgentLifecycleResponse {
	return {
		status,
		generation: 1,
		lastError: null,
		statusChangedAt: "2026-01-01T00:00:00.000Z",
		retiredAt: null,
		operations,
	};
}

describe("shouldPollLifecycle", () => {
	it("polls while a retire's current operation is pending, even though status stays 'retiring'", () => {
		expect(shouldPollLifecycle(response("retiring", [operation("pending")]))).toBe(true);
	});

	it("polls while a retire's current operation is running, even though status stays 'retiring'", () => {
		expect(shouldPollLifecycle(response("retiring", [operation("running")]))).toBe(true);
	});

	it("stops polling once a retire's operation succeeds, even though status moves straight to 'retired'", () => {
		expect(shouldPollLifecycle(response("retired", [operation("succeeded")]))).toBe(false);
	});

	it("stops polling once a retire's operation fails permanently, status staying 'retiring'", () => {
		expect(shouldPollLifecycle(response("retiring", [operation("failed")]))).toBe(false);
	});

	it("polls while a reprovision is running, even though status stays 'ready'", () => {
		expect(
			shouldPollLifecycle(response("ready", [{ ...operation("running"), kind: "reprovision" }])),
		).toBe(true);
	});

	it("stops polling once a reprovision completes, status staying 'ready' throughout", () => {
		expect(
			shouldPollLifecycle(response("ready", [{ ...operation("succeeded"), kind: "reprovision" }])),
		).toBe(false);
	});

	it("does not poll with no data yet", () => {
		expect(shouldPollLifecycle(undefined)).toBe(false);
		expect(shouldPollLifecycle(null)).toBe(false);
	});

	it("does not poll when there is no operation history", () => {
		expect(shouldPollLifecycle(response("ready", []))).toBe(false);
	});
});
