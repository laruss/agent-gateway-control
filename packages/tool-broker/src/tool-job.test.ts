import type { ToolActionJob, ToolReport } from "@agent-gateway/contracts";
import { silentLogger } from "@agent-gateway/logging";
import { approvalActionHash } from "@agent-gateway/policy";
import { describe, expect, it } from "vitest";
import { executorRegistry, type ToolExecutor } from "./executor.ts";
import {
	blockingExecutor,
	failingExecutor,
	recordingExecutor,
	throwingExecutor,
} from "./testing.ts";
import { processToolJob } from "./tool-job.ts";

const params = [
	{ name: "amount", value: "120.00" },
	{ name: "currency", value: "EUR" },
	{ name: "recipient", value: "DE89370400440532013000" },
	{ name: "purpose", value: "Domain renewal" },
	{ name: "recurring", value: "false" },
];
const action = { actionType: "finance.payment.create", actionParams: params };

function job(overrides: Partial<ToolActionJob> = {}): ToolActionJob {
	return {
		actionId: "0b6f0b7e-8a36-4a45-9d9c-2ad1f1c0a001",
		approvalId: "0b6f0b7e-8a36-4a45-9d9c-2ad1f1c0a002",
		attempt: 1,
		agentId: "finance",
		...action,
		immutableActionHash: approvalActionHash(action),
		deadline: "2026-09-27T12:00:00.000Z",
		...overrides,
	};
}

const STORED_KEY = "tool-action:stored-key";

function harness(
	executors: Readonly<ToolExecutor[]>,
	verdict = "begin",
	stopRequested: () => boolean = () => false,
) {
	const reports: ToolReport[] = [];
	const begun: string[] = [];
	return {
		reports,
		begun,
		run: (data: object) =>
			processToolJob(
				{
					namespace: "finance",
					executors: executorRegistry(executors),
					begin: async (id, _attempt, hash) => {
						begun.push(`${id}:${hash}`);
						return verdict === "begin"
							? { verdict: "begin", idempotencyKey: STORED_KEY }
							: { verdict, idempotencyKey: null };
					},
					stopRequested: async () => stopRequested(),
					report: async (report) => {
						reports.push(report);
					},
					log: silentLogger,
					stopPollMs: 10,
				},
				data,
				new AbortController().signal,
			),
	};
}

describe("processToolJob", () => {
	it("runs an approved action once begin agrees, with the stored idempotency key", async () => {
		const payments = recordingExecutor("finance.payment.create");
		const h = harness([payments]);
		expect(await h.run(job())).toBe("succeeded");
		expect(h.begun).toEqual([`${job().actionId}:${approvalActionHash(action)}`]);
		expect(payments.effects()).toEqual([
			{
				idempotencyKey: STORED_KEY,
				params: Object.fromEntries(params.map((p) => [p.name, p.value])),
			},
		]);
		expect(h.reports).toEqual([
			expect.objectContaining({ kind: "succeeded", receipt: { provider_id: "sandbox-1" } }),
		]);
	});

	it("refuses a job whose amount changed after approval, before begin", async () => {
		const payments = recordingExecutor("finance.payment.create");
		const h = harness([payments]);
		const changed = params.map((p) => (p.name === "amount" ? { ...p, value: "9120.00" } : p));
		expect(await h.run(job({ actionParams: changed }))).toBe("refused");
		expect(h.begun).toEqual([]);
		expect(payments.calls()).toEqual([]);
		expect(h.reports[0]).toMatchObject({ reason: "the action does not match its approval hash" });
	});

	it("runs nothing when begin refuses (kill switch, cancelled, not granted)", async () => {
		const payments = recordingExecutor("finance.payment.create");
		const h = harness([payments], "kill_switch");
		expect(await h.run(job())).toBe("refused");
		expect(payments.calls()).toEqual([]);
		expect(h.reports[0]).toMatchObject({ kind: "refused", reason: "not begun: kill_switch" });
	});

	it("refuses another namespace's action and parameters outside the typed set", async () => {
		const h = harness([recordingExecutor("finance.payment.create")]);
		const mail = { actionType: "mail.send", actionParams: [{ name: "to", value: "x@y.z" }] };
		expect(await h.run(job({ ...mail, immutableActionHash: approvalActionHash(mail) }))).toBe(
			"refused",
		);
		const recurring = params.map((p) => (p.name === "recurring" ? { ...p, value: "true" } : p));
		const changed = { actionType: "finance.payment.create", actionParams: recurring };
		expect(await h.run(job({ ...changed, immutableActionHash: approvalActionHash(changed) }))).toBe(
			"refused",
		);
		expect(h.begun).toEqual([]);
	});

	it("fails as known without an executor, only once begin vouched for the job", async () => {
		const h = harness([]);
		expect(await h.run(job())).toBe("failed");
		expect(h.begun).toHaveLength(1);
		// A job that begin refuses (another action under this action's id) fails nothing.
		const refusing = harness([], "hash_mismatch");
		expect(await refusing.run(job())).toBe("refused");
	});

	it("reports a provider's refusal as failed and a crash as unknown", async () => {
		const refused = harness([failingExecutor("finance.payment.create", "insufficient funds")]);
		expect(await refused.run(job())).toBe("failed");
		expect(refused.reports[0]).toMatchObject({ error: "insufficient funds" });
		const crashed = harness([throwingExecutor("finance.payment.create")]);
		expect(await crashed.run(job())).toBe("unknown");
		expect(crashed.reports[0]).toMatchObject({ kind: "unknown" });
	});

	it("rejects a malformed job without reporting, a job's own idempotency key included", async () => {
		const h = harness([]);
		expect(await h.run({ ...job(), attempt: 0 })).toBe("invalid_job");
		expect(await h.run({ ...job(), idempotencyKey: "tool-action:forged" })).toBe("invalid_job");
		expect(h.reports).toEqual([]);
	});

	it("aborts a running executor when a stop is requested", async () => {
		let stop = false;
		const h = harness([blockingExecutor("finance.payment.create")], "begin", () => stop);
		const running = h.run(job());
		await Bun.sleep(50);
		stop = true;
		expect(await running).toBe("failed");
		expect(h.reports[0]).toMatchObject({ error: "aborted before anything was sent" });
	});
});
