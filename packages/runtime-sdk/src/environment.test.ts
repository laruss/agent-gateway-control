import type { ToolPolicySnapshot } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import { confinedGrants, nativeToolGrants, withheldToolsRisk } from "./environment.ts";

const policy = (
	allow: string[],
	deny: string[] = [],
	requireHumanApproval: string[] = [],
): ToolPolicySnapshot => ({ policyVersion: "test", allow, deny, requireHumanApproval });

describe("nativeToolGrants", () => {
	it("grants nothing by default", () => {
		expect(nativeToolGrants(policy(["mattermost.post"]))).toEqual({
			read: false,
			write: false,
			exec: false,
			webSearch: false,
			webFetch: false,
		});
	});

	it("lets writing and commands read", () => {
		expect(nativeToolGrants(policy(["workspace.write"]))).toMatchObject({
			read: true,
			write: true,
		});
		expect(nativeToolGrants(policy(["tests.run"]))).toMatchObject({
			read: true,
			write: false,
			exec: true,
		});
	});

	it("withholds commands and writes when reading or writing is denied or needs approval", () => {
		expect(
			nativeToolGrants(policy(["tests.run", "workspace.write"], ["repository.read"])),
		).toMatchObject({ read: false, write: false, exec: false });
		expect(nativeToolGrants(policy(["tests.run"], ["workspace.write"]))).toMatchObject({
			exec: false,
		});
		expect(nativeToolGrants(policy(["tests.run"], [], ["workspace.*"]))).toMatchObject({
			exec: false,
		});
	});
});

describe("confinedGrants", () => {
	const all = nativeToolGrants(
		policy(["repository.read", "workspace.write", "tests.run", "web.search", "web.fetch"]),
	);

	it("withholds the tools a runtime cannot confine", () => {
		expect(confinedGrants(all, ["webSearch", "webFetch"])).toEqual({
			read: false,
			write: false,
			exec: false,
			webSearch: true,
			webFetch: true,
		});
		expect(withheldToolsRisk("grok", ["webSearch", "webFetch"])).toContain(
			"repository.read, workspace.write, tests.run",
		);
	});

	it("drops writing and commands with reading", () => {
		expect(confinedGrants(all, ["write", "exec", "webSearch"])).toMatchObject({
			read: false,
			write: false,
			exec: false,
		});
		expect(confinedGrants(all, ["read", "write"])).toMatchObject({
			read: true,
			write: true,
			exec: false,
		});
		expect(
			withheldToolsRisk("codex", ["read", "write", "exec", "webSearch", "webFetch"]),
		).toBeNull();
	});
});
