import type { MattermostId } from "@agent-gateway/contracts";
import type { ApiPost } from "./api-schemas.ts";
import { type MattermostClient, POSTS_SINCE_LIMIT } from "./client.ts";
import type { PostChange } from "./normalize.ts";

export type PostSource = Pick<
	MattermostClient,
	"channelPostsSince" | "channelPostsBefore" | "channelPostsPage"
>;

const PAGE_SIZE = 200;

/**
 * Every post of a channel changed after `sinceMs`, oldest change first. `since` reports edits and
 * deletions too, but only the newest {@link POSTS_SINCE_LIMIT}; when it is full, older posts
 * created in the gap are recovered by paging back through the channel, each page anchored at a
 * post of the one before, so deletions cannot shift pages and posts sharing a millisecond are not
 * skipped (pages hold no deleted posts, and edits of those older posts are not seen, which only
 * matters for the audit trail).
 */
export async function channelChangesSince(
	source: PostSource,
	channelId: MattermostId,
	sinceMs: number,
	/** Called when the gap exceeds the since limit: older edits and deletions are not seen. */
	onLimit?: () => void,
): Promise<Readonly<ApiPost[]>> {
	const recent = await source.channelPostsSince(channelId, sinceMs);
	const byId = new Map(Object.values(recent.posts).map((post) => [post.id, post]));
	if (byId.size >= POSTS_SINCE_LIMIT) {
		onLimit?.();
		let before: MattermostId | null = null;
		for (;;) {
			const list = await source.channelPostsBefore(channelId, before, PAGE_SIZE);
			const posts = list.order.flatMap((id) => {
				const post = list.posts[id];
				return post === undefined ? [] : [post];
			});
			for (const post of posts) {
				if (post.create_at > sinceMs && !byId.has(post.id)) {
					byId.set(post.id, post);
				}
			}
			const oldest = posts.at(-1);
			if (posts.length < PAGE_SIZE || oldest === undefined || oldest.create_at <= sinceMs) {
				break;
			}
			// The server's `before` means "created strictly earlier than the anchor", so anchoring
			// at the oldest post would skip others of its millisecond. Anchor at the oldest post of
			// a later millisecond instead: the page after it repeats the oldest millisecond whole
			// (duplicates are dropped by id), and the anchor's time strictly decreases.
			const anchor = [...posts].reverse().find((post) => post.create_at > oldest.create_at);
			if (anchor === undefined) {
				// A whole page in one millisecond: no anchor can reach past it. Offset pages can
				// (they may shift under deletions, so they only add to what anchored paging found).
				await pageByOffset(source, channelId, sinceMs, byId);
				break;
			}
			before = anchor.id;
		}
	}
	return [...byId.values()].sort((a, b) => a.update_at - b.update_at || a.create_at - b.create_at);
}

/** Offset pages shift when posts are deleted meanwhile, so a pass is repeated until it is stable. */
const OFFSET_PASSES = 4;

export class UnstableCatchUpError extends Error {
	constructor(channelId: MattermostId) {
		super(`catch-up of channel '${channelId}' did not settle; it is retried`);
		this.name = "UnstableCatchUpError";
	}
}

/**
 * Offset pages until a whole pass adds no post: only then is the scan known to be complete. An
 * unsettled scan throws, so the channel's cursor stays put and the sync is retried.
 */
async function pageByOffset(
	source: PostSource,
	channelId: MattermostId,
	sinceMs: number,
	byId: Map<MattermostId, ApiPost>,
): Promise<void> {
	for (let pass = 0; pass < OFFSET_PASSES; pass += 1) {
		const before = byId.size;
		await offsetPass(source, channelId, sinceMs, byId);
		if (pass > 0 && byId.size === before) {
			return;
		}
	}
	throw new UnstableCatchUpError(channelId);
}

async function offsetPass(
	source: PostSource,
	channelId: MattermostId,
	sinceMs: number,
	byId: Map<MattermostId, ApiPost>,
): Promise<void> {
	for (let page = 0; ; page += 1) {
		const list = await source.channelPostsPage(channelId, page, PAGE_SIZE);
		const posts = list.order.flatMap((id) => {
			const post = list.posts[id];
			return post === undefined ? [] : [post];
		});
		for (const post of posts) {
			if (post.create_at > sinceMs && !byId.has(post.id)) {
				byId.set(post.id, post);
			}
		}
		const oldest = posts.at(-1);
		if (posts.length < PAGE_SIZE || oldest === undefined || oldest.create_at <= sinceMs) {
			return;
		}
	}
}

/**
 * The changes a synced post stands for: a deleted post only its deletion (its text is gone); an
 * edited one its creation (in case that was missed too) and its latest edit.
 */
export function changesOf(post: ApiPost): Readonly<PostChange[]> {
	if (post.delete_at > 0) {
		return ["deleted"];
	}
	return post.edit_at > 0 ? ["created", "edited"] : ["created"];
}
