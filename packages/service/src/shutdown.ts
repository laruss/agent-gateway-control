import type { Logger } from "@agent-gateway/logging";

/** Runs `stop` once on SIGINT or SIGTERM, then exits. */
export function onShutdown(log: Logger, stop: () => Promise<void>): void {
	let stopping = false;
	const handler = (signal: string) => {
		if (stopping) {
			return;
		}
		stopping = true;
		log.info("shutting down", { signal });
		stop().then(
			() => process.exit(0),
			(error: unknown) => {
				log.error("shutdown failed", {
					error_message: error instanceof Error ? error.message : String(error),
				});
				process.exit(1);
			},
		);
	};
	process.on("SIGINT", () => handler("SIGINT"));
	process.on("SIGTERM", () => handler("SIGTERM"));
}
