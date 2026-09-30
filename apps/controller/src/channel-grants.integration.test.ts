import {
	type AgentTurnInput,
	type GatewayEvent,
	MattermostPostDataSchema,
} from "@agent-gateway/contracts";
import {
	applyConfig,
	grantChannel,
	ingestEvent,
	loadMattermostSnapshot,
	readChannelFloor,
	revokeChannelGrant,
	setAgentBotUser,
	unneededChannels,
	whileAgentMayPost,
} from "@agent-gateway/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	eventually,
	exampleConfig,
	humanPost,
	IDS,
	startTestGateway,
	type TestGateway,
} from "./test-gateway.ts";

const LAB = IDS.channel("lab");
const RESEARCH_BOT = "researchb0t00000000000000a";
const EVIDENCE = "addp0st0000000000000000000";

/** A human's mention of `research` in `channel`, created at `time`. */
function mention(channel: string, time: number, message = "@research look at this"): GatewayEvent {
	const base = humanPost(message, ["research"]);
	const data = { ...MattermostPostDataSchema.parse(base.data), channel_id: channel };
	return { ...base, time: new Date(time).toISOString(), data };
}

describe("channel grants", () => {
	let gateway: TestGateway;
	let since: number;

	beforeAll(async () => {
		gateway = await startTestGateway();
		await setAgentBotUser(gateway.deps(), "research", RESEARCH_BOT, "test");
		since = Date.now() - 60_000;
	});

	afterAll(async () => {
		await gateway?.stop();
	});

	const grant = (sinceMs: number, botUserId = RESEARCH_BOT) =>
		grantChannel(gateway.deps(), {
			agentId: "research",
			botUserId,
			teamId: IDS.channel("team"),
			channelId: LAB,
			channelName: "lab",
			grantorUserId: IDS.owner,
			evidencePostId: EVIDENCE,
			sinceMs,
		});

	const researchChannels = async () =>
		(await loadMattermostSnapshot(gateway.deps()))?.agents.find((a) => a.id === "research")
			?.channelIds;

	const mayPost = async () =>
		(await whileAgentMayPost(gateway.deps(), "research", LAB, async () => true)).allowed;

	it("gives the agent the channel from its add on, everywhere", async () => {
		expect(await grant(since)).toBe(true);
		const snapshot = await loadMattermostSnapshot(gateway.deps());
		expect(snapshot?.channels.get(LAB)).toBe("lab");
		expect(await researchChannels()).toContain(LAB);
		expect(await mayPost()).toBe(true);
		// The channel was not followed: its catch-up starts at the add.
		expect(await readChannelFloor(gateway.deps(), LAB)).toEqual({
			floor: since,
			floorPostIds: [EVIDENCE],
		});

		const before = await ingestEvent(gateway.deps(), mention(LAB, since));
		expect(before.routes).toEqual([
			expect.objectContaining({
				agentId: "research",
				decision: "ignore",
				reason: "channel_not_allowed",
			}),
		]);
		const after = await ingestEvent(gateway.deps(), mention(LAB, since + 1));
		expect(after.routes).toEqual([
			expect.objectContaining({ agentId: "research", decision: "wake", reason: "target" }),
		]);
	});

	it("counts only the add a grant came from once, and a newer one again", async () => {
		// The same add again: nothing new, the grant holds.
		expect(await grant(since)).toBe(true);
		expect(await revokeChannelGrant(gateway.deps(), "research", LAB, "bot_left")).toBe(false);
		expect(await researchChannels()).not.toContain(LAB);
		expect(await mayPost()).toBe(false);
		// Nothing needs the channel: its catch-up is gone.
		expect(await readChannelFloor(gateway.deps(), LAB)).toBeNull();
		// The old add does not grant again; a newer one does.
		expect(await grant(since)).toBe(false);
		expect(await grant(since + 5000)).toBe(true);
		expect(await researchChannels()).toContain(LAB);
	});

	it("never grants a channel the agent has in its configuration", async () => {
		const config = exampleConfig();
		const configured = config.agents.find((agent) => agent.id === "research")?.mattermost
			.allowed_channels[0];
		if (configured === undefined) {
			throw new Error("the example research agent has no channel");
		}
		expect(
			await grantChannel(gateway.deps(), {
				agentId: "research",
				botUserId: RESEARCH_BOT,
				teamId: IDS.channel("team"),
				channelId: IDS.channel(configured),
				channelName: configured,
				grantorUserId: IDS.owner,
				evidencePostId: EVIDENCE,
				sinceMs: Date.now(),
			}),
		).toBe(false);
	});

	it("holds only for the agent's current bot", async () => {
		expect(await unneededChannels(gateway.deps(), [LAB])).toEqual([]);
		await setAgentBotUser(gateway.deps(), "research", "replacedb0t000000000000000", "test");
		expect(await researchChannels()).not.toContain(LAB);
		expect(await grant(since + 10_000)).toBe(false);
		// A stale row keeps nothing followed.
		expect(await unneededChannels(gateway.deps(), [LAB])).toEqual([LAB]);
		await setAgentBotUser(gateway.deps(), "research", RESEARCH_BOT, "test");
	});

	it("turns a channel taken out of allowed_channels into a tombstone, not a grant", async () => {
		const config = exampleConfig();
		const research = config.agents.find((agent) => agent.id === "research");
		const dropped = research?.mattermost.allowed_channels[0];
		if (research === undefined || dropped === undefined) {
			throw new Error("the example research agent has no channel");
		}
		const applied = Date.now();
		await applyConfig(
			gateway.deps(),
			{
				...config,
				agents: config.agents.map((agent) =>
					agent.id === "research"
						? {
								...agent,
								mattermost: {
									...agent.mattermost,
									allowed_channels: agent.mattermost.allowed_channels.filter((c) => c !== dropped),
								},
							}
						: agent,
				),
			},
			"test",
		);
		const rows = await gateway.pool.query<{
			state: string;
			since_ms: string;
			revoked_reason: string;
		}>(
			"select state, since_ms, revoked_reason from mattermost_channel_grants where agent_id = 'research' and channel_id = $1",
			[IDS.channel(dropped)],
		);
		expect(rows.rows).toEqual([
			expect.objectContaining({ state: "revoked", revoked_reason: "config_removed" }),
		]);
		expect(Number(rows.rows[0]?.since_ms)).toBeGreaterThanOrEqual(applied);
		// The owner's grant in another channel is untouched.
		expect(await researchChannels()).toContain(LAB);
	});

	it("keeps a thread's history from before the add out of the agent's turn", async () => {
		// A followed channel (the developer's), granted to research later.
		const engineering = IDS.channel("engineering");
		const addedAt = Date.now() - 30_000;
		const root = mention(engineering, addedAt - 10_000, "the plan from before: lighthouse42");
		await ingestEvent(gateway.deps(), root);
		expect(
			await grantChannel(gateway.deps(), {
				agentId: "research",
				botUserId: RESEARCH_BOT,
				teamId: IDS.channel("team"),
				channelId: engineering,
				channelName: "engineering",
				grantorUserId: IDS.owner,
				evidencePostId: EVIDENCE,
				sinceMs: addedAt,
			}),
		).toBe(true);
		const rootData = MattermostPostDataSchema.parse(root.data);
		const base = mention(engineering, addedAt + 1000, "@research what do you think?");
		const reply: GatewayEvent = {
			...base,
			correlationid: root.correlationid,
			data: { ...MattermostPostDataSchema.parse(base.data), root_id: rootData.post_id },
		};
		const routed = await ingestEvent(gateway.deps(), reply);
		expect(routed.routes).toEqual([
			expect.objectContaining({ agentId: "research", decision: "wake" }),
		]);
		const input = await eventually(
			async () => {
				const rows = await gateway.pool.query<{ input: AgentTurnInput }>(
					`select s.input from context_snapshots s join agent_runs r on r.id = s.run_id
				  where r.correlation_id = $1 and r.agent_id = 'research'`,
					[root.correlationid],
				);
				return rows.rows[0]?.input;
			},
			30_000,
			"research's turn",
		);
		expect(JSON.stringify(input.threadContext)).not.toContain("lighthouse42");
		expect(input.threadContext).toMatchObject({ rootPost: null, summary: null });
		expect(JSON.stringify(input.trigger)).toContain("what do you think");
	});

	it("revokes every grant when the team changes", async () => {
		const config = exampleConfig();
		await applyConfig(
			gateway.deps(),
			{
				...config,
				organization: {
					...config.organization,
					mattermost: { ...config.organization.mattermost, team: "another-team" },
				},
			},
			"test",
		);
		const rows = await gateway.pool.query<{ state: string; revoked_reason: string }>(
			"select state, revoked_reason from mattermost_channel_grants where channel_id = $1",
			[LAB],
		);
		expect(rows.rows).toEqual([{ state: "revoked", revoked_reason: "team_changed" }]);
	});
});
