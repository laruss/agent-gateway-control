import { describe, expect, it } from "vitest";
import { AgentConfigSchema, AgentPermissionsSchema, WakeRuleSchema } from "./agent-config.ts";
import {
	type ApprovalRequest,
	ApprovalRequestDraftSchema,
	ApprovalRequestSchema,
} from "./approval.ts";
import { AgentIdSchema, PromptPathSchema, ToolPatternSchema } from "./common.ts";
import { validateConfigBundle } from "./config-bundle.ts";
import { type GatewayEvent, GatewayEventSchema } from "./event.ts";
import { OrganizationMattermostSchema } from "./organization.ts";
import {
	agent,
	CHANNEL_ID,
	financeReplyWait,
	idleResult,
	issuePaths,
	message,
	organization,
	ROOT_ID,
	RUN_ID,
	USER_ID,
} from "./test-fixtures.ts";
import {
	AgentTurnInputSchema,
	AgentTurnResultSchema,
	type ArtifactDescriptor,
	MemoryItemSchema,
	ThreadPostSchema,
	ToolPolicySnapshotSchema,
} from "./turn.ts";
import { WaitConditionSchema } from "./wait.ts";

describe("AgentTurnResult", () => {
	it("accepts a message to another agent followed by a durable wait", () => {
		const result = {
			...idleResult(),
			publicMessages: [message()],
			nextState: { kind: "waiting", waits: [financeReplyWait()] },
		};
		expect(issuePaths(AgentTurnResultSchema, result)).toEqual([]);
	});

	it("rejects unknown fields at any depth instead of dropping them", () => {
		expect(
			issuePaths(AgentTurnResultSchema, { ...idleResult(), shellCommand: "rm -rf /" }),
		).toEqual([""]);
		const nested = { ...idleResult(), publicMessages: [{ ...message(), channel: "town-square" }] };
		expect(issuePaths(AgentTurnResultSchema, nested)).toEqual(["publicMessages.0"]);
	});

	it("does not accept side-effect receipts from the model", () => {
		const result = {
			...idleResult(),
			sideEffectReceipts: [{ kind: "finance.payment.create", status: "succeeded" }],
		};
		expect(issuePaths(AgentTurnResultSchema, result)).toEqual([""]);
	});

	it("rejects a waiting state without wait conditions", () => {
		const result = { ...idleResult(), nextState: { kind: "waiting", waits: [] } };
		expect(AgentTurnResultSchema.safeParse(result).success).toBe(false);
	});

	it("rejects a free-text summary: the summary must be structured", () => {
		expect(issuePaths(AgentTurnResultSchema, { ...idleResult(), publicSummary: "done" })).toEqual([
			"publicSummary",
		]);
	});

	it("bounds summaries that are fed back into every turn", () => {
		const summary = { ...idleResult().publicSummary, facts: Array(21).fill("fact") };
		expect(issuePaths(AgentTurnResultSchema, { ...idleResult(), publicSummary: summary })).toEqual([
			"publicSummary.facts",
		]);
	});

	it.each([
		["too long for a Mattermost post", "x".repeat(15_001)],
		["blank", "   \n "],
		["a broadcast mention", "Внимание @channel, срочно"],
		["a bidi override", "safe ‮ txet"],
		["a control character", "bell \u0007"],
		["a zero-width space", "pay\u200Bpal"],
		["a right-to-left mark", "amount \u200F50"],
		["a C1 control", "next \u0085line"],
		["a byte order mark", "\uFEFFhello"],
		["a word joiner", "pay\u2060pal"],
		["a tag character", "hello\u{E0041}\u{E0042}"],
		["a lone surrogate", "broken \uD800 text"],
		["a line separator", "one\u2028two"],
	])("rejects message markdown that is %s", (_, markdown) => {
		const result = { ...idleResult(), publicMessages: [message({ markdown })] };
		expect(issuePaths(AgentTurnResultSchema, result)).toEqual(["publicMessages.0.markdown"]);
	});

	it("keeps emoji sequences and scripts that need zero-width joiners", () => {
		for (const markdown of ["Семья 👨\u200D👩\u200D👧", "می\u200Cخواهم", "hyphen\u00ADated"]) {
			const result = { ...idleResult(), publicMessages: [message({ markdown })] };
			expect(issuePaths(AgentTurnResultSchema, result), markdown).toEqual([]);
		}
	});

	it.each(["Alert.@all", "join @all-hands at noon", "(@here)", "**@Channel**", "@all_hands"])(
		"rejects the broadcast mention in '%s'",
		(markdown) => {
			const result = { ...idleResult(), publicMessages: [message({ markdown })] };
			expect(issuePaths(AgentTurnResultSchema, result)).toEqual(["publicMessages.0.markdown"]);
		},
	);

	it.each(["email me@here.com", "ask @allison", "the @channels list"])(
		"does not mistake '%s' for a broadcast mention",
		(markdown) => {
			const result = { ...idleResult(), publicMessages: [message({ markdown })] };
			expect(issuePaths(AgentTurnResultSchema, result)).toEqual([]);
		},
	);

	it("keeps a message at exactly the length limit", () => {
		const result = { ...idleResult(), publicMessages: [message({ markdown: "x".repeat(15_000) })] };
		expect(issuePaths(AgentTurnResultSchema, result)).toEqual([]);
	});

	it("rejects duplicate target agents", () => {
		const result = {
			...idleResult(),
			publicMessages: [message({ targetAgentIds: ["finance", "finance"] })],
		};
		expect(issuePaths(AgentTurnResultSchema, result)).toEqual(["publicMessages.0.targetAgentIds"]);
	});

	describe("artifacts", () => {
		const file: ArtifactDescriptor = {
			key: "market-report",
			kind: "file",
			workspacePath: "reports/market.md",
			url: null,
			sha256: null,
			mimeType: "text/markdown",
			sizeBytes: 120,
			visibility: "shared",
			description: null,
		};
		const withArtifact = (artifact: ArtifactDescriptor) => ({
			...idleResult(),
			artifacts: [artifact],
		});

		it("accepts a workspace file and an https link", () => {
			expect(issuePaths(AgentTurnResultSchema, withArtifact(file))).toEqual([]);
			const link = { ...file, kind: "link" as const, workspacePath: null, url: "https://x.dev/a" };
			expect(issuePaths(AgentTurnResultSchema, withArtifact(link))).toEqual([]);
		});

		it.each([
			"../../../run/secrets/mm_finance_token",
			"reports/../../etc/passwd",
			"/run/secrets/x",
			"..",
			"./reports/x.md",
			"reports//x.md",
			"reports\\..\\x.md",
		])("rejects the escaping path %s", (workspacePath) => {
			expect(issuePaths(AgentTurnResultSchema, withArtifact({ ...file, workspacePath }))).toEqual([
				"artifacts.0.workspacePath",
			]);
		});

		it("rejects duplicate artifact keys", () => {
			const result = { ...idleResult(), artifacts: [file, { ...file, workspacePath: "b.md" }] };
			expect(issuePaths(AgentTurnResultSchema, result)).toEqual(["artifacts"]);
		});

		it("requires exactly one artifact reference in an attachment", () => {
			for (const attachment of [
				{ artifactId: null, artifactKey: null },
				{ artifactId: RUN_ID, artifactKey: "market-report" },
			]) {
				const result = {
					...idleResult(),
					publicMessages: [message({ attachments: [attachment] })],
				};
				expect(issuePaths(AgentTurnResultSchema, result)).toEqual([
					"publicMessages.0.attachments.0.artifactId",
				]);
			}
		});

		it("rejects non-https urls and ambiguous locations", () => {
			const httpLink = { ...file, workspacePath: null, url: "file:///run/secrets/x" };
			expect(issuePaths(AgentTurnResultSchema, withArtifact(httpLink))).toEqual([
				"artifacts.0.url",
			]);
			const userinfo = { ...file, workspacePath: null, url: "https://paypal.com@evil.example/" };
			expect(issuePaths(AgentTurnResultSchema, withArtifact(userinfo))).toEqual([
				"artifacts.0.url",
			]);
			const both = { ...file, url: "https://x.dev/a" };
			expect(issuePaths(AgentTurnResultSchema, withArtifact(both))).toEqual([
				"artifacts.0.workspacePath",
			]);
		});
	});

	it.each([
		["agents/developer", "public"],
		["agents/developer", "shared"],
		["organization/decisions", "private"],
	])("rejects memory in %s with visibility %s", (namespace, visibility) => {
		const result = {
			...idleResult(),
			memoryProposals: [{ namespace, key: "k", content: "c", visibility }],
		};
		expect(issuePaths(AgentTurnResultSchema, result)).toEqual(["memoryProposals.0.visibility"]);
	});

	it("rejects memory proposals outside the namespace scheme", () => {
		const proposal = {
			namespace: "../agents/finance",
			key: "k",
			content: "c",
			visibility: "public",
		};
		const result = { ...idleResult(), memoryProposals: [proposal] };
		expect(issuePaths(AgentTurnResultSchema, result)).toEqual(["memoryProposals.0.namespace"]);
	});
});

