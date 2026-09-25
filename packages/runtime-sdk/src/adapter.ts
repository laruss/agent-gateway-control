import type {
	AgentTurnInput,
	ArtifactDescriptor,
	JsonValue,
	RuntimeAdapterId,
	RuntimeSessionHandle,
	RuntimeUsage,
} from "@agent-gateway/contracts";

export type RuntimeProbeResult = Readonly<{
	ok: boolean;
	/** Exact version of the runtime binary or API, reported on every run. */
	runtimeVersion: string;
	detail: string;
}>;

export type RuntimeHealth = Readonly<{ healthy: boolean; detail: string }>;

export type CancelResult = Readonly<{ cancelled: boolean; detail: string }>;

/**
 * What a runtime produced. `modelOutput` is untrusted: the SDK validates it against
 * `AgentTurnModelOutput` and asks for one repair before giving up.
 */
export type RuntimeTurnOutput = Readonly<{
	modelOutput: JsonValue;
	usage: RuntimeUsage | null;
	session: RuntimeSessionHandle | null;
}>;

export type TurnOptions = Readonly<{
	/** Aborted on deadline, cancellation or kill-all; adapters stop their process on abort. */
	signal: AbortSignal;
}>;

/** Validation problems of the previous output, sent back once for a controlled repair. */
export type RepairRequest = Readonly<{
	issues: Readonly<string[]>;
	previousOutput: JsonValue;
}>;

/**
 * A runtime adapter. Every adapter must pass the shared contract suite
 * (`@agent-gateway/runtime-sdk/contract-suite`): mock task, wait result, invalid output,
 * timeout and cancel.
 */
export type RuntimeAdapter = Readonly<{
	id: RuntimeAdapterId;
	probe: () => Promise<RuntimeProbeResult>;
	health: () => Promise<RuntimeHealth>;
	startTurn: (input: AgentTurnInput, options: TurnOptions) => Promise<RuntimeTurnOutput>;
	continueTurn: (
		session: RuntimeSessionHandle,
		input: AgentTurnInput,
		options: TurnOptions,
	) => Promise<RuntimeTurnOutput>;
	repairTurn: (
		input: AgentTurnInput,
		repair: RepairRequest,
		options: TurnOptions,
	) => Promise<RuntimeTurnOutput>;
	cancel: (runId: string) => Promise<CancelResult>;
	collectArtifacts: (runId: string) => Promise<Readonly<ArtifactDescriptor[]>>;
}>;

/** A failure the adapter classified; anything else it throws counts as retryable. */
export class RuntimeError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
		this.name = "RuntimeError";
	}
}
