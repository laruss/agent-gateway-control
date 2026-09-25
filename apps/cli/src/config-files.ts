import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	type AgentConfig,
	AgentConfigSchema,
	OrganizationConfigSchema,
} from "@agent-gateway/contracts";
import type { ConfigApplyInput } from "@agent-gateway/core";
import type { z } from "zod";

export class ConfigFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigFileError";
	}
}

/**
 * Reads a prompt file inside `root`. The real path must stay inside the real root, so a
 * symlink cannot pull in a file from elsewhere on the host.
 */
export function readPromptFile(root: string, promptPath: string): string {
	const realRoot = realpathSync(root);
	let real: string;
	try {
		real = realpathSync(resolve(realRoot, promptPath));
	} catch {
		throw new ConfigFileError(`prompt file '${promptPath}' does not exist under '${root}'`);
	}
	const inside = relative(realRoot, real);
	if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
		throw new ConfigFileError(`prompt file '${promptPath}' resolves outside the config root`);
	}
	return readFileSync(real, "utf8");
}

function parseYaml(path: string) {
	try {
		return Bun.YAML.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ConfigFileError(
			`cannot parse '${path}': ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function issues(path: string, error: z.ZodError) {
	return error.issues.map(
		(issue) => `${path}: ${issue.path.map(String).join(".")}: ${issue.message}`,
	);
}

/**
 * Loads `<dir>/organization.yaml` and `<dir>/agents/*.yaml`, validates each file, and resolves
 * prompt files relative to `root`.
 */
export function loadConfigDirectory(dir: string, root: string): ConfigApplyInput {
	const problems: string[] = [];
	const organizationPath = join(dir, "organization.yaml");
	const organization = OrganizationConfigSchema.safeParse(parseYaml(organizationPath));
	if (!organization.success) {
		problems.push(...issues(organizationPath, organization.error));
	}
	const agents: AgentConfig[] = [];
	const agentsDir = join(dir, "agents");
	for (const file of readdirSync(agentsDir)
		.filter((name) => name.endsWith(".yaml"))
		.sort()) {
		const path = join(agentsDir, file);
		const agent = AgentConfigSchema.safeParse(parseYaml(path));
		if (agent.success) {
			agents.push(agent.data);
		} else {
			problems.push(...issues(path, agent.error));
		}
	}
	if (!organization.success || problems.length > 0) {
		throw new ConfigFileError(`configuration is invalid:\n- ${problems.join("\n- ")}`);
	}
	const rolePrompts: Record<string, string> = {};
	for (const agent of agents) {
		rolePrompts[agent.id] = readPromptFile(root, agent.prompts.role_file);
	}
	return {
		organization: organization.data,
		agents,
		constitution: readPromptFile(root, organization.data.organization.constitution_file),
		rolePrompts,
	};
}