describe("AgentTurnInput", () => {
	const gmailTrigger = {
		specversion: "1.0",
		id: "gmail:message:18c2",
		source: "gmail://mailbox/ops",
		type: "google.gmail.message.received",
		time: "2026-09-24T14:00:00Z",
		datacontenttype: "application/json",
		correlationid: "gmail-thread:18c2",
		causationid: null,
		trustlevel: "external-untrusted",
		hop: 0,
		data: { message_id: "18c2" },
	};
	const input = {
		schemaVersion: 1,
		runId: RUN_ID,
		agent: {
			agentId: "mail-follower",
			displayName: "Mail Follower",
			mattermostUsername: "mail-follower",
			rolePrompt: "Sort incoming mail.",
			configVersion: "1",
		},
		organization: {
			organizationId: "lab",
			globalGoal: "goal",
			constitution: "rules",
			rules: [],
			limits: organization().organization.default_limits,
			directory: [],
		},
		trigger: gmailTrigger,
		durableState: { previousRunId: null, previousSummary: null, resolvedWaits: [] },
		channels: [{ channelId: CHANNEL_ID, name: "mail" }],
		threadContext: null,
		memories: [],
		memoryNamespaces: { private: "agents/mail-follower", shared: ["organization/customers"] },
		pendingInbox: [],
		workspace: null,
		toolPolicy: { policyVersion: "1", allow: ["mail.read"], requireHumanApproval: [], deny: [] },
		outputSchema: { type: "object" },
		deadline: "2026-09-24T14:15:00Z",
	};

	it("gives a turn without a Mattermost thread the channels it may post to", () => {
		expect(issuePaths(AgentTurnInputSchema, input)).toEqual([]);
	});

	it("requires at least one postable channel", () => {
		expect(issuePaths(AgentTurnInputSchema, { ...input, channels: [] })).toEqual(["channels"]);
	});
});

