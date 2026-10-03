import type { ApprovalRequestDraft, RiskLevel } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import { buildApprovalCard } from "./runs.ts";

function draft(overrides: Partial<ApprovalRequestDraft> = {}): ApprovalRequestDraft {
	return {
		actionType: "workspace.write",
		actionSummary: "Writes a file.",
		actionParams: [{ name: "path", value: "a.txt" }],
		...overrides,
	};
}

/** A deterministic, already-valid identity — the shape `prepareApprovalIdentity` always produces,
 * hand-built here so these tests never depend on its own randomness. */
const IDENTITY = {
	approvalId: "6b2f9e7a-1c3d-4e5f-8a6b-7c8d9e0f1a2b",
	nonce: "a".repeat(32),
	immutableActionHash: "a".repeat(64),
	riskLevel: "medium" as RiskLevel,
	expiresAt: new Date("2026-01-01T00:00:00.000Z"),
	approvalCode: "ABCD-ABCD-ABCD",
};

describe("buildApprovalCard (ADR-027)", () => {
	it("builds a valid card for an ordinary native-tool approval request", () => {
		const result = buildApprovalCard({
			identity: IDENTITY,
			agentId: "finance",
			draft: draft(),
			channelName: "approvals",
			channelId: "a".repeat(26),
			customRequestPreview: null,
		});
		expect(result).toMatchObject({
			kind: "ok",
			card: { approvalId: IDENTITY.approvalId, requestedByAgentId: "finance" },
		});
	});

	it("carries a custom tool's own request preview when given one", () => {
		const result = buildApprovalCard({
			identity: IDENTITY,
			agentId: "finance",
			draft: draft({ actionType: "custom.zendesk" }),
			channelName: "approvals",
			channelId: null,
			customRequestPreview: "POST https://api.example.com/tickets",
		});
		expect(result).toMatchObject({
			kind: "ok",
			card: { customRequestPreview: "POST https://api.example.com/tickets" },
		});
	});

	it(
		"reports 'invalid' instead of throwing a raw ZodError when the assembled card fails " +
			"MattermostApprovalPayloadSchema — a defensive backstop (ADR-027): every caller already " +
			"guarantees a valid draft (`ApprovalRequestDraftSchema`'s own refine requires at least one " +
			"parameter for any non-custom action type), so this exercises the schema disagreement " +
			"directly rather than relying on finding a way past that caller",
		() => {
			const result = buildApprovalCard({
				identity: IDENTITY,
				agentId: "finance",
				// `ApprovalRequestDraftSchema` itself would refuse an empty `actionParams` for a
				// non-custom action type; `buildApprovalCard` takes an already-typed draft and never
				// re-validates that refinement, so a draft a future caller builds without going
				// through that schema is exactly the drift this guards against.
				draft: draft({ actionParams: [] }),
				channelName: "approvals",
				channelId: "a".repeat(26),
				customRequestPreview: null,
			});
			expect(result.kind).toBe("invalid");
			if (result.kind === "invalid") {
				expect(result.detail.length).toBeGreaterThan(0);
			}
		},
	);

	it("reports 'invalid' for a channel id that is not a well-formed Mattermost id", () => {
		const result = buildApprovalCard({
			identity: IDENTITY,
			agentId: "finance",
			draft: draft(),
			channelName: "approvals",
			channelId: "not-a-valid-mattermost-id",
			customRequestPreview: null,
		});
		expect(result).toMatchObject({ kind: "invalid" });
	});
});
