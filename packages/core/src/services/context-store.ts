import {
	DEFAULT_THREAD_BUDGET,
	EMPTY_THREAD_SUMMARY,
	type FoldedThread,
	foldThread,
	mergeThreadSummary,
	postOverlays,
	renderThreadSummary,
	type StoredPostEvent,
	selectMemories,
	threadSummaryEntry,
} from "@agent-gateway/context";
import {
	type GatewayEvent,
	MATTERMOST_POST_EVENT_TYPES,
	type MattermostId,
	MattermostPostDataSchema,
	type MemoryItem,
	MemoryItemSchema,
	type MemoryNamespaces,
	type ThreadSummary,
	ThreadSummarySchema,
	type WorkingSummary,
} from "@agent-gateway/contracts";
import { contextSnapshots, events, memoryItems, threadSummaries } from "@agent-gateway/db";
import { mattermostPost } from "@agent-gateway/events";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { UnitOfWork } from "./deps.ts";
import { NEW_POST_EVENT_TYPES } from "./store.ts";

type Db = UnitOfWork["tx"]["db"];

/** A Mattermost thread: its channel and root post. */
export type ThreadRef = Readonly<{ channelId: MattermostId; rootPostId: MattermostId }>;

/** Most replies read per thread; a longer thread is summarized by its runs instead. */
const MAX_THREAD_REPLIES = 1000;

/** Event types that create a post (as opposed to editing or deleting one). */
const POST_CREATION_TYPES = [...NEW_POST_EVENT_TYPES, "mattermost.post.recovered"] as const;
/** Most accepted memory items read before the budget picks the newest. */
const MAX_MEMORY_CANDIDATES = 500;

const THREAD_REF = /^channel\/([a-z0-9]{26})\/thread\/([a-z0-9]{26})$/;

export function formatThreadRef(ref: ThreadRef): string {
	return `channel/${ref.channelId}/thread/${ref.rootPostId}`;
}

export function parseThreadRef(value: string | null): ThreadRef | null {
	const match = value === null ? null : THREAD_REF.exec(value);
	const channelId = match?.[1];
	const rootPostId = match?.[2];
	return channelId === undefined || rootPostId === undefined ? null : { channelId, rootPostId };
}

/** The threads of the Mattermost posts among `events`, in order, without duplicates. */
export function threadsOf(events: Readonly<GatewayEvent[]>): ThreadRef[] {
	const refs = new Map<string, ThreadRef>();
	for (const event of events) {
		const post = mattermostPost(event);
		if (post !== null) {
			const ref = { channelId: post.channel_id, rootPostId: post.root_id ?? post.post_id };
			refs.set(formatThreadRef(ref), ref);
		}
	}
	return [...refs.values()];
}

/** The wait a turn resolved: its creating run, agent and conversation. */
export type ResolvedWaitOrigin = Readonly<{
	runId: string;
	agentId: string;
	correlationId: string;
}>;

/**
 * The thread of the run that created a wait: where a turn resumed without a post belongs. A run
 * without a thread of its own (started by a connector event) that opened exactly one new root in
 * the wait's conversation belongs there; with several roots, the thread is left open.
 */
export async function threadOfWaitCreator(
	db: Db,
	origin: ResolvedWaitOrigin,
): Promise<ThreadRef | null> {
	const [row] = await db
		.select({ threadRef: contextSnapshots.threadRef })
		.from(contextSnapshots)
		.where(eq(contextSnapshots.runId, origin.runId));
	const own = parseThreadRef(row?.threadRef ?? null);
	if (own !== null) {
		return own;
	}
	const roots = await db
		.select({
			channelId: sql<string>`${events.payload}->>'channel_id'`,
			postId: sql<string>`${events.payload}->>'post_id'`,
		})
		.from(events)
		.where(
			and(
				eq(events.causationId, `run:${origin.runId}`),
				eq(events.senderAgentId, origin.agentId),
				eq(events.correlationId, origin.correlationId),
				inArray(events.type, ["mattermost.post.created", "mattermost.agent.mentioned"]),
				sql`${events.payload} ? 'post_id'`,
				sql`(${events.payload}->>'root_id') is null`,
			),
		)
		.limit(2);
	const [root] = roots;
	return roots.length === 1 && root !== undefined
		? { channelId: root.channelId, rootPostId: root.postId }
		: null;
}