describe("ToolPolicySnapshot", () => {
	it("rejects overlapping lists, so no tool is both allowed and approval-gated", () => {
		const policy = {
			policyVersion: "1",
			allow: ["mattermost.post"],
			requireHumanApproval: ["mattermost.*"],
			deny: [],
		};
		expect(issuePaths(ToolPolicySnapshotSchema, policy)).toEqual(["requireHumanApproval"]);
		expect(
			issuePaths(ToolPolicySnapshotSchema, { ...policy, requireHumanApproval: ["deploy.staging"] }),
		).toEqual([]);
	});
});

describe("stored context items", () => {
	it("applies the memory visibility rule to stored items, not only to proposals", () => {
		const item = {
			id: RUN_ID,
			namespace: "agents/developer",
			key: "budget",
			content: "asked finance",
			visibility: "public",
			sourceRunId: null,
			createdAt: "2026-09-24T14:00:00Z",
		};
		expect(issuePaths(MemoryItemSchema, item)).toEqual(["visibility"]);
		expect(issuePaths(MemoryItemSchema, { ...item, visibility: "private" })).toEqual([]);
	});

	it.each([
		["a system-trusted post", null, "system-trusted"],
		["a human-trusted post by an agent bot", "finance", "human-trusted"],
	])("rejects %s in thread context", (_, authorAgentId, trustLevel) => {
		const post = {
			postId: ROOT_ID,
			authorUserId: USER_ID,
			authorAgentId,
			createdAt: "2026-09-24T14:00:00Z",
			message: "hello",
			trustLevel,
		};
		expect(issuePaths(ThreadPostSchema, post)).toEqual(["trustLevel"]);
	});
});

