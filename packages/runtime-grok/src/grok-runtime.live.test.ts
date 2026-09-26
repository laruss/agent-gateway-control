import { homedir } from "node:os";
import { join } from "node:path";
import { defineLiveRuntimeSuite } from "@agent-gateway/runtime-sdk/live-suite";
import { createGrokRuntime } from "./grok-runtime.ts";

// Uses the Gateway's Grok login in LIVE_GROK_HOME (default ~/.agent-gateway/grok, created with
// `GROK_HOME=<dir> grok login`); LIVE_GROK_MODEL picks the model.
defineLiveRuntimeSuite({
	id: "grok",
	createAdapter: () =>
		createGrokRuntime({
			grokHome: process.env.LIVE_GROK_HOME ?? join(homedir(), ".agent-gateway", "grok"),
		}),
	model: process.env.LIVE_GROK_MODEL ?? null,
});
