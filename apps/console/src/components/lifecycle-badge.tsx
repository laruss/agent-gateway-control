import type * as React from "react";
import { Badge } from "@/components/ui/badge";

const LIFECYCLE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
	pending: "outline",
	reconciling: "default",
	ready: "secondary",
	failed: "destructive",
	retiring: "outline",
	retired: "outline",
};

/** An agent's own lifecycle status (ADR-026), shown the same way wherever it appears: the agents
 * list, the agent page's header, and its own lifecycle panel. */
export function LifecycleStatusBadge({
	status,
	className,
}: Readonly<{ status: string; className?: string }>): React.ReactElement {
	return (
		<Badge variant={LIFECYCLE_VARIANT[status] ?? "outline"} className={className}>
			{status}
		</Badge>
	);
}
