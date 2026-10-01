import type { ConsoleAlert } from "@agent-gateway/contracts";
import { TriangleAlert } from "lucide-react";
import type * as React from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { formatTimestamp } from "./format";

export function AlertsList({
	alerts,
}: Readonly<{ alerts: Readonly<ConsoleAlert[]> }>): React.ReactElement | null {
	if (alerts.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-col gap-2">
			{alerts.map((alert) => (
				<Alert key={alert.key} variant="destructive">
					<TriangleAlert />
					<AlertTitle>{alert.key}</AlertTitle>
					<AlertDescription>
						Since {formatTimestamp(alert.firedAt)} — {alert.message}
					</AlertDescription>
				</Alert>
			))}
		</div>
	);
}
