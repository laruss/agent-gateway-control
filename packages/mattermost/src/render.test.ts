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

	it("shrinks only the summary so the whole card never exceeds Mattermost's own post limit, leaving the full preview and parameters untouched (ADR-027)", () => {
		const MATTERMOST_POST_MAX = 16_383;
		// A percent-encoded CJK path segment (each character three UTF-8 bytes, nine characters once
		// percent-encoded), comfortably under the preview's own 4000-character field bound, alongside
		// a summary large enough on its own (the same defensive, over-realistic sizing the old
		// truncation test used) that the full card overflows unless something gives way — never the
		// preview, never the parameters (already bounded, refused rather than trimmed, before the
		// request is ever created): only the model's own summary is ever shortened here.
		const summary = "A".repeat(14_000);
		const paramValue = "ticket-123";
		const preview = `GET https://api.example.com/items/${"%E4%B8%AD".repeat(400)}`;
		expect(preview.length).toBeLessThan(4000);
		const bigCard = card({
			actionSummary: summary,
			actionParams: [{ name: "note", value: paramValue }],
			customRequestPreview: preview,
		});
		const rendered = renderApprovalCard(bigCard);
		expect(rendered.length).toBeLessThanOrEqual(MATTERMOST_POST_MAX);
		// The preview and the parameters survive exactly as given — never cut.
		expect(rendered).toContain(preview);
		expect(rendered).toContain(paramValue);
		// The summary no longer appears in full: it was the only thing shortened.
		expect(rendered).not.toContain(summary);
	});

	it("renders a short, non-approvable notice instead of an approvable card, once even dropping the summary entirely still does not fit (data from before ADR-027's full-card-fit rule)", () => {
		// Six 1900-character header-slot parameter values and one 2000-character body-slot value,
		// alongside a preview near its own 4000-character field bound: individually within every
		// bound this release enforces at request time, yet together too large for one Mattermost
		// post even with the summary dropped entirely — the one shape this release's own
		// request-time check (`@agent-gateway/core`) now refuses before it is ever stored, so this
		// is reachable here only as data a release before that rule existed already created.
		const actionParams = [
			{ name: "h1", value: "x".repeat(1900) },
			{ name: "h2", value: "x".repeat(1900) },
			{ name: "h3", value: "x".repeat(1900) },
			{ name: "h4", value: "x".repeat(1900) },
			{ name: "h5", value: "x".repeat(1900) },
			{ name: "h6", value: "x".repeat(1900) },
			{ name: "body1", value: "x".repeat(2000) },
		];
		const preview = "P".repeat(4000);
		const legacyCard = card({
			actionSummary: "short",
			actionParams,
			customRequestPreview: preview,
		});
		const rendered = renderApprovalCard(legacyCard);
		expect(rendered.length).toBeLessThanOrEqual(16_383);
		// Never the oversized preview or parameters an owner could not actually review in full.
		expect(rendered).not.toContain(preview);
		expect(rendered).not.toContain("x".repeat(1900));
		// Never an approve/deny instruction bound to a code: nothing here can be approved.
		expect(rendered).not.toContain(legacyCard.approvalCode);
		expect(rendered.toLowerCase()).toContain("too large");
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
