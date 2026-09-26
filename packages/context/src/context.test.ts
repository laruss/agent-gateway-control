import type {
	MattermostPostData,
	MemoryItem,
	ThreadSummary,
	WorkingSummary,
} from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import { selectMemories } from "./memory.ts";
import {
	MAX_EARLIER_LINES,
	MAX_SUMMARY_CHARS,
	MAX_SUMMARY_ENTRIES,
	mergeThreadSummary,
	renderThreadSummary,
	threadSummaryEntry,
} from "./summary.ts";
import { truncate } from "./text.ts";
import { DEFAULT_THREAD_BUDGET, foldThread, postOverlays, type StoredPostEvent } from "./thread.ts";

const CHANNEL = "c".repeat(26);
const OTHER_CHANNEL = "o".repeat(26);
const ROOT = "r".repeat(26);
const HUMAN = "h".repeat(26);
const BOT = "b".repeat(26);

const id = (n: number) => `p${String(n).padStart(25, "0")}`;

function post(postId: string, overrides: Partial<MattermostPostData> = {}): MattermostPostData {
	return {
		post_id: postId,
		root_id: postId === ROOT ? null : ROOT,
		channel_id: CHANNEL,
		user_id: HUMAN,
		sender_agent_id: null,
		target_agent_ids: [],
		message: `message ${postId}`,
		...overrides,
	};
}

function created(
	postId: string,
	minute: number,
	overrides: Partial<MattermostPostData> = {},
): StoredPostEvent {
	const data = post(postId, overrides);
	return {
		type: data.root_id === null ? "mattermost.post.created" : "mattermost.thread.reply",
		time: new Date(Date.UTC(2026, 8, 26, 12, minute)),
		trustLevel: data.sender_agent_id === null ? "human-trusted" : "internal-untrusted",
		post: data,
	};
}

const request = (overrides: Partial<Parameters<typeof foldThread>[1]> = {}) => ({
	channelId: CHANNEL,
	rootPostId: ROOT,
	exclude: new Set<string>(),
	summary: null,
	budget: DEFAULT_THREAD_BUDGET,
	...overrides,
});

