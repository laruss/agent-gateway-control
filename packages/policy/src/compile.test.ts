import type { ToolAttachment } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import {
	type CompiledCatalogEntry,
	compileAttachments,
	compiledAgentPermissions,
	compiledToolPolicyLists,
	describeWidenedTools,
	modeSupportedByKind,
	widenedTools,
} from "./compile.ts";

const CATALOG = new Map<string, CompiledCatalogEntry>([
	["native-repository-read", { kind: "native", implementationKey: "repository.read" }],
	["native-workspace-write", { kind: "native", implementationKey: "workspace.write" }],
	["native-tests-run", { kind: "native", implementationKey: "tests.run" }],
	["native-web-search", { kind: "native", implementationKey: "web.search" }],
	["gateway-mattermost-post", { kind: "gateway", implementationKey: "mattermost.post" }],
	["gateway-memory-write", { kind: "gateway", implementationKey: "memory.write" }],
	[
		"executor-finance-payment-create",
		{ kind: "executor", implementationKey: "finance.payment.create" },
	],
	[
		"executor-finance-subscription-create",
		{ kind: "executor", implementationKey: "finance.subscription.create" },
	],
]);

function attachment(entryId: string, mode: ToolAttachment["mode"]): ToolAttachment {
	return { entryId, pinnedVersion: null, mode, settings: {} };
}

const BASE = { agentId: "developer", financeAgentId: "finance", adapter: "mock" as const };

