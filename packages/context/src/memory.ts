import {
	type MemoryItem,
	type MemoryNamespaces,
	memoryVisibilityIssue,
} from "@agent-gateway/contracts";

export type MemoryBudget = Readonly<{
	maxItems: number;
	/** Most characters of all memory contents together. */
	maxChars: number;
}>;

export const DEFAULT_MEMORY_BUDGET: MemoryBudget = { maxItems: 50, maxChars: 20_000 };

/** Namespaces an agent reads: its own private one and the shared ones it is configured for. */
export function readableNamespaces(namespaces: MemoryNamespaces): ReadonlySet<string> {
	return new Set([namespaces.private, ...namespaces.shared]);
}

/**
 * The memory a turn sees: items of the agent's own namespaces only, newest first, within the
 * budget. Items whose visibility contradicts their namespace are dropped, so another agent's
 * private memory can never appear here even if the store returned it. Pure.
 */
export function selectMemories(
	items: Readonly<MemoryItem[]>,
	namespaces: MemoryNamespaces,
	budget: MemoryBudget = DEFAULT_MEMORY_BUDGET,
): MemoryItem[] {
	const readable = readableNamespaces(namespaces);
	const eligible = items
		.filter(
			(item) =>
				readable.has(item.namespace) &&
				memoryVisibilityIssue(item.namespace, item.visibility) === null,
		)
		.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
	const selected: MemoryItem[] = [];
	let chars = 0;
	for (const item of eligible) {
		if (selected.length >= budget.maxItems || chars + item.content.length > budget.maxChars) {
			break;
		}
		chars += item.content.length;
		selected.push(item);
	}
	return selected;
}
