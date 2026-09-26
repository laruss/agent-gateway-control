import { ApprovalRequestDraftSchema } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import type { ApiPost, ApiPostList } from "./api-schemas.ts";
import { channelChangesSince, type PostSource } from "./backfill.ts";
import { channelStartOf } from "./bootstrap.ts";
import { POSTS_SINCE_LIMIT } from "./client.ts";
import { codeBlock, renderAlert, renderApprovalCard } from "./render.ts";

const CHANNEL = "channe1000000000000000000a";

function post(n: number, overrides: Partial<ApiPost> = {}): ApiPost {
	return {
		id: `p${String(n).padStart(25, "0")}`,
		create_at: n,
		update_at: n,
		edit_at: 0,
		delete_at: 0,
		user_id: "u0000000000000000000000000",
		channel_id: CHANNEL,
		root_id: "",
		message: `m${n}`,
		type: "",
		props: {},
		...overrides,
	};
}

function list(posts: Readonly<ApiPost[]>): ApiPostList {
	return {
		order: posts.map((p) => p.id),
		posts: Object.fromEntries(posts.map((p) => [p.id, p])),
	};
}

/** A channel as the server answers: `since` keeps the newest changes, pages go newest first. */
function channel(posts: ApiPost[]): PostSource & { pages: (string | null)[] } {
	const pages: (string | null)[] = [];
	return {
		pages,
		channelPostsSince: async (_id, since) =>
			list(
				posts
					.filter((p) => p.update_at > since)
					.sort((a, b) => b.update_at - a.update_at)
					.slice(0, POSTS_SINCE_LIMIT),
			),
		// As Mattermost 11.7 answers `before`: posts created strictly earlier than the anchor.
		channelPostsBefore: async (_id, before, perPage) => {
			pages.push(before);
			const live = posts.filter((p) => p.delete_at === 0).sort((a, b) => b.create_at - a.create_at);
			const anchor = before === null ? undefined : posts.find((p) => p.id === before);
			const older =
				anchor === undefined ? live : live.filter((p) => p.create_at < anchor.create_at);
			return list(older.slice(0, perPage));
		},
		channelPostsPage: async (_id, page, perPage) => {
			const live = posts.filter((p) => p.delete_at === 0).sort((a, b) => b.create_at - a.create_at);
			return list(live.slice(page * perPage, (page + 1) * perPage));
		},
	};
}

