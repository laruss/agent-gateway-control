import { homedir } from "node:os";
import { join } from "node:path";
import { defineLiveRuntimeSuite } from "@agent-gateway/runtime-sdk/live-suite";
import { createHermesRuntime } from "./hermes-runtime.ts";

// Uses the Gateway's Hermes login in LIVE_HERMES_HOME (default ~/.agent-gateway/hermes, created
// with `HERMES_HOME=<dir> hermes auth add <provider>`); LIVE_HERMES_PROVIDER and
// LIVE_HERMES_MODEL pick the provider and model.
defineLiveRuntimeSuite({
	id: "hermes",
	createAdapter: () =>
		createHermesRuntime({
			hermesHome: process.env.LIVE_HERMES_HOME ?? join(homedir(), ".agent-gateway", "hermes"),
			...(process.env.LIVE_HERMES_PROVIDER === undefined
				? {}
				: { provider: process.env.LIVE_HERMES_PROVIDER }),
		}),
	model: process.env.LIVE_HERMES_MODEL ?? null,
});
