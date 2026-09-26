import type {
	AgentConfig,
	AgentId,
	MattermostId,
	OrganizationConfig,
} from "@agent-gateway/contracts";
import { type ApiChannel, isElevatedMember } from "./api-schemas.ts";
import { MattermostApiError, MattermostClient } from "./client.ts";

/** A bot the Gateway runs: the listener, or one per agent. */
export type BotSpec = Readonly<{
	/** Null for the listener bot. */
	agentId: AgentId | null;
	username: string;
	displayName: string;
	/** Channel names the bot must be a member of. */
	channels: Readonly<string[]>;
	/** Where the bot's token is stored (resolved secret file path). */
	tokenPath: string;
}>;

/** What bootstrap and reconcile check, derived from the active configuration. */
export type MattermostPlan = Readonly<{
	team: string;
	channels: Readonly<string[]>;
	owners: Readonly<string[]>;
	bots: Readonly<BotSpec[]>;
	/** Bots of agents removed from the configuration: deactivated, out of every channel. */
	retiredBots: Readonly<Readonly<{ username: string; userId: MattermostId }>[]>;
}>;

/**
 * Every bot of a configuration: the listener in all managed channels, each agent in its own.
 * `tokenPath` maps a configured secret reference to the file that holds it.
 */
export function mattermostPlan(
	organization: OrganizationConfig,
	agents: Readonly<AgentConfig[]>,
	tokenPath: (ref: string) => string,
	retiredBots: MattermostPlan["retiredBots"] = [],
): MattermostPlan {
	const { mattermost } = organization;
	return {
		team: mattermost.team,
		channels: mattermost.channels,
		owners: organization.organization.owner_mattermost_usernames,
		retiredBots,
		bots: [
			{
				agentId: null,
				username: mattermost.listener.username,
				displayName: "Agent Gateway",
				channels: mattermost.channels,
				tokenPath: tokenPath(mattermost.listener.token_secret_file),
			},
			...agents.map((agent) => ({
				agentId: agent.id,
				username: agent.mattermost.username,
				displayName: agent.display_name,
				channels: agent.mattermost.allowed_channels,
				tokenPath: tokenPath(agent.mattermost.token_secret_file),
			})),
		],
	};
}

/**
 * Where a channel's catch-up starts. Nothing created before `floor` is ever replayed, nor the
 * posts of that very millisecond that already existed (`floorPostIds`).
 */
export type ChannelStart = Readonly<{
	cursor: number;
	floor: number;
	floorPostIds: Readonly<MattermostId[]>;
}>;

/** The start of a channel's catch-up now: at its newest post, by the server's clock. */
export async function channelStartOf(
	client: Pick<MattermostClient, "channelPostsPage">,
	channelId: MattermostId,
): Promise<ChannelStart> {
	// Offset pages shift when posts are deleted meanwhile: scan until two scans agree.
	let previous = await scanChannelStart(client, channelId);
	for (let scan = 0; scan < 4; scan += 1) {
		const next = await scanChannelStart(client, channelId);
		const ids = new Set(previous.floorPostIds);
		if (
			next.floor === previous.floor &&
			next.floorPostIds.length === ids.size &&
			next.floorPostIds.every((id) => ids.has(id))
		) {
			return { ...next, cursor: Math.max(next.cursor, previous.cursor) };
		}
		previous = next;
	}
	throw new BootstrapError(`the newest posts of channel '${channelId}' keep changing; retry`);
}

async function scanChannelStart(
	client: Pick<MattermostClient, "channelPostsPage">,
	channelId: MattermostId,
): Promise<ChannelStart> {
	// Every existing post of the newest millisecond, however many: page until an older one shows.
	let cursor = 0;
	let floor: number | null = null;
	const floorPostIds: MattermostId[] = [];
	for (let page = 0; ; page += 1) {
		const list = await client.channelPostsPage(channelId, page, 200);
		const posts = list.order.flatMap((id) => {
			const post = list.posts[id];
			return post === undefined ? [] : [post];
		});
		for (const post of posts) {
			cursor = Math.max(cursor, post.update_at);
			floor ??= post.create_at;
			if (post.create_at === floor && !floorPostIds.includes(post.id)) {
				floorPostIds.push(post.id);
			}
		}
		const oldest = posts.at(-1);
		if (posts.length < 200 || oldest === undefined || oldest.create_at < (floor ?? 0)) {
			break;
		}
	}
	return { cursor, floor: floor ?? 0, floorPostIds };
}

