import type * as React from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AgentDetailTabProps } from "./types.ts";

const ROLE_PROMPT_MAX = 50_000;

/** The agent's base instructions: free text, monospace (it is read by a model, not rendered),
 * bounded at the same 50,000 characters `RolePromptSchema` enforces server-side. */
export function InstructionsTab({
	original,
	draft,
	patchDraft,
}: AgentDetailTabProps): React.ReactElement {
	const rolePrompt = draft.rolePrompt ?? original.rolePrompt;
	const overLimit = rolePrompt.length > ROLE_PROMPT_MAX;

	return (
		<div className="flex flex-col gap-2">
			<Label htmlFor="role-prompt">Role prompt</Label>
			<Textarea
				id="role-prompt"
				value={rolePrompt}
				rows={20}
				className="font-mono text-sm"
				aria-invalid={overLimit}
				onChange={(event) => {
					const next = event.target.value;
					patchDraft("rolePrompt", next === original.rolePrompt ? undefined : next);
				}}
			/>
			<p className={`text-xs ${overLimit ? "text-destructive" : "text-muted-foreground"}`}>
				{rolePrompt.length.toLocaleString()} / {ROLE_PROMPT_MAX.toLocaleString()} characters
			</p>
		</div>
	);
}