describe("foldThread", () => {
	it("returns the root, the replies oldest first, and the participants", () => {
		const folded = foldThread(
			[
				created(ROOT, 0, { target_agent_ids: ["developer"] }),
				created(id(2), 2, {
					user_id: BOT,
					sender_agent_id: "finance",
					target_agent_ids: ["developer"],
				}),
				created(id(1), 1, {
					user_id: BOT,
					sender_agent_id: "developer",
					target_agent_ids: ["finance"],
				}),
			],
			request(),
		);
		expect(folded?.context.rootPost?.message).toBe(`message ${ROOT}`);
		expect(folded?.context.recentPosts.map((p) => p.postId)).toEqual([id(1), id(2)]);
		expect(folded?.context.recentPosts[0]?.authorAgentId).toBe("developer");
		expect(folded?.context.participantAgentIds).toEqual(["developer", "finance"]);
		expect(folded?.humanUserIds).toEqual([HUMAN]);
	});

	it("does not repeat a root the turn carries itself", () => {
		const folded = foldThread(
			[created(ROOT, 0), created(id(1), 1)],
			request({ exclude: new Set([ROOT]) }),
		);
		expect(folded?.context.rootPost).toBeNull();
		expect(folded?.context.recentPosts.map((p) => p.postId)).toEqual([id(1)]);
		expect(folded?.humanUserIds).toEqual([HUMAN]);
	});

	it("keeps the replies of a thread whose root was never recorded", () => {
		expect(foldThread([], request())).toBeNull();
		const folded = foldThread([created(id(1), 1)], request());
		expect(folded?.context.rootPost).toBeNull();
		expect(folded?.context.recentPosts.map((p) => p.postId)).toEqual([id(1)]);
		expect(folded?.humanUserIds).toEqual([HUMAN]);
	});

	it("applies edits, drops deleted posts and keeps a deleted root without its text", () => {
		const folded = foldThread(
			[
				created(ROOT, 0),
				created(id(1), 1),
				created(id(2), 2, { user_id: "x".repeat(26) }),
				{
					...created(id(1), 3),
					type: "mattermost.post.edited",
					post: post(id(1), { message: "edited" }),
				},
				{
					...created(id(2), 4),
					type: "mattermost.post.deleted",
					post: post(id(2), { message: "" }),
				},
				{ ...created(ROOT, 5), type: "mattermost.post.deleted", post: post(ROOT, { message: "" }) },
			],
			request(),
		);
		expect(folded?.context.rootPost?.message).toBe("");
		expect(folded?.context.recentPosts.map((p) => p.message)).toEqual(["edited"]);
		// The author of the deleted reply is no longer a participant.
		expect(folded?.humanUserIds).toEqual([HUMAN]);
	});

	it("lowers the trust of a human post edited by an integration", () => {
		const folded = foldThread(
			[
				created(ROOT, 0),
				created(id(1), 1),
				{
					...created(id(1), 2),
					type: "mattermost.post.edited",
					trustLevel: "internal-untrusted",
					post: post(id(1), { message: "rewritten" }),
				},
			],
			request(),
		);
		expect(folded?.context.recentPosts[0]?.trustLevel).toBe("internal-untrusted");
		expect(folded?.humanUserIds).toEqual([HUMAN]);
	});

	it("ignores changes of unrecorded posts, other threads and other channels", () => {
		const folded = foldThread(
			[
				created(ROOT, 0),
				{ ...created(id(1), 1), type: "mattermost.post.edited" },
				created(id(2), 2, { root_id: "z".repeat(26) }),
				created(id(3), 3, { channel_id: OTHER_CHANNEL }),
			],
			request(),
		);
		expect(folded?.context.recentPosts).toEqual([]);
	});

	it("leaves out the posts the turn carries and keeps the newest posts within the budget", () => {
		const events = [created(ROOT, 0), ...[1, 2, 3, 4, 5].map((n) => created(id(n), n))];
		const folded = foldThread(
			events,
			request({
				exclude: new Set([id(5)]),
				budget: { maxPosts: 2, maxChars: 10_000, maxPostChars: 4000 },
			}),
		);
		expect(folded?.context.recentPosts.map((p) => p.postId)).toEqual([id(3), id(4)]);
		expect(folded?.context.omittedPostCount).toBe(2);

		const byChars = foldThread(
			events,
			request({ budget: { maxPosts: 10, maxChars: 60, maxPostChars: 4000 } }),
		);
		// Each message is 34 characters: only the newest fits in 60.
		expect(byChars?.context.recentPosts.map((p) => p.postId)).toEqual([id(5)]);
		expect(byChars?.context.omittedPostCount).toBe(4);
	});

	it("cuts long messages without splitting a surrogate pair", () => {
		const long = `${"a".repeat(9)}😀tail`;
		const folded = foldThread(
			[created(ROOT, 0, { message: long })],
			request({ budget: { maxPosts: 10, maxChars: 100, maxPostChars: 14 } }),
		);
		expect(folded?.context.rootPost?.message).toBe(`${"a".repeat(9)} […]`);
		expect(truncate("short", 14)).toBe("short");
	});
});

describe("postOverlays", () => {
	it("gives the latest text of carried posts, blanks deleted ones and flags foreign edits", () => {
		const edit = (
			postId: string,
			minute: number,
			message: string,
			trust = "human-trusted" as const,
		) => ({
			...created(postId, minute),
			type: "mattermost.post.edited" as const,
			trustLevel: trust,
			post: post(postId, { message }),
		});
		const overlays = postOverlays(
			[
				created(id(1), 1),
				edit(id(1), 2, "v2"),
				edit(id(1), 3, "v3"),
				created(id(2), 4),
				{
					...created(id(2), 5),
					type: "mattermost.post.deleted",
					post: post(id(2), { message: "" }),
				},
				edit(id(2), 6, "after deletion"),
				{ ...edit(id(3), 7, "by a bot"), trustLevel: "internal-untrusted" },
				edit(id(4), 8, "not carried"),
			],
			new Set([id(1), id(2), id(3)]),
		);
		expect(Object.fromEntries(overlays)).toEqual({
			[id(1)]: { message: "v3", deleted: false, untrusted: false },
			[id(2)]: { message: "", deleted: true, untrusted: false },
			[id(3)]: { message: "by a bot", deleted: false, untrusted: true },
		});
	});
});

const workingSummary = (n: number): WorkingSummary => ({
	assigned: `task ${n}`,
	facts: [],
	decisions: [`decision ${n}`],
	done: [`done ${n}`],
	remaining: [],
	waitingFor: n === 1 ? ["@finance"] : [],
	risks: n === 2 ? ["budget may overrun"] : [],
});

