import { z } from "zod";

/** Mattermost mentions that notify a whole channel; never valid as agent ids. */
export const BROADCAST_MENTIONS: Readonly<string[]> = ["all", "here", "channel"];

/**
 * Logical agent id, equal to the agent's Mattermost bot username.
 * Hyphens only between alphanumerics; broadcast mention names are reserved.
 */
export const AgentIdSchema = z
	.string()
	.min(2)
	.max(32)
	.regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "lowercase letters, digits, inner '-'")
	.refine((id) => !BROADCAST_MENTIONS.includes(id), "reserved Mattermost mention name");
export type AgentId = z.infer<typeof AgentIdSchema>;

/** Mattermost entity id (user, channel, post, team): 26 lowercase alphanumerics. */
export const MattermostIdSchema = z.string().regex(/^[a-z0-9]{26}$/, "Mattermost id");
export type MattermostId = z.infer<typeof MattermostIdSchema>;

export const MattermostNameSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "Mattermost team/channel/user name");
export type MattermostName = z.infer<typeof MattermostNameSchema>;

/**
 * A Docker/Compose secret file: `/run/secrets/<name>` (the controller's read-only, owner-managed
 * secrets) or `/run/bot-secrets/<name>` (the controller's own read-write directory, where it
 * writes tokens it provisions itself for lifecycle-created agents; see ADR-026).
 */
export const SecretFileSchema = z
	.string()
	.regex(
		/^\/run\/(?:secrets|bot-secrets)\/[a-z0-9_]+$/,
		"path under /run/secrets/ or /run/bot-secrets/",
	);
export type SecretFile = z.infer<typeof SecretFileSchema>;

/** Prefix of a lifecycle-created agent's bot token file (ADR-026): generated server-side by the
 * controller's own provisioner, under its read-write directory — never bootstrap's or reconcile's
 * to resolve or touch (`mattermostPlan` skips any agent whose `token_secret_file` lives here; it
 * is the provisioner's bot to manage). */
export const BOT_SECRET_FILE_PREFIX = "/run/bot-secrets/";

/** The controller's HMAC key for agent routing props; no bot token may live there. */
export const ROUTING_KEY_SECRET_FILE: SecretFile = "/run/secrets/gateway_routing_key";

/** The console's sign-in credential: only its Argon2id hash is ever stored, never the password. */
export const CONSOLE_PASSWORD_HASH_SECRET_FILE: SecretFile = "/run/secrets/console_password_hash";

/** The dedicated, non-bot Mattermost system-admin account's personal access token the lifecycle
 * provisioner uses (ADR-026): read-only to the controller, written only by
 * `gateway mattermost admin-token set|rotate`. */
export const MATTERMOST_ADMIN_TOKEN_SECRET_FILE: SecretFile = "/run/secrets/mattermost_admin_token";

export const TimestampSchema = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;

export const UuidSchema = z.uuid();
export type Uuid = z.infer<typeof UuidSchema>;

export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, "sha256 hex digest");
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;

/** Concrete tool action with at least two segments: `mail.read`, `finance.payment.create`. */
export const ToolNameSchema = z
	.string()
	.regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, "concrete tool name like 'mail.read'");
export type ToolName = z.infer<typeof ToolNameSchema>;

/** Tool name, or a prefix wildcard in the last segment only: `finance.*`. */
export const ToolPatternSchema = z
	.string()
	.regex(
		/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*\.([a-z][a-z0-9-]*|\*)$/,
		"tool name like 'mail.read' or prefix wildcard like 'finance.*'",
	);
export type ToolPattern = z.infer<typeof ToolPatternSchema>;

/** The only tool pattern that ever names every finance capability at once. A single shared
 * constant so `@agent-gateway/contracts`' own finance rule, `@agent-gateway/policy`'s compiler
 * and `core`'s agent-lifecycle service (restore/retire normalization) can never drift apart on
 * what "finance" means as a tool pattern. */
export const FINANCE_TOOLS: ToolPattern = "finance.*";

/** True when `pattern` matches every tool that `other` matches. */
export function toolPatternCovers(pattern: ToolPattern, other: ToolPattern): boolean {
	if (!pattern.endsWith(".*")) {
		return pattern === other;
	}
	const prefix = pattern.slice(0, -1);
	return other === pattern || other.startsWith(prefix);
}

/** True when some tool is matched by both patterns. */
export function toolPatternsOverlap(a: ToolPattern, b: ToolPattern): boolean {
	return toolPatternCovers(a, b) || toolPatternCovers(b, a);
}

export type ToolPatternOverlap = Readonly<{ list: string; message: string }>;

/**
 * A tool may be reachable through exactly one permission list; overlapping patterns across
 * (or within) lists are ambiguous. Returns one entry per overlapping pair.
 */
