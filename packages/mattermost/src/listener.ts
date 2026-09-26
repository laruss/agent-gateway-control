import type { AgentId, GatewayEvent, MattermostId } from "@agent-gateway/contracts";
import { errorFields, type Logger } from "@agent-gateway/logging";
import { type ApiPost, ApiPostSchema, WsEventSchema, WsReplySchema } from "./api-schemas.ts";
import { changesOf, channelChangesSince } from "./backfill.ts";
import { type ChannelStart, channelStartOf, isBeforeStart } from "./bootstrap.ts";
import { MattermostApiError, MattermostClient, websocketUrl } from "./client.ts";
import {
	type BridgeDirectory,
	normalizePost,
	type PostChange,
	postSubject,
	type RejectReason,
	rootSubject,
} from "./normalize.ts";

/** `not_admitted`: the post came before its channel's current start; nothing was stored. */
export type IngestOutcome = "accepted" | "duplicate" | "conflict" | "not_admitted";

/** A new post to be admitted against its channel's start inside the ingest transaction. */
export type PostAdmission = Readonly<{
	channelId: MattermostId;
	postId: MattermostId;
	createAt: number;
}>;

export type RejectedPost = Readonly<{
	reason: RejectReason;
	agentId: AgentId;
	postId: MattermostId;
	channelId: MattermostId;
}>;

/** What the listener needs from the control plane; implemented by the controller. */
export type ListenerStore = Readonly<{
	/** Null while no configuration is active. */
	directory: () => Promise<BridgeDirectory | null>;
	/**
	 * Durably ingests one event; resolves only after it is committed. With `admission`, a change
	 * of a post is stored only if the post came after its channel's current start, checked in
	 * the same transaction (work in flight across a channel's removal and re-adding cannot slip
	 * under it).
	 */
	ingest: (event: GatewayEvent, admission: PostAdmission | null) => Promise<IngestOutcome>;
	/** The listener bot bootstrap recorded; its token must belong to exactly that account. */
	listenerUserId: () => Promise<MattermostId | null>;
	/** The stored correlation of a thread root (by its event `subject`), or null. */
	threadCorrelation: (source: string, rootSubject: string) => Promise<string | null>;
	/** Whether the creation of a post (by its event `subject`) is already stored. */
	hasPostCreation: (source: string, subject: string) => Promise<boolean>;
	/** The newest `update_at` synced for a channel, or null before it was started. */
	cursor: (channelId: MattermostId) => Promise<number | null>;
	/** Where the channel was started: nothing that existed then is ever replayed. */
	floor: (
		channelId: MattermostId,
	) => Promise<Readonly<{ floor: number; floorPostIds: Readonly<MattermostId[]> }> | null>;
	/** Whether a change of this post would be admitted now (managed channel, after its start). */
	admits: (admission: PostAdmission) => Promise<boolean>;
	/**
	 * Starts a channel's catch-up (bootstrap normally has) if it is still managed; an existing
	 * start is kept.
	 */
	startChannel: (
		channelId: MattermostId,
		start: ChannelStart,
		generation: number,
	) => Promise<boolean>;
	/** The configuration generation, incremented by every config apply. */
	configGeneration: () => Promise<number>;
	/** Moves an existing cursor forward; never back, never creates one. */
	saveCursor: (channelId: MattermostId, updateAt: number) => Promise<void>;
	/** Drops the catch-up state of every channel not managed at this moment. */
	forgetUnmanagedChannels: () => Promise<void>;
	/**
	 * The outbox item a signed key names: whether the Gateway issued it, its status, and the post
	 * its receipt recorded (null until delivered).
	 */
	deliveredPost: (
		idempotencyKey: string,
	) => Promise<Readonly<{ exists: boolean; status: string | null; postId: string | null }>>;
	/** Records (and alerts about) a post that impersonates an agent. */
	reject: (post: RejectedPost) => Promise<void>;
}>;

