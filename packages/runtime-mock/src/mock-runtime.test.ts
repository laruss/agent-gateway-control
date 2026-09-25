import { defineRuntimeContractSuite } from "@agent-gateway/runtime-sdk/contract-suite";
import { createMockRuntime } from "./mock-runtime.ts";

defineRuntimeContractSuite({
	name: "mock",
	createAdapter: () => createMockRuntime(),
	prompts: {
		reply: "@developer please reply",
		wait: "@developer ask finance [mock:wait finance]",
		invalid: "@developer [mock:invalid]",
		slow: "@developer [mock:slow]",
	},
});
