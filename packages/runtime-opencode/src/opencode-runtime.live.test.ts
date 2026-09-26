import { homedir } from "node:os";
import { join } from "node:path";
import { defineLiveRuntimeSuite } from "@agent-gateway/runtime-sdk/live-suite";
import { createOpencodeRuntime } from "./opencode-runtime.ts";

// Uses OPENCODE_API_KEY (an OpenCode Go key) with the Gateway's directory in LIVE_OPENCODE_HOME
// (default ~/.agent-gateway/opencode); LIVE_OPENCODE_MODEL picks the model.
defineLiveRuntimeSuite({
	id: "opencode-go",
	createAdapter: () =>
		createOpencodeRuntime({
			opencodeHome: process.env.LIVE_OPENCODE_HOME ?? join(homedir(), ".agent-gateway", "opencode"),
			...(process.env.OPENCODE_API_KEY === undefined
				? {}
				: { apiKey: process.env.OPENCODE_API_KEY }),
		}),
	model: process.env.LIVE_OPENCODE_MODEL ?? null,
});
