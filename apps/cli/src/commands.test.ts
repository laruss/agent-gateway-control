import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentCreateRequest, parseOutboxStatusFlag, UsageError } from "./commands.ts";

/** A `--root` with `prompts/<file>` already written, for `--role-prompt-file` to read. */
function rootWithPrompt(fileName: string, content: string): string {
	const root = mkdtempSync(join(tmpdir(), "gateway-agents-create-"));
	mkdirSync(join(root, "prompts"), { recursive: true });
	writeFileSync(join(root, "prompts", fileName), content);
	return root;
}

describe("buildAgentCreateRequest (gateway agents create)", () => {
	it("assembles a create request from the id, display name and role prompt file", () => {
		const root = rootWithPrompt("analyst.md", "You are the analyst.");
		const request = buildAgentCreateRequest(
			[
				"agents",
				"create",
				"analyst",
				"--display-name",
				"Analyst",
				"--role-prompt-file",
				"prompts/analyst.md",
			],
			root,
			"cli:owner",
		);
		expect(request).toMatchObject({
			agent: {
				id: "analyst",
				display_name: "Analyst",
				mattermost: { username: "analyst", allowed_channels: [] },
				prompts: { role_file: "prompts/analyst.md" },
				wake_rules: [{ event_type: "mattermost.agent.mentioned", target_agent_id: "analyst" }],
			},
			rolePrompt: "You are the analyst.",
			actor: "cli:owner",
			source: "cli",
		});
		// Never set by the CLI: the service generates the bot token path and the runtime defaults.
		expect(request.agent.mattermost).not.toHaveProperty("token_secret_file");
		expect(request.agent.runtime).toBeUndefined();
	});

	it("collects every --channel flag given, in order", () => {
		const root = rootWithPrompt("analyst.md", "Role.");
		const request = buildAgentCreateRequest(
			[
				"agents",
				"create",
				"analyst",
				"--display-name",
				"Analyst",
				"--role-prompt-file",
				"prompts/analyst.md",
				"--channel",
				"hq",
				"--channel",
				"research",
			],
			root,
			"cli:owner",
		);
		expect(request.agent.mattermost.allowed_channels).toEqual(["hq", "research"]);
	});

	it("builds a runtime only when --runtime or --model is given, keeping the other default", () => {
		const root = rootWithPrompt("analyst.md", "Role.");
		const withModel = buildAgentCreateRequest(
			[
				"agents",
				"create",
				"analyst",
				"--display-name",
				"Analyst",
				"--role-prompt-file",
				"prompts/analyst.md",
				"--model",
				"gpt-5-codex",
			],
			root,
			"cli:owner",
		);
		expect(withModel.agent.runtime).toEqual({ model: "gpt-5-codex" });

		const withAdapter = buildAgentCreateRequest(
			[
				"agents",
				"create",
				"analyst",
				"--display-name",
				"Analyst",
				"--role-prompt-file",
				"prompts/analyst.md",
				"--runtime",
				"mock",
			],
			root,
			"cli:owner",
		);
		expect(withAdapter.agent.runtime).toEqual({ adapter: "mock" });
	});

	it("requires --display-name", () => {
		const root = rootWithPrompt("analyst.md", "Role.");
		expect(() =>
			buildAgentCreateRequest(
				["agents", "create", "analyst", "--role-prompt-file", "prompts/analyst.md"],
				root,
				"cli:owner",
			),
		).toThrow(UsageError);
	});

	it("requires --role-prompt-file", () => {
		const root = rootWithPrompt("analyst.md", "Role.");
		expect(() =>
			buildAgentCreateRequest(
				["agents", "create", "analyst", "--display-name", "Analyst"],
				root,
				"cli:owner",
			),
		).toThrow(UsageError);
	});

	it("refuses a role prompt file that escapes the root", () => {
		const root = rootWithPrompt("analyst.md", "Role.");
		expect(() =>
			buildAgentCreateRequest(
				[
					"agents",
					"create",
					"analyst",
					"--display-name",
					"Analyst",
					"--role-prompt-file",
					"prompts/../../etc/passwd.md",
				],
				root,
				"cli:owner",
			),
		).toThrow();
	});
});

describe("parseOutboxStatusFlag (gateway outbox list --status)", () => {
	it("accepts every status the shared, authoritative list names, including 'cancelled'", () => {
		for (const status of ["pending", "sending", "sent", "dead", "cancelled"]) {
			expect(parseOutboxStatusFlag(status)).toBe(status);
		}
	});

	it("accepts no flag at all", () => {
		expect(parseOutboxStatusFlag(null)).toBeNull();
	});

	it("refuses a status outside the shared list", () => {
		expect(() => parseOutboxStatusFlag("bogus")).toThrow(UsageError);
	});
});