describe("compileAttachments", () => {
	it("compiles disjoint allow/requireApproval/deny from each attachment's own mode", () => {
		const compiled = compileAttachments({
			...BASE,
			attachments: [
				attachment("native-repository-read", "allow"),
				attachment("gateway-mattermost-post", "allow"),
				attachment("native-web-search", "disabled"),
			],
			catalog: CATALOG,
		});
		expect(compiled.allow).toEqual(["mattermost.post", "repository.read"]);
		expect(compiled.requireApproval).toEqual([]);
		// `memory.write` is always explicit (never attached here, so not allowed): see the
		// dedicated memory.write test below for why it still appears in `deny`.
		expect(compiled.deny).toEqual(["memory.write", "web.search"]);
	});

	it("an unknown or deleted entry id contributes nothing (fail-closed)", () => {
		const compiled = compileAttachments({
			...BASE,
			attachments: [attachment("entry-does-not-exist", "allow")],
			catalog: CATALOG,
		});
		expect(compiled.allow).toEqual([]);
	});

	describe("native dependencies (data, not scattered ifs)", () => {
		it("tests.run implies repository.read and workspace.write, recorded in impliedBy", () => {
			const compiled = compileAttachments({
				...BASE,
				attachments: [attachment("native-tests-run", "allow")],
				catalog: CATALOG,
			});
			expect(compiled.allow).toEqual(["repository.read", "tests.run", "workspace.write"]);
			expect(compiled.impliedBy["repository.read"]).toEqual(["tests.run", "workspace.write"]);
			expect(compiled.impliedBy["workspace.write"]).toEqual(["tests.run"]);
		});

		it("workspace.write alone implies repository.read only", () => {
			const compiled = compileAttachments({
				...BASE,
				attachments: [attachment("native-workspace-write", "allow")],
				catalog: CATALOG,
			});
			expect(compiled.allow).toEqual(["repository.read", "workspace.write"]);
			expect(compiled.impliedBy["repository.read"]).toEqual(["workspace.write"]);
		});

		it("an explicit deny of the implied tool wins over the implication", () => {
			const compiled = compileAttachments({
				...BASE,
				attachments: [
					attachment("native-tests-run", "allow"),
					attachment("native-repository-read", "disabled"),
				],
				catalog: CATALOG,
			});
			expect(compiled.allow).toEqual(["tests.run", "workspace.write"]);
			expect(compiled.deny).toContain("repository.read");
			expect(compiled.impliedBy["repository.read"]).toBeUndefined();
		});

		it("never grants an implied tool whose own catalog entry is deleted (absent from `catalog`), reporting it as a missing prerequisite instead (ADR-027)", () => {
			// `native-workspace-write` deleted (absent here, unlike `CATALOG`): nobody holds it, but
			// `native-tests-run` is still attached and still implies `workspace.write` by name alone.
			const catalogWithoutWorkspaceWrite = new Map(CATALOG);
			catalogWithoutWorkspaceWrite.delete("native-workspace-write");
			const compiled = compileAttachments({
				...BASE,
				attachments: [attachment("native-tests-run", "allow")],
				catalog: catalogWithoutWorkspaceWrite,
			});
			// `repository.read` is still granted: `tests.run` implies it directly, and its own entry
			// is still live — only `workspace.write`'s own deleted entry is withheld.
			expect(compiled.allow).toEqual(["repository.read", "tests.run"]);
			expect(compiled.allow).not.toContain("workspace.write");
			expect(compiled.impliedBy["workspace.write"]).toBeUndefined();
			expect(compiled.missingPrerequisites["tests.run"]).toEqual(["workspace.write"]);
		});

		it("still withholds a transitively-implied tool once its own direct implier's entry is also deleted", () => {
			// Neither `workspace.write` nor `repository.read` has a live entry at all: `tests.run`
			// implies both directly (`NATIVE_TOOL_DEPENDENCIES["tests.run"]`), so both are withheld,
			// not merely the one `workspace.write` would have transitively implied.
			const onlyTestsRun = new Map(CATALOG);
			onlyTestsRun.delete("native-workspace-write");
			onlyTestsRun.delete("native-repository-read");
			const compiled = compileAttachments({
				...BASE,
				attachments: [attachment("native-tests-run", "allow")],
				catalog: onlyTestsRun,
			});
			expect(compiled.allow).toEqual(["tests.run"]);
			expect(compiled.missingPrerequisites["tests.run"]?.slice().sort()).toEqual([
				"repository.read",
				"workspace.write",
			]);
		});
	});

	describe("adapter-specific prerequisites", () => {
		it("surfaces a Codex agent's missing shell prerequisite for repository.read, without removing the grant", () => {
			const compiled = compileAttachments({
				agentId: "developer",
				financeAgentId: "finance",
				adapter: "codex",
				attachments: [attachment("native-repository-read", "allow")],
				catalog: CATALOG,
			});
			expect(compiled.allow).toContain("repository.read");
			expect(compiled.missingPrerequisites["repository.read"]).toEqual(["tests.run"]);
		});

		it("no missing prerequisite once tests.run is also allowed", () => {
			const compiled = compileAttachments({
				agentId: "developer",
				financeAgentId: "finance",
				adapter: "codex",
				attachments: [
					attachment("native-repository-read", "allow"),
					attachment("native-tests-run", "allow"),
				],
				catalog: CATALOG,
			});
			expect(compiled.missingPrerequisites["repository.read"]).toBeUndefined();
		});

		it("another adapter (e.g. claude-code) has no such prerequisite", () => {
			const compiled = compileAttachments({
				agentId: "developer",
				financeAgentId: "finance",
				adapter: "claude-code",
				attachments: [attachment("native-repository-read", "allow")],
				catalog: CATALOG,
			});
			expect(compiled.missingPrerequisites).toEqual({});
		});
	});

	describe("memory.write authority", () => {
		it("memoryWriteAllowed is true only when attached with mode allow", () => {
			const allowed = compileAttachments({
				...BASE,
				attachments: [attachment("gateway-memory-write", "allow")],
				catalog: CATALOG,
			});
			expect(allowed.memoryWriteAllowed).toBe(true);
			expect(allowed.allow).toContain("memory.write");
			expect(allowed.deny).not.toContain("memory.write");
		});

		it("memoryWriteAllowed is false, and deny names it explicitly, when never attached", () => {
			const compiled = compileAttachments({
				...BASE,
				attachments: [],
				catalog: CATALOG,
			});
			expect(compiled.memoryWriteAllowed).toBe(false);
			expect(compiled.deny).toEqual(["memory.write"]);
		});

		it("memoryWriteAllowed is false, and deny still names it, when explicitly disabled", () => {
			const compiled = compileAttachments({
				...BASE,
				attachments: [attachment("gateway-memory-write", "disabled")],
				catalog: CATALOG,
			});
			expect(compiled.memoryWriteAllowed).toBe(false);
			expect(compiled.deny).toEqual(["memory.write"]);
		});
	});

	describe("finance exclusivity", () => {
		it("a finance attachment held by a non-finance agent contributes nothing at all", () => {
			const compiled = compileAttachments({
				agentId: "developer",
				financeAgentId: "finance",
				adapter: "mock",
				attachments: [attachment("executor-finance-payment-create", "require_approval")],
				catalog: CATALOG,
			});
			expect(compiled.allow).toEqual([]);
			expect(compiled.requireApproval).toEqual([]);
			expect(compiled.deny).toEqual(["memory.write"]);
		});

		it("the finance agent itself compiles its own finance attachments normally", () => {
			const compiled = compileAttachments({
				agentId: "finance",
				financeAgentId: "finance",
				adapter: "mock",
				attachments: [attachment("executor-finance-payment-create", "require_approval")],
				catalog: CATALOG,
			});
			expect(compiled.requireApproval).toEqual(["finance.payment.create"]);
		});
	});
});

