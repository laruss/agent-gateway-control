import type { AgentRuntimePatch, RuntimeAdapterId, SessionPolicy } from "@agent-gateway/contracts";
import type * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type { AgentDetailTabProps } from "./types.ts";

const SESSION_POLICIES: Readonly<SessionPolicy[]> = ["stateless", "resumable-if-available"];

export function RuntimeTab({
	original,
	draft,
	patchDraft,
	knownRuntimeAdapters,
}: AgentDetailTabProps): React.ReactElement {
	const runtime = { ...original.runtime, ...draft.runtime };

	function setRuntimeField<K extends keyof AgentRuntimePatch>(key: K, value: AgentRuntimePatch[K]) {
		const next: AgentRuntimePatch = { ...draft.runtime, [key]: value };
		for (const field of Object.keys(next) as (keyof AgentRuntimePatch)[]) {
			const draftValue = next[field];
			const originalValue = original.runtime[field];
			// `model: null` ("clear the override") reads as unchanged exactly when the agent had no
			// override to begin with (`original.runtime.model === undefined`) — the patch contract's
			// only field with a distinct "remove" representation (`console-management.ts`).
			const unchanged =
				draftValue === originalValue ||
				(field === "model" && draftValue === null && originalValue === undefined);
			if (unchanged) {
				delete next[field];
			}
		}
		patchDraft("runtime", Object.keys(next).length === 0 ? undefined : next);
	}

	return (
		<div className="grid max-w-md gap-6">
			<div className="grid gap-2">
				<Label htmlFor="runtime-adapter">Adapter</Label>
				<Select
					value={runtime.adapter}
					onValueChange={(value) => setRuntimeField("adapter", value as RuntimeAdapterId)}
				>
					<SelectTrigger id="runtime-adapter" className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{knownRuntimeAdapters.map((adapter) => (
							<SelectItem key={adapter} value={adapter}>
								{adapter}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<div className="grid gap-2">
				<Label htmlFor="runtime-model">Model</Label>
				<Input
					id="runtime-model"
					value={runtime.model ?? ""}
					placeholder="(provider default)"
					onChange={(event) => {
						const value = event.target.value;
						// `null`, never `undefined`: `undefined` is dropped by `JSON.stringify` (nothing
						// is sent at all), which the server can only read as "this field is unchanged" —
						// `null` is this patch's own explicit "remove the override" value.
						setRuntimeField("model", value === "" ? null : value);
					}}
				/>
			</div>
			<div className="grid gap-2">
				<Label htmlFor="session-policy">Session policy</Label>
				<Select
					value={runtime.session_policy}
					onValueChange={(value) => setRuntimeField("session_policy", value as SessionPolicy)}
				>
					<SelectTrigger id="session-policy" className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{SESSION_POLICIES.map((policy) => (
							<SelectItem key={policy} value={policy}>
								{policy}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<div className="grid gap-2">
				<Label htmlFor="timeout">Timeout (seconds)</Label>
				<Input
					id="timeout"
					type="number"
					min={10}
					max={86_400}
					value={runtime.timeout_seconds}
					onChange={(event) => {
						const next = Number(event.target.value);
						if (Number.isFinite(next)) {
							setRuntimeField("timeout_seconds", next);
						}
					}}
				/>
			</div>
		</div>
	);
}