export function toolPatternOverlaps(
	lists: Readonly<Record<string, Readonly<ToolPattern[]>>>,
): Readonly<ToolPatternOverlap[]> {
	const entries = Object.entries(lists).flatMap(([list, patterns]) =>
		patterns.map((pattern) => ({ list, pattern })),
	);
	return entries.flatMap((a, i) =>
		entries
			.slice(i + 1)
			.filter((b) => toolPatternsOverlap(a.pattern, b.pattern))
			.map((b) => ({
				list: b.list,
				message: `tool pattern '${b.pattern}' in ${b.list} overlaps '${a.pattern}' in ${a.list}`,
			})),
	);
}

export const TrustLevelSchema = z.enum([
	"system-trusted",
	"human-trusted",
	"internal-untrusted",
	"external-untrusted",
]);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;

export const RuntimeAdapterIdSchema = z.enum([
	"mock",
	"codex",
	"claude-code",
	"grok",
	"kiro",
	"opencode-go",
	"hermes",
]);
export type RuntimeAdapterId = z.infer<typeof RuntimeAdapterIdSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const VisibilitySchema = z.enum(["private", "shared", "public"]);
export type Visibility = z.infer<typeof VisibilitySchema>;

/** `agents/<agent-id>` (private) or `organization/<topic>[/<sub>...]` (shared). */
export const MemoryNamespaceSchema = z
	.string()
	.regex(
		/^(agents\/[a-z][a-z0-9-]{1,31}|organization(\/[a-z][a-z0-9-]{0,63}){1,4})$/,
		"memory namespace 'agents/<id>' or 'organization/<topic>'",
	);
export type MemoryNamespace = z.infer<typeof MemoryNamespaceSchema>;

/**
 * An agent's own namespace stays private; shared namespaces are never private.
 * Returns the violation, or null.
 */
export function memoryVisibilityIssue(
	namespace: MemoryNamespace,
	visibility: Visibility,
): string | null {
	const isPrivateNamespace = namespace.startsWith("agents/");
	if (isPrivateNamespace === (visibility === "private")) {
		return null;
	}
	return isPrivateNamespace
		? "memory in 'agents/<id>' must be private"
		: "memory in a shared namespace cannot be private";
}

/**
 * Repository-relative path to a Markdown prompt under `prompts/`.
 * The shape itself excludes absolute paths, `..` and secret mounts.
 */
export const PromptPathSchema = z
	.string()
	.regex(/^prompts(\/[a-z0-9][a-z0-9_-]*)+\.md$/, "path like 'prompts/agents/developer.md'");
export type PromptPath = z.infer<typeof PromptPathSchema>;

/**
 * How strictly text is checked:
 * - `text`: messages and summaries. A blocklist: no controls except tab/newline/CR, no line
 *   separators, no lone surrogates, no format characters except the zero-width joiners
 *   (U+200C, U+200D, needed by emoji sequences and Persian/Indic scripts) and the soft hyphen.
 * - `verbatim`: single-line values a human approves as shown (approval parameters, paths). An
 *   allowlist: NFKC-stable letters, digits, punctuation, symbols and single inner spaces only,
 *   so two values that render alike (`acme` / `acme `, `paypal` / fullwidth `ｐａｙｐａｌ`) differ
 *   visibly or are rejected.
 */
export type TextSafety = "text" | "verbatim";

const TEXT_ALLOWED_CONTROLS = new Set(["\t", "\n", "\r"]);
/** Controls (Cc), line/paragraph separators (Zl, Zp), lone surrogates (Cs). */
const TEXT_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}\p{Cs}]/u;
/** Format characters (Cf): bidi controls, zero-width characters, word joiner, BOM, tags. */
const FORMAT_CHARACTER = /\p{Cf}/u;
const TEXT_ALLOWED_FORMAT = new Set(["\u200C", "\u200D", "\u00AD"]);

const VERBATIM_ALLOWED = /^[\p{L}\p{N}\p{P}\p{S} ]$/u;
/** Letters and symbols that render as blank space. */
const VERBATIM_BLANK_LOOKALIKES = new Set([
	"\u115F",
	"\u1160",
	"\u3164",
	"\uFFA0",
	"\u2800",
	"\uFFFC",
]);
/** Leading, trailing or repeated spaces. */
const VERBATIM_SPACING = /^ | $| {2}/;

function isUnsafeTextCharacter(char: string): boolean {
	if (TEXT_ALLOWED_CONTROLS.has(char)) {
		return false;
	}
	return (
		TEXT_FORBIDDEN.test(char) || (FORMAT_CHARACTER.test(char) && !TEXT_ALLOWED_FORMAT.has(char))
	);
}

