import type { SystemStatus } from "@agent-gateway/contracts";
import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import { fmt } from "./format";

export function TopSummary({ system }: Readonly<{ system: SystemStatus }>): React.ReactElement {
	return (
		<div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
			<Badge variant={system.killSwitch ? "destructive" : "secondary"}>
				Kill switch: {system.killSwitch ? "ON" : "off"}
			</Badge>
			<span>
				Approvals pending: <strong>{fmt(system.approvalsPending)}</strong>
			</span>
			<span>
				Tool actions unknown: <strong>{fmt(system.toolActionsUnknown)}</strong>
			</span>
			<span>
				Outbox pending: <strong>{fmt(system.outbox.pending)}</strong> · dead:{" "}
				<strong>{fmt(system.outbox.dead)}</strong>
			</span>
			<span>
				Agents omitted: <strong>{fmt(system.omittedAgents)}</strong>
			</span>
		</div>
	);
}
