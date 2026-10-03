// @vitest-environment happy-dom
import type { CustomHttpsDefinition } from "@agent-gateway/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { CustomToolDialog } from "./custom-tool-form.tsx";

function validDefinition(overrides: Partial<CustomHttpsDefinition> = {}): CustomHttpsDefinition {
	return {
		host: "api.example.com",
		pathTemplate: "/items",
		method: "GET",
		parameters: [{ name: "size", slot: "query", slotName: "size", type: "enum", values: ["low"] }],
		secretSlots: [],
		idempotency: null,
		responseLimits: {
			maxResponseBytes: 65_536,
			allowedContentTypes: ["application/json"],
			timeoutMs: 5000,
			includeBodyPreview: true,
		},
		...overrides,
	};
}

describe("CustomToolDialog", () => {
	it(
		"keeps a trailing comma while typing an enum's values, instead of collapsing " +
			"'low,high' into 'lowhigh'",
		async () => {
			const user = userEvent.setup();
			render(
				<CustomToolDialog
					open={true}
					onOpenChange={() => {}}
					mode="create"
					initial={{
						entryId: "status-check",
						name: "Status check",
						description: "Checks the status endpoint.",
						httpsDefinition: validDefinition(),
					}}
					onSubmit={async () => ({ problems: [] })}
					onSaved={() => {}}
				/>,
			);
			const input = screen.getByPlaceholderText("low,high");
			expect(input).toHaveValue("low");
			await user.clear(input);
			await user.type(input, "low,high");
			// Before the fix, every keystroke re-derived the displayed value from the committed,
			// already-split array: typing the comma produced `["low", ""]`, the empty trailing
			// element was filtered straight back out, and the input snapped back to "low" — so the
			// very next character landed right after "low", not after the comma.
			expect(input).toHaveValue("low,high");
			await user.tab();
			// Committing on blur does not itself clear or re-derive the text.
			expect(input).toHaveValue("low,high");
		},
	);

	it("deleting a parameter never corrupts the next row's own enum values on blur (stable row ids, not array index)", async () => {
		const user = userEvent.setup();
		render(
			<CustomToolDialog
				open={true}
				onOpenChange={() => {}}
				mode="create"
				initial={{
					entryId: "status-check",
					name: "Status check",
					description: "Checks the status endpoint.",
					httpsDefinition: validDefinition({
						parameters: [
							{
								name: "alpha",
								slot: "query",
								slotName: "alpha",
								type: "enum",
								values: ["one"],
							},
							{
								name: "beta",
								slot: "query",
								slotName: "beta",
								type: "enum",
								values: ["two"],
							},
						],
					}),
				}}
				onSubmit={async () => ({ problems: [] })}
				onSaved={() => {}}
			/>,
		);
		const enumInputs = screen.getAllByPlaceholderText("low,high");
		expect(enumInputs).toHaveLength(2);
		// Types into "alpha"'s own enum input, but never blurs it (never commits) before deleting
		// the row entirely — the uncommitted text that keying by array index used to carry over
		// onto whatever row ends up at position 0 next.
		await user.clear(enumInputs[0] as HTMLElement);
		await user.type(enumInputs[0] as HTMLElement, "corrupted");

		const removeButtons = screen.getAllByRole("button", { name: /remove parameter/i });
		await user.click(removeButtons[0] as HTMLElement);

		// "beta" is now the only (and first) row; its own enum input must still show its own,
		// already-committed value, never "alpha"'s uncommitted, never-blurred text.
		const remaining = screen.getAllByPlaceholderText("low,high");
		expect(remaining).toHaveLength(1);
		expect(remaining[0]).toHaveValue("two");
		await user.click(remaining[0] as HTMLElement);
		await user.tab();
		// Blurring commits "beta"'s own value, unchanged — not "corrupted".
		expect(remaining[0]).toHaveValue("two");
	});

	it(
		"shows a submission error in the dialog instead of leaving it blank on an unhandled " +
			"rejection (an invalid entry id, a network failure, any non-422 response)",
		async () => {
			const user = userEvent.setup();
			const onSubmit = vi.fn().mockRejectedValue(new ApiError(400, "entry id already exists"));
			const onSaved = vi.fn();
			const onOpenChange = vi.fn();
			render(
				<CustomToolDialog
					open={true}
					onOpenChange={onOpenChange}
					mode="create"
					initial={{
						entryId: "status-check",
						name: "Status check",
						description: "Checks the status endpoint.",
						httpsDefinition: validDefinition(),
					}}
					onSubmit={onSubmit}
					onSaved={onSaved}
				/>,
			);
			await user.click(screen.getByRole("button", { name: /^review$/i }));
			await user.click(screen.getByRole("button", { name: /^create$/i }));

			expect(await screen.findByText(/entry id already exists/i)).toBeInTheDocument();
			expect(onSaved).not.toHaveBeenCalled();
			expect(onOpenChange).not.toHaveBeenCalledWith(false);
		},
	);

	it("falls back to a generic message for a rejection that is not an ApiError (e.g. a network failure)", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
		render(
			<CustomToolDialog
				open={true}
				onOpenChange={() => {}}
				mode="create"
				initial={{
					entryId: "status-check",
					name: "Status check",
					description: "Checks the status endpoint.",
					httpsDefinition: validDefinition(),
				}}
				onSubmit={onSubmit}
				onSaved={() => {}}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /^review$/i }));
		await user.click(screen.getByRole("button", { name: /^create$/i }));

		expect(await screen.findByText(/could not save this tool/i)).toBeInTheDocument();
	});

	it("disables Review for an entry id the contract's own schema would reject (e.g. uppercase)", () => {
		render(
			<CustomToolDialog
				open={true}
				onOpenChange={() => {}}
				mode="create"
				initial={{
					entryId: "Status-Check",
					name: "Status check",
					description: "Checks the status endpoint.",
					httpsDefinition: validDefinition(),
				}}
				onSubmit={async () => ({ problems: [] })}
				onSaved={() => {}}
			/>,
		);
		expect(screen.getByRole("button", { name: /^review$/i })).toBeDisabled();
	});
});
