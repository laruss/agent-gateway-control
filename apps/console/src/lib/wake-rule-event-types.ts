import {
	GatewayEventTypeSchema,
	isRecordOnlyEventType,
	isReservedEventType,
} from "@agent-gateway/contracts";

/** Event types a wake rule may actually name (`WakeRuleSchema`): every configured event type
 * except the Gateway-reserved ones (lifecycle, waits, approvals, timers, control — the Gateway
 * itself emits these; nothing configures a rule for them) and the record-only ones (edits,
 * deletions, recovered posts and Gmail notifications never wake an agent). Computed once from
 * the same schema and predicates the server validates a wake rule against, so this list can
 * never drift from what the server actually accepts. */
export const WAKEABLE_EVENT_TYPES: Readonly<string[]> = GatewayEventTypeSchema.options.filter(
	(type) => !isReservedEventType(type) && !isRecordOnlyEventType(type),
);