describe("compiledToolPolicyLists", () => {
	it("relabels the compiled result as a ToolPolicySnapshot's own three lists", () => {
		const compiled = compileAttachments({
			...BASE,
			attachments: [attachment("native-repository-read", "allow")],
			catalog: CATALOG,
		});
		expect(compiledToolPolicyLists(compiled)).toEqual({
			allow: compiled.allow,
			requireHumanApproval: compiled.requireApproval,
			deny: compiled.deny,
		});
	});
});

describe("compiledAgentPermissions (the bundle-mirror invariant, ADR-027)", () => {
	it("adds a 'finance.*' wildcard to tools_deny for a non-finance agent, never alongside an individual finance pattern", () => {
		const compiled = compileAttachments({
			...BASE,
			attachments: [attachment("native-repository-read", "allow")],
			catalog: CATALOG,
		});
		const permissions = compiledAgentPermissions(compiled, {
			agentId: "developer",
			financeAgentId: "finance",
			observeSystem: false,
		});
		expect(permissions.tools_deny).toContain("finance.*");
		expect(permissions.tools_deny).toContain("memory.write");
		expect(permissions.observe_system).toBeUndefined();
	});

	it("never adds the finance wildcard for the finance agent itself", () => {
		const compiled = compileAttachments({
			agentId: "finance",
			financeAgentId: "finance",
			adapter: "mock",
			attachments: [attachment("executor-finance-payment-create", "require_approval")],
			catalog: CATALOG,
		});
		const permissions = compiledAgentPermissions(compiled, {
			agentId: "finance",
			financeAgentId: "finance",
			observeSystem: true,
		});
		expect(permissions.tools_deny).not.toContain("finance.*");
		expect(permissions.tools_require_human_approval).toEqual(["finance.payment.create"]);
		expect(permissions.observe_system).toBe(true);
	});
});

describe("modeSupportedByKind", () => {
	it("native and gateway kinds support allow/disabled only", () => {
		expect(modeSupportedByKind("native", "allow")).toBe(true);
		expect(modeSupportedByKind("native", "disabled")).toBe(true);
		expect(modeSupportedByKind("native", "require_approval")).toBe(false);
		expect(modeSupportedByKind("gateway", "require_approval")).toBe(false);
	});

	it("executor kind supports require_approval/disabled only", () => {
		expect(modeSupportedByKind("executor", "require_approval")).toBe(true);
		expect(modeSupportedByKind("executor", "disabled")).toBe(true);
		expect(modeSupportedByKind("executor", "allow")).toBe(false);
	});

	it("custom_https and utility kinds support require_approval/disabled only, like executor", () => {
		expect(modeSupportedByKind("custom_https", "require_approval")).toBe(true);
		expect(modeSupportedByKind("custom_https", "disabled")).toBe(true);
		expect(modeSupportedByKind("custom_https", "allow")).toBe(false);
		expect(modeSupportedByKind("utility", "require_approval")).toBe(true);
		expect(modeSupportedByKind("utility", "disabled")).toBe(true);
		expect(modeSupportedByKind("utility", "allow")).toBe(false);
	});
});

