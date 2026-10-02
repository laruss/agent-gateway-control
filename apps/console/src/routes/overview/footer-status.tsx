import type { SystemStatus } from "@agent-gateway/contracts";
import type * as React from "react";
import { formatTimestamp } from "./format";

export function FooterStatus({ system }: Readonly<{ system: SystemStatus }>): React.ReactElement {
	return (
		<footer className="flex flex-col gap-1 text-xs text-muted-foreground">
			{system.runtimes.length > 0 && (
				<p>
					Runtimes:{" "}
					{system.runtimes
						.map(
							(runtime) => `${runtime.adapter}: ${runtime.available ? "available" : "unavailable"}`,
						)
						.join(" · ")}
				</p>
			)}
			{system.maintenance.length > 0 && (
				<p>
					Maintenance:{" "}
					{system.maintenance
						.map(
							(task) =>
								`${task.task}: ${task.lastSuccessAt === null ? "never" : formatTimestamp(task.lastSuccessAt)}`,
						)
						.join(" · ")}
				</p>
			)}
		</footer>
	);
}
