import type {
	AgentTurnInput,
	AgentTurnModelOutput,
	JsonValue,
	MattermostId,
	PublicMessage,
	WorkingSummary,
} from "@agent-gateway/contracts";
import { MattermostPostDataSchema } from "@agent-gateway/contracts";

/** Scenarios the mock can play, selected by a `[mock:<name> <arg>]` directive in the trigger. */
export const MOCK_SCENARIOS = [
	"reply",
	"mention",
	"wait",
	"wait-open",
	"wait-asker",
	"remember",
	"invalid",
	"invalid-once",
	"slow",
	"retryable",
	"flaky",
	"permanent",
	"artifact",
	"approval",
	"fail",
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

export type MockDirective = Readonly<{ scenario: MockScenario; arg: string | null }>;

const DIRECTIVE = /\[mock:([a-z-]+)(?:\s+([a-z0-9.*-]+))?\]/u;

function isScenario(name: string): name is MockScenario {
	return MOCK_SCENARIOS.some((scenario) => scenario === name);
}

/** The directive in the triggering post; `reply` when there is none. */
export function mockDirective(input: AgentTurnInput): MockDirective {
	const post = MattermostPostDataSchema.safeParse(input.trigger.data);
	const match = post.success ? DIRECTIVE.exec(post.data.message) : null;
	const name = match?.[1];
	if (name === undefined || !isScenario(name)) {
		return { scenario: "reply", arg: null };
	}
	return { scenario: name, arg: match?.[2] ?? null };
}

type ReplyPlace = Readonly<{ channelId: MattermostId; rootPostId: MattermostId | null }>;

/**
 * Replies go to the trigger's thread when it is a post in an allowed channel, else to the turn's
 * thread (a turn resumed by a timeout carries no post).
 */
function replyPlace(input: AgentTurnInput): ReplyPlace {
	const post = MattermostPostDataSchema.safeParse(input.trigger.data);
	const allowed = input.channels.map((c) => c.channelId);
	if (post.success && allowed.includes(post.data.channel_id)) {
		return { channelId: post.data.channel_id, rootPostId: post.data.root_id ?? post.data.post_id };
	}
	const thread = input.threadContext;
	if (thread !== null && allowed.includes(thread.channelId)) {
		return { channelId: thread.channelId, rootPostId: thread.rootPostId };
	}
	const first = input.channels[0];
	if (first === undefined) {
		throw new Error("turn input has no channel");
	}
	return { channelId: first.channelId, rootPostId: null };
}

function summary(input: AgentTurnInput, done: string): WorkingSummary {
	return {
		assigned: `Handle ${input.trigger.type} in ${input.trigger.correlationid}`,
		facts: [],
		decisions: [],
		done: [done],
		remaining: [],
		waitingFor: [],
		risks: [],
	};
}

function message(
	input: AgentTurnInput,
	markdown: string,
	targetAgentIds: Readonly<string[]> = [],
	artifactKey: string | null = null,
): PublicMessage {
	return {
		...replyPlace(input),
		markdown,
		targetAgentIds: [...targetAgentIds],
		attachments: artifactKey === null ? [] : [{ artifactId: null, artifactKey }],
	};
}

/**
 * The agent to answer: the trigger's sender when it is another Gateway-managed agent that asked
 * a question (its post ends with `?`). Answers are not answered, so two mocks never ping-pong.
 */
function askingAgent(input: AgentTurnInput): string | null {
	const post = MattermostPostDataSchema.safeParse(input.trigger.data);
	if (!post.success || !post.data.message.trim().endsWith("?")) {
		return null;
	}
	const sender = post.data.sender_agent_id;
	return sender !== null && sender !== input.agent.agentId ? sender : null;
}

const base = (input: AgentTurnInput, done: string) => ({
	nextState: { kind: "idle" as const },
	publicSummary: summary(input, done),
	memoryProposals: [],
	artifacts: [],
});

/** A valid model output for every scenario that produces one. */
export function scenarioOutput(
	input: AgentTurnInput,
	directive: MockDirective,
	now: Date,
): AgentTurnModelOutput {
	const target = directive.arg;
	switch (directive.scenario) {
		case "mention":
			return {
				...base(input, "Handed the task over"),
				publicMessages: [message(input, "please take a look.", target === null ? [] : [target])],
			};
		case "wait":
		case "wait-open": {
			const from = target ?? "finance";
			return {
				...base(input, "Asked a question"),
				publicMessages: [message(input, "could you answer in this thread?", [from])],
				nextState: {
					kind: "waiting",
					waits: [
						{
							eventType: "mattermost.thread.reply",
							correlationId: input.trigger.correlationid,
							expectedSenderAgentIds: [from],
							expectedSenderUserIds: [],
							// `wait-open` accepts any reply of the sender in the thread, addressed or not.
							requireTargetAgentId: directive.scenario === "wait-open" ? null : input.agent.agentId,
							timeoutAt: new Date(now.getTime() + 3600_000).toISOString(),
						},
					],
				},
			};
		}
		case "wait-asker": {
			// Waits for the human who asked: an answer in the thread, addressed or not.
			const post = MattermostPostDataSchema.safeParse(input.trigger.data);
			if (!post.success || input.trigger.trustlevel !== "human-trusted") {
				return { ...base(input, "Nobody to ask"), publicMessages: [] };
			}
			return {
				...base(input, "Asked the requester"),
				publicMessages: [message(input, "could you answer in this thread?")],
				nextState: {
					kind: "waiting",
					waits: [
						{
							eventType: "mattermost.thread.reply",
							correlationId: input.trigger.correlationid,
							expectedSenderAgentIds: [],
							expectedSenderUserIds: [post.data.user_id],
							requireTargetAgentId: null,
							timeoutAt: new Date(now.getTime() + 3600_000).toISOString(),
						},
					],
				},
			};
		}
		case "remember": {
			// Proposes one item to the private namespace and one to the first shared namespace.
			const shared = input.memoryNamespaces.shared[0];
			const note = `noted from ${input.trigger.id}`;
			return {
				...base(input, "Remembered a note"),
				publicMessages: [message(input, `Remembered (${input.memories.length} known).`)],
				memoryProposals: [
					{
						namespace: input.memoryNamespaces.private,
						key: "mock-note",
						content: note,
						visibility: "private",
					},
					...(shared === undefined
						? []
						: [
								{
									namespace: shared,
									key: "mock-note",
									content: note,
									visibility: "shared" as const,
								},
							]),
				],
			};
		}
		case "artifact":
			return {
				...base(input, "Published a report"),
				publicMessages: [message(input, "Report attached.", [], "mock-report")],
				artifacts: [
					{
						key: "mock-report",
						kind: "link",
						workspacePath: null,
						url: "https://example.com/mock-report",
						sha256: null,
						mimeType: "text/html",
						sizeBytes: null,
						visibility: "shared",
						description: "Mock report",
					},
				],
			};
		case "approval":
			return {
				...base(input, "Asked for approval"),
				publicMessages: [],
				nextState: {
					kind: "needs_human",
					approvalRequest: {
						actionType: target ?? "finance.payment.create",
						actionParams: [
							{ name: "amount", value: "10.00" },
							{ name: "currency", value: "EUR" },
						],
						actionSummary: "Mock payment for a test scenario.",
					},
				},
			};
		case "fail":
			return {
				...base(input, "Gave up"),
				publicMessages: [],
				nextState: { kind: "failed", publicError: "Mock failure requested.", retryable: false },
			};
		default: {
			const resumed = input.durableState.resolvedWaits.length > 0;
			const sender = resumed ? null : askingAgent(input);
			return {
				...base(input, resumed ? "Resumed after the wait" : "Replied"),
				publicMessages: [
					message(
						input,
						resumed ? "Thanks, continuing." : "Done.",
						sender === null ? [] : [sender],
					),
				],
			};
		}
	}
}

/** Output that violates the schema: unknown field, missing summary. */
export function invalidOutput(): JsonValue {
	return { publicMessages: [], nextState: { kind: "idle" }, unexpected: true };
}
