import { defineLiveRuntimeSuite } from "@agent-gateway/runtime-sdk/live-suite";
import { createClaudeRuntime } from "./claude-runtime.ts";

// Uses the local Claude Code login (CLAUDE_CONFIG_DIR or ~/.claude); LIVE_CLAUDE_MODEL picks
// the model.
defineLiveRuntimeSuite({
	id: "claude-code",
	createAdapter: () =>
		createClaudeRuntime(
			process.env.CLAUDE_CONFIG_DIR === undefined
				? {}
				: { configDir: process.env.CLAUDE_CONFIG_DIR },
		),
	model: process.env.LIVE_CLAUDE_MODEL ?? null,
});
