import type { AgentId, ToolName } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import { type AttachmentWidening, acceptWideningHash } from "./attachment-validation.ts";

function widening(
	agentId: AgentId,
	tool: ToolName,
	from: "deny" | "require_approval",
	to: "require_approval" | "allow",
): AttachmentWidening {
	return { agentId, tools: [{ tool, from, to }] };
}

describe("acceptWideningHash", () => {
	it("is deterministic for the same widenings list", () => {
		const widenings = [
			widening("developer" as AgentId, "workspace.write" as ToolName, "deny", "allow"),
		];
		expect(acceptWideningHash(widenings)).toBe(acceptWideningHash(widenings));
	});

	it("is insensitive to agent order, so two reads of the same set hash identically", () => {
		const a = widening("alpha" as AgentId, "workspace.write" as ToolName, "deny", "allow");
		const b = widening(
			"bravo" as AgentId,
			"repository.read" as ToolName,
			"require_approval",
			"allow",
		);
		expect(acceptWideningHash([a, b])).toBe(acceptWideningHash([a, b]));
	});

	it("differs once the widened tool's own levels differ — a stale hash can never match a commit's fresh computation", () => {
		const before = widening("developer" as AgentId, "workspace.write" as ToolName, "deny", "allow");
		const after = widening(
			"developer" as AgentId,
			"workspace.write" as ToolName,
			"require_approval",
			"allow",
		);
		expect(acceptWideningHash([before])).not.toBe(acceptWideningHash([after]));
	});

	it("differs once a different agent or tool is named", () => {
		const base = widening("developer" as AgentId, "workspace.write" as ToolName, "deny", "allow");
		const otherAgent = widening(
			"finance" as AgentId,
			"workspace.write" as ToolName,
			"deny",
			"allow",
		);
		const otherTool = widening(
			"developer" as AgentId,
			"repository.read" as ToolName,
			"deny",
			"allow",
		);
		expect(acceptWideningHash([base])).not.toBe(acceptWideningHash([otherAgent]));
		expect(acceptWideningHash([base])).not.toBe(acceptWideningHash([otherTool]));
	});
});
