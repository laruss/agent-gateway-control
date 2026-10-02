import type { ChangePreview } from "@agent-gateway/core";
import { describe, expect, it } from "vitest";
import { formatConfigDiff } from "./config-commands.ts";

function preview(overrides: Partial<ChangePreview> = {}): ChangePreview {
	return {
		baseRevisionId: 1,
		baseHash: "a".repeat(64),
		newHash: "b".repeat(64),
		noop: false,
		diff: {
			agents: [],
			organizationFieldPaths: [],
			constitution: { changed: false, beforeSize: 11, afterSize: 11 },
			toolAttachments: [],
		},
		problems: [],
		...overrides,
	};
}

describe("formatConfigDiff: attachment changes (ADR-027)", () => {
	it("renders nothing extra when no attachment changed", () => {
		expect(formatConfigDiff(preview())).not.toMatch(/attachments:/);
	});

	it("renders an added, a removed and a changed attachment, each on its own line", () => {
		const text = formatConfigDiff(
			preview({
				diff: {
					agents: [],
					organizationFieldPaths: [],
					constitution: { changed: false, beforeSize: 11, afterSize: 11 },
					toolAttachments: [
						{ kind: "added", agentId: "director", entryId: "gateway-mattermost-post" },
						{ kind: "removed", agentId: "director", entryId: "native-web-search" },
						{
							kind: "changed",
							agentId: "editor",
							entryId: "gateway-memory-write",
							fields: ["mode", "settings"],
						},
					],
				},
			}),
		);
		expect(text).toMatch(/attachments:/);
		expect(text).toMatch(/\+ director: gateway-mattermost-post \(added\)/);
		expect(text).toMatch(/- director: native-web-search \(removed\)/);
		expect(text).toMatch(/~ editor: gateway-memory-write \(mode, settings\)/);
	});
});