describe("widenedTools", () => {
	it("is empty when before and after are identical", () => {
		const compiled = compileAttachments({
			...BASE,
			attachments: [attachment("native-repository-read", "allow")],
			catalog: CATALOG,
		});
		expect(widenedTools(compiled, compiled)).toEqual([]);
	});

	it("includes a tool that moved from deny to allow", () => {
		const before = compileAttachments({
			...BASE,
			attachments: [attachment("native-web-search", "disabled")],
			catalog: CATALOG,
		});
		const after = compileAttachments({
			...BASE,
			attachments: [attachment("native-web-search", "allow")],
			catalog: CATALOG,
		});
		expect(widenedTools(before, after)).toEqual(["web.search"]);
	});

	it("includes a tool that moved from require_approval to allow", () => {
		// `finance.payment.create` only ever compiles in for the finance agent, so attaching it to
		// `BASE.agentId` ("developer") would contribute nothing at all to either side of the
		// comparison — built against the finance agent itself instead, so the move is real.
		const financeBefore = compileAttachments({
			...BASE,
			agentId: "finance",
			financeAgentId: "finance",
			attachments: [attachment("executor-finance-payment-create", "require_approval")],
			catalog: CATALOG,
		});
		const financeAfter = compileAttachments({
			...BASE,
			agentId: "finance",
			financeAgentId: "finance",
			attachments: [attachment("executor-finance-payment-create", "require_approval")],
			catalog: CATALOG,
		});
		// Sanity: identical finance compiles widen nothing.
		expect(widenedTools(financeBefore, financeAfter)).toEqual([]);
		// The actual require_approval -> allow case: `executor` only supports
		// require_approval/disabled (`modeSupportedByKind`), so the realistic widening case for a
		// tool already at require_approval is `tests.run`, a native capability that does support
		// `allow`.
		const requireApproval = compileAttachments({
			...BASE,
			attachments: [
				attachment("native-tests-run", "require_approval"),
				attachment("native-repository-read", "disabled"),
				attachment("native-workspace-write", "disabled"),
			],
			catalog: CATALOG,
		});
		const allowed = compileAttachments({
			...BASE,
			attachments: [attachment("native-tests-run", "allow")],
			catalog: CATALOG,
		});
		expect(widenedTools(requireApproval, allowed)).toEqual(
			expect.arrayContaining(["repository.read", "tests.run", "workspace.write"]),
		);
	});

	it("never reports a narrowing move (allow -> deny) as widened", () => {
		const before = compileAttachments({
			...BASE,
			attachments: [attachment("native-web-search", "allow")],
			catalog: CATALOG,
		});
		const after = compileAttachments({
			...BASE,
			attachments: [attachment("native-web-search", "disabled")],
			catalog: CATALOG,
		});
		expect(widenedTools(before, after)).toEqual([]);
	});

	it("a tool absent from before entirely but present in after's requireApproval counts as widened (absence is level 0, same as deny)", () => {
		const before = compileAttachments({ ...BASE, attachments: [], catalog: CATALOG });
		const after = compileAttachments({
			...BASE,
			attachments: [attachment("native-web-search", "require_approval")],
			catalog: CATALOG,
		});
		expect(before.requireApproval).not.toContain("web.search");
		expect(before.allow).not.toContain("web.search");
		expect(before.deny).not.toContain("web.search");
		expect(widenedTools(before, after)).toEqual(["web.search"]);
	});

	it("reports an implied tool newly let through once the explicit attachment suppressing it is removed (the clear-attachment / detach scenario)", () => {
		// `workspace.write` explicitly `disabled` wins over `tests.run`'s own implication
		// (`compileAttachments`'s "an explicit restriction on the implied tool wins" rule).
		const before = compileAttachments({
			...BASE,
			attachments: [
				attachment("native-tests-run", "allow"),
				attachment("native-workspace-write", "disabled"),
			],
			catalog: CATALOG,
		});
		expect(before.deny).toContain("workspace.write");
		// Simulating the `workspace.write` attachment being cleared/detached: nothing governs it
		// explicitly any more, so `tests.run`'s own implication lets it through.
		const after = compileAttachments({
			...BASE,
			attachments: [attachment("native-tests-run", "allow")],
			catalog: CATALOG,
		});
		expect(after.allow).toContain("workspace.write");
		expect(widenedTools(before, after)).toEqual(["workspace.write"]);
	});
});

describe("describeWidenedTools", () => {
	it("names both levels a widened tool actually moved between, the canonical content a caller hashes", () => {
		const before = compileAttachments({
			...BASE,
			attachments: [attachment("native-web-search", "disabled")],
			catalog: CATALOG,
		});
		const after = compileAttachments({
			...BASE,
			attachments: [attachment("native-web-search", "allow")],
			catalog: CATALOG,
		});
		expect(describeWidenedTools(before, after)).toEqual([
			{ tool: "web.search", from: "deny", to: "allow" },
		]);
	});

	it("sorts by tool name, and widenedTools is exactly its own tool names in the same order", () => {
		const before = compileAttachments({
			...BASE,
			attachments: [
				attachment("native-web-search", "disabled"),
				attachment("native-tests-run", "require_approval"),
				attachment("native-repository-read", "disabled"),
				attachment("native-workspace-write", "disabled"),
			],
			catalog: CATALOG,
		});
		const after = compileAttachments({
			...BASE,
			attachments: [
				attachment("native-web-search", "allow"),
				attachment("native-tests-run", "allow"),
			],
			catalog: CATALOG,
		});
		const described = describeWidenedTools(before, after);
		expect(described.map((w) => w.tool)).toEqual(widenedTools(before, after));
		expect(described).toEqual([...described].sort((a, b) => (a.tool < b.tool ? -1 : 1)));
	});
});
