import type {
	ChannelGrantInput,
	GrantRecord,
	MattermostId,
	RejectedAdd,
} from "@agent-gateway/contracts";
import { createLogger } from "@agent-gateway/logging";
import { describe, expect, it } from "vitest";
import type { ApiChannel, ApiPost, ApiPostList, ApiUser } from "./api-schemas.ts";
import { type MembershipClient, membershipMemory, syncMembership } from "./membership.ts";

/** A Mattermost id: 26 lowercase letters and digits. */
function id(label: string): MattermostId {
	return label.padEnd(26, "0");
}

const TEAM = id("team");
const OWNER = id("owner");
const ADMIN = id("admin");
const MEMBER = id("member");
const LISTENER = id("listener");
const DEVELOPER_BOT = id("developerbot");
const FINANCE_BOT = id("financebot");
const LAB = id("lab");
const CONFIGURED = id("hq");

type Channel = { channel: ApiChannel; members: Set<MattermostId>; posts: ApiPost[] };

/** A small Mattermost: users, channels with members and their system posts. */
class World {
	users = new Map<MattermostId, ApiUser>();
	channels = new Map<MattermostId, Channel>();
	now = 1_000_000;
	failListenerAdd = false;
	/** The next check of the listener's own membership throws once, like a transient server error. */
	failListenerCheckOnce = false;
	/** Tokens whose every call fails, like a revoked one. */
	broken = new Set<string>();

	constructor() {
		this.user(OWNER, { roles: "system_user" });
		this.user(ADMIN, { roles: "system_user system_admin" });
		this.user(MEMBER, { roles: "system_user" });
		this.user(LISTENER, { roles: "system_user", is_bot: true });
		this.user(DEVELOPER_BOT, { roles: "system_user", is_bot: true });
		this.user(FINANCE_BOT, { roles: "system_user system_admin", is_bot: true });
		this.channel(LAB, "lab");
		this.channel(CONFIGURED, "hq");
		this.channel(id("townsquare"), "town-square");
		this.channel(id("dm"), `${DEVELOPER_BOT}__${OWNER}`, "D");
	}

	user(userId: MattermostId, fields: Partial<ApiUser>) {
		this.users.set(userId, {
			id: userId,
			username: userId.replace(/0+$/, ""),
			is_bot: false,
			roles: "system_user",
			delete_at: 0,
			...fields,
		});
	}

	channel(channelId: MattermostId, name: string, type = "O") {
		this.channels.set(channelId, {
			channel: { id: channelId, team_id: TEAM, name, type, delete_at: 0 },
			members: new Set(),
			posts: [],
		});
	}

	/** `actor` adds `userId`, as the server does: the member, then its system post. */
	add(channelId: MattermostId, actor: MattermostId, userId: MattermostId) {
		this.at(channelId).members.add(userId);
		this.system(channelId, actor, "system_add_to_channel", { addedUserId: userId, userId: actor });
	}

	/** `actor` removes `userId` (or `userId` leaves), with the server's system post. */
	remove(channelId: MattermostId, actor: MattermostId, userId: MattermostId) {
		this.at(channelId).members.delete(userId);
		if (actor === userId) {
			this.system(channelId, userId, "system_leave_channel", {});
		} else {
			this.system(channelId, actor, "system_remove_from_channel", { removedUserId: userId });
		}
	}

	system(channelId: MattermostId, actor: MattermostId, type: string, props: ApiPost["props"]) {
		const entry = this.at(channelId);
		this.now += 10;
		entry.posts.push({
			id: id(`p${entry.posts.length}${channelId.slice(0, 4)}`),
			create_at: this.now,
			update_at: this.now,
			edit_at: 0,
			delete_at: 0,
			user_id: actor,
			channel_id: channelId,
			root_id: "",
			message: type,
			type,
			props,
		});
	}

	/** The author deletes a post, as a plain member may delete their own. */
	deleteNewest(channelId: MattermostId) {
		const post = this.at(channelId).posts.at(-1);
		if (post !== undefined) {
			post.delete_at = this.now;
		}
	}

	at(channelId: MattermostId): Channel {
		const entry = this.channels.get(channelId);
		if (entry === undefined) {
			throw new Error(`no channel ${channelId}`);
		}
		return entry;
	}

