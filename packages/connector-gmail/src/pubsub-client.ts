import { z } from "zod";
import type { TokenSource } from "./auth.ts";
import { callGoogle, GoogleApiError, type GoogleRequest } from "./google-api.ts";

/** `projects/<project>/subscriptions/<name>`. */
export const SUBSCRIPTION_NAME =
	/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/subscriptions\/[A-Za-z][\w.~+%-]{2,254}$/u;
/** `projects/<project>/topics/<name>`. */
export const TOPIC_NAME =
	/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][\w.~+%-]{2,254}$/u;

const PullSchema = z.object({
	receivedMessages: z
		.array(
			z.object({
				ackId: z.string().min(1),
				message: z.object({
					data: z.string().optional(),
					messageId: z.string().min(1),
					publishTime: z.string().min(1),
				}),
				deliveryAttempt: z.number().int().optional(),
			}),
		)
		.optional(),
});
export type ReceivedMessage = NonNullable<z.infer<typeof PullSchema>["receivedMessages"]>[number];

export type PubsubClient = Readonly<{
	/** Waits for messages; an empty list when none arrived before the call's timeout. */
	pull: (maxMessages: number, signal: AbortSignal) => Promise<Readonly<ReceivedMessage[]>>;
	acknowledge: (ackIds: Readonly<string[]>) => Promise<void>;
}>;

/** How long one pull waits for messages. */
const PULL_TIMEOUT_MS = 60_000;

/**
 * Synchronous pull over REST: a long-polling request per batch. Equivalent to streaming pull for
 * one mailbox (at most one notification per second) without a gRPC client.
 */
export function createPubsubClient(
	pubsubBase: string,
	subscription: string,
	tokens: TokenSource,
): PubsubClient {
	const url = `${pubsubBase}/${subscription}`;
	const call = async <T>(
		request: Omit<GoogleRequest, "accessToken">,
		schema: z.ZodType<T>,
	): Promise<T> => {
		try {
			return await callGoogle({ ...request, accessToken: await tokens.accessToken() }, schema);
		} catch (error) {
			if (!(error instanceof GoogleApiError) || error.status !== 401) {
				throw error;
			}
			tokens.invalidate();
			return callGoogle({ ...request, accessToken: await tokens.accessToken() }, schema);
		}
	};
	return {
		pull: async (maxMessages, signal) => {
			const timeout = AbortSignal.timeout(PULL_TIMEOUT_MS);
			try {
				const pulled = await call(
					{
						what: "Pub/Sub pull",
						url: `${url}:pull`,
						json: { maxMessages },
						signal: AbortSignal.any([signal, timeout]),
						timeoutMs: PULL_TIMEOUT_MS + 5000,
					},
					PullSchema,
				);
				return pulled.receivedMessages ?? [];
			} catch (error) {
				// A long poll that ran out: no messages. Anything leased meanwhile is redelivered.
				if (timeout.aborted && !signal.aborted) {
					return [];
				}
				throw error;
			}
		},
		acknowledge: async (ackIds) => {
			if (ackIds.length === 0) {
				return;
			}
			await call(
				{ what: "Pub/Sub acknowledge", url: `${url}:acknowledge`, json: { ackIds } },
				z.object({}),
			);
		},
	};
}