const inThread = (ref: ThreadRef) =>
	and(
		sql`${events.payload} ? 'post_id'`,
		sql`(${events.payload}->>'channel_id') = ${ref.channelId}`,
		sql`coalesce(${events.payload}->>'root_id', ${events.payload}->>'post_id') = ${ref.rootPostId}`,
		inArray(events.type, [...MATTERMOST_POST_EVENT_TYPES]),
	);

/**
 * The stored events of a thread's posts, in acceptance order: the root's, the newest replies'
 * creations (edits cannot push replies out of the window), and the changes of those posts.
 */
async function loadThreadEvents(db: Db, ref: ThreadRef): Promise<StoredPostEvent[]> {
	const columns = {
		seq: events.seq,
		type: events.type,
		time: events.time,
		trustLevel: events.trustLevel,
		payload: events.payload,
	};
	const root = await db
		.select(columns)
		.from(events)
		.where(and(inThread(ref), sql`(${events.payload}->>'root_id') is null`));
	const replies = await db
		.select(columns)
		.from(events)
		.where(
			and(
				inThread(ref),
				sql`(${events.payload}->>'root_id') is not null`,
				inArray(events.type, [...POST_CREATION_TYPES]),
			),
		)
		// Newest by post time: a catch-up importing older replies late cannot push newer ones out.
		.orderBy(desc(events.time), desc(events.seq))
		.limit(MAX_THREAD_REPLIES);
	const replyIds = replies.flatMap((row) => {
		const postId = row.payload.post_id;
		return typeof postId === "string" ? [postId] : [];
	});
	const changes =
		replyIds.length === 0
			? []
			: await db
					.select(columns)
					.from(events)
					.where(
						and(
							inThread(ref),
							inArray(events.type, ["mattermost.post.edited", "mattermost.post.deleted"]),
							inArray(sql<string>`${events.payload}->>'post_id'`, replyIds),
						),
					);
	return [...root, ...replies, ...changes]
		.sort((a, b) => a.seq - b.seq)
		.flatMap((row) => {
			const post = MattermostPostDataSchema.safeParse(row.payload);
			const trust = row.trustLevel;
			if (!post.success || (trust !== "human-trusted" && trust !== "internal-untrusted")) {
				return [];
			}
			return [{ type: row.type, time: row.time, trustLevel: trust, post: post.data }];
		});
}

/** Stored edits and deletions of the posts of a thread, in acceptance order. */
async function loadPostChanges(db: Db, ref: ThreadRef): Promise<StoredPostEvent[]> {
	const rows = await db
		.select({
			type: events.type,
			time: events.time,
			trustLevel: events.trustLevel,
			payload: events.payload,
		})
		.from(events)
		.where(
			and(
				inThread(ref),
				inArray(events.type, ["mattermost.post.edited", "mattermost.post.deleted"]),
			),
		)
		.orderBy(events.seq);
	return rows.flatMap((row) => {
		const post = MattermostPostDataSchema.safeParse(row.payload);
		const trust = row.trustLevel;
		if (!post.success || (trust !== "human-trusted" && trust !== "internal-untrusted")) {
			return [];
		}
		return [{ type: row.type, time: row.time, trustLevel: trust, post: post.data }];
	});
}

/**
 * The posts a turn carries (trigger, inbox) in their current state: the latest edit's text, an
 * empty text once deleted or when the post's channel is no longer allowed, and internal-untrusted
 * once edited by software on a human's account. The stored events stay as first seen; only the
 * turn's copy changes.
 */
