import type {
	AgentId,
	ThreadSummary,
	ThreadSummaryEntry,
	Uuid,
	WorkingSummary,
} from "@agent-gateway/contracts";
import { truncate } from "./text.ts";

/** Runs kept whole in a thread summary; older ones are compacted. */
export const MAX_SUMMARY_ENTRIES = 8;
/** Compacted lines kept per kind; the oldest drop out first. */
export const MAX_EARLIER_LINES = 24;
/** Longest rendered thread summary. */
export const MAX_SUMMARY_CHARS = 8000;
/** Longest line taken from a run summary. */
const MAX_LINE_CHARS = 300;

export const EMPTY_THREAD_SUMMARY: ThreadSummary = {
	entries: [],
	earlier: { decisions: [], done: [] },
	compactedRuns: 0,
};

export type RunSummaryInit = Readonly<{
	runId: Uuid;
	agentId: AgentId;
	at: Date;
	summary: WorkingSummary;
}>;

const lines = (items: Readonly<string[]>) => items.map((item) => truncate(item, MAX_LINE_CHARS));

/** The part of a run's public summary its thread keeps. */
export function threadSummaryEntry(init: RunSummaryInit): ThreadSummaryEntry {
	const { summary } = init;
	return {
		runId: init.runId,
		agentId: init.agentId,
		at: init.at.toISOString(),
		assigned: truncate(summary.assigned, MAX_LINE_CHARS),
		facts: lines(summary.facts),
		done: lines(summary.done),
		decisions: lines(summary.decisions),
		remaining: lines(summary.remaining),
		waitingFor: lines(summary.waitingFor),
		risks: lines(summary.risks),
	};
}

const keepNewest = (items: Readonly<string[]>) => items.slice(-MAX_EARLIER_LINES);

/**
 * Adds a run to its thread's summary. The newest runs stay whole; the oldest are compacted into
 * their decisions and results, attributed to their agent. Idempotent per run. Pure.
 */
export function mergeThreadSummary(
	previous: ThreadSummary | null,
	entry: ThreadSummaryEntry,
): ThreadSummary {
	const base = previous ?? EMPTY_THREAD_SUMMARY;
	if (base.entries.some((known) => known.runId === entry.runId)) {
		return base;
	}
	const entries = [...base.entries, entry];
	let { decisions, done } = base.earlier;
	let compactedRuns = base.compactedRuns;
	while (entries.length > MAX_SUMMARY_ENTRIES) {
		const oldest = entries.shift();
		if (oldest === undefined) {
			break;
		}
		decisions = keepNewest([
			...decisions,
			...oldest.decisions.map((d) => `@${oldest.agentId}: ${d}`),
		]);
		done = keepNewest([...done, ...oldest.done.map((d) => `@${oldest.agentId}: ${d}`)]);
		compactedRuns += 1;
	}
	return { entries, earlier: { decisions, done }, compactedRuns };
}

function section(title: string, items: Readonly<string[]>): string[] {
	return items.length === 0 ? [] : [`  ${title}:`, ...items.map((item) => `  - ${item}`)];
}

function renderEntry(entry: ThreadSummaryEntry): string {
	return [
		`@${entry.agentId} at ${entry.at}: ${entry.assigned}`,
		...section("facts", entry.facts),
		...section("done", entry.done),
		...section("decisions", entry.decisions),
		...section("remaining", entry.remaining),
		...section("waiting for", entry.waitingFor),
		...section("risks", entry.risks),
	].join("\n");
}

/**
 * The summary as the turn reads it, within `MAX_SUMMARY_CHARS`; null when no run contributed yet.
 * The budget goes to the newest runs first, then to the compacted history; the result reads
 * oldest first. Pure.
 */
export function renderThreadSummary(summary: ThreadSummary | null): string | null {
	if (summary === null || (summary.entries.length === 0 && summary.compactedRuns === 0)) {
		return null;
	}
	const kept: string[] = [];
	let chars = 0;
	let omitted = 0;
	for (let i = summary.entries.length - 1; i >= 0; i -= 1) {
		const entry = summary.entries[i];
		if (entry === undefined) {
			break;
		}
		const text = renderEntry(entry);
		if (kept.length > 0 && chars + text.length + 1 > MAX_SUMMARY_CHARS) {
			omitted = i + 1;
			break;
		}
		kept.unshift(truncate(text, MAX_SUMMARY_CHARS));
		chars += text.length + 1;
	}
	const earlier =
		summary.compactedRuns + omitted === 0
			? []
			: [
					`Earlier runs: ${summary.compactedRuns} compacted${omitted > 0 ? `, ${omitted} more not shown` : ""}.`,
					...section("decisions", summary.earlier.decisions),
					...section("done", summary.earlier.done),
				];
	// The compacted history gets what the newest runs left, cut from its oldest lines.
	const room = MAX_SUMMARY_CHARS - chars;
	const history = earlier.join("\n");
	const head =
		history.length === 0
			? []
			: room <= 0
				? []
				: [history.length <= room ? history : tail(history, room)];
	return [...head, ...kept].join("\n");
}

/** The last `max` characters of `text`, starting at a line, marked as cut. */
function tail(text: string, max: number): string {
	const mark = "[…]\n";
	const start = text.length - Math.max(0, max - mark.length);
	const lineStart = text.indexOf("\n", start);
	return lineStart < 0 ? "" : `${mark}${text.slice(lineStart + 1)}`;
}
