import type { AgentPermissions } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import {
	builtInEditProblems,
	computeCatalogEntryAvailability,
	editCatalogEntryInputProblems,
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

describe("editCatalogEntryInputProblems", () => {
	const base = { entryId: "custom-thing", actor: "test" };

	it("accepts a fully unset edit (nothing to change)", () => {
		expect(editCatalogEntryInputProblems(base)).toEqual([]);
	});

	it("accepts every field within its own bound", () => {
		expect(
			editCatalogEntryInputProblems({
				...base,
				name: "Name",
				description: "Description.",
				configSchema: { type: "object" },
				riskFloor: "require_approval",
				supportedAdapters: ["mock", "codex"],
			}),
		).toEqual([]);
	});

	it("rejects an empty name and an empty description", () => {
		const problems = editCatalogEntryInputProblems({ ...base, name: "", description: "" });
		expect(problems.some((p) => p.startsWith("name:"))).toBe(true);
		expect(problems.some((p) => p.startsWith("description:"))).toBe(true);
	});

	it("rejects a name over its bound", () => {
		expect(
			editCatalogEntryInputProblems({ ...base, name: "x".repeat(101) }).some((p) =>
				p.startsWith("name:"),
			),
		).toBe(true);
	});

	it("rejects an unknown riskFloor", () => {
		// A caller's `EditCatalogEntryInput` is a plain TypeScript type, never itself runtime-checked
		// (this function's whole point) — parsed here from an untyped source, exactly as a console or
		// CLI request body would arrive, so this exercises the runtime check the type system itself
		// cannot.
		const untyped: unknown = JSON.parse(JSON.stringify({ ...base, riskFloor: "sometimes" }));
		const problems = editCatalogEntryInputProblems(
			untyped as Parameters<typeof editCatalogEntryInputProblems>[0],
		);
		expect(problems.some((p) => p.startsWith("riskFloor:"))).toBe(true);
	});

	it("rejects more supportedAdapters than the bound allows", () => {
		const problems = editCatalogEntryInputProblems({
			...base,
			supportedAdapters: Array.from({ length: 17 }, () => "mock" as const),
		});
		expect(problems.some((p) => p.startsWith("supportedAdapters:"))).toBe(true);
	});

	it("rejects a configSchema over its serialized-size bound", () => {
		const problems = editCatalogEntryInputProblems({
			...base,
			configSchema: { huge: "x".repeat(20_001) },
		});
		expect(problems.some((p) => p.startsWith("configSchema:"))).toBe(true);
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
				registeredNamespaces: new Set(),
			}),
		).toBe(true);
		expect(
			computeCatalogEntryAvailability(entry, {
				installedAdapters: new Set(["grok"]),
				registeredExecutorActionTypes: new Set(),
				registeredNamespaces: new Set(),
			}),
		).toBe(false);
	});

	it("a gateway entry is always available", () => {
		expect(
			computeCatalogEntryAvailability(
				{ kind: "gateway", implementationKey: "mattermost.post", supportedAdapters: [] },
				{
					installedAdapters: new Set(),
					registeredExecutorActionTypes: new Set(),
					registeredNamespaces: new Set(),
				},
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
				registeredNamespaces: new Set(),
			}),
		).toBe(false);
		expect(
			computeCatalogEntryAvailability(entry, {
				installedAdapters: new Set(),
				registeredExecutorActionTypes: new Set(["finance.payment.create"]),
				registeredNamespaces: new Set(),
			}),
		).toBe(true);
	});

	it("a utility entry is unavailable until its action type is actually registered", () => {
		const entry = {
			kind: "utility" as const,
			implementationKey: "utility.text-transform",
			supportedAdapters: [],
		};
		expect(
			computeCatalogEntryAvailability(entry, {
				installedAdapters: new Set(),
				registeredExecutorActionTypes: new Set(),
				registeredNamespaces: new Set(),
			}),
		).toBe(false);
		expect(
			computeCatalogEntryAvailability(entry, {
				installedAdapters: new Set(),
				registeredExecutorActionTypes: new Set(["utility.text-transform"]),
				registeredNamespaces: new Set(),
			}),
		).toBe(true);
	});

	it("a custom_https entry is available once a tool runner serves the 'custom' namespace", () => {
		const entry = {
			kind: "custom_https" as const,
			implementationKey: "custom.whatever",
			supportedAdapters: [],
		};
		expect(
			computeCatalogEntryAvailability(entry, {
				installedAdapters: new Set(["mock", "codex"]),
				registeredExecutorActionTypes: new Set(["custom.whatever"]),
				registeredNamespaces: new Set(),
			}),
		).toBe(false);
		expect(
			computeCatalogEntryAvailability(entry, {
				installedAdapters: new Set(),
				registeredExecutorActionTypes: new Set(),
				registeredNamespaces: new Set(["custom"]),
			}),
		).toBe(true);
	});
});
