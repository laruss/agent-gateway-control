import type { OutboxKind } from "@agent-gateway/db";
import type { Logger } from "@agent-gateway/logging";
import type { Deliverer } from "./deliver.ts";

/**
 * Logs what would be sent instead of sending it. Used until the Mattermost deliverers exist;
 * the receipt says `dryRun` so nobody mistakes it for a real post.
 */
export function dryRunDeliverers(log: Logger): Readonly<Record<OutboxKind, Deliverer>> {
	const deliverer: Deliverer = {
		deliver: async (item) => {
			log.info("dry-run delivery", {
				kind: item.kind,
				destination: item.destination,
				idempotency_key: item.idempotencyKey,
			});
			return { dryRun: true, idempotencyKey: item.idempotencyKey };
		},
	};
	return {
		"mattermost.post": deliverer,
		"mattermost.alert": deliverer,
		"mattermost.approval": deliverer,
	};
}
