import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type AgentConfig, AgentConfigSchema } from "./agent-config.ts";
import { JsonObjectSchema, toolPatternsOverlap } from "./common.ts";
import { validateConfigBundle } from "./config-bundle.ts";
import {
	isJsonObject,
	type JsonValue,
	PUBLISHED_SCHEMAS,
	renderJsonSchema,
	STRUCTURAL_SCHEMA_COMMENT,
	toProviderSchema,
} from "./json-schema.ts";
import { OrganizationConfigSchema } from "./organization.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const examplesDir = join(repoRoot, "config", "examples");

function readYaml(path: string) {
	return Bun.YAML.parse(readFileSync(path, "utf8"));
}

function loadExampleAgents(): AgentConfig[] {
	const agentsDir = join(examplesDir, "agents");
	return readdirSync(agentsDir)
		.filter((name) => name.endsWith(".yaml"))
		.sort()
		.map((name) => AgentConfigSchema.parse(readYaml(join(agentsDir, name))));
}

describe("config examples", () => {
	const organization = OrganizationConfigSchema.parse(
		readYaml(join(examplesDir, "organization.yaml")),
	);
	const agents = loadExampleAgents();

	it("contains the agents the MVP scenarios rely on", () => {
		expect(agents.map((agent) => agent.id)).toEqual(
			expect.arrayContaining(["developer", "finance", "research", "mail-follower"]),
		);
	});

	it("names each agent file after the agent id", () => {
		const fileIds = readdirSync(join(examplesDir, "agents"))
			.filter((name) => name.endsWith(".yaml"))
			.map((name) => name.replace(/\.yaml$/, ""))
			.sort();
		expect(agents.map((agent) => agent.id)).toEqual(fileIds);
	});

	it("is consistent across files", () => {
		expect(validateConfigBundle({ organization, agents })).toEqual([]);
	});

	it("references prompt files that exist", () => {
		const promptFiles = [
			organization.organization.constitution_file,
			...agents.map((agent) => agent.prompts.role_file),
		];
		for (const file of promptFiles) {
			expect(existsSync(join(repoRoot, file)), file).toBe(true);
		}
	});

	it("never lets a non-finance agent reach a finance tool", () => {
		for (const agent of agents.filter((a) => a.id !== organization.organization.finance_agent_id)) {
			const reachable = [
				...agent.permissions.tools_allow,
				...agent.permissions.tools_require_human_approval,
			];
			expect(
				reachable.filter((tool) => toolPatternsOverlap(tool, "finance.*")),
				agent.id,
			).toEqual([]);
			expect(agent.permissions.tools_deny, agent.id).toContain("finance.*");
		}
	});
});

/**
 * Rules for strict structured output shared by OpenAI and Anthropic, written out
 * independently of `toProviderSchema` so that the test does not restate the code.
 */
const STRICT_FORBIDDEN_KEYWORDS = [
	"oneOf",
	"allOf",
	"not",
	"if",
	"then",
	"else",
	"propertyNames",
	"patternProperties",
	"dependentSchemas",
	"minLength",
	"maxLength",
	"maxItems",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
];
const STRICT_ALLOWED_FORMATS = ["date-time", "date", "time", "uuid", "email"];

