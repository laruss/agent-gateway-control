import type { WakeRule } from "@agent-gateway/contracts";
import { Plus, X } from "lucide-react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { WAKEABLE_EVENT_TYPES } from "@/lib/wake-rule-event-types";
import type { AgentDetailTabProps } from "./types.ts";

function ChannelsEditor({
	original,
	draft,
	patchDraft,
	knownChannels,
}: AgentDetailTabProps): React.ReactElement {
	const channels = draft.allowedChannels ?? original.mattermost.allowedChannels;

	function toggle(channel: string, allowed: boolean) {
		const next = allowed ? [...channels, channel] : channels.filter((c) => c !== channel);
		const unchanged =
			next.length === original.mattermost.allowedChannels.length &&
			next.every((c) => original.mattermost.allowedChannels.includes(c));
		patchDraft("allowedChannels", unchanged ? undefined : next);
	}

	return (
		<div className="flex flex-col gap-2">
			<h3 className="text-sm font-medium">Allowed Mattermost channels</h3>
			<div className="grid max-w-md gap-2">
				{knownChannels.map((channel) => (
					<div key={channel} className="flex items-center gap-3">
						<Switch
							id={`channel-${channel}`}
							checked={channels.includes(channel)}
							onCheckedChange={(checked) => toggle(channel, checked)}
						/>
						<Label htmlFor={`channel-${channel}`} className="font-mono">
							{channel}
						</Label>
					</div>
				))}
				{knownChannels.length === 0 && (
					<p className="text-sm text-muted-foreground">
						No channels are configured for the organization.
					</p>
				)}
			</div>
		</div>
	);
}

function WakeRulesEditor({
	original,
	draft,
	patchDraft,
	knownAgentIds,
}: AgentDetailTabProps): React.ReactElement {
	const rules = draft.wakeRules ?? original.wakeRules;

	function setRules(next: Readonly<WakeRule[]>) {
		const unchanged =
			next.length === original.wakeRules.length &&
			next.every(
				(rule, index) =>
					rule.event_type === original.wakeRules[index]?.event_type &&
					rule.target_agent_id === original.wakeRules[index]?.target_agent_id,
			);
		patchDraft("wakeRules", unchanged ? undefined : [...next]);
	}

	function updateRule(index: number, next: WakeRule) {
		setRules(rules.map((rule, i) => (i === index ? next : rule)));
	}

	function removeRule(index: number) {
		setRules(rules.filter((_, i) => i !== index));
	}

	function addRule() {
		const eventType = WAKEABLE_EVENT_TYPES[0];
		if (eventType === undefined) {
			return;
		}
		setRules([
			...rules,
			{
				event_type: eventType as WakeRule["event_type"],
				...(eventType.startsWith("mattermost.") ? { target_agent_id: original.id } : {}),
			},
		]);
	}

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between">
				<h3 className="text-sm font-medium">Wake rules</h3>
				<Button type="button" variant="outline" size="sm" onClick={addRule}>
					<Plus /> Add rule
				</Button>
			</div>
			<div className="flex flex-col gap-2">
				{rules.map((rule, index) => (
					// Rules are an ordered list the agent itself does not reorder by content; the index
					// is a stable enough key for this bounded (max 32), purely client-side editor list.
					// biome-ignore lint/suspicious/noArrayIndexKey: see above
					<div key={index} className="flex items-center gap-2 rounded-lg border border-input p-2">
						<Select
							value={rule.event_type}
							onValueChange={(value) =>
								updateRule(index, { ...rule, event_type: value as WakeRule["event_type"] })
							}
						>
							<SelectTrigger className="w-64">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{WAKEABLE_EVENT_TYPES.map((eventType) => (
									<SelectItem key={eventType} value={eventType}>
										{eventType}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Select
							value={rule.target_agent_id ?? "__none__"}
							onValueChange={(value) =>
								updateRule(index, {
									...rule,
									...(value === "__none__" ? {} : { target_agent_id: value }),
								})
							}
						>
							<SelectTrigger className="w-48">
								<SelectValue placeholder="any target" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="__none__">(no specific target)</SelectItem>
								{knownAgentIds.map((id) => (
									<SelectItem key={id} value={id}>
										{id}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							aria-label="remove rule"
							onClick={() => removeRule(index)}
						>
							<X />
						</Button>
					</div>
				))}
				{rules.length === 0 && <p className="text-sm text-muted-foreground">No wake rules.</p>}
			</div>
		</div>
	);
}

export function AssignmentsTab(props: AgentDetailTabProps): React.ReactElement {
	return (
		<div className="flex flex-col gap-8">
			<ChannelsEditor {...props} />
			<WakeRulesEditor {...props} />
		</div>
	);
}
