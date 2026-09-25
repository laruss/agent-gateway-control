import { z } from "zod";
import { AgentIdSchema, MattermostIdSchema, TimestampSchema, UuidSchema } from "./common.ts";

/** Events an agent may wait for. Control and lifecycle events are never waitable. */
export const WaitableEventTypeSchema = z.enum([
	"mattermost.thread.reply",
	"mattermost.agent.mentioned",
	"approval.granted",
	"approval.denied",
	"google.gmail.message.received",
	"timer.fired",
]);
export type WaitableEventType = z.infer<typeof WaitableEventTypeSchema>;

const SENDER_REQUIRED: Readonly<WaitableEventType[]> = [
	"mattermost.thread.reply",
	"mattermost.agent.mentioned",
];

/**
 * Durable wait requested by an agent in `nextState`. Every condition must hold
 * for an event to match. The controller additionally checks that
 * `correlationId` belongs to the run and clamps `timeoutAt` to policy limits.
 */
export const WaitConditionSchema = z
	.strictObject({
		eventType: WaitableEventTypeSchema,
		correlationId: z.string().min(1).max(512),
		expectedSenderAgentIds: z.array(AgentIdSchema).max(8),
		expectedSenderUserIds: z.array(MattermostIdSchema).max(8),
		/** Agent the matching message must be addressed to; null when not required. */
		requireTargetAgentId: AgentIdSchema.nullable(),
		timeoutAt: TimestampSchema,
	})
	.check((ctx) => {
		const { eventType, expectedSenderAgentIds, expectedSenderUserIds } = ctx.value;
		if (
			SENDER_REQUIRED.includes(eventType) &&
			expectedSenderAgentIds.length === 0 &&
			expectedSenderUserIds.length === 0
		) {
			ctx.issues.push({
				code: "custom",
				input: ctx.value,
				path: ["expectedSenderAgentIds"],
				message: `a wait for ${eventType} must name at least one expected sender`,
			});
		}
	});
export type WaitCondition = z.infer<typeof WaitConditionSchema>;

/** `data` of an `agent.wait.timeout` event, emitted by the controller when a wait expires. */
export const WaitTimeoutDataSchema = z.strictObject({
	agent_id: AgentIdSchema,
	wait_id: UuidSchema,
});
export type WaitTimeoutData = z.infer<typeof WaitTimeoutDataSchema>;
