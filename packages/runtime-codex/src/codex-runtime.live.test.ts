import { defineLiveRuntimeSuite } from "@agent-gateway/runtime-sdk/live-suite";
import { createCodexRuntime } from "./codex-runtime.ts";

// Uses the local Codex login (CODEX_HOME or ~/.codex); LIVE_CODEX_MODEL picks the model.
defineLiveRuntimeSuite({
	id: "codex",
	createAdapter: () =>
		createCodexRuntime(
			process.env.CODEX_HOME === undefined ? {} : { codexHome: process.env.CODEX_HOME },
		),
	model: process.env.LIVE_CODEX_MODEL ?? null,
});
