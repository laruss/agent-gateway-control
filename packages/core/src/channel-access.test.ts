import type { AgentConfig } from "@agent-gateway/contracts";
import { describe, expect, it } from "vitest";
import {
	agentChannelFloors,
	agentChannelIds,
	agentChannelRefs,
	type ChannelAccess,
	grantedChannels,
} from "./channel-access.ts";

const HQ = "hqchanne10000000000000000a";
const LAB = "1abchanne1000000000000000a";
const OPS = "0pschanne1000000000000000a";

function agent(id: string, allowed: string[]) {
	const mattermost: AgentConfig["mattermost"] = {
		username: id,
		token_secret_file: `/run/secrets/mm_${id}_token`,
		allowed_channels: allowed,
	};
	return { id, config: { mattermost } };
}

const ACCESS: ChannelAccess = {
	named: new Map([
		["hq", HQ],
		["ops", OPS],
	]),
	granted: new Map([
		[
			"developer",
			[
				{ channelId: LAB, name: "lab", sinceMs: 1000 },
				// Granted and configured: the configuration's own rules hold, no floor.
				{ channelId: HQ, name: "hq", sinceMs: 2000 },
			],
		],
	]),
};

describe("channel access", () => {
	it("gives an agent its configured channels and its grants, once each", () => {
		expect(agentChannelRefs(agent("developer", ["hq", "unresolved"]), ACCESS)).toEqual([
			{ channelId: HQ, name: "hq" },
			{ channelId: LAB, name: "lab" },
		]);
		expect(agentChannelIds(agent("finance", ["ops"]), ACCESS)).toEqual(new Set([OPS]));
		// A granted-only agent needs no configured channel.
		expect(agentChannelIds(agent("developer", []), ACCESS)).toEqual(new Set([LAB, HQ]));
	});

	it("keeps an agent from posts before its add, in granted channels only", () => {
		expect(agentChannelFloors(agent("developer", ["hq"]), ACCESS)).toEqual(new Map([[LAB, 1000]]));
		expect(agentChannelFloors(agent("finance", ["ops"]), ACCESS)).toEqual(new Map());
	});

	it("lists every granted channel", () => {
		expect(grantedChannels(ACCESS)).toEqual(
			new Map([
				[LAB, "lab"],
				[HQ, "hq"],
			]),
		);
	});
});
