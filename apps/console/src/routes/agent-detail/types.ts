import type { AgentPatch, ConsoleAgentDetail } from "@agent-gateway/contracts";

/** What every tab needs: the agent's last-loaded configuration, the draft accumulated so far,
 * and a way to change one top-level field of it (`undefined` clears the field — the draft only
 * ever names fields that actually differ from `original`). */
export type AgentDetailTabProps = Readonly<{
	original: ConsoleAgentDetail;
	draft: AgentPatch;
	patchDraft: <K extends keyof AgentPatch>(key: K, value: AgentPatch[K] | undefined) => void;
	knownChannels: Readonly<string[]>;
	knownRuntimeAdapters: Readonly<string[]>;
	knownAgentIds: Readonly<string[]>;
}>;
