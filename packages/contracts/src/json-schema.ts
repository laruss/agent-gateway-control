import { z } from "zod";
import { AgentConfigSchema } from "./agent-config.ts";
import { ApprovalRequestSchema } from "./approval.ts";
import { type JsonObject, JsonObjectSchema, MattermostIdSchema } from "./common.ts";
import {
	GatewayEventSchema,
	GatewayEventTypeSchema,
	MATTERMOST_POST_EVENT_TYPES,
	MattermostPostDataSchema,
} from "./event.ts";
import { OrganizationConfigSchema } from "./organization.ts";
import { AgentTurnInputSchema, AgentTurnModelOutputSchema, AgentTurnResultSchema } from "./turn.ts";
import { WaitConditionSchema } from "./wait.ts";

export type JsonValue = z.infer<ReturnType<typeof z.json>>;

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Generates a JSON Schema and validates it as plain JSON data. */
function generateJsonSchema(schema: z.ZodType, io: "input" | "output"): JsonObject {
	const generated = z.toJSONSchema(schema, { target: "draft-2020-12", io });
	return JsonObjectSchema.parse(JSON.parse(JSON.stringify(generated)));
}

type PublishedSchema = Readonly<{
	/** File name under `config/schemas/`. */
	fileName: string;
	schema: z.ZodType;
	/** `input` for documents written by people (defaults are optional), `output` otherwise. */
	io: "input" | "output";
	/** Adjusts the generated JSON Schema, e.g. to express a Zod `.check` or a provider subset. */
	postProcess?: (schema: JsonObject) => JsonObject;
	/** Passed to providers as structured output; kept free of non-essential keywords. */
	providerFacing?: boolean;
}>;

/** Size and numeric keywords that provider strict structured output rejects. */
const PROVIDER_UNSUPPORTED_KEYWORDS: Readonly<string[]> = [
	"minLength",
	"maxLength",
	"maxItems",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minProperties",
	"maxProperties",
];
/** String formats accepted by both OpenAI and Anthropic structured output. */
export const PROVIDER_SUPPORTED_FORMATS: Readonly<string[]> = [
	"date-time",
	"date",
	"time",
	"uuid",
	"email",
];

/** Lookaround or a range quantifier (`{m,n}`, `{m,}`): both can make providers reject a schema. */
const PROVIDER_UNSUPPORTED_PATTERN = /\(\?[=!<]|\{\d+,\d*\}/;

function isUnsupportedKeyword(key: string, value: JsonValue): boolean {
	return (
		PROVIDER_UNSUPPORTED_KEYWORDS.includes(key) ||
		(key === "minItems" && typeof value === "number" && value > 1) ||
		(key === "pattern" && typeof value === "string" && PROVIDER_UNSUPPORTED_PATTERN.test(value)) ||
		(key === "format" && typeof value === "string" && !PROVIDER_SUPPORTED_FORMATS.includes(value))
	);
}

/**
 * Reduces a JSON Schema to the subset providers accept for strict structured output
 * (Codex `--output-schema`, Claude `--json-schema`). Dropped constraints stay enforced by
 * Zod, which validates every result afterwards (ADR-009).
 */
export function toProviderSchema(node: JsonValue): JsonValue {
	if (Array.isArray(node)) {
		return node.map(toProviderSchema);
	}
	if (!isJsonObject(node)) {
		return node;
	}
	const result: JsonObject = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "properties" && isJsonObject(value)) {
			// Keys of `properties` are field names, not keywords: keep every one of them.
			result[key] = Object.fromEntries(
				Object.entries(value).map(([field, schema]) => [field, toProviderSchema(schema)]),
			);
		} else if (key === "pattern" && typeof node.format === "string" && node.format !== "") {
		} else if (!isUnsupportedKeyword(key, value)) {
			result[key] = toProviderSchema(value);
		}
	}
	return result;
}

/** Expresses the Zod `.check` of `GatewayEventSchema`: post events carry typed Mattermost data. */
function withMattermostPostData(schema: JsonObject): JsonObject {
	const { $schema: _, ...postData } = generateJsonSchema(MattermostPostDataSchema, "output");
	const { $schema: __, ...mattermostId } = generateJsonSchema(MattermostIdSchema, "output");
	const postProperties = isJsonObject(postData.properties) ? postData.properties : {};
	const replyData = { ...postData, properties: { ...postProperties, root_id: mattermostId } };
	const postTrust = { enum: ["human-trusted", "internal-untrusted"] };
	const otherTypes = GatewayEventTypeSchema.options.filter(
		(type) => !MATTERMOST_POST_EVENT_TYPES.includes(type),
	);
	const rootlessPostTypes = MATTERMOST_POST_EVENT_TYPES.filter(
		(type) => type !== "mattermost.thread.reply",
	);
	return {
		...schema,
		anyOf: [
			{ properties: { type: { enum: otherTypes } } },
			{ properties: { type: { enum: rootlessPostTypes }, trustlevel: postTrust, data: postData } },
			{
				properties: {
					type: { const: "mattermost.thread.reply" },
					trustlevel: postTrust,
					data: replyData,
				},
			},
		],
	};
}

function providerOutputSchema(schema: JsonObject): JsonObject {
	const reduced = toProviderSchema(schema);
	return isJsonObject(reduced) ? reduced : schema;
}

/**
 * JSON Schema of `AgentTurnModelOutput` in the provider strict subset; the controller passes it
 * to runtimes as `AgentTurnInput.outputSchema`.
 */
export function modelOutputJsonSchema(): JsonObject {
	return providerOutputSchema(generateJsonSchema(AgentTurnModelOutputSchema, "output"));
}

export const PUBLISHED_SCHEMAS: Readonly<PublishedSchema[]> = [
	{ fileName: "organization.schema.json", schema: OrganizationConfigSchema, io: "input" },
	{ fileName: "agent.schema.json", schema: AgentConfigSchema, io: "input" },
	{
		fileName: "gateway-event.schema.json",
		schema: GatewayEventSchema,
		io: "output",
		postProcess: withMattermostPostData,
	},
	{ fileName: "wait-condition.schema.json", schema: WaitConditionSchema, io: "output" },
	{ fileName: "approval-request.schema.json", schema: ApprovalRequestSchema, io: "output" },
	{ fileName: "agent-turn-input.schema.json", schema: AgentTurnInputSchema, io: "output" },
	{ fileName: "agent-turn-result.schema.json", schema: AgentTurnResultSchema, io: "output" },
	{
		/** Provider-facing: passed to runtimes as the structured output schema. */
		fileName: "agent-turn-model-output.schema.json",
		schema: AgentTurnModelOutputSchema,
		io: "output",
		postProcess: providerOutputSchema,
		providerFacing: true,
	},
];

/** Every published schema except the provider-facing one says that it is not a validator. */
export const STRUCTURAL_SCHEMA_COMMENT =
	"Structural schema generated from the Zod contracts in @agent-gateway/contracts for editors " +
	"and tooling. Cross-field rules are not expressed here: validate with the Zod schema (ADR-010).";

export function renderJsonSchema(entry: PublishedSchema): string {
	const generated = generateJsonSchema(entry.schema, entry.io);
	const processed = entry.postProcess ? entry.postProcess(generated) : generated;
	const jsonSchema = entry.providerFacing
		? processed
		: { $comment: STRUCTURAL_SCHEMA_COMMENT, ...processed };
	return `${JSON.stringify(jsonSchema, null, 2)}\n`;
}