export type ListenerOptions = Readonly<{
	baseUrl: string;
	/** The listener bot's token, read at every connect so a rotated one takes effect. */
	token: () => Promise<string>;
	routingKey: string;
	store: ListenerStore;
	log: Logger;
	clock?: () => Date;
	random?: () => number;
	/**
	 * How far behind its cursor a sync starts. Posts are stamped when created but may be
	 * broadcast later than newer ones; re-reading a margin costs only duplicates.
	 */
	syncMarginMs?: number;
	/** Periodic sync, a safety net under the WebSocket. */
	syncIntervalMs?: number;
	pingIntervalMs?: number;
	reconnectMinMs?: number;
	reconnectMaxMs?: number;
}>;

export type ListenerStatus = Readonly<{
	connected: boolean;
	/** A change failed to ingest in some channel: its cursor stays put until a sync succeeds. */
	degraded: boolean;
	lastSyncAt: Date | null;
	reconnects: number;
}>;

export type RunningListener = Readonly<{
	status: () => ListenerStatus;
	/** Syncs every managed channel now and resolves when done. */
	sync: () => Promise<void>;
	/** Drops the connection; it reconnects and syncs as after any network loss. */
	reconnect: () => void;
	stop: () => Promise<void>;
}>;

/** A channel start scanned before the channel left management: scanned again soon. */
export class ChannelStartVoidedError extends Error {
	constructor(channelId: MattermostId) {
		super(`the start of channel '${channelId}' was scanned before it left management`);
		this.name = "ChannelStartVoidedError";
	}
}

/** How soon a post that waits for its delivery receipt is read again. */
const AWAITING_RECEIPT_RETRY_MS = 1000;

/** A signed agent post whose delivery has no receipt yet: handled again by a later sync. */
export class AwaitingReceiptError extends Error {
	constructor(postId: MattermostId) {
		super(`post '${postId}' waits for its delivery receipt`);
		this.name = "AwaitingReceiptError";
	}
}

const DEFAULTS = {
	// Longer than the periodic sync, so one missed tick still leaves the change in the window.
	syncMarginMs: 10 * 60_000,
	syncIntervalMs: 5 * 60_000,
	pingIntervalMs: 30_000,
	reconnectMinMs: 1000,
	reconnectMaxMs: 60_000,
	helloTimeoutMs: 15_000,
	resyncDelayMs: 10_000,
} as const;

const CHANGE_EVENTS: Readonly<Record<string, PostChange>> = {
	posted: "created",
	post_edited: "edited",
	post_deleted: "deleted",
};

function parseFrame(text: string): object | null {
	try {
		const value: object | null = JSON.parse(text);
		return typeof value === "object" ? value : null;
	} catch {
		return null;
	}
}

/**
 * The Gateway's Mattermost listener: one WebSocket as the listener bot, durable ingest of every
 * post in managed channels, and a REST sync from stored per-channel cursors after every
 * (re)connect, on a timer and after any failure. Changes are handled one at a time, in arrival
 * order; nothing is acknowledged to Mattermost, the cursors are the only progress marker.
 */
