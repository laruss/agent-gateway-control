// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewAgentDialog } from "./new-agent-dialog.tsx";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("NewAgentDialog", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function renderDialog(onCreated: (agentId: string) => void = () => {}) {
		return render(
			<NewAgentDialog
				open={true}
				onOpenChange={() => {}}
				knownChannels={["hq", "research"]}
				knownRuntimeAdapters={["mock", "codex"]}
				onCreated={onCreated}
			/>,
		);
	}

	it("disables Create until an id, a display name and a role prompt are all filled in", async () => {
		const user = userEvent.setup();
		renderDialog();
		const create = screen.getByRole("button", { name: /create/i });
		expect(create).toBeDisabled();

		await user.type(screen.getByLabelText(/agent id/i), "data-analyst");
		expect(create).toBeDisabled();

		await user.type(screen.getByLabelText(/display name/i), "Data Analyst");
		expect(create).toBeDisabled();

		await user.type(screen.getByLabelText(/role prompt/i), "You are the data analyst.");
		expect(create).toBeEnabled();
	});

	it("shows a validation message for an id that is not lowercase-and-hyphens, and keeps Create disabled", async () => {
		const user = userEvent.setup();
		renderDialog();
		await user.type(screen.getByLabelText(/agent id/i), "Data_Analyst");
		expect(await screen.findByText(/lowercase letters, digits, inner '-'/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /create/i })).toBeDisabled();
	});

	it("submits the filled-in fields to POST /api/agents and reports the new agent id", async () => {
		const user = userEvent.setup();
		const calls: Array<{ path: string; method: string; body: unknown }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const path = typeof input === "string" ? input : input.toString();
				calls.push({
					path,
					method: init?.method ?? "GET",
					body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
				});
				return jsonResponse({
					agentId: "data-analyst",
					operationId: "11111111-1111-4111-8111-111111111111",
					revisionId: 5,
				});
			}),
		);
		const onCreated = vi.fn();
		renderDialog(onCreated);

		await user.type(screen.getByLabelText(/agent id/i), "data-analyst");
		await user.type(screen.getByLabelText(/display name/i), "Data Analyst");
		await user.type(screen.getByLabelText(/role prompt/i), "You are the data analyst.");
		await user.click(screen.getByLabelText("hq"));
		await user.click(screen.getByRole("button", { name: /^create$/i }));

		expect(onCreated).toHaveBeenCalledWith("data-analyst");
		const call = calls.find((c) => c.path === "/api/agents" && c.method === "POST");
		expect(call).toBeDefined();
		expect(call?.body).toMatchObject({
			id: "data-analyst",
			displayName: "Data Analyst",
			allowedChannels: ["hq"],
			rolePrompt: "You are the data analyst.",
		});
	});

	it("shows the server's own problems for an invalid create request, never silently discarding them", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse(
					{ error: "the create request is invalid", problems: ["id already exists"] },
					422,
				),
			),
		);
		renderDialog();

		await user.type(screen.getByLabelText(/agent id/i), "director");
		await user.type(screen.getByLabelText(/display name/i), "Director");
		await user.type(screen.getByLabelText(/role prompt/i), "You are the director.");
		await user.click(screen.getByRole("button", { name: /^create$/i }));

		expect(await screen.findByText("id already exists")).toBeInTheDocument();
	});
});
