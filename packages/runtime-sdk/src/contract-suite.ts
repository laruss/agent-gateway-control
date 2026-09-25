import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RuntimeAdapter } from "./adapter.ts";
import { executeTurn } from "./execute.ts";
import { contractTurnInput } from "./testing.ts";

export type ContractSuiteOptions = Readonly<{
	name: string;
	createAdapter: () => RuntimeAdapter;
	/** Scenario instructions, written as the triggering post. */
	prompts: Readonly<{
		/** Reply in the channel and finish idle. */
		reply: string;
		/** Ask @finance and wait for its reply in this thread. */
		wait: string;
		/** Produce output that fails the schema, also on repair. */
		invalid: string;
		/** Take longer than any test deadline. */
		slow: string;
	}>;
	/** Deadline for the scenarios that should finish. */
	turnDeadlineMs?: number;
}>;

/**
 * The shared runtime adapter contract: every adapter must pass it unchanged. It runs through
 * `executeTurn`, the same path the worker uses.
 */
export function defineRuntimeContractSuite(options: ContractSuiteOptions): void {
	const deadlineMs = options.turnDeadlineMs ?? 30_000;
	const input = (message: string, ms = deadlineMs) =>
		contractTurnInput({ runId: randomUUID(), message, deadlineMs: ms });

	describe(`runtime contract: ${options.name}`, () => {
		it("probes with an exact runtime version", async () => {
			const probe = await options.createAdapter().probe();
			expect(probe.ok).toBe(true);
			expect(probe.runtimeVersion).not.toBe("");
		});

		it("completes a task with a valid result for the same run", async () => {
			const turn = input(options.prompts.reply);
			const execution = await executeTurn(options.createAdapter(), turn, { session: null });
			expect(execution.kind).toBe("completed");
			if (execution.kind === "completed") {
				expect(execution.result.runId).toBe(turn.runId);
				expect(execution.result.nextState.kind).toBe("idle");
				expect(execution.result.publicMessages.length).toBeGreaterThan(0);
				expect(execution.result.publicMessages[0]?.channelId).toBe(turn.channels[0]?.channelId);
			}
		});

		it("returns a structured wait instead of waiting", async () => {
			const turn = input(options.prompts.wait);
			const execution = await executeTurn(options.createAdapter(), turn, { session: null });
			expect(execution.kind).toBe("completed");
			if (execution.kind === "completed" && execution.result.nextState.kind === "waiting") {
				const [wait] = execution.result.nextState.waits;
				expect(wait?.correlationId).toBe(turn.trigger.correlationid);
				expect(wait?.expectedSenderAgentIds).toContain("finance");
			} else {
				expect.fail("expected a waiting result");
			}
		});

		it("fails invalid output after one repair, without leaking it", async () => {
			const execution = await executeTurn(options.createAdapter(), input(options.prompts.invalid), {
				session: null,
			});
			expect(execution.kind).toBe("failed");
			if (execution.kind === "failed") {
				expect(execution.error.code).toBe("invalid_output");
				expect(execution.error.retryable).toBe(false);
			}
		});

		it("times out at the deadline", async () => {
			const started = Date.now();
			const execution = await executeTurn(
				options.createAdapter(),
				input(options.prompts.slow, 300),
				{
					session: null,
				},
			);
			expect(execution.kind).toBe("failed");
			if (execution.kind === "failed") {
				expect(execution.error.code).toBe("timeout");
				expect(execution.error.retryable).toBe(true);
			}
			expect(Date.now() - started).toBeLessThan(5_000);
		});

		it("treats a deadline that passed before the start as retryable", async () => {
			const execution = await executeTurn(
				options.createAdapter(),
				input(options.prompts.reply, 1),
				{
					session: null,
					clock: () => new Date(Date.now() + 60_000),
				},
			);
			expect(
				execution.kind === "failed" ? [execution.error.code, execution.error.retryable] : null,
			).toEqual(["timeout", true]);
		});

		it("stops on cancellation", async () => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 100);
			const execution = await executeTurn(options.createAdapter(), input(options.prompts.slow), {
				session: null,
				signal: controller.signal,
			});
			expect(execution.kind).toBe("failed");
			if (execution.kind === "failed") {
				expect(execution.error.code).toBe("cancelled");
				expect(execution.error.retryable).toBe(false);
			}
		});
	});
}
