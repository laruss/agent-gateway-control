import { type AgentPermissionsPatch, ToolPatternSchema } from "@agent-gateway/contracts";
import type * as React from "react";
import { TagListInput } from "@/components/tag-list-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { AgentDetailTabProps } from "./types.ts";

function validateToolPattern(candidate: string): string | null {
	return ToolPatternSchema.safeParse(candidate).success
		? null
		: "must be a tool name like 'mail.read' or a prefix wildcard like 'finance.*'";
}

type ToolListField = "tools_allow" | "tools_require_human_approval" | "tools_deny";

export function PermissionsTab({
	original,
	draft,
	patchDraft,
}: AgentDetailTabProps): React.ReactElement {
	const permissions = { ...original.permissions, ...draft.permissions };

	function setListField(field: ToolListField, next: string[]) {
		const merged: AgentPermissionsPatch = { ...draft.permissions, [field]: next };
		for (const key of Object.keys(merged) as (keyof AgentPermissionsPatch)[]) {
			const currentValue = merged[key];
			const originalValue = original.permissions[key];
			const same =
				Array.isArray(currentValue) && Array.isArray(originalValue)
					? currentValue.length === originalValue.length &&
						currentValue.every((v, i) => v === originalValue[i])
					: currentValue === originalValue;
			if (same) {
				delete merged[key];
			}
		}
		patchDraft("permissions", Object.keys(merged).length === 0 ? undefined : merged);
	}

	function setObserveSystem(checked: boolean) {
		const merged: AgentPermissionsPatch = { ...draft.permissions, observe_system: checked };
		if (checked === (original.permissions.observe_system ?? false)) {
			delete merged.observe_system;
		}
		patchDraft("permissions", Object.keys(merged).length === 0 ? undefined : merged);
	}

	return (
		<div className="flex max-w-xl flex-col gap-6">
			<div className="grid gap-2">
				<Label>Tools allowed</Label>
				<TagListInput
					value={permissions.tools_allow}
					onChange={(next) => setListField("tools_allow", next)}
					placeholder="e.g. mattermost.post"
					validate={validateToolPattern}
				/>
			</div>
			<div className="grid gap-2">
				<Label>Tools requiring human approval</Label>
				<TagListInput
					value={permissions.tools_require_human_approval}
					onChange={(next) => setListField("tools_require_human_approval", next)}
					placeholder="e.g. finance.payment.create"
					validate={validateToolPattern}
				/>
			</div>
			<div className="grid gap-2">
				<Label>Tools denied</Label>
				<TagListInput
					value={permissions.tools_deny}
					onChange={(next) => setListField("tools_deny", next)}
					placeholder="e.g. deploy.*"
					validate={validateToolPattern}
				/>
			</div>
			<div className="flex items-center gap-3">
				<Switch
					id="observe-system"
					checked={permissions.observe_system ?? false}
					onCheckedChange={setObserveSystem}
				/>
				<Label htmlFor="observe-system">Observe system status</Label>
			</div>
		</div>
	);
}
