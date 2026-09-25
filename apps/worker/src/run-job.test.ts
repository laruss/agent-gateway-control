import { randomUUID } from "node:crypto";
import {
	type JsonObject,
	type RunReport,
	RunReportSchema,
	reportQueue,
} from "@agent-gateway/contracts";
import { silentLogger } from "@agent-gateway/logging";
import { createMockRuntime, MOCK_RUNTIME_VERSION } from "@agent-gateway/runtime-mock";
import { contractTurnInput } from "@agent-gateway/runtime-sdk";
import { describe, expect, it } from "vitest";
import { processRunJob } from "./run-job.ts";

function recordingSink() {
	const reports: RunReport[] = [];
	return {
		reports,
		sink: {
			send: async (queue: string, data: JsonObject) => {
				expect(queue).toBe(reportQueue("mock"));
				reports.push(RunReportSchema.parse(data));
				return "job";
			},
		},
	};
}

const job = (message: string) => {
	const runId = randomUUID();
	return {
		runId,
		attempt: 1,
		timeoutSeconds: 10,
		input: contractTurnInput({ runId, message, deadlineMs: 10_000 }),
	};
};

describe("worker run job", () => {
	it("reports started, then the validated result", async () => {
		const { reports, sink } = recordingSink();
		const data = job("@developer hi");
		const outcome = await processRunJob(
			createMockRuntime(),
			MOCK_RUNTIME_VERSION,
			data,
			sink,
			new AbortController().signal,
			silentLogger,
		);
		expect(outcome).toBe("completed");
		expect(reports.map((r) => r.kind)).toEqual(["started", "completed"]);
		expect(reports.every((r) => r.runId === data.runId && r.agentId === "developer")).toBe(true);
	});

	it("repairs invalid output once", async () => {
		const { reports, sink } = recordingSink();
		const outcome = await processRunJob(
			createMockRuntime(),
			MOCK_RUNTIME_VERSION,
			job("@developer [mock:invalid-once]"),
			sink,
			new AbortController().signal,
			silentLogger,
		);
		expect(outcome).toBe("completed");
		expect(reports.at(-1)?.kind).toBe("completed");
	});

	it("reports classified runtime errors", async () => {
		for (const [directive, code, retryable] of [
			["retryable", "runtime_retryable", true],
			["permanent", "runtime_permanent", false],
		] as const) {
			const { reports, sink } = recordingSink();
			await processRunJob(
				createMockRuntime(),
				MOCK_RUNTIME_VERSION,
				job(`@developer [mock:${directive}]`),
				sink,
				new AbortController().signal,
				silentLogger,
			);
			const last = reports.at(-1);
			expect(last?.kind === "failed" ? [last.error.code, last.error.retryable] : null).toEqual([
				code,
				retryable,
			]);
		}
	});

	it("rejects a malformed job without reporting", async () => {
		const { reports, sink } = recordingSink();
		await expect(
			processRunJob(
				createMockRuntime(),
				MOCK_RUNTIME_VERSION,
				{ runId: "x" },
				sink,
				new AbortController().signal,
				silentLogger,
			),
		).rejects.toThrow("invalid run job payload");
		expect(reports).toEqual([]);
	});
});