describe("WaitCondition", () => {
	it("requires an expected sender for Mattermost replies", () => {
		const wait = financeReplyWait({ expectedSenderAgentIds: [], expectedSenderUserIds: [] });
		expect(issuePaths(WaitConditionSchema, wait)).toEqual(["expectedSenderAgentIds"]);
	});

	it("allows a timer wait without a sender", () => {
		const wait = financeReplyWait({
			eventType: "timer.fired",
			expectedSenderAgentIds: [],
			requireTargetAgentId: null,
		});
		expect(issuePaths(WaitConditionSchema, wait)).toEqual([]);
	});

	it("never waits for control or lifecycle events", () => {
		for (const eventType of ["gateway.control.kill_all", "agent.wait.timeout"]) {
			expect(issuePaths(WaitConditionSchema, { ...financeReplyWait(), eventType })).toEqual([
				"eventType",
			]);
		}
	});
});

describe("ApprovalRequestDraft", () => {
	it("must fit one approval card", () => {
		const big = Array.from({ length: 32 }, (_, n) => ({ name: `p${n}`, value: "x".repeat(2000) }));
		const parsed = ApprovalRequestDraftSchema.safeParse({
			actionType: "finance.payment.create",
			actionParams: big,
			actionSummary: "pay",
		});
		expect(parsed.success).toBe(false);
	});

	const draft = {
		actionType: "finance.payment.create",
		actionParams: [
			{ name: "amount", value: "50.00" },
			{ name: "currency", value: "USD" },
		],
		actionSummary: "Pay for a domain",
	};

	it("accepts a concrete action with parameters", () => {
		expect(issuePaths(ApprovalRequestDraftSchema, draft)).toEqual([]);
	});

	it("rejects wildcards, empty or duplicate parameters, and a model-chosen risk level", () => {
		expect(issuePaths(ApprovalRequestDraftSchema, { ...draft, actionType: "finance.*" })).toEqual([
			"actionType",
		]);
		expect(issuePaths(ApprovalRequestDraftSchema, { ...draft, actionParams: [] })).toEqual([
			"actionParams",
		]);
		const duplicate = [...draft.actionParams, { name: "amount", value: "5000.00" }];
		expect(issuePaths(ApprovalRequestDraftSchema, { ...draft, actionParams: duplicate })).toEqual([
			"actionParams",
		]);
		expect(issuePaths(ApprovalRequestDraftSchema, { ...draft, riskLevel: "low" })).toEqual([""]);
	});

	it("accepts ordinary single-line parameter values", () => {
		for (const value of ["DE89 3704 0044 0532 0130 00", "5000.00", "José Müller", "ops@x.dev"]) {
			const params = [{ name: "recipient", value }];
			expect(
				issuePaths(ApprovalRequestDraftSchema, { ...draft, actionParams: params }),
				value,
			).toEqual([]);
		}
	});

	it("rejects parameter values that would render differently on the approval card", () => {
		for (const value of [
			"acct-\u202E1234",
			"pay\u2060pal.com",
			"\u2060",
			"pay\u200Dpal.com",
			"DE001\namount: 5.00",
			"DE001\tamount",
			"broken \uD800",
			"pay\uFE0Fpal",
			"pay\u{E0100}pal",
			"\u3164",
			"acct \u2800",
			"pay\u0336pal",
			"Jose\u0301",
			"acme ",
			" acme",
			"ac  me",
			"ｐａｙｐａｌ",
			"𝐩𝐚𝐲𝐩𝐚𝐥",
			"acct \uFFFC",
		]) {
			const spoofed = [{ name: "recipient", value }];
			expect(
				issuePaths(ApprovalRequestDraftSchema, { ...draft, actionParams: spoofed }),
				JSON.stringify(value),
			).toEqual(["actionParams.0.value"]);
		}
	});
});