	/** Each token is its user's id: the client acts as that user. */
	client(token: string): MembershipClient {
		const check = () => {
			if (this.broken.has(token)) {
				throw new Error("401 invalid token");
			}
		};
		const list = (posts: ApiPost[]): ApiPostList => ({
			order: posts.map((post) => post.id),
			posts: Object.fromEntries(posts.map((post) => [post.id, post])),
		});
		return {
			userChannelsInTeam: async (userId, teamId) => {
				check();
				return [...this.channels.values()]
					.filter((c) => c.members.has(userId) && c.channel.team_id === teamId)
					.map((c) => c.channel);
			},
			channelPostsSince: async (channelId, sinceMs) =>
				list(this.at(channelId).posts.filter((post) => post.update_at > sinceMs)),
			channelPostsBefore: async (channelId, before, perPage) => {
				const newestFirst = [...this.at(channelId).posts].reverse();
				const start = before === null ? 0 : newestFirst.findIndex((post) => post.id === before) + 1;
				return list(newestFirst.slice(start, start + perPage));
			},
			user: async (userId) => {
				const user = this.users.get(userId);
				if (user === undefined) {
					throw new Error(`no user ${userId}`);
				}
				return user;
			},
			isChannelMember: async (channelId, userId) => {
				if (userId === LISTENER && this.failListenerCheckOnce) {
					this.failListenerCheckOnce = false;
					throw new Error("500 temporary");
				}
				return this.at(channelId).members.has(userId);
			},
			addChannelMember: async (channelId, userId) => {
				if (userId === LISTENER && this.failListenerAdd) {
					throw new Error("403 no permission to add members");
				}
				this.add(channelId, token, userId);
			},
			removeChannelMember: async (channelId, userId) => {
				this.remove(channelId, token, userId);
			},
		};
	}
}

/** The control-plane side: grants and rejections, as the store records them. */
class Records {
	grants: GrantRecord[] = [];
	granted: ChannelGrantInput[] = [];
	rejections: RejectedAdd[] = [];
	routed: Readonly<{ agentId: string; channelId: MattermostId; postId: MattermostId }>[] = [];
	/** What `grant` answers: false stands for a stale grant (the bot was replaced meanwhile). */
	accept = true;
}

/** `clockAheadMs`: how far the controller's clock runs ahead of Mattermost's. */
function harness(bots = [DEVELOPER_BOT], clockAheadMs = 0) {
	const world = new World();
	const records = new Records();
	const memory = membershipMemory();
	const store = {
		state: async () => ({
			teamId: TEAM,
			ownerUserIds: new Set([OWNER]),
			listener: { userId: LISTENER, tokenSecretRef: LISTENER },
			bots: bots.map((userId) => ({
				agentId: userId === DEVELOPER_BOT ? "developer" : "finance",
				userId,
				tokenSecretRef: userId,
				configuredChannelIds: new Set([CONFIGURED]),
			})),
			grants: records.grants,
		}),
		grant: async (grant: ChannelGrantInput) => {
			if (!records.accept) {
				return false;
			}
			records.granted.push(grant);
			records.grants = [
				...records.grants.filter(
					(g) => !(g.agentId === grant.agentId && g.channelId === grant.channelId),
				),
				{
					agentId: grant.agentId,
					channelId: grant.channelId,
					state: "active",
					botUserId: grant.botUserId,
					sinceMs: grant.sinceMs,
					revokedReason: null,
					checkedAtMs: grant.sinceMs,
				},
			];
			return true;
		},
		revoke: async (agentId: string, channelId: MattermostId, reason: string) => {
			records.grants = records.grants.map((g) =>
				g.agentId === agentId && g.channelId === channelId && g.state === "active"
					? { ...g, state: "revoked", revokedReason: reason }
					: g,
			);
			return records.grants.some((g) => g.channelId === channelId && g.state === "active");
		},
		reject: async (rejection: RejectedAdd) => {
			records.rejections.push(rejection);
		},
		unneeded: async (channelIds: Readonly<MattermostId[]>) =>
			channelIds.filter(
				(channelId) =>
					channelId !== CONFIGURED &&
					!records.grants.some((g) => g.channelId === channelId && g.state === "active"),
			),
		token: (secretRef: string) => secretRef,
		routeMention: async (agentId: string, channelId: MattermostId, postId: MattermostId) => {
			records.routed.push({ agentId, channelId, postId });
			return true;
		},
		checked: async (agentId: string, channelId: MattermostId, atMs: number) => {
			records.grants = records.grants.map((g) =>
				g.agentId === agentId && g.channelId === channelId && g.state === "active"
					? { ...g, checkedAtMs: Math.max(g.checkedAtMs ?? 0, atMs) }
					: g,
			);
		},
	};
	const sync = () =>
		syncMembership(
			{
				baseUrl: "http://mattermost.test",
				store,
				log: createLogger({
					service: "test",
					version: "0.0.0",
					environment: "test",
					level: "error",
				}),
				clock: () => new Date(world.now + clockAheadMs),
				evidenceGraceMs: 60_000,
				client: (token) => world.client(token),
			},
			memory,
		);
	return { world, records, sync };
}

