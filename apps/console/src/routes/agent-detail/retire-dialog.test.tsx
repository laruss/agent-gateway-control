// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RetireAgentDialog } from "./retire-dialog.tsx";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("RetireAgentDialog", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("requires a finance reassignment before Retire can be submitted, for the organization's finance agent", () => {
		render(
			<RetireAgentDialog
				open={true}
				onOpenChange={() => {}}
				agentId="finance"
				isSystemAgent={false}
				isFinanceAgent={true}
				otherAgentIds={["director", "research"]}
				onRetired={() => {}}
			/>,
		);
		expect(screen.getByRole("button", { name: /^retire$/i })).toBeDisabled();
		expect(screen.getByText(/is the organization's finance agent/i)).toBeInTheDocument();
		expect(screen.getByText(/reassign the finance role to/i)).toBeInTheDocument();
	});

	it("never shows the finance reassignment select for an agent that is not the finance agent, and Retire starts enabled", () => {
		render(
			<RetireAgentDialog
				open={true}
				onOpenChange={() => {}}
				agentId="director"
				isSystemAgent={false}
				isFinanceAgent={false}
				otherAgentIds={["finance", "research"]}
				onRetired={() => {}}
			/>,
		);
		expect(screen.queryByText(/reassign the finance role to/i)).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^retire$/i })).toBeEnabled();
	});

	it("shows a warning, but never blocks, retiring a system (observe_system) agent", () => {
		render(
			<RetireAgentDialog
				open={true}
				onOpenChange={() => {}}
				agentId="operator"
				isSystemAgent={true}
				isFinanceAgent={false}
				otherAgentIds={[]}
				onRetired={() => {}}
			/>,
		);
		expect(screen.getByText(/operator-style agent/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^retire$/i })).toBeEnabled();
	});

	it("submits the reason and calls onRetired on success", async () => {
		const user = userEvent.setup();
		const calls: Array<{ path: string; body: unknown }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				calls.push({
					path: typeof input === "string" ? input : input.toString(),
					body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
				});
				return jsonResponse({
					operationId: "22222222-2222-4222-8222-222222222222",
					revisionId: 9,
				});
			}),
		);
		const onRetired = vi.fn();
		render(
			<RetireAgentDialog
				open={true}
				onOpenChange={() => {}}
				agentId="director"
				isSystemAgent={false}
				isFinanceAgent={false}
				otherAgentIds={[]}
				onRetired={onRetired}
			/>,
		);
		await user.type(screen.getByLabelText(/reason/i), "role no longer needed");
		await user.click(screen.getByRole("button", { name: /^retire$/i }));

		expect(onRetired).toHaveBeenCalledTimes(1);
		const call = calls.find((c) => c.path === "/api/agents/director/retire");
		expect(call?.body).toMatchObject({ reason: "role no longer needed" });
	});
});
