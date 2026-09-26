/**
 * HTML mail to plain text. Active and embedded content (scripts, styles, frames, forms, media,
 * SVG) is removed with everything inside it, as is content hidden from the reader
 * (`display:none`, `visibility:hidden`, zero font size, `hidden`): hidden text in mail is a
 * classic prompt injection carrier. Links keep their target in the text, since a phishing check
 * needs it; images are dropped (tracking pixels).
 */

/** Elements dropped with their content. */
const DROPPED = new Set([
	"script",
	"style",
	"head",
	"title",
	"template",
	"iframe",
	"frame",
	"frameset",
	"object",
	"embed",
	"applet",
	"svg",
	"math",
	"noscript",
	"form",
	"select",
	"textarea",
	"button",
	"audio",
	"video",
	"canvas",
]);

/** Elements without a closing tag. */
const VOID = new Set([
	"area",
	"base",
	"br",
	"col",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

/** Elements that end a line. */
const BLOCK = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"div",
	"dl",
	"dt",
	"dd",
	"footer",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hr",
	"li",
	"main",
	"nav",
	"ol",
	"p",
	"pre",
	"section",
	"table",
	"tr",
	"ul",
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ensp: " ",
	emsp: " ",
	thinsp: " ",
	ndash: "–",
	mdash: "—",
	hellip: "…",
	laquo: "«",
	raquo: "»",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	bull: "•",
	middot: "·",
	copy: "©",
	reg: "®",
	trade: "™",
	euro: "€",
	pound: "£",
	yen: "¥",
	cent: "¢",
	deg: "°",
	times: "×",
	divide: "÷",
	shy: "",
	zwnj: "",
	zwj: "",
};

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});?/giu, (match, body: string) => {
		if (body.startsWith("#")) {
			const code =
				body[1] === "x" || body[1] === "X"
					? Number.parseInt(body.slice(2), 16)
					: Number.parseInt(body.slice(1), 10);
			return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
				? String.fromCodePoint(code)
				: "";
		}
		return NAMED_ENTITIES[body.toLowerCase()] ?? match;
	});
}

/** A tag, a comment, a doctype or a CDATA section. */
const TOKEN =
	/<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gu;

