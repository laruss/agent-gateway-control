// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelAssignments } from "./channel-assignments.tsx";

const AGENT_ID = "director";
const CHANNEL_ID = "hqchanne1000000000000000aa";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function renderAssignments(queryClient: QueryClient = new QueryClient()) {
	return {
		queryClient,
		...render(
			<QueryClientProvider client={queryClient}>
				<ChannelAssignments agentId={AGENT_ID} />
			</QueryClientProvider>,
		),
	};
}

describe("ChannelAssignments", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("invalidates the lifecycle query once a grant is revoked, so a reprovision it queues (ADR-026) shows its own progress without a manual reload", async () => {
		let revoked = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				const path = new URL(input, "http://localhost").pathname;
				if (path === `/api/agents/${AGENT_ID}/channels` && method === "GET") {
					return jsonResponse({
						channels: revoked
							? []
							: [
									{
										channelId: CHANNEL_ID,
										channelName: "hq",
										provenance: "granted",
										grantedByUserId: "owner00000000000000000000a",
										grantedAt: new Date().toISOString(),
										evidencePostId: "post0000000000000000000000",
									},
								],
					});
				}
				if (path === `/api/agents/${AGENT_ID}/channels/revoke` && method === "POST") {
					revoked = true;
					return jsonResponse({ channelId: CHANNEL_ID, channelName: "hq", stillFollowed: false });
				}
				throw new Error(`unexpected request: ${method} ${path}`);
			}),
		);
		const queryClient = new QueryClient();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
		renderAssignments(queryClient);
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: /^revoke$/i }));

		await screen.findByText(/no channel assignments/i);
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["agent-lifecycle", AGENT_ID] });
	});
});