export async function withCurrentPosts(
	db: Db,
	carried: Readonly<GatewayEvent[]>,
	allowed: ReadonlySet<MattermostId>,
): Promise<GatewayEvent[]> {
	const postIds = new Set<MattermostId>();
	for (const event of carried) {
		const post = mattermostPost(event);
		if (post !== null) {
			postIds.add(post.post_id);
		}
	}
	const changes: StoredPostEvent[] = [];
	for (const ref of threadsOf(carried)) {
		changes.push(...(await loadPostChanges(db, ref)));
	}
	const overlays = postOverlays(changes, postIds);
	return carried.map((event) => {
		const post = mattermostPost(event);
		if (post !== null && !allowed.has(post.channel_id)) {
			// A wait resolved by a post of a channel the agent has lost since: the outcome stays,
			// the text does not reach the turn.
			return { ...event, data: { ...post, message: "" } };
		}
		const overlay = post === null ? undefined : overlays.get(post.post_id);
		if (post === null || overlay === undefined) {
			return event;
		}
		return {
			...event,
			trustlevel: overlay.untrusted ? "internal-untrusted" : event.trustlevel,
			data: { ...post, message: overlay.message },
		};
	});
}

/** Posts among `candidates` that were deleted since. */
export async function deletedPosts(
	db: Db,
	candidates: Readonly<GatewayEvent[]>,
): Promise<ReadonlySet<MattermostId>> {
	const deleted = new Set<MattermostId>();
	for (const ref of threadsOf(candidates)) {
		for (const change of await loadPostChanges(db, ref)) {
			if (change.type === "mattermost.post.deleted") {
				deleted.add(change.post.post_id);
			}
		}
	}
	return deleted;
}

/**
 * Drops pending inbox entries a turn must no longer see: posts in channels the agent is not
 * allowed in (any more) and posts deleted since. An entry that resolved a wait stays: the wait is
 * spent, and the turn it resumes carries the post with its current (possibly empty) text.
 * Returns the dropped event ids.
 */
export async function retireInbox(
	uow: UnitOfWork,
	agentId: string,
	allowedChannelIds: Readonly<MattermostId[]>,
): Promise<string[]> {
	const result = await uow.tx.client.query<{ event_id: string }>(
		`update agent_inbox i set status = 'dead'
		   from events e
		  where e.id = i.event_id
		    and i.agent_id = $1 and i.status = 'pending' and i.wait_id is null
		    and e.type = any($3::text[]) and e.payload ? 'post_id'
		    and (not ((e.payload->>'channel_id') = any($2::text[]))
		         or exists (
		           select 1 from events d
		            where d.type = 'mattermost.post.deleted'
		              and d.payload ? 'post_id'
		              and (d.payload->>'channel_id') = (e.payload->>'channel_id')
		              and coalesce(d.payload->>'root_id', d.payload->>'post_id')
		                  = coalesce(e.payload->>'root_id', e.payload->>'post_id')
		              and (d.payload->>'post_id') = (e.payload->>'post_id')))
		  returning i.event_id`,
		[agentId, [...allowedChannelIds], [...MATTERMOST_POST_EVENT_TYPES]],
	);
	return result.rows.map((row) => row.event_id);
}

async function loadThreadSummary(db: Db, ref: ThreadRef): Promise<ThreadSummary | null> {
	const [row] = await db
		.select({ summary: threadSummaries.summary })
		.from(threadSummaries)
		.where(
			and(
				eq(threadSummaries.channelId, ref.channelId),
				eq(threadSummaries.rootPostId, ref.rootPostId),
			),
		);
	if (row === undefined) {
		return null;
	}
	const parsed = ThreadSummarySchema.safeParse(row.summary);
	return parsed.success ? parsed.data : null;
}

/** A thread as a turn sees it; null when its root was never recorded. */
export async function assembleThread(
	db: Db,
	ref: ThreadRef,
	exclude: ReadonlySet<MattermostId>,
): Promise<FoldedThread | null> {
	return foldThread(await loadThreadEvents(db, ref), {
		...ref,
		exclude,
		summary: renderThreadSummary(await loadThreadSummary(db, ref)),
		budget: DEFAULT_THREAD_BUDGET,
	});
}

