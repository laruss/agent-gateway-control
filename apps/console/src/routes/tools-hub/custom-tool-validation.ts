import {
	type CustomHttpsDefinition,
	CustomHttpsDefinitionSchema,
	customHttpMethodWrites,
	customHttpsDefinitionProblems,
	isReservedCustomHeaderName,
	pathTemplatePlaceholders,
	ToolCatalogEntryIdSchema,
} from "@agent-gateway/contracts";

/**
 * Client-side mirror of `customHttpsDefinitionProblems` (`@agent-gateway/contracts`): the same
 * rules, run in the browser before a request is ever sent, so the form's own "Review" step can
 * refuse to proceed on an invalid definition instead of only finding out from a `422`. The server
 * is still the one actual authority — this never replaces its own check, only anticipates it.
 */
export function clientSideDefinitionProblems(
	definition: CustomHttpsDefinition,
): Readonly<string[]> {
	const shape = CustomHttpsDefinitionSchema.safeParse(definition);
	if (!shape.success) {
		return shape.error.issues.map(
			(issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
		);
	}
	return customHttpsDefinitionProblems(shape.data);
}

/**
 * Client-side mirror of `ToolCatalogEntryIdSchema` (`@agent-gateway/contracts`): the same rule a
 * create request's own `entryId` is validated against, run here too so a name that does not fit it
 * (uppercase, a space, too short) is refused before the "Review" step rather than only discovered
 * from the create request's own `400`.
 */
export function entryIdProblems(entryId: string): Readonly<string[]> {
	const parsed = ToolCatalogEntryIdSchema.safeParse(entryId);
	return parsed.success ? [] : [parsed.error.issues[0]?.message ?? "invalid entry id"];
}

export { customHttpMethodWrites, isReservedCustomHeaderName, pathTemplatePlaceholders };
