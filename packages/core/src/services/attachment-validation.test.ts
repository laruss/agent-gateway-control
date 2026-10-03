import type { ToolAttachment } from "@agent-gateway/contracts";
import type { CompiledCatalogEntry } from "@agent-gateway/policy";
import { describe, expect, it } from "vitest";
import { widenedByRemovingAttachment } from "./attachment-validation.ts";

const CATALOG = new Map<string, CompiledCatalogEntry>([
	["native-repository-read", { kind: "native", implementationKey: "repository.read" }],
	["native-workspace-write", { kind: "native", implementationKey: "workspace.write" }],
	["native-tests-run", { kind: "native", implementationKey: "tests.run" }],
	["native-web-search", { kind: "native", implementationKey: "web.search" }],
	[
		"executor-finance-payment-create",
		{ kind: "executor", implementationKey: "finance.payment.create" },
	],
]);

function attachment(entryId: string, mode: ToolAttachment["mode"]): ToolAttachment {
	return { entryId, pinnedVersion: null, mode, settings: {} };
}

const BASE = { agentId: "developer", financeAgentId: "finance", adapter: "mock" as const };

describe("widenedByRemovingAttachment", () => {
	it("is empty when removing an attachment that suppresses nothing", () => {
		const widened = widenedByRemovingAttachment({
			...BASE,
			attachments: [attachment("native-web-search", "disabled")],
			entryId: "native-web-search",
			catalog: CATALOG,
		});
		expect(widened).toEqual([]);
	});

	it("reports the implied tool a disabled attachment was suppressing, once that attachment is removed", () => {
		// `workspace.write` is explicitly `disabled` here, which wins over `tests.run`'s own
		// implication (`compileAttachments`'s "an explicit restriction on the implied tool wins"
		// rule) — removing the `workspace.write` attachment leaves nothing governing it explicitly,
		// so `tests.run`'s implication lets it through.
		const widened = widenedByRemovingAttachment({
			...BASE,
			attachments: [
				attachment("native-tests-run", "allow"),
				attachment("native-workspace-write", "disabled"),
			],
			entryId: "native-workspace-write",
			catalog: CATALOG,
		});
		expect(widened).toEqual(["workspace.write"]);
	});

	it("reports nothing when removing the attachment that does the implying, rather than the one being implied", () => {
		// Removing `tests.run` itself only ever narrows (nothing implies `workspace.write`/
		// `repository.read` any more); it must never show up as a widening.
		const widened = widenedByRemovingAttachment({
			...BASE,
			attachments: [attachment("native-tests-run", "allow")],
			entryId: "native-tests-run",
			catalog: CATALOG,
		});
		expect(widened).toEqual([]);
	});

	it("a finance entry held by a non-finance agent contributes nothing either way, so removing it changes nothing", () => {
		const widened = widenedByRemovingAttachment({
			...BASE,
			// `agentId` ("developer") is not `financeAgentId` ("finance"): `compileAttachments`
			// already excludes a finance entry's attachment for every agent but the finance agent,
			// as though it were never attached at all — before and after are identical.
			attachments: [attachment("executor-finance-payment-create", "require_approval")],
			entryId: "executor-finance-payment-create",
			catalog: CATALOG,
		});
		expect(widened).toEqual([]);
	});
});
