import { MattermostApprovalPayloadSchema } from "@agent-gateway/contracts";
import { approvalPending, type ControlPlaneDeps } from "@agent-gateway/core";
import type { OutboxKind } from "@agent-gateway/db";
import type { Deliverer } from "@agent-gateway/outbox";

/**
 * Posts an approval card only while its request still waits for a decision: a card for a
 * request withdrawn or expired meanwhile would invite a decision that no longer counts. The
 * receipt then carries no post, so nothing answers in a thread that does not exist. (A request
 * that ends while its card is being posted gets its last word from the approvals sweep.)
 */
export function pendingApprovalCards(deps: ControlPlaneDeps, cards: Deliverer): Deliverer {
	return {
		deliver: async (item) => {
			const card = MattermostApprovalPayloadSchema.safeParse(item.payload);
			if (card.success && !(await approvalPending(deps, card.data.approvalId))) {
				return { skipped: true, reason: "the request ended before its card was posted" };
			}
			return cards.deliver(item);
		},
	};
}

/** The deliverers with approval cards posted only for pending requests. */
export function withPendingApprovalCards<
	D extends Readonly<Partial<Record<OutboxKind, Deliverer>>>,
>(deps: ControlPlaneDeps, deliverers: D): D {
	const cards = deliverers["mattermost.approval"];
	return cards === undefined
		? deliverers
		: { ...deliverers, "mattermost.approval": pendingApprovalCards(deps, cards) };
}