/** True for a post that existed when its channel's catch-up started. */
export function isBeforeStart(
	post: Readonly<{ id: MattermostId; create_at: number }>,
	start: Readonly<{ floor: number; floorPostIds: Readonly<MattermostId[]> }>,
): boolean {
	return (
		post.create_at < start.floor ||
		(post.create_at === start.floor && start.floorPostIds.includes(post.id))
	);
}

/** Where resolved ids are recorded. */
export type BootstrapStore = Readonly<{
	/**
	 * Records the team and its channels in one step, each channel's catch-up started with it; a
	 * channel that already has a start (`start` null) keeps it.
	 */
	/** False (nothing recorded) when a configuration was applied since `generation`. */
	publishTeam: (
		team: Readonly<{ name: string; id: MattermostId }>,
		channels: Readonly<Readonly<{ name: string; id: MattermostId; start: ChannelStart | null }>[]>,
		generation: number,
	) => Promise<boolean>;
	/** Whether a channel's catch-up has been started. */
	hasChannelStart: (channelId: MattermostId) => Promise<boolean>;
	setUser: (name: string, id: MattermostId) => Promise<void>;
	setAgentBot: (agentId: AgentId, userId: MattermostId) => Promise<void>;
	/** Channels and users recorded by earlier runs, name to id. */
	recordedChannels: () => Promise<ReadonlyMap<string, MattermostId>>;
	recordedUsers: () => Promise<ReadonlyMap<string, MattermostId>>;
	/** Forgets `name` only while it still maps to `id`. */
	forget: (kind: "channel" | "user", name: string, id: MattermostId) => Promise<void>;
	/** The account bootstrap recorded for this bot earlier, or null. */
	recordedBotUserId: (bot: BotSpec) => Promise<MattermostId | null>;
	/** Drops a channel's catch-up, so managing it again starts afresh. */
	forgetChannelStart: (channelId: MattermostId) => Promise<void>;
}>;

/** Token files; values never pass through logs or output. */
export type TokenFiles = Readonly<{
	/** `private`: a regular file only its owner can read; anything else is not reused as is. */
	state: (path: string) => "missing" | "private" | "exposed" | "symlink";
	read: (path: string) => string;
	write: (path: string, token: string) => void;
}>;

export type BootstrapOptions = Readonly<{
	baseUrl: string;
	/** A system admin's token; needed only for bootstrap and revoked afterwards. */
	adminToken: string;
	plan: MattermostPlan;
	store: BootstrapStore;
	tokens: TokenFiles;
	/** Issue new tokens even where a working one is stored. */
	rotateTokens: boolean;
	/** The configuration generation `plan` was read in; a later config apply voids the run. */
	generation: number;
	report: (line: string) => void;
}>;

export class BootstrapError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BootstrapError";
	}
}

/** A configuration was applied during bootstrap: reload the plan and run again. */
export class StaleConfigurationError extends BootstrapError {
	constructor() {
		super("the configuration changed during bootstrap");
		this.name = "StaleConfigurationError";
	}
}

const TOKEN_DESCRIPTION = "agent-gateway";

/**
 * Revokes every access token of an account. The listing is paged; revoking empties the first
 * page, so it is read again until nothing is left.
 */
async function revokeAllTokens(admin: MattermostClient, userId: MattermostId): Promise<void> {
	for (let round = 0; round < 1000; round += 1) {
		const ids = await admin.userAccessTokenIds(userId);
		if (ids.length === 0) {
			return;
		}
		for (const tokenId of ids) {
			await admin.revokeUserAccessToken(tokenId);
		}
	}
	throw new BootstrapError(`could not revoke every token of account '${userId}'`);
}

/** Plain system roles: `system_user` and nothing else. */
function isPlainSystemRoles(roles: string): boolean {
	return roles.trim().split(/\s+/).join(" ") === "system_user";
}

/** Every team member stays in the team's default channel; Mattermost does not let it leave. */
const DEFAULT_CHANNEL = "town-square";

/** A team channel (public or private) a bot is in but should not be. */
function isExtraChannel(channel: ApiChannel, allowed: ReadonlySet<MattermostId>): boolean {
	return (
		(channel.type === "O" || channel.type === "P") &&
		channel.delete_at === 0 &&
		channel.name !== DEFAULT_CHANNEL &&
		!allowed.has(channel.id)
	);
}

async function tokenOwner(baseUrl: string, token: string): Promise<MattermostId | null> {
	try {
		return (await new MattermostClient({ baseUrl, token }).me()).id;
	} catch (error) {
		if (error instanceof MattermostApiError && error.status === 401) {
			return null;
		}
		throw error;
	}
}

