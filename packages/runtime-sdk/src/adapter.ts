import type {
	AgentTurnInput,
	ArtifactDescriptor,
	JsonValue,
	RuntimeAdapterId,
	RuntimeSessionHandle,
	RuntimeUsage,
} from "@agent-gateway/contracts";

export type RuntimeProbeResult = Readonly<{
	/** Installed, authenticated and able to take turns. */
	ok: boolean;
	/** Exact version of the runtime binary or API, reported on every run. */
	runtimeVersion: string;
	detail: string;
	/** Weaknesses of this installation an operator should know about; never secrets. */
	risks: Readonly<string[]>;
}>;

export type RuntimeHealth = Readonly<{ healthy: boolean; detail: string }>;

export type CancelResult = Readonly<{ cancelled: boolean; detail: string }>;

/** What an adapter can do beyond the required contract. */
export type RuntimeCapabilities = Readonly<{
	/** `continueTurn` can resume a provider session returned by an earlier turn. */
	sessionResume: boolean;
}>;

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
	/**
	 * The run's own working directory, created by the worker before the turn and removed after
	 * it. The runtime reads and writes nowhere else.
	 */
	workspacePath: string;
	/** Provider model id; null lets the runtime choose its default. */
	model: string | null;
	/** Keep the provider session so a later run can resume it; otherwise leave nothing behind. */
	persistSession: boolean;
}>;

/** Validation problems of the previous output, sent back once for a controlled repair. */
export type RepairRequest = Readonly<{
	issues: Readonly<string[]>;
	previousOutput: JsonValue;
}>;

/**
 * A runtime adapter. Every adapter must pass the shared contract suite
 * (`@agent-gateway/runtime-sdk/contract-suite`): mock task, wait result, invalid output,
 * timeout, cancel and session fallback.
 */
export type RuntimeAdapter = Readonly<{
	id: RuntimeAdapterId;
	capabilities: RuntimeCapabilities;
	probe: () => Promise<RuntimeProbeResult>;
	health: () => Promise<RuntimeHealth>;
	startTurn: (input: AgentTurnInput, options: TurnOptions) => Promise<RuntimeTurnOutput>;
	/** Throws `SessionUnavailableError` when the session cannot be resumed. */
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
	/** Stops the run's processes and resolves once they are gone. */
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

/** The provider no longer knows the session (expired, deleted, other host); start afresh. */
export class SessionUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionUnavailableError";
	}
}

/**
 * The session to offer a turn: only one this adapter issued, from the same runtime version,
 * not expired. Anything else starts fresh, since resuming it would fail or mix incompatible
 * histories.
 */
export function resumableSession(
	session: RuntimeSessionHandle | null,
	adapterId: RuntimeAdapterId,
	runtimeVersion: string,
	now: Date,
): RuntimeSessionHandle | null {
	if (session === null || session.adapter !== adapterId) {
		return null;
	}
	if (session.runtimeVersion !== runtimeVersion) {
		return null;
	}
	if (session.expiresAt !== null && Date.parse(session.expiresAt) <= now.getTime()) {
		return null;
	}
	return session;
}
