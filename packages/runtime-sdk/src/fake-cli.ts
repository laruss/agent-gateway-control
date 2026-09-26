import {
	type AgentTurnModelOutput,
	GatewayEventSchema,
	type JsonValue,
	MattermostPostDataSchema,
} from "@agent-gateway/contracts";

/**
 * Support for fake runtime CLIs: test doubles of `codex`, `claude` and later runtimes that
 * speak the real CLI's wire format, so an adapter's argument building, parsing, process control
 * and isolation are tested without a provider. The scenario is a `[fake:<name>]` directive in
 * the triggering post, read back from the rendered prompt.
 */
export const FAKE_SCENARIOS = ["reply", "wait", "invalid", "slow", "crash", "env"] as const;
export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

export type FakeTurn =
	| Readonly<{ kind: "output"; output: JsonValue }>
	| Readonly<{ kind: "slow" }>
	| Readonly<{ kind: "crash" }>;

/** Key and value of invalid fake output; neither may show up in a report. */
export const INVALID_OUTPUT_MARKER = "model-private-text-7f3a";

const TRIGGER_BLOCK = /<data kind="trigger" trust="[a-z-]+">\n([\s\S]*?)\n<\/data>/u;
const DIRECTIVE = /\[fake:([a-z-]+)\]/u;

function isScenario(name: string): name is FakeScenario {
	return FAKE_SCENARIOS.some((scenario) => scenario === name);
}

function summary(done: string): AgentTurnModelOutput["publicSummary"] {
	return {
		assigned: "Fake runtime turn",
		facts: [],
		decisions: [],
		done: [done],
		remaining: [],
		waitingFor: [],
		risks: [],
	};
}

/**
 * The fake CLI's answer to a prompt rendered by `renderTurnPrompt`. A repair prompt (it has a
 * `# Repair` section) always gets a valid reply, except for the `invalid` scenario.
 * `env` replies with the names of the environment variables the process received.
 */
export function fakeTurn(
	prompt: string,
	env: Readonly<Record<string, string | undefined>>,
	cwd: string,
): FakeTurn {
	const block = TRIGGER_BLOCK.exec(prompt)?.[1];
	if (block === undefined) {
		return { kind: "output", output: "no trigger in prompt" };
	}
	const parsedJson: JsonValue = JSON.parse(block);
	const trigger = GatewayEventSchema.parse(parsedJson);
	const post = MattermostPostDataSchema.parse(trigger.data);
	const name = DIRECTIVE.exec(post.message)?.[1] ?? "reply";
	const scenario: FakeScenario = isScenario(name) ? name : "reply";
	const place = { channelId: post.channel_id, rootPostId: post.root_id ?? post.post_id };
	const reply = (markdown: string): AgentTurnModelOutput => ({
		publicMessages: [{ ...place, markdown, targetAgentIds: [], attachments: [] }],
		nextState: { kind: "idle" },
		publicSummary: summary("Replied"),
		memoryProposals: [],
		artifacts: [],
	});
	switch (scenario) {
		case "slow":
			return { kind: "slow" };
		case "crash":
			return { kind: "crash" };
		case "invalid":
			return {
				kind: "output",
				output: { publicMessages: [], [INVALID_OUTPUT_MARKER]: INVALID_OUTPUT_MARKER },
			};
		case "env":
			return {
				kind: "output",
				output: reply(`cwd=${cwd} env=${Object.keys(env).sort().join(",")}`),
			};
		case "wait":
			return {
				kind: "output",
				output: {
					publicMessages: [
						{
							...place,
							markdown: "could you answer in this thread?",
							targetAgentIds: ["finance"],
							attachments: [],
						},
					],
					nextState: {
						kind: "waiting",
						waits: [
							{
								eventType: "mattermost.thread.reply",
								correlationId: trigger.correlationid,
								expectedSenderAgentIds: ["finance"],
								expectedSenderUserIds: [],
								requireTargetAgentId: null,
								timeoutAt: new Date(Date.now() + 3_600_000).toISOString(),
							},
						],
					},
					publicSummary: summary("Asked finance"),
					memoryProposals: [],
					artifacts: [],
				},
			};
		default:
			return {
				kind: "output",
				output: prompt.includes("\n# Repair\n") ? reply("Repaired.") : reply("Done."),
			};
	}
}
