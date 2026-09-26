import { randomUUID } from "node:crypto";
import type { AgentTurnInput, RuntimeSessionHandle } from "@agent-gateway/contracts";
import {
	ALL_NATIVE_TOOLS,
	type RuntimeAdapter,
	RuntimeError,
	type RuntimeTurnOutput,
	SessionUnavailableError,
	type TurnOptions,
} from "@agent-gateway/runtime-sdk";
import { invalidOutput, mockDirective, scenarioOutput } from "./scenarios.ts";

export const MOCK_RUNTIME_VERSION = "mock-runtime/1.0.0";

export type MockRuntimeOptions = Readonly<{ clock?: () => Date }>;

function usage(durationMs: number) {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
		costUsd: 0,
		durationMs,
		model: "mock",
	};
}

/** Never settles until aborted; the stand-in for a runtime that hangs. */
function hang(signal: AbortSignal): Promise<never> {
	return new Promise<never>((_, reject) => {
		const abort = () => reject(new RuntimeError("aborted", false));
		if (signal.aborted) {
			abort();
		} else {
			signal.addEventListener("abort", abort, { once: true });
		}
	});
}

/**
 * Deterministic runtime for tests and development. The scenario comes from a `[mock:...]`
 * directive in the triggering post; see `MOCK_SCENARIOS`. `flaky` fails the first call of a
 * run and succeeds afterwards, which exercises controller retries. Sessions live in memory,
 * so a restarted mock resumes none of them.
 */
export function createMockRuntime(options: MockRuntimeOptions = {}): RuntimeAdapter {
	const clock = options.clock ?? (() => new Date());
	const calls = new Map<string, number>();
	const sessions = new Set<string>();
	const newSession = (): RuntimeSessionHandle => {
		const providerSessionId = randomUUID();
		sessions.add(providerSessionId);
		return {
			adapter: "mock",
			providerSessionId,
			runtimeVersion: MOCK_RUNTIME_VERSION,
			expiresAt: null,
		};
	};

	const turn = async (
		input: AgentTurnInput,
		turnOptions: TurnOptions,
		repair: boolean,
	): Promise<RuntimeTurnOutput> => {
		const directive = mockDirective(input);
		const count = (calls.get(input.runId) ?? 0) + 1;
		calls.set(input.runId, count);
		const done = (modelOutput: RuntimeTurnOutput["modelOutput"]): RuntimeTurnOutput => ({
			modelOutput,
			usage: usage(1),
			session: turnOptions.persistSession ? newSession() : null,
		});
		switch (directive.scenario) {
			case "slow":
				return hang(turnOptions.signal);
			case "retryable":
				throw new RuntimeError("mock retryable failure", true);
			case "permanent":
				throw new RuntimeError("mock permanent failure", false);
			case "flaky":
				if (count === 1) {
					throw new RuntimeError("mock flaky failure", true);
				}
				return done(scenarioOutput(input, { scenario: "reply", arg: null }, clock()));
			case "invalid":
				return done(invalidOutput());
			case "invalid-once":
				return done(
					repair
						? scenarioOutput(input, { scenario: "reply", arg: null }, clock())
						: invalidOutput(),
				);
			default:
				return done(scenarioOutput(input, directive, clock()));
		}
	};

	return {
		id: "mock",
		capabilities: { sessionResume: true, confinedTools: ALL_NATIVE_TOOLS },
		probe: async () => ({
			ok: true,
			runtimeVersion: MOCK_RUNTIME_VERSION,
			detail: "in-process",
			risks: [],
		}),
		health: async () => ({ healthy: true, detail: "in-process" }),
		startTurn: (input, turnOptions) => turn(input, turnOptions, false),
		continueTurn: async (session, input, turnOptions) => {
			if (!sessions.has(session.providerSessionId)) {
				throw new SessionUnavailableError("unknown mock session");
			}
			return turn(input, turnOptions, false);
		},
		repairTurn: (input, _repair, turnOptions) => turn(input, turnOptions, true),
		cancel: async () => ({ cancelled: true, detail: "in-process" }),
		collectArtifacts: async () => [],
	};
}
