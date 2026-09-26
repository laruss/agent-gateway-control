import type { AgentId } from "@agent-gateway/contracts";

/**
 * Opening line of a fenced code block: three or more ``` or ~~~, also inside a list item
 * (`- ```` or `1. ````). Indentation is not checked: a doubtful fence is code.
 */
const FENCE_OPEN = /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)*(`{3,}|~{3,})/;
/** A blockquote line, also inside a list item (`- > ...`). */
const QUOTE = /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)*>/;
/** A link reference definition, `[label]: destination "title"`: an address, not prose. */
const REFERENCE_DEFINITION = /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)*\[[^\]]+\]:/;
/** Four spaces or a tab: an indented code block (or a deeply indented continuation). */
const INDENTED = /^( {4}|\t)/;
/** An inline code span: a backtick run, closed by a run of the same length. */
const CODE_SPAN = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
/**
 * Text that is an address, not prose: link destinations (`](...)`), autolinks (`<...>`) and
 * bare URLs. `https://medium.com/@research` names no one.
 */
const NON_PROSE = [
	// An image's alt text describes a picture: `![chart [v2] @x](url)`. Brackets may nest or be
	// escaped and line endings are allowed, so the alt text runs to the first `](`, or else to
	// the last `]` of the paragraph.
	/!\[[\s\S]*?\]\(/g,
	/!\[[\s\S]*\]/g,
	// A backslash-escaped `\@` is a literal at sign.
	/\\@/g,
	// A name inside a path (`example.com/@developer`, `/users/@x`) is an address.
	/\S*\/@\S*/g,
	// URIs without `//` (`mailto:ops@x?subject=@y`) and bare domains with a path, query or
	// fragment (`example.com?to=@y`) are addresses too.
	/\b[a-z][a-z0-9+.-]*:[^\s@]*@\S*/gi,
	/\b[\w-]+(?:\.[\w-]+)+[/?#]\S*/g,
	// A destination with its title (`](url "ask \"@x\"")`, parentheses inside, line endings
	// allowed): the whole link target to the last `)` of the paragraph, and an unclosed one
	// through its next word, even on the next line.
	/\]\([\s\S]*\)/g,
	/\]\(\s*\S*/g,
	/<[^>\s]+>/g,
	/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,
	/\bwww\.\S+/gi,
];

function isClosingFence(line: string, fence: string): boolean {
	const trimmed = line.trim();
	const char = fence.charAt(0);
	return trimmed.length >= fence.length && [...trimmed].every((c) => c === char);
}

/**
 * The text of a Markdown message that is prose: fenced and indented code blocks, blockquotes
 * (with their lazy continuation lines) and inline code spans are removed. A mention inside any
 * of them is an example or a quotation, not an address. When in doubt a line is dropped: a
 * missed wake-up is recoverable by mentioning again, an unwanted one is not.
 */
export function proseOf(markdown: string): string {
	const paragraphs: string[] = [];
	let current: string[] = [];
	let fence: string | null = null;
	let inQuote = false;
	const flush = () => {
		if (current.length > 0) {
			const text = current.join("\n").replace(CODE_SPAN, " ");
			paragraphs.push(NON_PROSE.reduce((acc, pattern) => acc.replace(pattern, " "), text));
			current = [];
		}
	};
	for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
		if (fence !== null) {
			if (isClosingFence(line, fence)) {
				fence = null;
			}
			continue;
		}
		const open = FENCE_OPEN.exec(line);
		if (open?.[1] !== undefined) {
			flush();
			fence = open[1];
			inQuote = false;
			continue;
		}
		if (line.trim() === "") {
			flush();
			inQuote = false;
			continue;
		}
		if (QUOTE.test(line) || REFERENCE_DEFINITION.test(line) || inQuote) {
			// A quote runs until a blank line: Markdown continues it lazily onto plain lines. A
			// reference definition may continue too (its title on the next line): same rule.
			flush();
			inQuote = true;
			continue;
		}
		// Indentation starts a code block only where a paragraph could start; inside a paragraph
		// it is a continuation line (and may still be inside a code span).
		if (INDENTED.test(line) && current.length === 0) {
			continue;
		}
		current.push(line);
	}
	flush();
	return paragraphs.join("\n\n");
}

/** Mention tokens as Mattermost reads them: `@name` not preceded by a letter, digit or `_`. */
const MENTION = /(^|[^\p{L}\p{N}_])@([\p{L}\p{N}_.-]+)/gu;

/**
 * Registered agents a human message addresses: exact `@username` mentions in prose, in order of
 * first appearance, without duplicates. Only trailing dots (sentence punctuation) are dropped:
 * `@developer_` or `@developer-x` may be another account's name and address no agent.
 * Broadcast mentions address nobody.
 */
export function mentionedAgents(
	markdown: string,
	registered: ReadonlySet<AgentId>,
): Readonly<AgentId[]> {
	const found: AgentId[] = [];
	for (const match of proseOf(markdown).matchAll(MENTION)) {
		const raw = (match[2] ?? "").toLowerCase();
		const name = registered.has(raw) ? raw : raw.replace(/\.+$/, "");
		if (registered.has(name) && !found.includes(name)) {
			found.push(name);
		}
	}
	return found;
}