/** Returns violations of the strict structured-output rules, as `path: reason`. */
function strictModeViolations(node: JsonValue, path = "#"): string[] {
	if (Array.isArray(node)) {
		return node.flatMap((item, i) => strictModeViolations(item, `${path}/${i}`));
	}
	if (!isJsonObject(node)) {
		return [];
	}
	const violations = STRICT_FORBIDDEN_KEYWORDS.filter((k) => k in node).map((k) => `${path}: ${k}`);
	if (typeof node.minItems === "number" && node.minItems > 1) {
		violations.push(`${path}: minItems above 1`);
	}
	if (typeof node.pattern === "string" && /\(\?[=!<]/.test(node.pattern)) {
		violations.push(`${path}: lookaround in pattern`);
	}
	if (typeof node.pattern === "string" && /\{\d+,/.test(node.pattern)) {
		violations.push(`${path}: range quantifier in pattern`);
	}
	if (typeof node.pattern === "string" && typeof node.format === "string") {
		violations.push(`${path}: pattern next to format`);
	}
	if (typeof node.format === "string" && !STRICT_ALLOWED_FORMATS.includes(node.format)) {
		violations.push(`${path}: format '${node.format}'`);
	}
	if (node.type === "object" || "properties" in node) {
		if (node.additionalProperties !== false) {
			violations.push(`${path}: additionalProperties must be false`);
		}
		const properties = isJsonObject(node.properties) ? Object.keys(node.properties).sort() : [];
		const required = Array.isArray(node.required) ? node.required.map(String).sort() : [];
		if (JSON.stringify(properties) !== JSON.stringify(required)) {
			violations.push(`${path}: every property must be required`);
		}
	}
	for (const [key, value] of Object.entries(node)) {
		violations.push(...strictModeViolations(value, `${path}/${key}`));
	}
	return violations;
}

function readPublishedSchema(fileName: string): string {
	return readFileSync(join(repoRoot, "config", "schemas", fileName), "utf8");
}

describe("published JSON Schemas", () => {
	it.each(PUBLISHED_SCHEMAS)(
		"$fileName is up to date (run `bun run schemas:generate`)",
		(entry) => {
			expect(JSON.parse(readPublishedSchema(entry.fileName))).toEqual(
				JSON.parse(renderJsonSchema(entry)),
			);
		},
	);

	it("marks every non-provider schema as structural, not as a validator", () => {
		for (const entry of PUBLISHED_SCHEMAS.filter((e) => e.providerFacing !== true)) {
			const schema = JsonObjectSchema.parse(JSON.parse(readPublishedSchema(entry.fileName)));
			expect(schema.$comment, entry.fileName).toBe(STRUCTURAL_SCHEMA_COMMENT);
		}
	});

	it("publishes a model-output schema that fits provider strict mode", () => {
		const schema = JsonObjectSchema.parse(
			JSON.parse(readPublishedSchema("agent-turn-model-output.schema.json")),
		);
		expect(strictModeViolations(schema)).toEqual([]);
	});

	it("reports violations the linter is meant to catch", () => {
		const bad = {
			type: "object",
			properties: {
				id: { type: "string", pattern: "^(?!all$)[a-z]+$", maxLength: 3 },
				key: { type: "string", pattern: "^[a-z]{0,255}$" },
			},
			required: [],
		};
		expect(strictModeViolations(bad)).toEqual([
			"#: additionalProperties must be false",
			"#: every property must be required",
			"#/properties/id: maxLength",
			"#/properties/id: lookaround in pattern",
			"#/properties/key: range quantifier in pattern",
		]);
	});

	it("reduces keywords but keeps fields whose names look like keywords", () => {
		const schema = {
			type: "object",
			properties: {
				format: { type: "string", maxLength: 3 },
				pattern: { type: "string", pattern: "^[a-z]{1,9}$" },
			},
			required: ["format", "pattern"],
			additionalProperties: false,
		};
		expect(toProviderSchema(schema)).toEqual({
			type: "object",
			properties: { format: { type: "string" }, pattern: { type: "string" } },
			required: ["format", "pattern"],
			additionalProperties: false,
		});
	});

	it("keeps the no-wildcard rule for approval actions in JSON Schema, not only in Zod", () => {
		const { properties } = z
			.object({ properties: z.object({ actionType: z.object({ pattern: z.string() }) }) })
			.parse(JSON.parse(readPublishedSchema("approval-request.schema.json")));
		const pattern = new RegExp(properties.actionType.pattern);
		expect(pattern.test("finance.payment.create")).toBe(true);
		expect(pattern.test("finance.*")).toBe(false);
	});

	it("requires a root post for thread replies in the event JSON Schema", () => {
		const schema = JsonObjectSchema.parse(
			JSON.parse(readPublishedSchema("gateway-event.schema.json")),
		);
		const branches = Array.isArray(schema.anyOf) ? schema.anyOf : [];
		const replyBranch = branches[2];
		const properties = isJsonObject(replyBranch) ? replyBranch.properties : undefined;
		const type = isJsonObject(properties) ? properties.type : undefined;
		const data = isJsonObject(properties) ? properties.data : undefined;
		const dataProperties = isJsonObject(data) ? data.properties : undefined;
		const rootId = isJsonObject(dataProperties) ? dataProperties.root_id : undefined;
		expect(type).toEqual({ const: "mattermost.thread.reply" });
		expect(isJsonObject(rootId) ? rootId.type : undefined).toBe("string");
		expect(isJsonObject(rootId) && "anyOf" in rootId).toBe(false);
	});

	it("encodes typed Mattermost post data in the event JSON Schema", () => {
		const schema = JsonObjectSchema.parse(
			JSON.parse(readPublishedSchema("gateway-event.schema.json")),
		);
		const branches = Array.isArray(schema.anyOf) ? schema.anyOf : [];
		const postBranch = branches[1];
		const properties = isJsonObject(postBranch) ? postBranch.properties : undefined;
		const data = isJsonObject(properties) ? properties.data : undefined;
		const required = isJsonObject(data) && Array.isArray(data.required) ? data.required : [];
		expect(required).toEqual(
			expect.arrayContaining(["post_id", "channel_id", "user_id", "sender_agent_id"]),
		);
	});
});