function isUnsafeVerbatimCharacter(char: string): boolean {
	return !VERBATIM_ALLOWED.test(char) || VERBATIM_BLANK_LOOKALIKES.has(char);
}

export function hasUnsafeCharacters(value: string, safety: TextSafety): boolean {
	if (
		safety === "verbatim" &&
		(value !== value.normalize("NFKC") || VERBATIM_SPACING.test(value))
	) {
		return true;
	}
	const isUnsafe = safety === "verbatim" ? isUnsafeVerbatimCharacter : isUnsafeTextCharacter;
	for (const char of value) {
		if (isUnsafe(char)) {
			return true;
		}
	}
	return false;
}

/**
 * `value` without the characters `text` safety rejects: for external content (mail, web) that is
 * kept, not refused, but must not carry controls, bidi overrides or invisible tag characters.
 */
export function withoutUnsafeCharacters(value: string): string {
	let result = "";
	for (const char of value) {
		if (!isUnsafeTextCharacter(char)) {
			result += char;
		}
	}
	return result;
}

/** Non-blank text without control or invisible characters, bounded by `max`. */
export function safeText(max: number, safety: TextSafety) {
	return z
		.string()
		.min(1)
		.max(max)
		.regex(/\S/, "must not be blank")
		.refine(
			(value) => !hasUnsafeCharacters(value, safety),
			"control or invisible characters are not allowed",
		);
}

/** `true` for a character `safeText(_, "verbatim")` would accept on its own (ignoring the
 * whole-string NFKC/spacing rules `hasUnsafeCharacters` also checks) — a letter, digit,
 * punctuation or symbol, and not one of the blank lookalikes. */
function isVerbatimSafeCharacter(char: string): boolean {
	return VERBATIM_ALLOWED.test(char) && !VERBATIM_BLANK_LOOKALIKES.has(char);
}

/**
 * `value`, collapsed into a single line any `safeText(max, "verbatim")` schema accepts: every
 * character the allowlist would reject (controls, newlines/tabs, bidi overrides, emoji
 * modifiers that render blank, ...) becomes one space, runs of spaces collapse to one, and the
 * ends are trimmed — never dropped outright, so words on either side of a stripped character
 * never run together. Longer than `max` once collapsed, it is cut and marked with the same `…`
 * truncation marker `@agent-gateway/logging`'s `truncateText` already uses elsewhere; genuinely
 * empty (nothing but unsafe characters, or blank to start with) becomes `"(empty)"` — `safeText`
 * never accepts blank. Built to satisfy the schema by construction, but a value this function
 * cannot make to fit (an astral character's surrogate pair split by truncation, the one case
 * construction alone cannot rule out) is shrunk one code unit at a time, re-checked against the
 * real schema rule each time, until it does: correctness is verified, not merely argued for.
 * For a result a human approves or reads back verbatim (a tool receipt field, a response
 * preview) — never for `"text"` safety, which already tolerates newlines/tabs and so never needs
 * this collapsing.
 */
export function toVerbatimPreview(value: string, max: number): string {
	let collapsed = "";
	for (const char of value.normalize("NFKC")) {
		const piece = isVerbatimSafeCharacter(char) ? char : " ";
		if (piece === " " && collapsed.endsWith(" ")) {
			continue;
		}
		collapsed += piece;
	}
	collapsed = collapsed.trim();
	const marker = "…";
	let candidate =
		collapsed.length <= max
			? collapsed
			: `${collapsed.slice(0, Math.max(0, max - marker.length)).replace(/ +$/, "")}${marker}`;
	while (
		candidate !== "" &&
		(candidate.length > max || hasUnsafeCharacters(candidate, "verbatim"))
	) {
		candidate = candidate.slice(0, -1);
	}
	return candidate === "" ? "(empty)" : candidate;
}

/** Mention tokens as Mattermost reads them: `@name` not preceded by a letter, digit or `_`. */
const MENTION = /(^|[^\p{L}\p{N}_])@([\p{L}\p{N}_.-]+)/gu;

/**
 * Lowercased names mentioned in `text`, each with and without trailing `.`, `-`, `_`
 * (Mattermost retries a mention without trailing punctuation).
 */
export function mentionedNames(text: string): Readonly<string[]> {
	const names = new Set<string>();
	for (const match of text.matchAll(MENTION)) {
		const name = (match[2] ?? "").toLowerCase();
		names.add(name);
		names.add(name.replace(/[._-]+$/, ""));
	}
	names.delete("");
	return [...names];
}

/** Arbitrary JSON object payload. Never used in model-facing schemas. */
export const JsonObjectSchema = z.record(z.string(), z.json());
export type JsonObject = z.infer<typeof JsonObjectSchema>;

/** W3C trace context `traceparent` header value. */
export const TraceparentSchema = z
	.string()
	.regex(/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/, "W3C traceparent");