/** Humans whose own posts are in the given threads. */
export async function threadHumans(
	db: Db,
	refs: Readonly<ThreadRef[]>,
): Promise<Readonly<MattermostId[]>> {
	const humans = new Set<MattermostId>();
	for (const ref of refs) {
		const folded = foldThread(await loadThreadEvents(db, ref), {
			...ref,
			exclude: new Set(),
			summary: null,
			budget: DEFAULT_THREAD_BUDGET,
		});
		for (const userId of folded?.humanUserIds ?? []) {
			humans.add(userId);
		}
	}
	return [...humans];
}

/**
 * The stored correlation of a thread: its root's, so replies in a thread an agent started stay
 * in that agent's cascade; `thread:<root>` when the root was never recorded.
 */
export async function threadCorrelationOf(db: Db, ref: ThreadRef): Promise<string> {
	const [row] = await db
		.select({ correlationId: events.correlationId })
		.from(events)
		.where(
			and(
				inThread(ref),
				sql`(${events.payload}->>'root_id') is null`,
				inArray(events.type, [...POST_CREATION_TYPES]),
			),
		)
		.orderBy(events.seq)
		.limit(1);
	return row?.correlationId ?? `thread:${ref.rootPostId}`;
}

/** Accepted memory of the agent's own namespaces, within the context budget. */
export async function loadMemories(db: Db, namespaces: MemoryNamespaces): Promise<MemoryItem[]> {
	const rows = await db
		.select()
		.from(memoryItems)
		.where(
			and(
				eq(memoryItems.status, "accepted"),
				isNull(memoryItems.supersededAt),
				inArray(memoryItems.namespace, [namespaces.private, ...namespaces.shared]),
			),
		)
		.orderBy(desc(memoryItems.createdAt))
		.limit(MAX_MEMORY_CANDIDATES);
	const items = rows.flatMap((row) => {
		const parsed = MemoryItemSchema.safeParse({
			id: row.id,
			namespace: row.namespace,
			key: row.key,
			content: row.content,
			visibility: row.visibility,
			sourceRunId: row.sourceRunId,
			createdAt: row.createdAt.toISOString(),
		});
		return parsed.success ? [parsed.data] : [];
	});
	return selectMemories(items, namespaces);
}

/** Adds a completed run's public summary to its thread's summary. */
export async function recordThreadSummary(
	uow: UnitOfWork,
	ref: ThreadRef,
	run: Readonly<{ id: string; agentId: string; summary: WorkingSummary }>,
): Promise<void> {
	const { db } = uow.tx;
	// Create the row first, then lock it: concurrent runs of one thread merge one after another.
	await db
		.insert(threadSummaries)
		.values({
			channelId: ref.channelId,
			rootPostId: ref.rootPostId,
			summary: EMPTY_THREAD_SUMMARY,
			updatedAt: uow.now,
		})
		.onConflictDoNothing();
	const [row] = await db
		.select({ summary: threadSummaries.summary })
		.from(threadSummaries)
		.where(
			and(
				eq(threadSummaries.channelId, ref.channelId),
				eq(threadSummaries.rootPostId, ref.rootPostId),
			),
		)
		.for("update");
	const parsed = ThreadSummarySchema.safeParse(row?.summary);
	if (!parsed.success) {
		// Never overwrite a history this version cannot read; a schema change migrates it.
		uow.deps.log.warn("thread summary is unreadable; not updated", {
			channel_id: ref.channelId,
			root_post_id: ref.rootPostId,
		});
		return;
	}
	const entry = threadSummaryEntry({
		runId: run.id,
		agentId: run.agentId,
		at: uow.now,
		summary: run.summary,
	});
	const previous = parsed.data;
	await db
		.update(threadSummaries)
		.set({ summary: mergeThreadSummary(previous, entry), updatedAt: uow.now })
		.where(
			and(
				eq(threadSummaries.channelId, ref.channelId),
				eq(threadSummaries.rootPostId, ref.rootPostId),
			),
		);
}
