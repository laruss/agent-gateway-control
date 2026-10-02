// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecyclePanel } from "./lifecycle-panel.tsx";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function renderPanel(onRetried: () => void = () => {}) {
	const queryClient = new QueryClient();
	return render(
		<QueryClientProvider client={queryClient}>
			<LifecyclePanel agentId="director" onRetried={onRetried} />
		</QueryClientProvider>,
	);
}

describe("LifecyclePanel", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("renders nothing once the agent is ready", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					status: "ready",
					generation: 1,
					lastError: null,
					statusChangedAt: new Date().toISOString(),
					retiredAt: null,
					operations: [],
				}),
			),
		);
		const { container } = renderPanel();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(container).toBeEmptyDOMElement();
	});

	it("renders a progress checklist from the current operation's checkpoints while pending", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					status: "pending",
					generation: 1,
					lastError: null,
					statusChangedAt: new Date().toISOString(),
					retiredAt: null,
					operations: [
						{
							id: "33333333-3333-4333-8333-333333333333",
							kind: "create",
							state: "running",
							checkpoints: {
								bot_user_id: "abcdefghijklmnopqrstuvwxyz",
								token_ref: "/run/bot-secrets/mm_director_token",
							},
							error: null,
							createdAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
							finishedAt: null,
						},
					],
				}),
			),
		);
		renderPanel();
		expect(await screen.findByText(/resolve or create the bot/i)).toBeInTheDocument();
		expect(screen.getByText(/issue an access token/i)).toBeInTheDocument();
		expect(screen.getByText(/join the team/i)).toBeInTheDocument();
		expect(screen.getByText(/join its configured channels/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
	});

	it("renders a progress checklist for an in-flight retire, which never passes through reconciling", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					status: "retiring",
					generation: 2,
					lastError: null,
					statusChangedAt: new Date().toISOString(),
					retiredAt: null,
					operations: [
						{
							id: "33333333-3333-4333-8333-333333333334",
							kind: "retire",
							state: "running",
							checkpoints: { tokens_revoked: true },
							error: null,
							createdAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
							finishedAt: null,
						},
					],
				}),
			),
		);
		renderPanel();
		expect(await screen.findByText(/revoke its access tokens/i)).toBeInTheDocument();
		expect(screen.getByText(/deactivate the bot/i)).toBeInTheDocument();
		expect(screen.getByText(/leave its channels/i)).toBeInTheDocument();
		expect(screen.getByText(/remove its local token file/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
	});

	it("renders a progress checklist for a running reprovision, which never moves the agent out of ready", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					status: "ready",
					generation: 3,
					lastError: null,
					statusChangedAt: new Date().toISOString(),
					retiredAt: null,
					operations: [
						{
							id: "33333333-3333-4333-8333-333333333335",
							kind: "reprovision",
							state: "running",
							// A channel id (ADR-026), never a name: `channels_joined`
							// is this pass's own progress marker, reset every pass, by id.
							checkpoints: { channels_joined: ["hqchanne1000000000000000aa"] },
							error: null,
							createdAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
							finishedAt: null,
						},
					],
				}),
			),
		);
		renderPanel();
		expect(await screen.findByText(/join newly configured channels/i)).toBeInTheDocument();
		expect(screen.getByText(/leave channels no longer configured/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
	});

	it("shows the actionable failure with a Retry button for a failed reprovision, which leaves the agent ready rather than failed", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					status: "ready",
					generation: 3,
					lastError: "channel 'ops' could not be resolved",
					statusChangedAt: new Date().toISOString(),
					retiredAt: null,
					operations: [
						{
							id: "33333333-3333-4333-8333-333333333336",
							kind: "reprovision",
							state: "failed",
							checkpoints: {},
							error: "channel 'ops' could not be resolved",
							createdAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
							finishedAt: new Date().toISOString(),
						},
					],
				}),
			),
		);
		renderPanel();
		expect(await screen.findByText(/channel 'ops' could not be resolved/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^retry$/i })).toBeInTheDocument();
	});

	it("shows the actionable failure with a Retry button once failed, and retrying calls the API", async () => {
		const user = userEvent.setup();
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const path = typeof input === "string" ? input : input.toString();
				if ((init?.method ?? "GET") === "POST") {
					calls.push(path);
					return jsonResponse({
						operationId: "44444444-4444-4444-8444-444444444444",
						kind: "create",
					});
				}
				return jsonResponse({
					status: "failed",
					generation: 1,
					lastError: "the bot account could not be created",
					statusChangedAt: new Date().toISOString(),
					retiredAt: null,
					operations: [
						{
							id: "33333333-3333-4333-8333-333333333333",
							kind: "create",
							state: "failed",
							checkpoints: {},
							error: "the bot account could not be created",
							createdAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
							finishedAt: new Date().toISOString(),
						},
					],
				});
			}),
		);
		const onRetried = vi.fn();
		renderPanel(onRetried);

		expect(await screen.findByText(/the bot account could not be created/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /^retry$/i }));

		expect(onRetried).toHaveBeenCalledTimes(1);
		expect(calls).toEqual(["/api/agents/director/retry"]);
	});
});
