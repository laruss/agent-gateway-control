// @vitest-environment happy-dom
import type {
	AgentPatch,
	ConsoleCommitResponse,
	ConsolePreviewResponse,
} from "@agent-gateway/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewChangesDialog } from "./review-dialog.tsx";

// ---------------------------------------------------------------------------
// `ReviewChangesDialog` against a mocked `fetch`, with each preview/commit response held back by a
// manually-resolved deferred promise — the two races this covers (an obsolete preview response
// overwriting a newer one, and a commit's own `onApplied` clearing edits made after the reviewed
// snapshot) both depend on controlling exactly when a request's response lands, not merely what it
// contains.
// ---------------------------------------------------------------------------

const AGENT_ID = "director";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function previewResponseFor(patch: AgentPatch): ConsolePreviewResponse {
	return {
		baseRevisionId: 7,
		baseHash: "a".repeat(64),
		newHash: "b".repeat(64),
		noop: false,
		problems: [],
		impact: patch.enabled === false ? ["disables the agent"] : [],
		diff: {
			agents: [
				{
					kind: "changed",
					agentId: AGENT_ID,
					fieldPaths: patch.displayName !== undefined ? ["display_name"] : [],
					rolePrompt: {
						changed: patch.rolePrompt !== undefined,
						beforeSize: 10,
						afterSize: patch.rolePrompt?.length ?? 10,
					},
				},
			],
			organizationFieldPaths: [],
			constitution: { changed: false, beforeSize: 0, afterSize: 0 },
			toolAttachments: [],
		},
	};
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

type PreviewCall = {
	patch: AgentPatch;
	signal: AbortSignal | null | undefined;
	resolve: (preview: ConsolePreviewResponse) => void;
};
type CommitCall = { patch: AgentPatch; resolve: (result: ConsoleCommitResponse) => void };

/** Every `/preview`/`/commit` request is held open until the test resolves it, in whatever order
 * it chooses — real concurrent requests resolve in arrival order only by coincidence, never by
 * guarantee. */
function stubFetch(): { previewCalls: PreviewCall[]; commitCalls: CommitCall[] } {
	const previewCalls: PreviewCall[] = [];
	const commitCalls: CommitCall[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			const path = new URL(input, "http://localhost").pathname;
			if (path === `/api/agents/${AGENT_ID}/preview` && method === "POST") {
				const body = JSON.parse(String(init?.body)) as { changes: AgentPatch };
				const { promise, resolve } = deferred<ConsolePreviewResponse>();
				previewCalls.push({ patch: body.changes, signal: init?.signal, resolve });
				return jsonResponse(await promise);
			}
			if (path === `/api/agents/${AGENT_ID}/commit` && method === "POST") {
				const body = JSON.parse(String(init?.body)) as { changes: AgentPatch };
				const { promise, resolve } = deferred<ConsoleCommitResponse>();
				commitCalls.push({ patch: body.changes, resolve });
				return jsonResponse(await promise);
			}
			throw new Error(`unexpected request: ${method} ${path}`);
		}),
	);
	return { previewCalls, commitCalls };
}

