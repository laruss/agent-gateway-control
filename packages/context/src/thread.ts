import type {
	AgentId,
	GatewayEventType,
	MattermostId,
	MattermostPostData,
	ThreadContext,
	ThreadPost,
	TrustLevel,
} from "@agent-gateway/contracts";
import { truncate } from "./text.ts";

/** One stored event about a post of the thread, in acceptance order. */
export type StoredPostEvent = Readonly<{
	type: GatewayEventType;
	time: Date;
	trustLevel: TrustLevel;
	post: MattermostPostData;
}>;

export type ThreadBudget = Readonly<{
	/** Most posts in `recentPosts`. */
	maxPosts: number;
	/** Most characters of all messages in `recentPosts` together. */
	maxChars: number;
	/** Longest single message, root included; longer ones are cut. */
	maxPostChars: number;
}>;

export const DEFAULT_THREAD_BUDGET: ThreadBudget = {
	maxPosts: 40,
	maxChars: 24_000,
	maxPostChars: 4000,
};

export type ThreadRequest = Readonly<{
	channelId: MattermostId;
	rootPostId: MattermostId;
	/** Posts the turn carries elsewhere (its trigger and inbox): not repeated in the thread. */
	exclude: ReadonlySet<MattermostId>;
	summary: string | null;
	budget: ThreadBudget;
}>;

export type FoldedThread = Readonly<{
	context: ThreadContext;
	/** Humans whose own posts are in the thread (deleted posts not counted). */
	humanUserIds: Readonly<MattermostId[]>;
}>;

/** The current state of one post: its latest text, whether it was deleted or edited by software. */
export type PostOverlay = Readonly<{ message: string; deleted: boolean; untrusted: boolean }>;

/**
 * The latest state of the given posts from their stored edits and deletions, for posts a turn
 * carries as events of their own (trigger, inbox). Posts without later changes are absent. Pure.
 */
export function postOverlays(
	events: Readonly<StoredPostEvent[]>,
	postIds: ReadonlySet<MattermostId>,
): Map<MattermostId, PostOverlay> {
	const overlays = new Map<MattermostId, PostOverlay>();
	for (const event of events) {
		const id = event.post.post_id;
		if (!postIds.has(id)) {
			continue;
		}
		const known = overlays.get(id);
		if (event.type === "mattermost.post.deleted") {
			overlays.set(id, { message: "", deleted: true, untrusted: known?.untrusted ?? false });
		} else if (event.type === "mattermost.post.edited" && known?.deleted !== true) {
			overlays.set(id, {
				message: event.post.message,
				deleted: false,
				untrusted: (known?.untrusted ?? false) || event.trustLevel !== "human-trusted",
			});
		}
	}
	return overlays;
}

type PostState = {
	postId: MattermostId;
	authorUserId: MattermostId;
	authorAgentId: AgentId | null;
	createdAt: Date;
	message: string;
	trustLevel: TrustLevel;
	targets: Readonly<AgentId[]>;
	deleted: boolean;
	/** Acceptance order of the creation; ties of `createdAt` keep it. */
	order: number;
};

const CREATION_TYPES: ReadonlySet<GatewayEventType> = new Set([
	"mattermost.post.created",
	"mattermost.thread.reply",
	"mattermost.agent.mentioned",
	"mattermost.post.recovered",
]);

/** The current state of every post of the thread: edits applied, deletions marked. */
function currentPosts(events: Readonly<StoredPostEvent[]>): Map<MattermostId, PostState> {
	const posts = new Map<MattermostId, PostState>();
	events.forEach((event, order) => {
		const { post } = event;
		const known = posts.get(post.post_id);
		if (CREATION_TYPES.has(event.type)) {
			if (known === undefined) {
				posts.set(post.post_id, {
					postId: post.post_id,
					authorUserId: post.user_id,
					authorAgentId: post.sender_agent_id,
					createdAt: event.time,
					message: post.message,
					trustLevel: event.trustLevel,
					targets: post.target_agent_ids,
					deleted: false,
					order,
				});
			}
			return;
		}
		if (known === undefined) {
			// A change of a post whose creation was never recorded (e.g. before the channel was
			// managed): nothing to attribute it to.
			return;
		}
		if (event.type === "mattermost.post.deleted") {
			known.deleted = true;
		} else if (event.type === "mattermost.post.edited") {
			known.message = post.message;
			// Text edited by anyone but a human on their own account is no longer theirs to vouch for.
			if (event.trustLevel !== "human-trusted") {
				known.trustLevel = "internal-untrusted";
			}
		}
	});
	return posts;
}

function threadPost(state: PostState, maxChars: number): ThreadPost {
	return {
		postId: state.postId,
		authorUserId: state.authorUserId,
		authorAgentId: state.authorAgentId,
		createdAt: state.createdAt.toISOString(),
		message: state.deleted ? "" : truncate(state.message, maxChars),
		trustLevel: state.trustLevel,
	};
}

/**
 * The thread as the turn sees it: its root, the newest posts within the budget, the participants
 * and the stored summary. Null when nothing of the thread was recorded. Pure.
 */
export function foldThread(
	events: Readonly<StoredPostEvent[]>,
	request: ThreadRequest,
): FoldedThread | null {
	const posts = currentPosts(
		events.filter(
			(event) =>
				event.post.channel_id === request.channelId &&
				(event.post.root_id ?? event.post.post_id) === request.rootPostId,
		),
	);
	if (posts.size === 0) {
		return null;
	}
	const root = posts.get(request.rootPostId);
	const live = [...posts.values()]
		.filter((post) => !post.deleted)
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.order - b.order);
	const candidates = live.filter(
		(post) => post.postId !== request.rootPostId && !request.exclude.has(post.postId),
	);

	const { budget } = request;
	const recent: ThreadPost[] = [];
	let chars = 0;
	for (let i = candidates.length - 1; i >= 0 && recent.length < budget.maxPosts; i -= 1) {
		const candidate = candidates[i];
		if (candidate === undefined) {
			break;
		}
		const post = threadPost(candidate, budget.maxPostChars);
		if (chars + post.message.length > budget.maxChars) {
			break;
		}
		chars += post.message.length;
		recent.push(post);
	}
	recent.reverse();

	const participants = new Set<AgentId>();
	const humans = new Set<MattermostId>();
	for (const post of live) {
		if (post.authorAgentId !== null) {
			participants.add(post.authorAgentId);
		}
		for (const target of post.targets) {
			participants.add(target);
		}
		if (post.trustLevel === "human-trusted") {
			humans.add(post.authorUserId);
		}
	}
	return {
		context: {
			channelId: request.channelId,
			rootPostId: request.rootPostId,
			rootPost:
				root === undefined || request.exclude.has(root.postId)
					? null
					: threadPost(root, budget.maxPostChars),
			recentPosts: recent,
			summary: request.summary,
			participantAgentIds: [...participants].sort(),
			omittedPostCount: candidates.length - recent.length,
		},
		humanUserIds: [...humans].sort(),
	};
}
