// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteEntryDialog } from "./delete-entry-dialog.tsx";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("DeleteEntryDialog", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("names every agent that would lose the entry, before anything is deleted", () => {
		render(
			<DeleteEntryDialog
				open={true}
				onOpenChange={() => {}}
				entryId="demo-tool"
				isBuiltin={false}
				attachedAgentIds={["director", "finance"]}
				onDeleted={() => {}}
			/>,
		);
		const dialog = screen.getByRole("dialog");
		expect(dialog).toHaveTextContent("director, finance");
		expect(dialog).toHaveTextContent(/cannot be undone/i);
	});

	it("warns that a built-in's deletion is a permanent tombstone, never silently re-seeded", () => {
		render(
			<DeleteEntryDialog
				open={true}
				onOpenChange={() => {}}
				entryId="native-repository-read"
				isBuiltin={true}
				attachedAgentIds={[]}
				onDeleted={() => {}}
			/>,
		);
		expect(screen.getByText(/no agent currently holds this entry/i)).toBeInTheDocument();
		expect(screen.getByText(/permanent/i)).toBeInTheDocument();
	});

	it("deletes on confirm and reports a 409 conflict inline rather than throwing", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "stale", currentRevisionId: 9 }, 409)),
		);
		const onDeleted = vi.fn();
		render(
			<DeleteEntryDialog
				open={true}
				onOpenChange={() => {}}
				entryId="demo-tool"
				isBuiltin={false}
				attachedAgentIds={[]}
				onDeleted={onDeleted}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /^delete$/i }));
		expect(await screen.findByText(/changed since this page was loaded/i)).toBeInTheDocument();
		expect(onDeleted).not.toHaveBeenCalled();
	});

	it("calls onDeleted after a successful delete", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ entryId: "demo-tool", affectedAgentIds: [] })),
		);
		const onDeleted = vi.fn();
		render(
			<DeleteEntryDialog
				open={true}
				onOpenChange={() => {}}
				entryId="demo-tool"
				isBuiltin={false}
				attachedAgentIds={[]}
				onDeleted={onDeleted}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /^delete$/i }));
		expect(onDeleted).toHaveBeenCalled();
	});
});