/** Attribute lists with `/` separators are read as browsers read them (`<div/style=...>`). */
function attribute(attributes: string, name: string): string | null {
	const match = new RegExp(
		`(?:^|[\\s/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
		"iu",
	).exec(attributes);
	if (match === null) {
		return null;
	}
	return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

function hasAttribute(attributes: string, name: string): boolean {
	return new RegExp(`(?:^|[\\s/])${name}(?:\\s*=|[\\s/]|$)`, "iu").test(attributes);
}

function withoutCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?(?:\*\/|$)/gu, " ");
}

/** CSS escapes decoded (`n\6f ne` is `none`), so an escaped keyword reads as the keyword. */
function unescapeCss(css: string): string {
	return css.replace(
		/\\(?:([0-9a-f]{1,6})\s?|(.))/giu,
		(_match, hex: string | undefined, char: string | undefined) => {
			if (hex === undefined) {
				return char ?? "";
			}
			const code = Number.parseInt(hex, 16);
			return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
				? String.fromCodePoint(code)
				: "";
		},
	);
}

/** CSS declarations by property, lowercased, without `!important`. */
function declarations(css: string): ReadonlyMap<string, string> {
	const result = new Map<string, string>();
	for (const declaration of unescapeCss(withoutCssComments(css)).split(";")) {
		const colon = declaration.indexOf(":");
		if (colon === -1) {
			continue;
		}
		const property = declaration.slice(0, colon).trim().toLowerCase();
		const value = declaration
			.slice(colon + 1)
			.replace(/!\s*important/giu, "")
			.trim()
			.toLowerCase();
		if (property !== "" && value !== "") {
			result.set(property, value);
		}
	}
	return result;
}

/** A CSS length in pixels (`0`, `-9999px`, `1pt`, `0.1em`), or null when unknown. */
function pixels(value: string | undefined): number | null {
	const match = /^(-?[0-9]*\.?[0-9]+)(px|pt|em|rem|%|vw|vh)?$/u.exec(value ?? "");
	if (match === null) {
		return null;
	}
	const number = Number(match[1]);
	switch (match[2]) {
		case "pt":
			return (number * 4) / 3;
		case "em":
		case "rem":
			return number * 16;
		case undefined:
		case "px":
			return number;
		default:
			// Relative to something unknown: only zero is known to be zero.
			return number === 0 ? 0 : null;
	}
}

/**
 * Whether declarations hide content from a reader: not displayed, invisible, transparent, too
 * small to read, collapsed with the overflow cut off, moved off screen, or in the background's
 * colour. Deliberately broad: text a human does not see is exactly where an injection hides.
 */
export function hidesContent(css: string): boolean {
	const d = declarations(css);
	const px = (property: string) => pixels(d.get(property));
	const zero = (property: string) => px(property) === 0;
	const clipped = /^(hidden|clip)$/u.test(d.get("overflow") ?? d.get("overflow-y") ?? "");
	const offscreen = (property: string) => (px(property) ?? 0) <= -500;
	const colour = d.get("color");
	const background = d.get("background-color") ?? d.get("background");
	return (
		d.get("display") === "none" ||
		/^(hidden|collapse)$/u.test(d.get("visibility") ?? "") ||
		d.get("mso-hide") === "all" ||
		Number(d.get("opacity") ?? "1") <= 0.05 ||
		(px("font-size") ?? 16) <= 1 ||
		((zero("height") || zero("max-height") || zero("width") || zero("max-width")) && clipped) ||
		(/^(absolute|fixed)$/u.test(d.get("position") ?? "") &&
			(offscreen("left") || offscreen("top") || offscreen("right"))) ||
		offscreen("text-indent") ||
		(colour !== undefined && colour === background)
	);
}

/** An element a stylesheet rule hides: a tag (or any), classes and ids it must all have. */
type Compound = Readonly<{
	tag: string | null;
	classes: Readonly<string[]>;
	ids: Readonly<string[]>;
}>;

/**
 * What the mail's own stylesheets hide. `compounds` are resolved and removed. `suspected` is
 * set when some rule hides content in a way the sanitizer does not resolve (a conditional
 * `@media`, a selector it cannot read): that text is kept, and the event says it may be hidden.
 */
type HidingRules = Readonly<{
	/** By `#id`, `.class`, tag or `*`: an element is checked against its own keys only. */
	compounds: ReadonlyMap<string, Readonly<Compound[]>>;
	suspected: boolean;
}>;

/** Most resolved hiding rules kept; a mail with more is marked suspected. */
export const MAX_HIDING_RULES = 2000;

function ruleKey(compound: Compound): string {
	const id = compound.ids[0];
	const name = compound.classes[0];
	return id !== undefined ? `#${id}` : name !== undefined ? `.${name}` : (compound.tag ?? "*");
}

/** A stylesheet rule, and whether it applies only under a condition (`@media (...)`). */
type StyleRule = Readonly<{
	selectors: string;
	body: string;
	conditional: boolean;
	/** At-rules nested too deeply to read; whatever they hide is unknown. */
	unread?: true;
}>;

/**
 * Whether the rules inside an at-rule apply to every reader: `@layer`, `@supports`, and
 * `@media` with media types only (`all`, `screen`). A `@media` with conditions (width,
 * orientation) applies to some screens only: a responsive template hides its mobile or desktop
 * version there, never the mail itself, so its rules are conditional.
 */
function appliesToEveryReader(head: string): boolean {
	const at = /^@([a-z-]+)\s*(.*)$/isu.exec(head);
	const name = at?.[1]?.toLowerCase();
	const query = (at?.[2] ?? "").trim().toLowerCase();
	if (name === "layer" || name === "supports") {
		return true;
	}
	return name === "media" && !query.includes("(") && !/\bprint\b/u.test(query);
}

/** The index of the brace closing the block that opens at `open`, or the end. */
function blockEnd(css: string, open: number): number {
	let depth = 0;
	for (let j = open; j < css.length; j += 1) {
		if (css[j] === "{") {
			depth += 1;
		} else if (css[j] === "}") {
			depth -= 1;
			if (depth === 0) {
				return j;
			}
		}
	}
	return css.length;
}

/** The rules of a stylesheet, those inside at-rules included (bounded nesting). */
function styleRules(css: string, conditional = false, depth = 0): Readonly<StyleRule[]> {
	const rules: StyleRule[] = [];
	let i = 0;
	while (i < css.length) {
		const open = css.indexOf("{", i);
		const semicolon = css.indexOf(";", i);
		if (open === -1) {
			break;
		}
		if (semicolon !== -1 && semicolon < open && css.slice(i, semicolon).trim().startsWith("@")) {
			// `@import ...;`, `@charset ...;`
			i = semicolon + 1;
			continue;
		}
		const head = css.slice(i, open).trim();
		if (head.startsWith("@")) {
			const end = blockEnd(css, open);
			if (depth < 4) {
				rules.push(
					...styleRules(
						css.slice(open + 1, end),
						conditional || !appliesToEveryReader(head),
						depth + 1,
					),
				);
			} else {
				rules.push({ selectors: "", body: "", conditional, unread: true });
			}
			i = end + 1;
			continue;
		}
		const close = css.indexOf("}", open);
		if (close === -1) {
			break;
		}
		rules.push({ selectors: head, body: css.slice(open + 1, close), conditional });
		i = close + 1;
	}
	return rules;
}

/** `text` split at `separator` outside parentheses and brackets. */
function splitTopLevel(text: string, separator: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		if (char === "(" || char === "[") {
			depth += 1;
		} else if ((char === ")" || char === "]") && depth > 0) {
			depth -= 1;
		} else if (char === separator && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}

/** The index after the parenthesis closing the one at `open`. */
function parenEnd(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i += 1) {
		if (text[i] === "(") {
			depth += 1;
		} else if (text[i] === ")") {
			depth -= 1;
			if (depth === 0) {
				return i + 1;
			}
		}
	}
	return text.length;
}

/** The last compound of a selector (after its last top-level combinator): what it styles. */
function subject(selector: string): string {
	let depth = 0;
	let start = 0;
	const text = selector.trim();
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i] ?? "";
		if (char === "(" || char === "[") {
			depth += 1;
		} else if ((char === ")" || char === "]") && depth > 0) {
			depth -= 1;
		} else if (depth === 0 && /[\s>+~]/u.test(char)) {
			start = i + 1;
		}
	}
	return text.slice(start);
}

