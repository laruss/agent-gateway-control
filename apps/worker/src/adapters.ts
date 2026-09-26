import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAdapterId } from "@agent-gateway/contracts";
import { createClaudeRuntime } from "@agent-gateway/runtime-claude";
import { createCodexRuntime } from "@agent-gateway/runtime-codex";
import { createMockRuntime } from "@agent-gateway/runtime-mock";
import type { RuntimeAdapter } from "@agent-gateway/runtime-sdk";
import { type Environment, intSetting, readSetting, SettingError } from "@agent-gateway/service";

/** Where run workspaces are created: `WORKER_WORKSPACE_ROOT`, else a directory under tmp. */
export function workspaceRoot(env: Environment = process.env): string {
	return readSetting("WORKER_WORKSPACE_ROOT", env) ?? join(tmpdir(), "agent-gateway-workspaces");
}

function command(name: string, fallback: string, env: Environment): Readonly<string[]> {
	return [readSetting(name, env) ?? fallback];
}

function budget(env: Environment): { maxBudgetUsd?: number } {
	const value = readSetting("CLAUDE_MAX_BUDGET_USD", env);
	if (value === undefined) {
		return {};
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new SettingError(
			`setting CLAUDE_MAX_BUDGET_USD must be a positive number, got '${value}'`,
		);
	}
	return { maxBudgetUsd: parsed };
}

/**
 * The runtime adapter a worker serves, configured from settings. Credentials are read through
 * `<NAME>_FILE` secrets and handed to the runtime process only, never to the model's commands.
 *
 * codex:       CODEX_BIN, CODEX_HOME, CODEX_API_KEY
 * claude-code: CLAUDE_BIN, CLAUDE_CONFIG_DIR, ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN,
 *              CLAUDE_MAX_TURNS, CLAUDE_MAX_BUDGET_USD
 */
export function createRuntimeAdapter(
	id: RuntimeAdapterId,
	env: Environment = process.env,
): RuntimeAdapter {
	switch (id) {
		case "mock":
			return createMockRuntime();
		case "codex": {
			const codexHome = readSetting("CODEX_HOME", env);
			const apiKey = readSetting("CODEX_API_KEY", env);
			return createCodexRuntime({
				command: command("CODEX_BIN", "codex", env),
				...(codexHome === undefined ? {} : { codexHome }),
				...(apiKey === undefined ? {} : { apiKey }),
			});
		}
		case "claude-code": {
			const configDir = readSetting("CLAUDE_CONFIG_DIR", env);
			const apiKey = readSetting("ANTHROPIC_API_KEY", env);
			const oauthToken = readSetting("CLAUDE_CODE_OAUTH_TOKEN", env);
			return createClaudeRuntime({
				command: command("CLAUDE_BIN", "claude", env),
				...(configDir === undefined ? {} : { configDir }),
				...(apiKey === undefined ? {} : { apiKey }),
				...(oauthToken === undefined ? {} : { oauthToken }),
				maxTurns: intSetting("CLAUDE_MAX_TURNS", 40, env),
				...budget(env),
			});
		}
		default:
			throw new Error(`runtime adapter '${id}' is not implemented yet`);
	}
}
