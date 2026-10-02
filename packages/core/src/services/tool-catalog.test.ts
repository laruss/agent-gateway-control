import type { AgentPermissions } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import {
	builtInEditProblems,
	computeCatalogEntryAvailability,
	type KnownCatalogEntry,
	legacyAttachmentsFromPermissions,
	riskFloorAllows,
} from "./tool-catalog.ts";

function permissions(overrides: Partial<AgentPermissions> = {}): AgentPermissions {
	return {
		tools_allow: [],
		tools_require_human_approval: [],
		tools_deny: [],
		...overrides,
	};
}

const KNOWN: Readonly<KnownCatalogEntry[]> = [
	{ id: "gateway-mattermost-post", implementationKey: "mattermost.post" },
	{ id: "gateway-memory-write", implementationKey: "memory.write" },
	{ id: "executor-finance-payment-create", implementationKey: "finance.payment.create" },
	{ id: "executor-finance-subscription-create", implementationKey: "finance.subscription.create" },
];

describe("legacyAttachmentsFromPermissions", () => {
	it("maps an exact allow pattern to an 'allow' attachment", () => {
		const { attachments, unresolved } = legacyAttachmentsFromPermissions(
			permissions({ tools_allow: ["mattermost.post"] }),
			KNOWN,
		);
		expect(unresolved).toEqual([]);
		expect(attachments).toEqual([
			{ entryId: "gateway-mattermost-post", pinnedVersion: null, mode: "allow", settings: {} },
		]);
	});

	it("expands a wildcard only against currently known entries", () => {
		const { attachments, unresolved } = legacyAttachmentsFromPermissions(
			permissions({ tools_require_human_approval: ["finance.*"] }),
			KNOWN,
		);
		expect(unresolved).toEqual([]);
		expect(attachments.map((a) => a.entryId).sort()).toEqual([
			"executor-finance-payment-create",
			"executor-finance-subscription-create",
		]);
		expect(attachments.every((a) => a.mode === "require_approval")).toBe(true);
	});

	it("never auto-grants a future entry: a wildcard expands only against entries known right now", () => {
		const { attachments } = legacyAttachmentsFromPermissions(
			permissions({ tools_allow: ["mattermost.*"] }),
			// `mattermost.reaction` is a plausible future entry; not in `KNOWN` today.
			KNOWN.filter((entry) => entry.implementationKey !== "mattermost.post"),
		);
		expect(attachments).toEqual([]);
	});

	it("keeps a pattern matching no known entry visibly unresolved, never dropped", () => {
		const { attachments, unresolved } = legacyAttachmentsFromPermissions(
			permissions({ tools_allow: ["web.fetch"] }),
			KNOWN,
		);
		expect(attachments).toEqual([]);
		expect(unresolved).toEqual([{ list: "tools_allow", pattern: "web.fetch" }]);
	});

	it("maps tools_deny to a 'disabled' attachment", () => {
		const { attachments } = legacyAttachmentsFromPermissions(
			permissions({ tools_deny: ["memory.write"] }),
			KNOWN,
		);
		expect(attachments).toEqual([
			{ entryId: "gateway-memory-write", pinnedVersion: null, mode: "disabled", settings: {} },
		]);
	});

	it("honours finance rules: the finance agent's own permissions convert to require_approval, not allow", () => {
		// The shape `defaultAgentPermissions`/`financeIssues` (config-bundle.ts) actually produce: a
		// non-finance agent denies `finance.*` wholesale; the finance agent itself requires approval
		// for a finance write (never bare `tools_allow`) and may only `tools_allow` a finance *read*.
		const nonFinance = legacyAttachmentsFromPermissions(
			permissions({ tools_deny: ["finance.*"] }),
			KNOWN,
		);
		expect(nonFinance.attachments.every((a) => a.mode === "disabled")).toBe(true);
		expect(nonFinance.attachments).toHaveLength(2);

		const financeAgent = legacyAttachmentsFromPermissions(
			permissions({
				tools_require_human_approval: ["finance.payment.create", "finance.subscription.create"],
			}),
			KNOWN,
		);
		expect(financeAgent.attachments.every((a) => a.mode === "require_approval")).toBe(true);
		expect(financeAgent.attachments).toHaveLength(2);
	});

	it("produces no attachment twice: overlapping patterns are never valid input in the first place", () => {
		// `AgentPermissionsSchema`'s own check already refuses this; this is just confirming the
		// conversion itself does not need to defend against it a second time to stay correct.
		const { attachments } = legacyAttachmentsFromPermissions(
			permissions({ tools_allow: ["mattermost.post", "memory.write"] }),
			KNOWN,
		);
		const ids = attachments.map((a) => a.entryId);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("builtInEditProblems", () => {
	it("allows a built-in's name/description to change", () => {
		expect(builtInEditProblems({})).toEqual([]);
	});

	it("refuses changing a built-in's configSchema, riskFloor or supportedAdapters", () => {
		const problems = builtInEditProblems({
			configSchema: { type: "object" },
			riskFloor: "allow",
			supportedAdapters: ["mock"],
		});
		expect(problems).toHaveLength(3);
		expect(problems.join(" ")).toMatch(/configSchema/);
		expect(problems.join(" ")).toMatch(/riskFloor/);
		expect(problems.join(" ")).toMatch(/supportedAdapters/);
	});
});

describe("riskFloorAllows", () => {
	it("refuses 'allow' once the floor is 'require_approval'", () => {
		expect(riskFloorAllows("allow", "require_approval")).toBe(false);
		expect(riskFloorAllows("require_approval", "require_approval")).toBe(true);
		expect(riskFloorAllows("disabled", "require_approval")).toBe(true);
	});

	it("places no floor at all when it is 'allow'", () => {
		expect(riskFloorAllows("allow", "allow")).toBe(true);
		expect(riskFloorAllows("require_approval", "allow")).toBe(true);
		expect(riskFloorAllows("disabled", "allow")).toBe(true);
	});
});

describe("computeCatalogEntryAvailability", () => {
	it("a native entry is available once at least one of its supported adapters is installed", () => {
		const entry = {
			kind: "native" as const,
			implementationKey: "repository.read",
			supportedAdapters: ["codex", "claude-code"] as const,
		};
		expect(
			computeCatalogEntryAvailability(entry, {
				installedAdapters: new Set(["claude-code"]),
				registeredExecutorActionTypes: new Set(),
			}),
		).toBe(true);
		expect(
			computeCatalogEntryAvailability(entry, {
				installedAdapters: new Set(["grok"]),
				registeredExecutorActionTypes: new Set(),
			}),
		).toBe(false);
	});

	it("a gateway entry is always available", () => {
		expect(
			computeCatalogEntryAvailability(
				{ kind: "gateway", implementationKey: "mattermost.post", supportedAdapters: [] },
				{ installedAdapters: new Set(), registeredExecutorActionTypes: new Set() },
			),
		).toBe(true);
	});

	it("an executor entry is unavailable until its action type is actually registered", () => {
		const entry = {
			kind: "executor" as const,
			implementationKey: "finance.payment.create",
			supportedAdapters: [],
		};
		expect(
			computeCatalogEntryAvailability(entry, {
				installedAdapters: new Set(),
				registeredExecutorActionTypes: new Set(),
			}),
		).toBe(false);
		expect(
			computeCatalogEntryAvailability(entry, {
				installedAdapters: new Set(),
				registeredExecutorActionTypes: new Set(["finance.payment.create"]),
			}),
		).toBe(true);
	});

	it("a custom_https entry is never available yet (reserved, no definitions ship this release)", () => {
		expect(
			computeCatalogEntryAvailability(
				{ kind: "custom_https", implementationKey: "custom.whatever", supportedAdapters: [] },
				{
					installedAdapters: new Set(["mock", "codex"]),
					registeredExecutorActionTypes: new Set(["custom.whatever"]),
				},
			),
		).toBe(false);
	});
});