/** States a reader must bring about; hiding in them hides nothing at rest. */
const INTERACTION_STATES = /:(?:hover|focus|focus-within|focus-visible|active|target|checked)\b/iu;

/**
 * Pseudo-elements, also in their legacy one-colon form: a rule for one styles generated content
 * or a scrollbar, never the element itself.
 */
const PSEUDO_ELEMENT =
	/::|:(?:before|after|first-line|first-letter|marker|placeholder|selection|backdrop)\b/iu;

/**
 * The simple compounds a compound stands for at rest, conservatively:
 * - `:is(...)` and `:where(...)` stand for each of their arguments;
 * - `:not(...)`, `:nth-child(...)`, `[attr]` and other filters only narrow a match, so they
 *   are dropped and the element counts as matched (hidden);
 * - an interaction state outside `:not()` (`.h:hover`) matches nothing at rest: empty list.
 * Null when the result cannot be read as tag, classes and ids.
 */
function expandCompound(compound: string, depth = 0): Readonly<Compound[]> | null {
	// Attribute selectors only narrow the match; removed first, so a quoted value such as
	// `[data-x=":hover"]` is not read as a pseudo-class.
	const text = compound.replace(/\[(?:[^\]"']|"[^"]*"|'[^']*')*\]/gu, "").trim();
	const alternative = /:(?:is|where|matches|any)\(/iu.exec(text);
	if (alternative !== null && depth < 4) {
		const open = alternative.index + alternative[0].length - 1;
		const end = parenEnd(text, open);
		const before = text.slice(0, alternative.index);
		const after = text.slice(end);
		const expanded: Compound[] = [];
		for (const option of splitTopLevel(text.slice(open + 1, end - 1), ",")) {
			const parts = expandCompound(`${before}${subject(option)}${after}`, depth + 1);
			if (parts === null) {
				return null;
			}
			expanded.push(...parts);
		}
		return expanded;
	}
	let rest = text;
	// Negations narrow the match; what is inside them never makes the element unhidden.
	for (let index = rest.search(/:not\(/iu); index !== -1; index = rest.search(/:not\(/iu)) {
		rest = rest.slice(0, index) + rest.slice(parenEnd(rest, index + 4));
	}
	if (INTERACTION_STATES.test(rest) || PSEUDO_ELEMENT.test(rest)) {
		return [];
	}
	if (/:visited\b/iu.test(rest)) {
		// Visited links differ per reader: the text may or may not be hidden.
		return null;
	}
	const simple = rest
		.replace(/::?[a-z-]+(?:\([^()]*\))?/giu, "")
		.replace(/\[[^\]]*\]/gu, "")
		.trim();
	const match = /^(\*|[a-z][a-z0-9-]*)?((?:[.#]-?[_a-z][\w-]*)*)$/iu.exec(simple);
	if (match === null || simple === "") {
		return null;
	}
	const parts = match[2] ?? "";
	return [
		{
			tag: match[1] === undefined || match[1] === "*" ? null : match[1].toLowerCase(),
			classes: [...parts.matchAll(/\.(-?[_a-z][\w-]*)/giu)].map((m) => (m[1] ?? "").toLowerCase()),
			ids: [...parts.matchAll(/#(-?[_a-z][\w-]*)/giu)].map((m) => (m[1] ?? "").toLowerCase()),
		},
	];
}

function hidingRules(html: string): HidingRules {
	const compounds = new Map<string, Compound[]>();
	let count = 0;
	let suspected = false;
	for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/giu)) {
		for (const rule of styleRules(withoutCssComments(style[1] ?? ""))) {
			if (rule.unread === true) {
				suspected = true;
				continue;
			}
			if (!hidesContent(rule.body)) {
				continue;
			}
			if (rule.conditional) {
				suspected = true;
				continue;
			}
			for (const selector of splitTopLevel(unescapeCss(rule.selectors), ",")) {
				const expanded = expandCompound(subject(selector));
				if (expanded === null) {
					suspected = true;
					continue;
				}
				for (const compound of expanded) {
					if (count >= MAX_HIDING_RULES) {
						suspected = true;
						break;
					}
					count += 1;
					const key = ruleKey(compound);
					compounds.set(key, [...(compounds.get(key) ?? []), compound]);
				}
			}
		}
	}
	return { compounds, suspected };
}

function isHidden(name: string, attributes: string, rules: HidingRules): boolean {
	if (hasAttribute(attributes, "hidden") || attribute(attributes, "aria-hidden") === "true") {
		return true;
	}
	const style = attribute(attributes, "style");
	if (style !== null && hidesContent(style)) {
		return true;
	}
	const classes = new Set((attribute(attributes, "class") ?? "").toLowerCase().split(/\s+/u));
	const id = (attribute(attributes, "id") ?? "").toLowerCase();
	const keys = [`#${id}`, ...[...classes].map((c) => `.${c}`), name, "*"];
	return keys.some((key) =>
		(rules.compounds.get(key) ?? []).some(
			(rule) =>
				(rule.tag === null || rule.tag === name) &&
				rule.classes.every((c) => classes.has(c)) &&
				rule.ids.every((i) => i === id),
		),
	);
}

/** A link target worth showing: web and mail addresses only. */
function linkTarget(attributes: string): string | null {
	const href = attribute(attributes, "href")?.trim() ?? null;
	return href !== null && /^(https?:|mailto:)/iu.test(href) ? href : null;
}

export type HtmlText = Readonly<{
	text: string;
	hiddenRemoved: boolean;
	/** A stylesheet rule may hide text the sanitizer kept (it could not resolve the rule). */
	hiddenSuspected: boolean;
	/** The HTML was too large or nested too deeply, and its end was not read. */
	truncated: boolean;
}>;

/** Most HTML read, in characters: far beyond any readable mail, bounded against a crafted one. */
export const MAX_HTML_INPUT = 2_000_000;
/**
 * Deepest element nesting read. Every lookup in the open-element stack is bounded by it, so
 * conversion stays linear in the input however the tags are arranged.
 */
export const MAX_HTML_DEPTH = 256;

type OpenElement = Readonly<{ name: string; drops: boolean; href: string | null }>;

export function htmlToText(input: string): HtmlText {
	const html = input.length > MAX_HTML_INPUT ? input.slice(0, MAX_HTML_INPUT) : input;
	let truncated = html.length < input.length;
	const rules = hidingRules(html);
	let out = "";
	let hiddenRemoved = false;
	const stack: OpenElement[] = [];
	let dropDepth = 0;
	let last = 0;
	const emit = (text: string) => {
		if (dropDepth === 0) {
			out += text;
		}
	};
	const closeTo = (index: number) => {
		for (const element of stack.splice(index).reverse()) {
			if (element.drops) {
				dropDepth -= 1;
			}
			if (element.href !== null) {
				emit(` <${element.href}>`);
			}
			if (BLOCK.has(element.name)) {
				emit("\n");
			}
		}
	};
	for (const match of html.matchAll(TOKEN)) {
		emit(decodeEntities(html.slice(last, match.index).replace(/\s+/gu, " ")));
		last = match.index + match[0].length;
		const name = match[2]?.toLowerCase();
		if (name === undefined) {
			continue;
		}
		const attributes = match[3] ?? "";
		if (match[1] === "/") {
			const index = stack.findLastIndex((element) => element.name === name);
			if (index !== -1) {
				closeTo(index);
			} else if (BLOCK.has(name)) {
				emit("\n");
			}
			continue;
		}
		if (name === "br") {
			emit("\n");
			continue;
		}
		// Implied end tags, as browsers apply them: a block closes an open paragraph, a list item
		// the previous item of its list. Without them an unclosed hidden paragraph would hide the
		// rest of the mail.
		if (BLOCK.has(name)) {
			const paragraph = stack.findLastIndex((element) => element.name === "p");
			if (paragraph !== -1) {
				closeTo(paragraph);
			}
		}
		if (name === "li") {
			const list = stack.findLastIndex((e) => e.name === "ul" || e.name === "ol");
			const item = stack.findLastIndex((e) => e.name === "li");
			if (item > list) {
				closeTo(item);
			}
		}
		if (BLOCK.has(name)) {
			emit("\n");
		}
		if (name === "li") {
			emit("- ");
		}
		if (name === "td" || name === "th") {
			emit(" ");
		}
		const selfClosing = VOID.has(name) || attributes.trimEnd().endsWith("/");
		const hidden = isHidden(name, attributes, rules);
		const drops = DROPPED.has(name) || hidden;
		if (hidden && dropDepth === 0) {
			hiddenRemoved = true;
		}
		if (selfClosing) {
			continue;
		}
		if (stack.length >= MAX_HTML_DEPTH) {
			truncated = true;
			last = html.length;
			break;
		}
		stack.push({ name, drops, href: name === "a" && !drops ? linkTarget(attributes) : null });
		if (drops) {
			dropDepth += 1;
		}
	}
	emit(decodeEntities(html.slice(last).replace(/\s+/gu, " ")));
	closeTo(0);
	return { text: out, hiddenRemoved, hiddenSuspected: rules.suspected, truncated };
}