export function startListener(options: ListenerOptions): RunningListener {
	const { store, log } = options;
	const clock = options.clock ?? (() => new Date());
	const random = options.random ?? Math.random;
	const settings = { ...DEFAULTS, ...definedOptions(options) };
	const url = websocketUrl(options.baseUrl);

	let stopped = false;
	let socket: WebSocket | null = null;
	let connected = false;
	let lastSyncAt: Date | null = null;
	let reconnects = 0;
	let attempts = 0;
	let resyncFailures = 0;
	let expectedSeq = 0;
	let actionSeq = 0;
	let lastFrameAt = 0;
	let listenerUserId: MattermostId | null = null;
	let client: MattermostClient | null = null;
	let token = "";
	let chain: Promise<void> = Promise.resolve();
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let resyncTimer: ReturnType<typeof setTimeout> | null = null;
	let helloTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * Posts whose live `posted` frame arrived but is still queued: sync leaves their creation to
	 * that frame, which carries the original text (a quick edit would otherwise turn it into a
	 * record-only recovered post).
	 */
	const pendingLive = new Set<MattermostId>();
	/** Channels with a change that failed to ingest: their cursors stay put until a sync. */
	const failing = new Set<MattermostId>();
	/** Accounts known to be bots; a bot stays a bot, a human account is looked up every time. */
	const botAccounts = new Set<MattermostId>();

	/** Runs tasks strictly one after another; a failing task never stops the chain. */
	const enqueue = (name: string, task: () => Promise<void>): Promise<void> => {
		chain = chain.then(task).catch((error) => {
			log.error(`mattermost listener task '${name}' failed`, errorFields(error));
		});
		return chain;
	};

	/**
	 * The directory, read fresh for every use: it is the channel and agent allowlist, and a
	 * revoked permission must not keep routing from a cache.
	 */
	const directory = (): Promise<BridgeDirectory | null> => store.directory();

	const isBot = async (source: MattermostClient, userId: MattermostId, dir: BridgeDirectory) => {
		if (dir.agents.some((agent) => agent.userId === userId)) {
			return true;
		}
		if (botAccounts.has(userId)) {
			return true;
		}
		// Asked for every post: a human account can be converted into a bot at any moment, and
		// only a bot stays one.
		const user = await source.user(userId);
		if (user.is_bot) {
			botAccounts.add(userId);
		}
		return user.is_bot;
	};

	/** A rejected token (rotated or revoked): reconnect, which reads the current one. */
	const reconnectOnAuthFailure = (error: unknown) => {
		if (error instanceof MattermostApiError && error.status === 401) {
			log.warn("the listener token was rejected; reconnecting with the current one");
			socket?.close();
		}
	};

	/** Retries a failed sync with backoff, up to the periodic sync interval. */
	/**
	 * Retries a failed sync with backoff, up to the periodic sync interval. A post that only waits
	 * for its delivery receipt (written a moment after the post) is retried soon, without backoff.
	 */
	const scheduleResync = (soon = false) => {
		if (stopped || resyncTimer !== null) {
			return;
		}
		const delay = soon
			? AWAITING_RECEIPT_RETRY_MS
			: Math.min(settings.syncIntervalMs, settings.resyncDelayMs * 2 ** resyncFailures);
		if (!soon) {
			resyncFailures += 1;
		}
		resyncTimer = setTimeout(() => {
			resyncTimer = null;
			void enqueue("sync", syncAll);
		}, delay);
	};

	const handleChange = async (
		source: MattermostClient,
		post: ApiPost,
		change: PostChange,
		dir: BridgeDirectory,
	) => {
		if (listenerUserId === null) {
			return;
		}
		// An edit or deletion is recorded only for a post the Gateway has: the changes of a
		// rejected post are not the agent's, and a post from before its channel became managed
		// is not the Gateway's history.
		if (
			(change === "edited" || change === "deleted") &&
			!(await store.hasPostCreation(dir.source, postSubject(post)))
		) {
			return;
		}
		const root = rootSubject(post);
		const result = normalizePost(post, change, {
			directory: dir,
			listenerUserId,
			rootCorrelation: root === null ? null : await store.threadCorrelation(dir.source, root),
			authorIsBot: post.user_id !== listenerUserId && (await isBot(source, post.user_id, dir)),
			routingKey: options.routingKey,
			now: clock(),
		});
		if (result.kind === "skip") {
			return;
		}
		const reject = async (reason: RejectReason, agentId: AgentId) => {
			log.warn("post by an agent bot without valid Gateway routing", {
				agent_id: agentId,
				post_id: post.id,
				reason,
			});
			await store.reject({ reason, agentId, postId: post.id, channelId: post.channel_id });
		};
		if (result.kind === "reject") {
			// A post from before its channel's current start is not the Gateway's history at all:
			// no impersonation to report.
			const admission = { channelId: post.channel_id, postId: post.id, createAt: post.create_at };
			if (!(await store.admits(admission))) {
				return;
			}
			await reject(result.reason, result.agentId);
			return;
		}
		if (result.signedKey !== null && typeof result.event.data.sender_agent_id === "string") {
			// Signed routing counts only for the post the Gateway itself delivered with that key.
			const delivered = await store.deliveredPost(result.signedKey);
			if (!delivered.exists || delivered.status === "dead") {
				await reject("unsigned_agent_post", result.event.data.sender_agent_id);
				return;
			}
			if (delivered.postId === null) {
				// Delivered but not yet receipted: which post is the Gateway's is not known yet (a
				// crash may even have left it to a retry). Wait for the receipt; the channel's
				// cursor stays behind this post.
				throw new AwaitingReceiptError(post.id);
			}
			if (delivered.postId !== post.id) {
				await reject("replayed_agent_post", result.event.data.sender_agent_id);
				return;
			}
		}
		// Every change of a post, edits and deletions too, counts only for a post created after
		// its channel's current start.
		const outcome = await store.ingest(result.event, {
			channelId: post.channel_id,
			postId: post.id,
			createAt: post.create_at,
		});
		if (outcome !== "conflict") {
			return;
		}
		const sender = result.event.data.sender_agent_id;
		if (result.event.id.startsWith("mattermost:agent-post:") && typeof sender === "string") {
			// Another post already carried this signed routing.
			await reject("replayed_agent_post", sender);
		} else {
			log.warn("Mattermost post differs from the stored event", { post_id: post.id });
		}
	};

	const handleLive = async (post: ApiPost, change: PostChange) => {
		const source = client;
		// A channel with an unprocessed change is left to the resync, in order: a reply handled
		// before its failed root would miss the thread's correlation.
		if (source === null || failing.has(post.channel_id)) {
			return;
		}
		try {
			const dir = await directory();
			if (dir === null || !dir.channels.has(post.channel_id)) {
				return;
			}
			await handleChange(source, post, change, dir);
		} catch (error) {
			// Not lost: the channel's cursor stays behind this post until a sync has read it again.
			failing.add(post.channel_id);
			if (error instanceof AwaitingReceiptError) {
				scheduleResync(true);
				return;
			}
			scheduleResync();
			reconnectOnAuthFailure(error);
			throw error;
		}
		if (!failing.has(post.channel_id)) {
			await store.saveCursor(post.channel_id, post.update_at);
		}
	};

	/**
	 * Replays one synced post. Only creations after the sync window's start count: a reply bumps
	 * its thread root's `update_at`, and an old root must not be ingested as a new instruction.
	 */
	const syncPost = async (
		source: MattermostClient,
		post: ApiPost,
		since: number,
		start: Readonly<{ floor: number; floorPostIds: Readonly<MattermostId[]> }>,
		dir: BridgeDirectory,
	) => {
		for (const change of changesOf(post)) {
			if (change === "created") {
				if (
					post.create_at <= since ||
					isBeforeStart(post, start) ||
					pendingLive.has(post.id) ||
					(await store.hasPostCreation(dir.source, postSubject(post)))
				) {
					continue;
				}
				await handleChange(source, post, post.edit_at > 0 ? "recovered" : "created", dir);
			} else {
				await handleChange(source, post, change, dir);
			}
		}
	};

	const syncChannel = async (source: MattermostClient, channelId: MattermostId) => {
		const cursor = await store.cursor(channelId);
		if (cursor === null) {
			// Not started by bootstrap: start at the newest post now; older history is not replayed.
			// The start is recorded only if no configuration was applied during the scan.
			const generation = await store.configGeneration();
			if (
				!(await store.startChannel(channelId, await channelStartOf(source, channelId), generation))
			) {
				// The channel left management during the scan: read it again soon (it may be back).
				throw new ChannelStartVoidedError(channelId);
			}
			return;
		}
		const since = Math.max(0, cursor - settings.syncMarginMs);
		const start = (await store.floor(channelId)) ?? { floor: 0, floorPostIds: [] };
		const posts = await channelChangesSince(source, channelId, since, () =>
			log.warn("catch-up gap exceeds 1000 changes; older edits and deletions are not seen", {
				channel_id: channelId,
			}),
		);
		let newest = cursor;
		// Creation order, not change order: a reply bumps its root's `update_at`, and a root must
		// be stored before its replies so they take its correlation.
		// Within one millisecond a root still comes before replies.
		const inCreationOrder = [...posts].sort(
			(a, b) => a.create_at - b.create_at || Number(a.root_id !== "") - Number(b.root_id !== ""),
		);
		for (const post of inCreationOrder) {
			// The directory is the allowlist: read it for each post, so a permission granted or
			// revoked during a long catch-up applies to the posts after it.
			const current = await directory();
			if (current === null || !current.channels.has(channelId)) {
				return;
			}
			await syncPost(source, post, since, start, current);
			newest = Math.max(newest, post.update_at);
		}
		await store.saveCursor(channelId, newest);
	};

	const syncAll = async () => {
		const dir = await directory();
		if (dir === null) {
			log.warn("no active configuration; Mattermost sync skipped");
			return;
		}
		const source = client;
		if (listenerUserId === null || source === null) {
			return;
		}
		let awaitingReceipt = false;
		let otherFailure = false;
		for (const channelId of dir.channels.keys()) {
			try {
				await syncChannel(source, channelId);
				failing.delete(channelId);
			} catch (error) {
				failing.add(channelId);
				if (error instanceof AwaitingReceiptError || error instanceof ChannelStartVoidedError) {
					awaitingReceipt = true;
					continue;
				}
				otherFailure = true;
				log.error("Mattermost channel sync failed", {
					channel_id: channelId,
					...errorFields(error),
				});
				reconnectOnAuthFailure(error);
			}
		}
		await store.forgetUnmanagedChannels();
		// A channel that is no longer managed cannot keep the listener degraded.
		for (const channelId of failing) {
			if (!dir.channels.has(channelId)) {
				failing.delete(channelId);
			}
		}
		if (failing.size > 0) {
			scheduleResync(awaitingReceipt && !otherFailure);
			return;
		}
		resyncFailures = 0;
		lastSyncAt = clock();
	};

	const onFrame = (text: string) => {
		lastFrameAt = Date.now();
		const frame = parseFrame(text);
		if (frame === null) {
			return;
		}
		const reply = WsReplySchema.safeParse(frame);
		if (reply.success) {
			if (reply.data.status !== "OK") {
				log.error("Mattermost WebSocket action failed", { status: reply.data.status });
				socket?.close();
			}
			return;
		}
		const parsed = WsEventSchema.safeParse(frame);
		if (!parsed.success) {
			return;
		}
		const event = parsed.data;
		if (event.event === "hello") {
			if (helloTimer !== null) {
				clearTimeout(helloTimer);
				helloTimer = null;
			}
			connected = true;
			attempts = 0;
			expectedSeq = event.seq + 1;
			log.info("Mattermost WebSocket connected");
			void enqueue("sync", syncAll);
			return;
		}
		if (event.seq !== expectedSeq) {
			// Events were dropped on the way: read the channels again.
			log.warn("Mattermost WebSocket sequence gap", { expected: expectedSeq, got: event.seq });
			void enqueue("sync", syncAll);
		}
		expectedSeq = event.seq + 1;
		const change = CHANGE_EVENTS[event.event];
		const raw = event.data?.post;
		if (change === undefined || typeof raw !== "string") {
			return;
		}
		const post = ApiPostSchema.safeParse(parseFrame(raw));
		if (!post.success) {
			log.warn("unreadable post in a WebSocket event", { event: event.event });
			return;
		}
		if (change === "created") {
			pendingLive.add(post.data.id);
		}
		void enqueue(event.event, async () => {
			try {
				await handleLive(post.data, change);
			} finally {
				if (change === "created") {
					pendingLive.delete(post.data.id);
				}
			}
		});
	};

	const scheduleReconnect = () => {
		if (stopped || reconnectTimer !== null) {
			return;
		}
		const base = Math.min(settings.reconnectMaxMs, settings.reconnectMinMs * 2 ** attempts);
		const delay = Math.round(base * (0.5 + random() / 2));
		attempts += 1;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			void connect();
		}, delay);
	};

	const connect = async () => {
		if (stopped) {
			return;
		}
		try {
			token = await options.token();
			const next = new MattermostClient({ baseUrl: options.baseUrl, token });
			const me = await next.me();
			const recorded = await store.listenerUserId();
			if (recorded === null || me.id !== recorded) {
				// A swapped secret would make the listener skip another account's posts as its own.
				throw new Error(
					recorded === null
						? "the listener bot is not bootstrapped yet"
						: "the listener token belongs to another account than the bootstrapped listener",
				);
			}
			listenerUserId = me.id;
			client = next;
		} catch (error) {
			log.error("Mattermost listener cannot authenticate", errorFields(error));
			scheduleReconnect();
			return;
		}
		// Stopped while authenticating: open nothing.
		if (stopped) {
			return;
		}
		const ws = new WebSocket(url);
		socket = ws;
		lastFrameAt = Date.now();
		helloTimer = setTimeout(() => ws.close(), settings.helloTimeoutMs);
		ws.onopen = () => {
			actionSeq += 1;
			ws.send(
				JSON.stringify({
					seq: actionSeq,
					action: "authentication_challenge",
					data: { token },
				}),
			);
		};
		// A replaced socket's late frames and close must not touch the current connection.
		ws.onmessage = (message) => {
			if (socket === ws && typeof message.data === "string") {
				onFrame(message.data);
			}
		};
		ws.onclose = () => {
			if (socket !== ws) {
				return;
			}
			socket = null;
			if (helloTimer !== null) {
				clearTimeout(helloTimer);
				helloTimer = null;
			}
			if (connected && !stopped) {
				reconnects += 1;
				log.warn("Mattermost WebSocket disconnected; reconnecting");
			}
			connected = false;
			scheduleReconnect();
		};
		ws.onerror = () => ws.close();
	};

	const pingTimer = setInterval(() => {
		const ws = socket;
		if (ws === null || !connected) {
			return;
		}
		if (Date.now() - lastFrameAt > 2 * settings.pingIntervalMs) {
			log.warn("Mattermost WebSocket silent; reconnecting");
			ws.close();
			return;
		}
		actionSeq += 1;
		ws.send(JSON.stringify({ seq: actionSeq, action: "ping" }));
	}, settings.pingIntervalMs);
	// The REST safety net runs whenever the listener is authenticated, also while the WebSocket
	// cannot connect.
	const syncTimer = setInterval(() => {
		if (client !== null) {
			void enqueue("sync", syncAll);
		}
	}, settings.syncIntervalMs);

	void connect();

	return {
		status: () => ({ connected, degraded: failing.size > 0, lastSyncAt, reconnects }),
		sync: () => enqueue("sync", syncAll),
		reconnect: () => {
			socket?.close();
		},
		stop: async () => {
			stopped = true;
			clearInterval(pingTimer);
			clearInterval(syncTimer);
			for (const timer of [reconnectTimer, resyncTimer, helloTimer]) {
				if (timer !== null) {
					clearTimeout(timer);
				}
			}
			socket?.close();
			await chain;
		},
	};
}

type TimingOptions = Pick<
	ListenerOptions,
	"syncMarginMs" | "syncIntervalMs" | "pingIntervalMs" | "reconnectMinMs" | "reconnectMaxMs"
>;

/** The timing options that were actually given; `undefined` must not override a default. */
function definedOptions(options: TimingOptions): Partial<Record<keyof TimingOptions, number>> {
	const keys: Readonly<(keyof TimingOptions)[]> = [
		"syncMarginMs",
		"syncIntervalMs",
		"pingIntervalMs",
		"reconnectMinMs",
		"reconnectMaxMs",
	];
	return Object.fromEntries(
		keys.flatMap((key) => {
			const value = options[key];
			return value === undefined ? [] : [[key, value]];
		}),
	);
}
