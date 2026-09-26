import { describe, expect, it } from "vitest";
import {
	CHANNEL_ID,
	financeReplyWait,
	idleResult,
	message,
	OTHER_CHANNEL_ID,
	RUN_ID,
} from "./test-fixtures.ts";
import type { AgentTurnResult, ArtifactDescriptor } from "./turn.ts";
import { checkTurnResultAuthority, type TurnAuthorityContext } from "./turn-authority.ts";

const ARTIFACT_ID = "3f0c1f5e-8a47-4f6a-9d0b-2b8d7d1c9e11";
const PARTICIPANT_ID = "p1a2r3t4i5c6i7p8a9n0t1u2s3";
const STRANGER_ID = "s1t2r3a4n5g6e7r8i9d0a1b2c3";

const context: TurnAuthorityContext = {
	runId: RUN_ID,
	agentId: "developer",
	allowedChannelIds: [CHANNEL_ID],
	registeredAgentIds: ["developer", "finance", "reviewer", "director"],
	addressableAgents: { finance: [CHANNEL_ID], reviewer: [CHANNEL_ID, OTHER_CHANNEL_ID] },
	writableMemoryNamespaces: ["agents/developer", "organization/decisions"],
	attachableArtifactIds: [ARTIFACT_ID],
	waitableUserIds: [PARTICIPANT_ID],
	toolPolicy: {
		policyVersion: "test",
		allow: ["repository.read", "mattermost.post"],
		requireHumanApproval: ["deploy.staging"],
		deny: ["finance.*", "deploy.production"],
	},
};

function paths(result: AgentTurnResult): string[] {
	return checkTurnResultAuthority(result, context).map((issue) => issue.path);
}

