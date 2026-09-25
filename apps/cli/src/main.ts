#!/usr/bin/env bun
import { redactText } from "@agent-gateway/logging";
import { runCommand, UsageError } from "./commands.ts";

try {
	process.exitCode = await runCommand(process.argv.slice(2), {
		print: (value) => console.log(value),
	});
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(redactText(message));
	process.exitCode = error instanceof UsageError ? 2 : 1;
}