const runId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("thread summaries", () => {
	const entry = (n: number) =>
		threadSummaryEntry({
			runId: runId(n),
			agentId: n % 2 === 0 ? "finance" : "developer",
			at: new Date(Date.UTC(2026, 8, 26, 12, n)),
			summary: workingSummary(n),
		});

	it("renders nothing before the first run", () => {
		expect(renderThreadSummary(null)).toBeNull();
	});

	it("keeps the newest runs whole and compacts the oldest, once per run", () => {
		let summary: ThreadSummary | null = null;
		for (let n = 1; n <= MAX_SUMMARY_ENTRIES + 2; n += 1) {
			summary = mergeThreadSummary(summary, entry(n));
		}
		summary = mergeThreadSummary(summary, entry(MAX_SUMMARY_ENTRIES + 2));
		expect(summary?.entries.map((e) => e.assigned)).toEqual(
			Array.from({ length: MAX_SUMMARY_ENTRIES }, (_, i) => `task ${i + 3}`),
		);
		expect(summary?.compactedRuns).toBe(2);
		expect(summary?.earlier.decisions).toEqual(["@developer: decision 1", "@finance: decision 2"]);
		const text = renderThreadSummary(summary);
		expect(text).toContain("Earlier runs: 2 compacted.");
		expect(text).toContain("@finance at 2026-09-26T12:10:00.000Z: task 10");
		const whole = renderThreadSummary(mergeThreadSummary(null, entry(2))) ?? "";
		expect(whole).toContain("  risks:\n  - budget may overrun");
	});

	it("gives the rendering budget to the newest runs first", () => {
		const long = (n: number) =>
			threadSummaryEntry({
				runId: runId(n),
				agentId: "developer",
				at: new Date(Date.UTC(2026, 8, 26, 12, n)),
				summary: { ...workingSummary(n), done: Array.from({ length: 10 }, () => `x`.repeat(290)) },
			});
		let summary: ThreadSummary | null = null;
		for (let n = 1; n <= MAX_SUMMARY_ENTRIES; n += 1) {
			summary = mergeThreadSummary(summary, long(n));
		}
		const text = renderThreadSummary(summary) ?? "";
		expect(text.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
		expect(text).toContain(`task ${MAX_SUMMARY_ENTRIES}`);
		expect(text).not.toContain("task 1\n");
		expect(text.startsWith("Earlier runs: 0 compacted, 6 more not shown.")).toBe(true);
	});

	it("bounds the compacted lines", () => {
		let summary: ThreadSummary | null = null;
		for (let n = 1; n <= MAX_SUMMARY_ENTRIES + MAX_EARLIER_LINES + 5; n += 1) {
			summary = mergeThreadSummary(summary, entry(n));
		}
		expect(summary?.earlier.decisions).toHaveLength(MAX_EARLIER_LINES);
		expect(summary?.earlier.decisions.at(-1)).toBe("@developer: decision 29");
	});
});

describe("selectMemories", () => {
	const item = (
		n: number,
		namespace: string,
		visibility: MemoryItem["visibility"],
	): MemoryItem => ({
		id: runId(n),
		namespace,
		key: `k${n}`,
		content: `content ${n}`,
		visibility,
		sourceRunId: null,
		createdAt: new Date(Date.UTC(2026, 8, 26, 12, n)).toISOString(),
	});
	const namespaces = { private: "agents/developer", shared: ["organization/decisions"] };

	it("returns only the agent's own namespaces, newest first", () => {
		const selected = selectMemories(
			[
				item(1, "agents/developer", "private"),
				item(2, "agents/finance", "private"),
				item(3, "organization/decisions", "shared"),
				item(4, "organization/finance", "public"),
			],
			namespaces,
		);
		expect(selected.map((m) => m.key)).toEqual(["k3", "k1"]);
	});

	it("drops items whose visibility contradicts their namespace and respects the budget", () => {
		const selected = selectMemories(
			[
				item(1, "agents/developer", "public"),
				item(2, "organization/decisions", "shared"),
				item(3, "organization/decisions", "public"),
				item(4, "organization/decisions", "shared"),
			],
			namespaces,
			{ maxItems: 2, maxChars: 1000 },
		);
		expect(selected.map((m) => m.key)).toEqual(["k4", "k3"]);
		expect(
			selectMemories([item(1, "agents/developer", "private")], namespaces, {
				maxItems: 5,
				maxChars: 3,
			}),
		).toEqual([]);
	});
});
