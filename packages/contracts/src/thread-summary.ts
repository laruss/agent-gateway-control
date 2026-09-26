import { z } from "zod";
import { AgentIdSchema, TimestampSchema, UuidSchema } from "./common.ts";

const SummaryLinesSchema = z.array(z.string());

/** One run's public summary as it contributes to its thread. */
export const ThreadSummaryEntrySchema = z.strictObject({
	runId: UuidSchema,
	agentId: AgentIdSchema,
	at: TimestampSchema,
	assigned: z.string(),
	facts: SummaryLinesSchema,
	done: SummaryLinesSchema,
	decisions: SummaryLinesSchema,
	remaining: SummaryLinesSchema,
	waitingFor: SummaryLinesSchema,
	risks: SummaryLinesSchema,
});
export type ThreadSummaryEntry = z.infer<typeof ThreadSummaryEntrySchema>;

/**
 * The durable summary of a Mattermost thread, built from the public summaries of the runs in it.
 * The newest runs are kept whole; older ones are compacted into their decisions and results.
 */
export const ThreadSummarySchema = z.strictObject({
	/** Oldest first. */
	entries: z.array(ThreadSummaryEntrySchema),
	earlier: z.strictObject({
		decisions: SummaryLinesSchema,
		done: SummaryLinesSchema,
	}),
	/** How many runs were compacted into `earlier`. */
	compactedRuns: z.int().min(0),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;