describe("channel backfill", () => {
	it("returns every change after the cursor, oldest first, without paging", async () => {
		const source = channel([post(1), post(2, { update_at: 9, edit_at: 9 }), post(3)]);
		const changes = await channelChangesSince(source, CHANNEL, 1);
		expect(changes.map((p) => p.create_at)).toEqual([3, 2]);
		expect(source.pages).toEqual([]);
	});

	it("pages back for creations the since limit cut off", async () => {
		const posts = Array.from({ length: POSTS_SINCE_LIMIT + 350 }, (_, i) => post(i + 1));
		const source = channel(posts);
		const changes = await channelChangesSince(source, CHANNEL, 100);
		expect(changes).toHaveLength(POSTS_SINCE_LIMIT + 250);
		expect(changes[0]?.create_at).toBe(101);
		expect(changes.at(-1)?.create_at).toBe(POSTS_SINCE_LIMIT + 350);
		expect(source.pages.length).toBeGreaterThan(1);
	});

	it("misses no post that shares a millisecond with a page boundary", async () => {
		// Three posts per millisecond: pages of 200 end inside a millisecond.
		const posts = Array.from({ length: POSTS_SINCE_LIMIT + 401 }, (_, i) =>
			post(i + 1, { create_at: 1000 + Math.floor(i / 3), update_at: 1000 + Math.floor(i / 3) }),
		);
		const changes = await channelChangesSince(channel(posts), CHANNEL, 999);
		expect(new Set(changes.map((p) => p.id)).size).toBe(posts.length);
	});

	it("misses no post when a whole page shares one millisecond", async () => {
		const posts = [
			...Array.from({ length: 450 }, (_, i) => post(i + 1, { create_at: 500, update_at: 500 })),
			...Array.from({ length: POSTS_SINCE_LIMIT }, (_, i) => post(i + 451, { create_at: 600 + i })),
		].map((p) => ({ ...p, update_at: p.create_at }));
		const changes = await channelChangesSince(channel(posts), CHANNEL, 100);
		expect(new Set(changes.map((p) => p.id)).size).toBe(posts.length);
	});

	it("repeats offset pages until deletions stop shifting them", async () => {
		const posts = [
			...Array.from({ length: 450 }, (_, i) => post(i + 1, { create_at: 500 })),
			...Array.from({ length: POSTS_SINCE_LIMIT }, (_, i) => post(i + 451, { create_at: 600 + i })),
		].map((p) => ({ ...p, update_at: p.create_at }));
		const source = channel(posts);
		let offsetCalls = 0;
		const deleting: PostSource = {
			...source,
			channelPostsPage: async (id, page, perPage) => {
				offsetCalls += 1;
				if (offsetCalls === 7) {
					// Posts of an already read offset page disappear: later pages shift left.
					for (const p of posts.slice(-100)) {
						p.delete_at = 1;
					}
				}
				return source.channelPostsPage(id, page, perPage);
			},
		};
		const changes = await channelChangesSince(deleting, CHANNEL, 100);
		const found = new Set(changes.map((p) => p.id));
		for (const p of posts.slice(0, 450)) {
			expect(found.has(p.id)).toBe(true);
		}
	});

	it("starts a channel past every post of its newest millisecond", async () => {
		const posts = [
			...Array.from({ length: 30 }, (_, i) => post(i + 1, { create_at: 400 })),
			...Array.from({ length: 450 }, (_, i) => post(i + 31, { create_at: 900 })),
		];
		const start = await channelStartOf(channel(posts), CHANNEL);
		expect(start.floor).toBe(900);
		expect(start.floorPostIds).toHaveLength(450);
	});

	it("starts a channel past every surviving post even when posts are deleted meanwhile", async () => {
		const posts = Array.from({ length: 250 }, (_, i) => post(i + 1, { create_at: 900 }));
		const source = channel(posts);
		let calls = 0;
		const deleting = {
			channelPostsPage: async (id: string, page: number, perPage: number) => {
				calls += 1;
				if (calls === 2) {
					// Posts of page 0 go away before page 1 is read: page 1 shifts past 50 posts.
					for (const p of posts.slice(0, 50)) {
						p.delete_at = 1;
					}
				}
				return source.channelPostsPage(id, page, perPage);
			},
		};
		const start = await channelStartOf(deleting, CHANNEL);
		const ids = new Set(start.floorPostIds);
		for (const p of posts.filter((candidate) => candidate.delete_at === 0)) {
			expect(ids.has(p.id)).toBe(true);
		}
	});

	it("misses nothing when posts are deleted while it pages", async () => {
		const posts = Array.from({ length: POSTS_SINCE_LIMIT + 400 }, (_, i) => post(i + 1));
		const source = channel(posts);
		const paging = source.channelPostsBefore;
		let calls = 0;
		const deleting: PostSource = {
			channelPostsSince: source.channelPostsSince,
			channelPostsPage: source.channelPostsPage,
			channelPostsBefore: async (id, before, perPage) => {
				calls += 1;
				if (calls === 2) {
					// Posts of an already read page disappear.
					for (const p of posts.slice(-50)) {
						p.delete_at = 1;
					}
				}
				return paging(id, before, perPage);
			},
		};
		const changes = await channelChangesSince(deleting, CHANNEL, 100);
		const created = new Set(changes.map((p) => p.create_at));
		for (let n = 101; n <= POSTS_SINCE_LIMIT + 350; n += 1) {
			expect(created.has(n)).toBe(true);
		}
	});
});

describe("rendering", () => {
	it("keeps the largest valid approval card within one post", () => {
		// Long backtick runs make the fences as long as they get.
		const value = `${"`".repeat(1990)}x`;
		const params: { name: string; value: string }[] = [];
		const summary = `${"`".repeat(1990)} s`;
		for (let n = 0; n < 32; n += 1) {
			const candidate = [...params, { name: `p${n}`, value }];
			const parsed = ApprovalRequestDraftSchema.safeParse({
				actionType: "finance.payment.create",
				actionParams: candidate,
				actionSummary: summary,
			});
			if (!parsed.success) {
				break;
			}
			params.push({ name: `p${n}`, value });
		}
		expect(params.length).toBeGreaterThan(0);
		const card = renderApprovalCard({
			approvalId: "0d7bc6f6-58a4-4a4b-8b7e-8b7c1f0d0a11",
			channelName: "approvals",
			channelId: null,
			requestedByAgentId: "finance",
			actionType: "finance.payment.create",
			actionSummary: summary,
			actionParams: params,
			riskLevel: "critical",
			immutableActionHash: "a".repeat(64),
			expiresAt: "2026-09-25T10:00:00.000Z",
		});
		expect(card.length).toBeLessThanOrEqual(16_383);
	});

	it("keeps variable text inside a code block it cannot close", () => {
		const block = codeBlock("a ``` b ```` c");
		expect(block.startsWith("`````\n")).toBe(true);
		expect(block.endsWith("\n`````")).toBe(true);
		const alert = renderAlert({
			channelName: "gateway-alerts",
			channelId: null,
			message: "@all ```\n**forged**",
			detail: { agent_id: "developer" },
		});
		expect(alert.split("\n")[0]).toBe("**Gateway alert**");
		expect(alert).toContain('{"agent_id":"developer"}');
		expect(alert.split("\n")[1]).toBe("````");
	});
});