describe("ApprovalRequest", () => {
	const pending: ApprovalRequest = {
		id: RUN_ID,
		requestedByAgentId: "finance",
		runId: RUN_ID,
		actionType: "finance.payment.create",
		actionParams: [{ name: "amount", value: "50.00" }],
		immutableActionHash: "a".repeat(64),
		actionSummary: "Pay for a domain",
		riskLevel: "high",
		status: "pending",
		allowedApproverUserIds: [USER_ID],
		nonce: "n".repeat(32),
		createdAt: "2026-09-24T14:00:00Z",
		expiresAt: "2026-09-25T14:00:00Z",
		decidedByUserId: null,
		decidedAt: null,
	};
	const granted: ApprovalRequest = {
		...pending,
		status: "granted",
		decidedByUserId: USER_ID,
		decidedAt: "2026-09-24T15:00:00Z",
	};

	it("accepts a pending request and a granted one decided by an allowlisted human", () => {
		expect(issuePaths(ApprovalRequestSchema, pending)).toEqual([]);
		expect(issuePaths(ApprovalRequestSchema, granted)).toEqual([]);
	});

	it.each([
		["granted without a decision", { ...pending, status: "granted" }, "decidedByUserId"],
		["executed without a decision", { ...pending, status: "executed" }, "decidedByUserId"],
		[
			"decided by a user outside the allowlist",
			{ ...granted, decidedByUserId: "x".repeat(26) },
			"decidedByUserId",
		],
		["decided after expiry", { ...granted, decidedAt: "2026-09-26T00:00:00Z" }, "decidedAt"],
		["decided before creation", { ...granted, decidedAt: "2026-09-23T00:00:00Z" }, "decidedAt"],
		["pending with a decision", { ...granted, status: "pending" }, "decidedByUserId"],
		["expiring before creation", { ...pending, expiresAt: "2026-09-23T00:00:00Z" }, "expiresAt"],
	])("rejects a request %s", (_, request, path) => {
		expect(issuePaths(ApprovalRequestSchema, request)).toEqual([path]);
	});
});

describe("GatewayEvent", () => {
	const event: GatewayEvent = {
		specversion: "1.0",
		id: `mattermost:post:${ROOT_ID}`,
		source: `mattermost://home/team/${CHANNEL_ID}`,
		type: "mattermost.post.created",
		time: "2026-09-24T14:00:00.000Z",
		datacontenttype: "application/json",
		correlationid: `thread:${ROOT_ID}`,
		causationid: null,
		trustlevel: "human-trusted",
		hop: 0,
		data: {
			post_id: ROOT_ID,
			root_id: null,
			channel_id: CHANNEL_ID,
			user_id: USER_ID,
			sender_agent_id: null,
			target_agent_ids: ["research"],
			message: "@research проверь рынок",
		},
	};

	it("accepts a CloudEvents envelope with normalized post data", () => {
		expect(issuePaths(GatewayEventSchema, event)).toEqual([]);
	});

	it("requires the fields wait matching relies on for Mattermost post events", () => {
		const { user_id: _, ...withoutSender } = event.data;
		expect(issuePaths(GatewayEventSchema, { ...event, data: withoutSender })).toEqual([
			"data.user_id",
		]);
	});

	it("requires a root post for thread replies", () => {
		const reply = { ...event, type: "mattermost.thread.reply" };
		expect(issuePaths(GatewayEventSchema, reply)).toEqual(["data.root_id"]);
		expect(
			issuePaths(GatewayEventSchema, { ...reply, data: { ...event.data, root_id: ROOT_ID } }),
		).toEqual([]);
	});

	it("labels posts by agent bots as internal-untrusted", () => {
		const botPost = { ...event, data: { ...event.data, sender_agent_id: "developer" } };
		expect(issuePaths(GatewayEventSchema, botPost)).toEqual(["trustlevel"]);
		expect(
			issuePaths(GatewayEventSchema, { ...botPost, trustlevel: "internal-untrusted" }),
		).toEqual([]);
	});

	it("never treats a Mattermost post as system-trusted", () => {
		expect(issuePaths(GatewayEventSchema, { ...event, trustlevel: "system-trusted" })).toEqual([
			"trustlevel",
		]);
	});

	it("rejects unknown event types and negative hops", () => {
		expect(issuePaths(GatewayEventSchema, { ...event, type: "mattermost.anything" })).toEqual([
			"type",
		]);
		expect(issuePaths(GatewayEventSchema, { ...event, hop: -1 })).toEqual(["hop"]);
	});
});

describe("wake rules", () => {
	it("allow subscriptions only outside Mattermost, and never on edits or reserved types", () => {
		const ok = (rule: object) => WakeRuleSchema.safeParse(rule).success;
		expect(ok({ event_type: "google.gmail.message.received" })).toBe(true);
		expect(ok({ event_type: "mattermost.agent.mentioned", target_agent_id: "developer" })).toBe(
			true,
		);
		expect(ok({ event_type: "mattermost.agent.mentioned" })).toBe(false);
		expect(ok({ event_type: "mattermost.post.created" })).toBe(false);
		expect(ok({ event_type: "mattermost.post.edited", target_agent_id: "developer" })).toBe(false);
		expect(ok({ event_type: "approval.granted", target_agent_id: "developer" })).toBe(false);
	});
});