async function ensureBot(admin: MattermostClient, bot: BotSpec): Promise<MattermostId> {
	const existing = await admin.userByUsername(bot.username);
	if (existing === null) {
		const created = await admin.createBot({
			username: bot.username,
			display_name: bot.displayName,
			description: "Agent Gateway bot",
		});
		return created.user_id;
	}
	if (!existing.is_bot) {
		throw new BootstrapError(
			`'${bot.username}' is a regular user account, not a bot; rename one of them`,
		);
	}
	// An existing bot is adopted only as a plain member: its token must grant nothing more.
	if (!isPlainSystemRoles(existing.roles)) {
		throw new BootstrapError(
			`bot '${bot.username}' has roles '${existing.roles}'; the Gateway adopts only plain members (system_user)`,
		);
	}
	if (existing.delete_at > 0) {
		await admin.enableBot(existing.id);
	}
	return existing.id;
}

/**
 * Creates or checks everything the Gateway needs in Mattermost: resolves the team, the managed
 * channels and the owners (which must exist), creates missing bots (plain members, never
 * admins), adds them to the team and their channels and removes them from other managed
 * channels, and stores a token per bot directly in its secret file. Existing working tokens are
 * kept unless rotation is asked for. Idempotent.
 */
export async function bootstrapMattermost(options: BootstrapOptions): Promise<void> {
	const { plan, store, tokens, report, baseUrl } = options;
	const admin = new MattermostClient({ baseUrl, token: options.adminToken });

	const team = await admin.teamByName(plan.team);
	if (team === null || team.delete_at > 0) {
		throw new BootstrapError(`team '${plan.team}' does not exist; create it first`);
	}
	const channelIds = new Map<string, MattermostId>();
	const missing: string[] = [];
	for (const name of plan.channels) {
		const channel = await admin.channelByName(team.id, name);
		if (channel === null || channel.delete_at > 0) {
			missing.push(name);
		} else {
			channelIds.set(name, channel.id);
		}
	}
	if (missing.length > 0) {
		throw new BootstrapError(
			`channels missing in team '${plan.team}': ${missing.join(", ")}; create them first`,
		);
	}
	const managedIds = new Set(channelIds.values());
	// Channels an earlier configuration managed: every Gateway bot leaves them.
	const staleChannels = [...(await store.recordedChannels())].filter(
		([, id]) => !managedIds.has(id),
	);
	const previousUsers = await store.recordedUsers();
	// Catch-up of a newly managed channel starts at its newest post: older history is not the
	// Gateway's to replay, anything newer is caught even before the listener notices the channel.
	// Only a channel without a start is scanned: a busy channel that is already managed must not
	// be able to hold up bootstrap (and a token rotation with it). Team, channels and starts are
	// then recorded together.
	const published: { name: string; id: MattermostId; start: ChannelStart | null }[] = [];
	for (const [name, id] of channelIds) {
		published.push({
			name,
			id,
			start: (await store.hasChannelStart(id)) ? null : await channelStartOf(admin, id),
		});
	}
	// A configuration applied since the plan was read voids plan and scans alike: the caller
	// reloads the plan and runs again.
	if (!(await store.publishTeam({ name: plan.team, id: team.id }, published, options.generation))) {
		throw new StaleConfigurationError();
	}
	for (const owner of plan.owners) {
		const user = await admin.userByUsername(owner);
		if (user === null || user.is_bot) {
			throw new BootstrapError(`owner '${owner}' is not an existing human account`);
		}
		await store.setUser(owner, user.id);
	}

	const everyChannel = [...channelIds.values(), ...staleChannels.map(([, id]) => id)];
	// The team's default channel: no member can leave it (Mattermost refuses), so it is skipped.
	const defaultChannelId = (await admin.channelByName(team.id, DEFAULT_CHANNEL))?.id ?? null;
	const leave = async (userId: MattermostId, channels: Readonly<MattermostId[]>) => {
		for (const channelId of channels) {
			if (channelId === defaultChannelId || !(await admin.isChannelMember(channelId, userId))) {
				continue;
			}
			try {
				await admin.removeChannelMember(channelId, userId);
			} catch (error) {
				// Another team's default channel (after a team change) cannot be left either: it is
				// reported and cleanup goes on (a retired account is deactivated before this).
				if (!(error instanceof MattermostApiError) || error.status !== 400) {
					throw error;
				}
				report(
					`could not remove account '${userId}' from channel '${channelId}': ${error.message}`,
				);
			}
		}
	};
	// A bot that is no longer the Gateway's keeps no access: its tokens revoked and the account
	// deactivated first (that alone ends all access), then out of every channel the Gateway
	// manages or managed.
	const retire = async (userId: MattermostId, username: string, what: string) => {
		await revokeAllTokens(admin, userId);
		const account = await admin.user(userId);
		if (account.delete_at === 0) {
			await admin.disableBot(userId);
		}
		await leave(userId, everyChannel);
		report(`${username}: retired ${what} (deactivated, removed from managed channels)`);
	};
	// Every account of the plan first: nothing the plan uses may be retired below.
	const resolved = new Map<BotSpec, MattermostId>();
	for (const bot of plan.bots) {
		resolved.set(bot, await ensureBot(admin, bot));
	}
	const gatewayBots = [...resolved.values()];
	for (const [bot, userId] of resolved) {
		const recorded = await store.recordedBotUserId(bot);
		if (recorded !== null && recorded !== userId && !gatewayBots.includes(recorded)) {
			// The recorded account was renamed or replaced: it must not keep the bot's access.
			await retire(recorded, `${bot.username} (previous account)`, "replaced bot");
		}
		// A bot the Gateway did not record (adopted) may have tokens issued by someone else; so may
		// any bot whose token file others could read or whose tokens are rotated. Those are all
		// revoked before the bot is granted any membership, and the new token issued after.
		const adopted = recorded !== userId;
		const state = tokens.state(bot.tokenPath);
		if (state === "symlink") {
			throw new BootstrapError(
				`token file '${bot.tokenPath}' is a symlink; replace it with a file`,
			);
		}
		const stored = state === "private" ? tokens.read(bot.tokenPath) : null;
		const works = !adopted && stored !== null && (await tokenOwner(baseUrl, stored)) === userId;
		const replaceToken = !works || options.rotateTokens;
		if (replaceToken) {
			await revokeAllTokens(admin, userId);
		}
		// One team only, as a plain member.
		for (const other of await admin.userTeams(userId)) {
			if (other.id !== team.id) {
				await admin.removeTeamMember(other.id, userId);
			}
		}
		await admin.addTeamMember(team.id, userId);
		const teamMember = await admin.teamMember(team.id, userId);
		if (teamMember !== null && isElevatedMember(teamMember)) {
			await admin.setTeamMemberRoles(team.id, userId, "team_user");
		}
		const allowed = new Set<MattermostId>();
		for (const name of bot.channels) {
			const channelId = channelIds.get(name);
			if (channelId === undefined) {
				throw new BootstrapError(`bot '${bot.username}' needs unmanaged channel '${name}'`);
			}
			allowed.add(channelId);
			await admin.addChannelMember(channelId, userId);
		}
		// Every other channel of the team (managed or not) must not stay readable to its token;
		// in the rest (its own and the default channel) it is a plain member.
		let removed = 0;
		for (const channel of await admin.userChannelsInTeam(userId, team.id)) {
			if (isExtraChannel(channel, allowed)) {
				await admin.removeChannelMember(channel.id, userId);
				removed += 1;
				continue;
			}
			const member = await admin.channelMember(channel.id, userId);
			if (member !== null && isElevatedMember(member)) {
				await admin.setChannelMemberRoles(channel.id, userId, "channel_user");
			}
		}
		if (replaceToken) {
			tokens.write(bot.tokenPath, await admin.createUserAccessToken(userId, TOKEN_DESCRIPTION));
		}
		if (bot.agentId === null) {
			await store.setUser(bot.username, userId);
		} else {
			await store.setAgentBot(bot.agentId, userId);
		}
		report(
			`${bot.username}: ok (${bot.channels.length} channels${removed > 0 ? `, removed from ${removed}` : ""}, token ${replaceToken ? "issued" : "kept"})`,
		);
	}

	// An account the current plan uses again (e.g. a removed agent's bot turned listener) stays.
	for (const retired of plan.retiredBots.filter((bot) => !gatewayBots.includes(bot.userId))) {
		await retire(retired.userId, retired.username, "agent bot");
	}
	const listener = plan.bots.find((bot) => bot.agentId === null)?.username;
	for (const [name, id] of previousUsers) {
		if (name === listener || plan.owners.includes(name)) {
			continue;
		}
		const account = await admin.user(id);
		if (account.is_bot && !gatewayBots.includes(id)) {
			// A listener bot of an earlier configuration.
			await retire(id, name, "listener bot");
		}
		await store.forget("user", name, id);
	}
	for (const [name, id] of staleChannels) {
		for (const userId of new Set([...gatewayBots, ...plan.retiredBots.map((bot) => bot.userId)])) {
			await leave(userId, [id]);
		}
		await store.forget("channel", name, id);
		await store.forgetChannelStart(id);
		report(`channel '${name}': no longer managed, Gateway bots removed`);
	}
}

