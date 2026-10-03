import {
	type CustomHttpsDefinition,
	CustomHttpsDefinitionSchema,
	customHttpMethodWrites,
	customHttpsDefinitionProblems,
	isReservedCustomHeaderName,
	pathTemplatePlaceholders,
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

export { customHttpMethodWrites, isReservedCustomHeaderName, pathTemplatePlaceholders };