describe("config schemas", () => {
	it.each(["all", "here", "channel", "ab-", "a--b", "-ab"])("rejects the agent id '%s'", (id) => {
		expect(AgentIdSchema.safeParse(id).success).toBe(false);
	});

	it("allows a wildcard only as the last tool segment", () => {
		expect(ToolPatternSchema.safeParse("finance.*").success).toBe(true);
		expect(ToolPatternSchema.safeParse("finance.*.create").success).toBe(false);
		expect(ToolPatternSchema.safeParse("*").success).toBe(false);
	});

	it.each([
		["the same tool", ["mail.read"], ["mail.read"]],
		["a tool covered by a wildcard", ["finance.payment.create"], ["finance.*"]],
	])("rejects allowing and denying %s", (_, tools_allow, tools_deny) => {
		const permissions = { tools_allow, tools_require_human_approval: [], tools_deny };
		expect(issuePaths(AgentPermissionsSchema, permissions)).toEqual(["tools_deny"]);
	});

	it.each(["/run/secrets/mm_finance_token", "prompts/../../run/secrets/x.md", "docs/role.md"])(
		"rejects the prompt path %s",
		(path) => {
			expect(PromptPathSchema.safeParse(path).success).toBe(false);
			expect(
				issuePaths(AgentConfigSchema, { ...agent("dev"), prompts: { role_file: path } }),
			).toEqual(["prompts.role_file"]);
		},
	);

	it("requires the approvals channel to be a managed channel", () => {
		const mattermost = { ...organization().mattermost, approvals_channel: "elsewhere" };
		expect(issuePaths(OrganizationMattermostSchema, mattermost)).toEqual(["approvals_channel"]);
	});
});

describe("validateConfigBundle", () => {
	it("reserves the routing key file", () => {
		const org = organization();
		const clash = agent("developer", {
			mattermost: {
				...agent("developer").mattermost,
				token_secret_file: "/run/secrets/gateway_routing_key",
			},
		});
		const issues = validateConfigBundle({ organization: org, agents: [clash, agent("finance")] });
		expect(issues.map((i) => i.message)).toContain(
			"token secret file '/run/secrets/gateway_routing_key' is used by another bot or the routing key",
		);
	});

	const finance = agent("finance", {
		permissions: {
			tools_allow: ["finance.read"],
			tools_require_human_approval: ["finance.payment.create"],
			tools_deny: [],
		},
	});
	const messages = (agents: Parameters<typeof validateConfigBundle>[0]["agents"]) =>
		validateConfigBundle({ organization: organization(), agents }).map((issue) => issue.message);

	it("accepts a consistent bundle", () => {
		expect(messages([finance, agent("developer")])).toEqual([]);
	});

	it("reports duplicate usernames, username/id mismatch and unmanaged channels", () => {
		const alpha = agent("alpha", {
			mattermost: { ...agent("alpha").mattermost, username: "beta" },
		});
		const beta = agent("beta", {
			mattermost: { ...agent("beta").mattermost, allowed_channels: ["engineering"] },
		});
		expect(messages([finance, alpha, beta])).toEqual([
			"Mattermost username 'beta' must equal the agent id",
			"duplicate Mattermost username 'beta'",
			"channel 'engineering' is not listed in organization mattermost.channels",
		]);
	});

	it("keeps finance tools with the finance agent only", () => {
		const developer = agent("developer", {
			permissions: {
				tools_allow: ["finance.payment.create"],
				tools_require_human_approval: [],
				tools_deny: ["deploy.*"],
			},
		});
		expect(messages([finance, developer])).toEqual([
			"only 'finance' may hold finance tools, found 'finance.payment.create'",
			"tools_deny must contain 'finance.*'",
		]);
	});

	it("requires human approval for every finance action except reads", () => {
		const autonomous = agent("finance", {
			permissions: { tools_allow: ["finance.*"], tools_require_human_approval: [], tools_deny: [] },
		});
		expect(messages([autonomous])).toEqual([
			"finance action 'finance.*' must be in tools_require_human_approval, not tools_allow",
		]);
	});

	it("requires the finance agent to exist", () => {
		expect(messages([agent("developer")])).toEqual([
			"finance_agent_id 'finance' has no agent definition",
		]);
	});
});