export type ReconcileStore = Readonly<{
	channelId: (name: string) => Promise<MattermostId | null>;
	/** The user id bootstrap recorded for a bot. */
	botUserId: (bot: BotSpec) => Promise<MattermostId | null>;
	markVerified: (agentId: AgentId) => Promise<void>;
}>;

export type ReconcileOptions = Readonly<{
	baseUrl: string;
	plan: MattermostPlan;
	store: ReconcileStore;
	tokens: TokenFiles;
}>;

/**
 * Checks, with each bot's own token and no admin rights, that the bootstrap result still holds:
 * every token works and belongs to the recorded bot, every bot is a member of exactly its
 * managed channels, and channel names still resolve to the recorded ids. Returns the problems found; changes nothing
 * in Mattermost.
 */
export async function reconcileMattermost(options: ReconcileOptions): Promise<Readonly<string[]>> {
	const { plan, store, tokens, baseUrl } = options;
	const problems: string[] = [];
	for (const bot of plan.bots) {
		const expected = await store.botUserId(bot);
		if (expected === null) {
			problems.push(`${bot.username}: not bootstrapped`);
			continue;
		}
		const state = tokens.state(bot.tokenPath);
		if (state !== "private") {
			problems.push(
				state === "missing"
					? `${bot.username}: token file '${bot.tokenPath}' is missing`
					: `${bot.username}: token file '${bot.tokenPath}' is ${state === "symlink" ? "a symlink" : "readable by others"}; rerun bootstrap`,
			);
			continue;
		}
		const token = tokens.read(bot.tokenPath);
		const owner = await tokenOwner(baseUrl, token);
		if (owner !== expected) {
			problems.push(
				`${bot.username}: token ${owner === null ? "is rejected" : "belongs to another account"}`,
			);
			continue;
		}
		const client = new MattermostClient({ baseUrl, token });
		const team = await client.teamByName(plan.team);
		if (team === null) {
			problems.push(`${bot.username}: not a member of team '${plan.team}'`);
			continue;
		}
		let healthy = true;
		const problem = (text: string) => {
			problems.push(text);
			healthy = false;
		};
		const account = await client.me();
		if (account.username !== bot.username || !account.is_bot) {
			problem(`${bot.username}: the bot account is now '${account.username}'; rerun bootstrap`);
		}
		if (!isPlainSystemRoles(account.roles)) {
			problem(`${bot.username}: has system roles beyond a plain member`);
		}
		const teamMember = await client.teamMember(team.id, expected);
		if (teamMember !== null && isElevatedMember(teamMember)) {
			problem(`${bot.username}: has admin rights in team '${plan.team}'`);
		}
		for (const other of await client.userTeams(expected)) {
			if (other.id !== team.id) {
				problem(`${bot.username}: member of another team '${other.name}'`);
			}
		}
		const allowed = new Set<MattermostId>();
		for (const name of bot.channels) {
			const recorded = await store.channelId(name);
			const channel = await client.channelByName(team.id, name);
			const member = channel === null ? null : await client.channelMember(channel.id, expected);
			if (channel === null || member === null) {
				problem(`${bot.username}: not a member of channel '${name}'`);
			} else if (recorded !== channel.id) {
				problem(`channel '${name}' resolves to another id than recorded; rerun bootstrap`);
			} else {
				allowed.add(channel.id);
			}
		}
		for (const channel of await client.userChannelsInTeam(expected, team.id)) {
			if (isExtraChannel(channel, allowed)) {
				if (!bot.channels.includes(channel.name)) {
					problem(`${bot.username}: member of channel '${channel.name}' it is not allowed in`);
				}
				continue;
			}
			const member = await client.channelMember(channel.id, expected);
			if (member !== null && isElevatedMember(member)) {
				problem(`${bot.username}: has admin rights in channel '${channel.name}'`);
			}
		}
		if (healthy && bot.agentId !== null) {
			await store.markVerified(bot.agentId);
		}
	}
	return problems;
}
