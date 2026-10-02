import type { WakeRule } from "@agent-gateway/contracts";
import { Plus, X } from "lucide-react";
import * as React from "react";
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

/** A wake rule paired with a client-only id, stable across edits of the list it belongs to —
 * `crypto.randomUUID()`, never the array index (`WakeRulesEditor` below), since the rule itself
 * carries nothing unique enough to key a React list on (two rules can share the same event type
 * and target). This is local state `WakeRulesEditor` owns directly (every mutation updates it in
 * the same call that notifies `patchDraft`), not something re-derived from `draft.wakeRules` on
 * every render: re-deriving it there would hand every rule a fresh id on every edit, exactly the
 * instability stable keys exist to avoid. A reload that changes the underlying agent out from
 * under this tab (`agent-detail-page.tsx`'s "Reload and try again" path) remounts it instead,
 * keyed by the agent's own `activeRevisionId`. */
type KeyedWakeRule = Readonly<{ key: string; rule: WakeRule }>;

function keyRules(rules: Readonly<WakeRule[]>): KeyedWakeRule[] {
	return rules.map((rule) => ({ key: crypto.randomUUID(), rule }));
}

/** The sentinel the target-agent `Select` below uses for "no specific target" (a `WakeRule` has
 * no empty-string representation of its own `target_agent_id`, which is `string | undefined`). */
export const NO_SPECIFIC_TARGET = "__none__";

/** `rule` with its target set to `value`, or with `target_agent_id` removed entirely when `value`
 * is {@link NO_SPECIFIC_TARGET} — built fresh from `event_type` alone, never `{...rule, ...}`,
 * which would carry the old `target_agent_id` through untouched (there is no field to overwrite
 * it with: `undefined` is dropped by JSON the same way it is everywhere else in this patch
 * contract, so only omitting the key entirely actually clears it). */
export function ruleWithTarget(rule: WakeRule, value: string): WakeRule {
	return value === NO_SPECIFIC_TARGET
		? { event_type: rule.event_type }
		: { event_type: rule.event_type, target_agent_id: value };
}

function WakeRulesEditor({
	original,
	draft,
	patchDraft,
	knownAgentIds,
}: AgentDetailTabProps): React.ReactElement {
	const [keyed, setKeyed] = React.useState<KeyedWakeRule[]>(() =>
		keyRules(draft.wakeRules ?? original.wakeRules),
	);

	function setRules(next: Readonly<KeyedWakeRule[]>) {
		const rules = next.map((entry) => entry.rule);
		const unchanged =
			rules.length === original.wakeRules.length &&
			rules.every(
				(rule, index) =>
					rule.event_type === original.wakeRules[index]?.event_type &&
					rule.target_agent_id === original.wakeRules[index]?.target_agent_id,
			);
		patchDraft("wakeRules", unchanged ? undefined : rules);
		setKeyed([...next]);
	}

	function updateRule(index: number, next: WakeRule) {
		setRules(keyed.map((entry, i) => (i === index ? { ...entry, rule: next } : entry)));
	}

	function removeRule(index: number) {
		setRules(keyed.filter((_, i) => i !== index));
	}

	function addRule() {
		const eventType = WAKEABLE_EVENT_TYPES[0];
		if (eventType === undefined) {
			return;
		}
		setRules([
			...keyed,
			{
				key: crypto.randomUUID(),
				rule: {
					event_type: eventType as WakeRule["event_type"],
					...(eventType.startsWith("mattermost.") ? { target_agent_id: original.id } : {}),
				},
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
				{keyed.map(({ key, rule }, index) => (
					<div key={key} className="flex items-center gap-2 rounded-lg border border-input p-2">
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
							value={rule.target_agent_id ?? NO_SPECIFIC_TARGET}
							onValueChange={(value) => updateRule(index, ruleWithTarget(rule, value))}
						>
							<SelectTrigger className="w-48">
								<SelectValue placeholder="any target" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={NO_SPECIFIC_TARGET}>(no specific target)</SelectItem>
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
				{keyed.length === 0 && <p className="text-sm text-muted-foreground">No wake rules.</p>}
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
