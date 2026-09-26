import { homedir } from "node:os";
import { join } from "node:path";
import { defineLiveRuntimeSuite } from "@agent-gateway/runtime-sdk/live-suite";
import { createKiroRuntime } from "./kiro-runtime.ts";

// Uses the Kiro login of this user (or KIRO_API_KEY) with the Gateway's KIRO_HOME in
// LIVE_KIRO_HOME (default ~/.agent-gateway/kiro); LIVE_KIRO_MODEL picks the model.
defineLiveRuntimeSuite({
	id: "kiro",
	createAdapter: () =>
		createKiroRuntime({
			kiroHome: process.env.LIVE_KIRO_HOME ?? join(homedir(), ".agent-gateway", "kiro"),
			...(process.env.KIRO_API_KEY === undefined ? {} : { apiKey: process.env.KIRO_API_KEY }),
		}),
	model: process.env.LIVE_KIRO_MODEL ?? null,
});