describe("the membership synchronizer", () => {
	it("grants a channel an owner added the bot to, and brings the listener in", async () => {
		const { world, records, sync } = harness();
		world.add(LAB, OWNER, DEVELOPER_BOT);
		const addedAt = world.now;
		await sync();
		expect(records.granted).toEqual([
			expect.objectContaining({
				agentId: "developer",
				channelId: LAB,
				channelName: "lab",
				grantorUserId: OWNER,
				sinceMs: addedAt,
			}),
		]);
		expect(world.at(LAB).members.has(LISTENER)).toBe(true);
		// Granted once: the next pass changes nothing.
		await sync();
		expect(records.granted).toHaveLength(1);
		expect(records.rejections).toEqual([]);
	});

	it("routes a mention made right after the add, before the grant was seen", async () => {
		const { world, records, sync } = harness();
		world.add(LAB, OWNER, DEVELOPER_BOT);
		world.now += 5;
		world.at(LAB).posts.push({
			id: id("mention"),
			create_at: world.now,
			update_at: world.now,
			edit_at: 0,
			delete_at: 0,
			user_id: OWNER,
			channel_id: LAB,
			root_id: "",
			message: "@developer please look at this",
			type: "",
			props: {},
		});
		await sync();
		expect(records.routed).toEqual([
			{ agentId: "developer", channelId: LAB, postId: id("mention") },
		]);
	});

	it("grants nothing from an old owner's add when someone else brought the bot back", async () => {
		const { world, records, sync } = harness();
		// An owner's add from long ago, then a removal (by the Gateway's bootstrap, say).
		world.add(LAB, OWNER, DEVELOPER_BOT);
		world.remove(LAB, ADMIN, DEVELOPER_BOT);
		// A member adds the bot again and deletes the add's system post.
		world.add(LAB, MEMBER, DEVELOPER_BOT);
		world.deleteNewest(LAB);
		await sync();
		world.now += 60_000;
		await sync();
		expect(records.granted).toEqual([]);
		expect(world.at(LAB).members.has(DEVELOPER_BOT)).toBe(false);
	});

	it("sees a re-add between polls even when the controller's clock runs ahead", async () => {
		const { world, records, sync } = harness([DEVELOPER_BOT], 3_600_000);
		world.add(LAB, OWNER, DEVELOPER_BOT);
		await sync();
		await sync();
		world.remove(LAB, MEMBER, DEVELOPER_BOT);
		world.add(LAB, MEMBER, DEVELOPER_BOT);
		await sync();
		expect(records.rejections).toEqual([
			expect.objectContaining({ actorUserId: MEMBER, reason: "not_owner_or_admin" }),
		]);
		expect(world.at(LAB).members.has(DEVELOPER_BOT)).toBe(false);
	});

	it("fails closed when a granted bot's return has no add record", async () => {
		const { world, records, sync } = harness();
		world.add(LAB, OWNER, DEVELOPER_BOT);
		await sync();
		world.remove(LAB, MEMBER, DEVELOPER_BOT);
		world.add(LAB, MEMBER, DEVELOPER_BOT);
		world.deleteNewest(LAB);
		await sync();
		expect(records.grants).toEqual([
			expect.objectContaining({ state: "revoked", revokedReason: "add_unverified" }),
		]);
		expect(world.at(LAB).members.has(DEVELOPER_BOT)).toBe(false);
	});

	it("grants a system admin's add as well", async () => {
		const { world, records, sync } = harness();
		world.add(LAB, ADMIN, DEVELOPER_BOT);
		await sync();
		expect(records.granted).toEqual([expect.objectContaining({ grantorUserId: ADMIN })]);
	});

	it("refuses an add by anyone else: the bot leaves", async () => {
		const { world, records, sync } = harness();
		world.add(LAB, MEMBER, DEVELOPER_BOT);
		await sync();
		expect(records.granted).toEqual([]);
		expect(records.rejections).toEqual([
			expect.objectContaining({ actorUserId: MEMBER, reason: "not_owner_or_admin" }),
		]);
		expect(world.at(LAB).members.has(DEVELOPER_BOT)).toBe(false);
		expect(world.at(LAB).members.has(LISTENER)).toBe(false);
	});

	it("never lets an agent grant: a bot's add is refused, even an admin bot's", async () => {
		const { world, records, sync } = harness([DEVELOPER_BOT, FINANCE_BOT]);
		world.add(LAB, OWNER, FINANCE_BOT);
		world.add(LAB, FINANCE_BOT, DEVELOPER_BOT);
		await sync();
		expect(records.granted.map((grant) => grant.agentId)).toEqual(["finance"]);
		expect(records.rejections).toEqual([
			expect.objectContaining({
				agentId: "developer",
				actorUserId: FINANCE_BOT,
				reason: "not_owner_or_admin",
			}),
		]);
		expect(world.at(LAB).members.has(DEVELOPER_BOT)).toBe(false);
	});

	it("waits for a missing add record, then makes the bot leave", async () => {
		const { world, records, sync } = harness();
		world.at(LAB).members.add(DEVELOPER_BOT);
		await sync();
		expect(records.rejections).toEqual([]);
		expect(world.at(LAB).members.has(DEVELOPER_BOT)).toBe(true);
		world.now += 60_000;
		await sync();
		expect(records.rejections).toEqual([
			expect.objectContaining({ actorUserId: null, reason: "no_add_record" }),
		]);
		expect(world.at(LAB).members.has(DEVELOPER_BOT)).toBe(false);
	});

	it("revokes a grant when the bot leaves; the listener leaves an unneeded channel", async () => {
		const { world, records, sync } = harness();
		world.add(LAB, OWNER, DEVELOPER_BOT);
		await sync();
		world.at(LAB).members.delete(DEVELOPER_BOT);
		await sync();
		expect(records.grants).toEqual([expect.objectContaining({ channelId: LAB, state: "revoked" })]);
		expect(world.at(LAB).members.has(LISTENER)).toBe(false);
	});

	it("after a revocation, only a new add grants again", async () => {
		const { world, records, sync } = harness();
		world.add(LAB, OWNER, DEVELOPER_BOT);
		await sync();
		world.at(LAB).members.delete(DEVELOPER_BOT);
		await sync();
		// Back in the channel without a new add: the old record does not count.
		world.at(LAB).members.add(DEVELOPER_BOT);
		await sync();
		expect(records.granted).toHaveLength(1);
		world.at(LAB).members.delete(DEVELOPER_BOT);
		world.add(LAB, OWNER, DEVELOPER_BOT);
		await sync();
		expect(records.granted).toHaveLength(2);
		expect(records.grants).toEqual([expect.objectContaining({ channelId: LAB, state: "active" })]);
	});

	it("revokes at once when the listener cannot be brought in: the bot leaves, once", async () => {
		const { world, records, sync } = harness();
		world.failListenerAdd = true;
		world.add(LAB, OWNER, DEVELOPER_BOT);
		await sync();
		await sync();
		// The grant is recorded (so no reader ever sees the listener a member of a channel its own
		// grant does not cover yet), then revoked at once when the listener cannot join after all.
		expect(records.grants).toEqual([
			expect.objectContaining({
				channelId: LAB,
				state: "revoked",
				revokedReason: "listener_not_added",
			}),
		]);
		expect(records.rejections).toEqual([
			expect.objectContaining({ reason: "listener_not_added", actorUserId: OWNER }),
		]);
		expect(world.at(LAB).members.has(DEVELOPER_BOT)).toBe(false);
	});

	it("heals a transient failure right after granting: the listener joins on the next poll", async () => {
		const { world, records, sync } = harness();
		world.add(LAB, OWNER, DEVELOPER_BOT);
		// The listener's own membership check fails once, right after the grant is recorded: the
		// join this pass meant to do never happens.
		world.failListenerCheckOnce = true;
		await sync();
		expect(records.grants).toEqual([expect.objectContaining({ channelId: LAB, state: "active" })]);
		expect(world.at(LAB).members.has(LISTENER)).toBe(false);
		// Every pass checks every active grant, not only the one that recorded it: the next poll
		// brings the listener in.
		await sync();
		expect(world.at(LAB).members.has(LISTENER)).toBe(true);
	});

	it("heals a grant the listener never joined before a restart: joins on the first pass", async () => {
		const { world, records, sync } = harness();
		world.add(LAB, OWNER, DEVELOPER_BOT);
		const grantedAt = world.now;
		// As if the controller restarted between recording the grant and bringing the listener in:
		// a fresh run (the harness' own `memory`) finds the grant already active, but Mattermost
		// still without the listener in the channel.
		records.grants = [
			{
				agentId: "developer",
				channelId: LAB,
				state: "active",
				botUserId: DEVELOPER_BOT,
				sinceMs: grantedAt,
				revokedReason: null,
				checkedAtMs: grantedAt,
			},
		];
		expect(world.at(LAB).members.has(LISTENER)).toBe(false);
		await sync();
		expect(world.at(LAB).members.has(LISTENER)).toBe(true);
		expect(records.grants).toEqual([expect.objectContaining({ channelId: LAB, state: "active" })]);
	});

	it("judges a re-add between two polls by the newer add", async () => {
		const { world, records, sync } = harness();
		world.add(LAB, OWNER, DEVELOPER_BOT);
		await sync();
		// Removed and added again by someone who may not grant, before the next poll.
		world.at(LAB).members.delete(DEVELOPER_BOT);
		world.add(LAB, MEMBER, DEVELOPER_BOT);
		await sync();
		expect(records.grants).toEqual([expect.objectContaining({ channelId: LAB, state: "revoked" })]);
		expect(records.rejections).toEqual([
			expect.objectContaining({ actorUserId: MEMBER, reason: "not_owner_or_admin" }),
		]);
		expect(world.at(LAB).members.has(DEVELOPER_BOT)).toBe(false);
		expect(world.at(LAB).members.has(LISTENER)).toBe(false);
	});

	it("judges a non-owner re-add before self-heal runs, even when its own check would fail", async () => {
		const { world, records, sync } = harness();
		world.add(LAB, OWNER, DEVELOPER_BOT);
		await sync();
		// Removed and added again by someone who may not grant, before the next poll.
		world.at(LAB).members.delete(DEVELOPER_BOT);
		world.add(LAB, MEMBER, DEVELOPER_BOT);
		// Armed right before the revalidating pass: if self-heal ran before the re-add is judged
		// (Codex's review of ebfdd5a), this failure would be spent for nothing, and could leave an
		// unauthorized grant active instead of revoked.
		world.failListenerCheckOnce = true;
		await sync();
		expect(records.grants).toEqual([expect.objectContaining({ channelId: LAB, state: "revoked" })]);
		expect(records.rejections).toEqual([
			expect.objectContaining({ actorUserId: MEMBER, reason: "not_owner_or_admin" }),
		]);
		expect(world.at(LAB).members.has(DEVELOPER_BOT)).toBe(false);
		// Never reached: self-heal only runs once a grant has held up to revalidation, and this one
		// did not, so the one-time failure is still armed.
		expect(world.failListenerCheckOnce).toBe(true);
	});

	it("finds a re-add behind many newer posts in a busy channel", async () => {
		const { world, records, sync } = harness();
		world.add(LAB, OWNER, DEVELOPER_BOT);
		await sync();
		world.at(LAB).members.delete(DEVELOPER_BOT);
		world.add(LAB, MEMBER, DEVELOPER_BOT);
		for (let i = 0; i < 150; i += 1) {
			world.add(LAB, OWNER, id(`h${i}`));
		}
		await sync();
		expect(records.rejections).toEqual([
			expect.objectContaining({ actorUserId: MEMBER, reason: "not_owner_or_admin" }),
		]);
	});

	it("fails closed when too many posts hide who added a granted bot again", async () => {
		const { world, records, sync } = harness();
		world.add(LAB, OWNER, DEVELOPER_BOT);
		await sync();
		world.at(LAB).members.delete(DEVELOPER_BOT);
		world.add(LAB, OWNER, DEVELOPER_BOT);
		world.now += 20_000;
		for (let i = 0; i < 2100; i += 1) {
			world.add(LAB, OWNER, id(`h${i}`));
		}
		await sync();
		expect(records.grants).toEqual([
			expect.objectContaining({
				channelId: LAB,
				state: "revoked",
				revokedReason: "add_unverified",
			}),
		]);
		expect(records.rejections).toEqual([expect.objectContaining({ reason: "add_unverified" })]);
		expect(world.at(LAB).members.has(DEVELOPER_BOT)).toBe(false);
	});

	it("remembers how far a granted channel was checked across a restart", async () => {
		const { world, records, sync } = harness();
		world.add(LAB, OWNER, DEVELOPER_BOT);
		await sync();
		// Posts pile up between polls, far more than one check reads back.
		for (let round = 0; round < 6; round += 1) {
			for (let i = 0; i < 400; i += 1) {
				world.add(LAB, OWNER, id(`h${round}x${i}`));
			}
			world.now += 20_000;
			await sync();
		}
		// A fresh synchronizer (a restarted controller) reads on from the stored check.
		const restarted = harness();
		restarted.world.channels = world.channels;
		restarted.world.now = world.now;
		restarted.records.grants = records.grants;
		await restarted.sync();
		expect(restarted.records.grants).toEqual([
			expect.objectContaining({ channelId: LAB, state: "active" }),
		]);
		expect(restarted.records.rejections).toEqual([]);
	});

	it("says so when a channel was taken out of the configuration", async () => {
		const { world, records, sync } = harness();
		world.add(LAB, ADMIN, DEVELOPER_BOT);
		records.grants = [
			{
				agentId: "developer",
				channelId: LAB,
				state: "revoked",
				botUserId: DEVELOPER_BOT,
				sinceMs: world.now + 1,
				revokedReason: "config_removed",
				checkedAtMs: null,
			},
		];
		await sync();
		world.now += 60_000;
		await sync();
		expect(records.granted).toEqual([]);
		expect(records.rejections).toEqual([
			expect.objectContaining({ reason: "configuration_removed" }),
		]);
		expect(world.at(LAB).members.has(DEVELOPER_BOT)).toBe(false);
	});

	it("moves a grant's floor to an owner's newer re-add", async () => {
		const { world, records, sync } = harness();
		world.add(LAB, OWNER, DEVELOPER_BOT);
		await sync();
		world.at(LAB).members.delete(DEVELOPER_BOT);
		world.add(LAB, ADMIN, DEVELOPER_BOT);
		const readdedAt = world.now;
		await sync();
		expect(records.grants).toEqual([
			expect.objectContaining({ channelId: LAB, state: "active", sinceMs: readdedAt }),
		]);
	});

	it("keeps the listener while another agent still has the channel", async () => {
		const { world, records, sync } = harness([DEVELOPER_BOT, FINANCE_BOT]);
		world.add(LAB, OWNER, DEVELOPER_BOT);
		world.add(LAB, OWNER, FINANCE_BOT);
		await sync();
		expect(records.granted).toHaveLength(2);
		world.at(LAB).members.delete(DEVELOPER_BOT);
		await sync();
		expect(world.at(LAB).members.has(LISTENER)).toBe(true);
		world.at(LAB).members.delete(FINANCE_BOT);
		await sync();
		expect(world.at(LAB).members.has(LISTENER)).toBe(false);
	});

	it("takes the listener out again when the grant turns out stale", async () => {
		const { world, records, sync } = harness();
		records.accept = false;
		world.add(LAB, OWNER, DEVELOPER_BOT);
		await sync();
		expect(records.granted).toEqual([]);
		expect(world.at(LAB).members.has(LISTENER)).toBe(false);
	});

	it("goes on with the other bots when one fails", async () => {
		const { world, records, sync } = harness([DEVELOPER_BOT, FINANCE_BOT]);
		world.broken.add(DEVELOPER_BOT);
		world.add(LAB, OWNER, FINANCE_BOT);
		await sync();
		expect(records.granted.map((grant) => grant.agentId)).toEqual(["finance"]);
	});

	it("leaves configured channels, town-square and direct messages alone", async () => {
		const { world, records, sync } = harness();
		world.at(CONFIGURED).members.add(DEVELOPER_BOT);
		world.at(id("townsquare")).members.add(DEVELOPER_BOT);
		world.at(id("dm")).members.add(DEVELOPER_BOT);
		world.now += 120_000;
		await sync();
		await sync();
		expect(records.granted).toEqual([]);
		expect(records.rejections).toEqual([]);
		expect(world.at(CONFIGURED).members.has(DEVELOPER_BOT)).toBe(true);
	});
});
