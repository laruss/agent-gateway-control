import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentTurnResultSchema,
	type JsonObject,
	type RunReport,
	RunReportSchema,
	type RunRuntime,
	reportQueue,
} from "@agent-gateway/contracts";
import { silentLogger } from "@agent-gateway/logging";
import { createMockRuntime, MOCK_RUNTIME_VERSION } from "@agent-gateway/runtime-mock";
import { contractTurnInput, type RuntimeAdapter } from "@agent-gateway/runtime-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processRunJob } from "./run-job.ts";

let root = "";
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "worker-run-job-"));
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

function recordingHost(adapter: RuntimeAdapter = createMockRuntime()) {
	const reports: RunReport[] = [];
	return {
		reports,
		host: {
			adapter,
			runtimeVersion: MOCK_RUNTIME_VERSION,
			workspaceRoot: root,
			log: silentLogger,
			reports: {
				send: async (queue: string, data: JsonObject) => {
					expect(queue).toBe(reportQueue("mock"));
					reports.push(RunReportSchema.parse(data));
					return "job";
				},
			},
		},
	};
}

const STATELESS: RunRuntime = { model: null, sessionPolicy: "stateless", session: null };

const job = (message: string, runtime: RunRuntime = STATELESS) => {
	const runId = randomUUID();
	return {
		runId,
		attempt: 1,
		timeoutSeconds: 10,
		runtime,
		input: contractTurnInput({ runId, message, deadlineMs: 10_000 }),
	};
};

const signal = () => new AbortController().signal;

describe("worker run job", () => {
	it("reports started, then the validated result", async () => {
		const { reports, host } = recordingHost();
		const data = job("@developer hi");
		const outcome = await processRunJob(host, data, signal());
		expect(outcome).toBe("completed");
		expect(reports.map((r) => r.kind)).toEqual(["started", "completed"]);
		expect(reports.every((r) => r.runId === data.runId && r.agentId === "developer")).toBe(true);
	});

	it("removes the run workspace after the run", async () => {
		const { host } = recordingHost();
		await processRunJob(host, job("@developer hi"), signal());
		await processRunJob(host, job("@developer [mock:permanent]"), signal());
		expect(await readdir(join(root, "developer"))).toEqual([]);
	});

	it("repairs invalid output once", async () => {
		const { reports, host } = recordingHost();
		const outcome = await processRunJob(host, job("@developer [mock:invalid-once]"), signal());
		expect(outcome).toBe("completed");
		expect(reports.at(-1)?.kind).toBe("completed");
	});

	it("reports classified runtime errors", async () => {
		for (const [directive, code, retryable] of [
			["retryable", "runtime_retryable", true],
			["permanent", "runtime_permanent", false],
		] as const) {
			const { reports, host } = recordingHost();
			await processRunJob(host, job(`@developer [mock:${directive}]`), signal());
			const last = reports.at(-1);
			expect(last?.kind === "failed" ? [last.error.code, last.error.retryable] : null).toEqual([
				code,
				retryable,
			]);
		}
	});

	it("keeps and resumes sessions only under resumable-if-available", async () => {
		const mock = createMockRuntime();
		const resumed: string[] = [];
		const adapter: RuntimeAdapter = {
			...mock,
			continueTurn: (session, input, options) => {
				resumed.push(session.providerSessionId);
				return mock.continueTurn(session, input, options);
			},
		};
		const { reports, host } = recordingHost(adapter);
		await processRunJob(host, job("@developer hi"), signal());
		const stateless = reports.at(-1);
		expect(stateless?.kind === "completed" ? stateless.result : null).toMatchObject({
			session: null,
		});

		const resumable: RunRuntime = {
			model: null,
			sessionPolicy: "resumable-if-available",
			session: null,
		};
		await processRunJob(host, job("@developer hi", resumable), signal());
		const first = reports.at(-1);
		const parsed = first?.kind === "completed" ? AgentTurnResultSchema.parse(first.result) : null;
		const session = parsed?.session ?? null;
		expect(session?.adapter).toBe("mock");

		// Offered under the stateless policy, the session is ignored.
		await processRunJob(host, job("@developer hi", { ...STATELESS, session }), signal());
		expect(resumed).toEqual([]);
		await processRunJob(host, job("@developer hi", { ...resumable, session }), signal());
		expect(resumed).toEqual([session?.providerSessionId]);
	});

	it("starts fresh when the offered session is unknown or from another version", async () => {
		const { reports, host } = recordingHost();
		for (const runtimeVersion of [MOCK_RUNTIME_VERSION, "mock-runtime/0.0.1"]) {
			const outcome = await processRunJob(
				host,
				job("@developer hi", {
					model: null,
					sessionPolicy: "resumable-if-available",
					session: {
						adapter: "mock",
						providerSessionId: randomUUID(),
						runtimeVersion,
						expiresAt: null,
					},
				}),
				signal(),
			);
			expect(outcome).toBe("completed");
		}
		expect(reports.filter((r) => r.kind === "completed")).toHaveLength(2);
	});

	it("rejects a malformed job without reporting", async () => {
		const { reports, host } = recordingHost();
		await expect(processRunJob(host, { runId: "x" }, signal())).rejects.toThrow(
			"invalid run job payload",
		);
		expect(reports).toEqual([]);
	});
});