describe("ReviewChangesDialog", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("ignores an obsolete preview response that resolves after a newer one, and applies exactly the snapshot it showed", async () => {
		const { previewCalls, commitCalls } = stubFetch();
		const onApplied = vi.fn();
		const draftA: AgentPatch = { enabled: false };
		const draftB: AgentPatch = { rolePrompt: "Draft B's role prompt." };

		const { rerender } = render(
			<ReviewChangesDialog
				open
				onOpenChange={() => {}}
				agentId={AGENT_ID}
				baseRevisionId={7}
				draft={draftA}
				onApplied={onApplied}
				onReload={() => {}}
			/>,
		);
		await waitFor(() => expect(previewCalls).toHaveLength(1));
		expect(previewCalls[0]?.patch).toEqual(draftA);

		// Closed while its preview is still loading, edited, and reopened: two requests are now in
		// flight, the stale one (draft A) and the current one (draft B).
		rerender(
			<ReviewChangesDialog
				open={false}
				onOpenChange={() => {}}
				agentId={AGENT_ID}
				baseRevisionId={7}
				draft={draftA}
				onApplied={onApplied}
				onReload={() => {}}
			/>,
		);
		rerender(
			<ReviewChangesDialog
				open
				onOpenChange={() => {}}
				agentId={AGENT_ID}
				baseRevisionId={7}
				draft={draftB}
				onApplied={onApplied}
				onReload={() => {}}
			/>,
		);
		await waitFor(() => expect(previewCalls).toHaveLength(2));
		expect(previewCalls[1]?.patch).toEqual(draftB);
		expect(previewCalls[0]?.signal?.aborted).toBe(true);

		// The stale request's response arrives last, as a slow or merely reordered round trip
		// could in production.
		previewCalls[1]?.resolve(previewResponseFor(draftB));
		await screen.findByRole("button", { name: /^apply$/i });
		previewCalls[0]?.resolve(previewResponseFor(draftA));
		// Let the (obsolete) response's own promise continuation run, if the bug were present.
		await Promise.resolve();
		await Promise.resolve();

		// Draft A's preview carries an impact warning (`enabled: false`); draft B's does not. The
		// dialog must still be showing draft B's preview, not have been overwritten by A's.
		expect(screen.queryByText(/this changes what the agent can do/i)).not.toBeInTheDocument();
		const applyButton = screen.getByRole("button", { name: /^apply$/i });
		expect(applyButton).not.toBeDisabled();

		const user = userEvent.setup();
		await user.click(applyButton);
		await waitFor(() => expect(commitCalls).toHaveLength(1));
		// Committed draft B — the reviewed snapshot — never draft A, and never "whatever `draft`
		// happens to be now" (both are draft B at this point, but only because the race didn't
		// actually confuse the two; see the next test for a case where they differ).
		expect(commitCalls[0]?.patch).toEqual(draftB);
	});

	it("blocks dismissal while a commit is in flight, and commits exactly the reviewed snapshot even once the live draft has moved on", async () => {
		const { previewCalls, commitCalls } = stubFetch();
		const onApplied = vi.fn();
		const onOpenChange = vi.fn();
		const snapshot: AgentPatch = { rolePrompt: "The reviewed role prompt." };

		const { rerender } = render(
			<ReviewChangesDialog
				open
				onOpenChange={onOpenChange}
				agentId={AGENT_ID}
				baseRevisionId={7}
				draft={snapshot}
				onApplied={onApplied}
				onReload={() => {}}
			/>,
		);
		await waitFor(() => expect(previewCalls).toHaveLength(1));
		previewCalls[0]?.resolve(previewResponseFor(snapshot));

		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: /^apply$/i }));
		await screen.findByRole("button", { name: /applying/i });
		await waitFor(() => expect(commitCalls).toHaveLength(1));

		// Escape, an overlay click and the dialog's own Close button all funnel through
		// `onOpenChange` — exercising Escape here covers that path; dismissal must not go through
		// while the commit above is still in flight.
		await user.keyboard("{Escape}");
		expect(onOpenChange).not.toHaveBeenCalled();

		// The live `draft` prop moves on while the commit is still in flight (edited elsewhere, or
		// rebased by an unrelated reload) — the dialog is still showing the snapshot it already
		// committed, not this.
		rerender(
			<ReviewChangesDialog
				open
				onOpenChange={onOpenChange}
				agentId={AGENT_ID}
				baseRevisionId={7}
				draft={{ ...snapshot, displayName: "Edited during the commit" }}
				onApplied={onApplied}
				onReload={() => {}}
			/>,
		);

		commitCalls[0]?.resolve({
			revisionId: 8,
			hash: "c".repeat(64),
			noop: false,
			replayed: false,
			activeRevisionId: 8,
		});

		await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
		// Exactly the snapshot that was reviewed and submitted — not the live draft, which by now
		// also carries `displayName`.
		expect(onApplied).toHaveBeenCalledWith(8, snapshot);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
