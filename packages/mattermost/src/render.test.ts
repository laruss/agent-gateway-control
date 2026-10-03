import type { MattermostApprovalPayload } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import { renderApprovalCard } from "./render.ts";

function card(overrides: Partial<MattermostApprovalPayload> = {}): MattermostApprovalPayload {
	return {
		approvalId: "0d7bc6f6-58a4-4a4b-8b7e-8b7c1f0d0a11",
		channelName: "hq",
		channelId: "hqchanne1000000000000000aa",
		requestedByAgentId: "finance",
		actionType: "custom.ticket-tool",
		actionSummary: "Files a support ticket for the customer.",
		actionParams: [{ name: "priority", value: "high" }],
		riskLevel: "medium",
		immutableActionHash: "a".repeat(64),
		expiresAt: "2026-01-01T00:00:00.000Z",
		approvalCode: "ABCD-EFGH-JKLM",
		...overrides,
	};
}

describe("renderApprovalCard", () => {
	it("has no request-preview block when customRequestPreview is absent (a non-custom action)", () => {
		const rendered = renderApprovalCard(card());
		expect(rendered).not.toContain("Request preview");
	});

	it("renders the preview in its own block, after the parameters and before any warning, separate from the model's summary", () => {
		const preview =
			"POST https://api.example.com/tickets?priority=high headers=[x-api-key(secret)]";
		const rendered = renderApprovalCard(card({ customRequestPreview: preview }));
		expect(rendered).toContain("Request preview (authoritative; no secret value is ever shown):");
		expect(rendered).toContain(preview);
		const summaryIndex = rendered.indexOf("Summary (written by the agent):");
		const paramsIndex = rendered.indexOf("Parameters (covered by the approval hash):");
		const previewIndex = rendered.indexOf("Request preview");
		expect(summaryIndex).toBeGreaterThanOrEqual(0);
		expect(paramsIndex).toBeGreaterThan(summaryIndex);
		expect(previewIndex).toBeGreaterThan(paramsIndex);
	});

	it("never lets a secret-filled slot's value appear, only its name, in a realistic preview", () => {
		// `customRequestSummary` (packages/policy/src/custom-tool.ts) is what actually builds this
		// string and is unit-tested there to never include a secret value — this only confirms the
		// card renders whatever string it is given verbatim, inside its own fenced block, without
		// stripping or otherwise mangling the `<secret>`/`(secret)` markers that guarantee is built
		// on.
		const preview =
			"GET https://api.example.com/status?key=<secret> headers=[authorization(secret)]";
		const rendered = renderApprovalCard(card({ customRequestPreview: preview }));
		expect(rendered).toContain("<secret>");
		expect(rendered).toContain("authorization(secret)");
		expect(rendered).not.toMatch(/key=[0-9a-zA-Z]{8,}/);
	});
});
