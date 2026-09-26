import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTurnInput, RuntimeSessionHandle } from "@agent-gateway/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeAdapter } from "./adapter.ts";
import { createRunWorkspace, removeRunWorkspace } from "./environment.ts";
import { type ExecuteOptions, executeTurn, type TurnExecution } from "./execute.ts";
import { INVALID_OUTPUT_MARKER } from "./fake-cli.ts";
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

type RunOptions = Partial<Pick<ExecuteOptions, "session" | "signal" | "clock" | "persistSession">>;

/**
 * The shared runtime adapter contract: every adapter must pass it unchanged. It runs through
 * `executeTurn`, the same path the worker uses, each turn in its own run workspace.
 */
export function defineRuntimeContractSuite(options: ContractSuiteOptions): void {
	const deadlineMs = options.turnDeadlineMs ?? 30_000;
	const input = (message: string, ms = deadlineMs) =>
		contractTurnInput({ runId: randomUUID(), message, deadlineMs: ms });
	let root = "";

	const run = async (
		adapter: RuntimeAdapter,
		turn: AgentTurnInput,
		runOptions: RunOptions = {},
	): Promise<TurnExecution> => {
		const workspacePath = await createRunWorkspace(root, turn.agent.agentId, turn.runId);
		try {
			return await executeTurn(adapter, turn, {
				session: null,
				model: null,
				persistSession: false,
				...runOptions,
				workspacePath,
			});
		} finally {
			await removeRunWorkspace(workspacePath);
		}
	};

	describe(`runtime contract: ${options.name}`, () => {
		beforeAll(async () => {
			root = await mkdtemp(join(tmpdir(), "runtime-contract-"));
		});
		afterAll(async () => {
			await rm(root, { recursive: true, force: true });
		});

		it("probes with an exact runtime version", async () => {
			const probe = await options.createAdapter().probe();
			expect(probe.ok).toBe(true);
			expect(probe.runtimeVersion).not.toBe("");
		});

		it("completes a task with a valid result for the same run", async () => {
			const turn = input(options.prompts.reply);
			const execution = await run(options.createAdapter(), turn);
			expect(execution.kind).toBe("completed");
			if (execution.kind === "completed") {
				expect(execution.result.runId).toBe(turn.runId);
				expect(execution.result.nextState.kind).toBe("idle");
				expect(execution.result.publicMessages.length).toBeGreaterThan(0);
				expect(execution.result.publicMessages[0]?.channelId).toBe(turn.channels[0]?.channelId);
				expect(execution.result.session).toBeNull();
			}
		});

		it("returns a structured wait instead of waiting", async () => {
			const turn = input(options.prompts.wait);
			const execution = await run(options.createAdapter(), turn);
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
			const execution = await run(options.createAdapter(), input(options.prompts.invalid));
			expect(execution.kind).toBe("failed");
			if (execution.kind === "failed") {
				expect(execution.error.code).toBe("invalid_output");
				expect(execution.error.retryable).toBe(false);
				expect(execution.error.detail).not.toContain(INVALID_OUTPUT_MARKER);
			}
		});

		it("times out at the deadline", async () => {
			const started = Date.now();
			const execution = await run(options.createAdapter(), input(options.prompts.slow, 300));
			expect(execution.kind).toBe("failed");
			if (execution.kind === "failed") {
				expect(execution.error.code).toBe("timeout");
				expect(execution.error.retryable).toBe(true);
			}
			expect(Date.now() - started).toBeLessThan(10_000);
		});

		it("treats a deadline that passed before the start as retryable", async () => {
			const execution = await run(options.createAdapter(), input(options.prompts.reply, 1), {
				clock: () => new Date(Date.now() + 60_000),
			});
			expect(
				execution.kind === "failed" ? [execution.error.code, execution.error.retryable] : null,
			).toEqual(["timeout", true]);
		});

		it("stops on cancellation", async () => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 100);
			const execution = await run(options.createAdapter(), input(options.prompts.slow), {
				signal: controller.signal,
			});
			expect(execution.kind).toBe("failed");
			if (execution.kind === "failed") {
				expect(execution.error.code).toBe("cancelled");
				expect(execution.error.retryable).toBe(false);
			}
		});

		it("starts fresh when the session cannot be resumed", async () => {
			const adapter = options.createAdapter();
			const probe = await adapter.probe();
			const session: RuntimeSessionHandle = {
				adapter: adapter.id,
				providerSessionId: randomUUID(),
				runtimeVersion: probe.runtimeVersion,
				expiresAt: null,
			};
			const execution = await run(adapter, input(options.prompts.reply), { session });
			expect(execution.kind).toBe("completed");
			expect(execution.resume).toBe(
				adapter.capabilities.sessionResume ? "unavailable" : "not_requested",
			);
		});

		it("resumes a session it returned, when it supports sessions", async () => {
			const adapter = options.createAdapter();
			const first = await run(adapter, input(options.prompts.reply), { persistSession: true });
			expect(first.kind).toBe("completed");
			if (first.kind !== "completed") {
				return;
			}
			if (!adapter.capabilities.sessionResume) {
				expect(first.result.session).toBeNull();
				return;
			}
			const session = first.result.session;
			expect(session?.adapter).toBe(adapter.id);
			const second = await run(adapter, input(options.prompts.reply), {
				session,
				persistSession: true,
			});
			expect([second.kind, second.resume]).toEqual(["completed", "resumed"]);
		});
	});
}