describe("checkTurnResultAuthority", () => {
	it("accepts a result within the agent's authority", () => {
		const result: AgentTurnResult = {
			...idleResult(),
			publicMessages: [message({ attachments: [{ artifactId: ARTIFACT_ID, artifactKey: null }] })],
			nextState: { kind: "waiting", waits: [financeReplyWait()] },
			memoryProposals: [
				{ namespace: "agents/developer", key: "budget", content: "asked", visibility: "private" },
			],
		};
		expect(paths(result)).toEqual([]);
	});

	it("rejects a result of another run", () => {
		expect(paths({ ...idleResult(), runId: "9a0b5d8e-3f1c-4c2a-9a57-6f1d2c3b4a5e" })).toEqual([
			"runId",
		]);
	});

	it("rejects public messages when the tool policy does not allow posting", () => {
		const result = { ...idleResult(), publicMessages: [message()] };
		for (const toolPolicy of [
			{ ...context.toolPolicy, allow: ["repository.read"] },
			{ ...context.toolPolicy, deny: [...context.toolPolicy.deny, "mattermost.*"] },
			{ ...context.toolPolicy, requireHumanApproval: ["mattermost.post"] },
		]) {
			expect(
				checkTurnResultAuthority(result, { ...context, toolPolicy }).map((i) => i.path),
			).toEqual(["publicMessages.0"]);
		}
	});

	it("rejects posting to a channel outside the allowlist", () => {
		const result = {
			...idleResult(),
			publicMessages: [message({ channelId: OTHER_CHANNEL_ID, targetAgentIds: ["reviewer"] })],
		};
		expect(paths(result)).toEqual(["publicMessages.0.channelId"]);
	});

	it("rejects self-targeting and unknown agents", () => {
		const result = {
			...idleResult(),
			publicMessages: [message({ targetAgentIds: ["developer", "operator"] })],
		};
		expect(paths(result)).toEqual([
			"publicMessages.0.targetAgentIds.0",
			"publicMessages.0.targetAgentIds.1",
		]);
	});

	it("rejects agent mentions in the text that are not declared as targets", () => {
		const result = {
			...idleResult(),
			publicMessages: [
				message({ markdown: "@finance please review, cc @Reviewer.", targetAgentIds: ["finance"] }),
			],
		};
		expect(checkTurnResultAuthority(result, context).map((issue) => issue.message)).toEqual([
			"'@reviewer' is mentioned in the text but missing from targetAgentIds",
		]);
	});

	it("rejects undeclared mentions of registered agents outside the addressable set", () => {
		const result = {
			...idleResult(),
			publicMessages: [message({ markdown: "escalating to @director" })],
		};
		expect(paths(result)).toEqual(["publicMessages.0.markdown"]);
	});

	it("attaches an artifact produced in the same turn by its key", () => {
		const report: ArtifactDescriptor = {
			key: "market-report",
			kind: "report",
			workspacePath: "reports/market.md",
			url: null,
			sha256: null,
			mimeType: "text/markdown",
			sizeBytes: 10,
			visibility: "shared",
			description: null,
		};
		const attach = (artifactKey: string) => ({
			...idleResult(),
			artifacts: [report],
			publicMessages: [message({ attachments: [{ artifactId: null, artifactKey }] })],
		});
		expect(paths(attach("market-report"))).toEqual([]);
		expect(paths(attach("other-report"))).toEqual(["publicMessages.0.attachments.0"]);
		const privateReport = { ...idleResult(), ...attach("market-report") };
		privateReport.artifacts = [{ ...report, visibility: "private" }];
		expect(checkTurnResultAuthority(privateReport, context).map((i) => i.message)).toEqual([
			"private artifact 'market-report' cannot be posted",
		]);
	});

	it("ignores mentions of unknown names and e-mail addresses", () => {
		const result = {
			...idleResult(),
			publicMessages: [message({ markdown: "ask @someone or mail finance@x.dev" })],
		};
		expect(paths(result)).toEqual([]);
	});

	it("treats inherited object keys as unknown agents instead of crashing", () => {
		const result: AgentTurnResult = {
			...idleResult(),
			publicMessages: [message({ targetAgentIds: ["constructor"] })],
			nextState: {
				kind: "waiting",
				waits: [financeReplyWait({ expectedSenderAgentIds: ["constructor"] })],
			},
		};
		expect(paths(result)).toEqual([
			"publicMessages.0.targetAgentIds.0",
			"nextState.waits.0.expectedSenderAgentIds.0",
		]);
	});

	it("rejects addressing an agent that is not a member of the channel", () => {
		const result = {
			...idleResult(),
			publicMessages: [
				message({ channelId: OTHER_CHANNEL_ID, targetAgentIds: ["finance", "reviewer"] }),
			],
		};
		const developerInBoth = {
			...context,
			allowedChannelIds: [CHANNEL_ID, OTHER_CHANNEL_ID],
		};
		expect(checkTurnResultAuthority(result, developerInBoth).map((issue) => issue.path)).toEqual([
			"publicMessages.0.targetAgentIds.0",
		]);
	});

	it.each([
		["a denied finance action", "finance.payment.create"],
		["a denied deploy action", "deploy.production"],
		["an action outside the approval list", "delete.repository"],
	])("rejects requesting approval for %s", (_, actionType) => {
		const result: AgentTurnResult = {
			...idleResult(),
			nextState: {
				kind: "needs_human",
				approvalRequest: {
					actionType,
					actionParams: [{ name: "amount", value: "5000.00" }],
					actionSummary: "Please approve",
				},
			},
		};
		expect(paths(result)).toEqual(["nextState.approvalRequest.actionType"]);
	});

	it("accepts an approval request the policy routes to a human", () => {
		const result: AgentTurnResult = {
			...idleResult(),
			nextState: {
				kind: "needs_human",
				approvalRequest: {
					actionType: "deploy.staging",
					actionParams: [{ name: "commit", value: "abc123" }],
					actionSummary: "Deploy to staging",
				},
			},
		};
		expect(paths(result)).toEqual([]);
	});

	it("rejects attaching foreign artifacts", () => {
		const foreign = "5a1e1f5e-8a47-4f6a-9d0b-2b8d7d1c9e11";
		const result = {
			...idleResult(),
			publicMessages: [message({ attachments: [{ artifactId: foreign, artifactKey: null }] })],
		};
		expect(paths(result)).toEqual(["publicMessages.0.attachments.0"]);
	});

	it("rejects waits for unknown senders or messages addressed to someone else", () => {
		const result: AgentTurnResult = {
			...idleResult(),
			nextState: {
				kind: "waiting",
				waits: [
					financeReplyWait({ expectedSenderAgentIds: ["operator"] }),
					financeReplyWait({ requireTargetAgentId: "finance" }),
				],
			},
		};
		expect(paths(result)).toEqual([
			"nextState.waits.0.expectedSenderAgentIds.0",
			"nextState.waits.1.requireTargetAgentId",
		]);
	});

	it("accepts waits for thread participants and rejects waits for anyone else", () => {
		const result: AgentTurnResult = {
			...idleResult(),
			nextState: {
				kind: "waiting",
				waits: [
					financeReplyWait({ expectedSenderAgentIds: [], expectedSenderUserIds: [PARTICIPANT_ID] }),
					financeReplyWait({
						expectedSenderAgentIds: [],
						expectedSenderUserIds: [PARTICIPANT_ID, STRANGER_ID],
					}),
				],
			},
		};
		expect(paths(result)).toEqual(["nextState.waits.1.expectedSenderUserIds.1"]);
	});

	it("rejects memory writes to another agent's namespace", () => {
		const result = {
			...idleResult(),
			memoryProposals: [
				{ namespace: "agents/finance", key: "k", content: "c", visibility: "public" as const },
			],
		};
		expect(paths(result)).toEqual(["memoryProposals.0.namespace"]);
	});
});
