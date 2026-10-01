import type { ConsoleSnapshot } from "@agent-gateway/contracts";
import { useQuery } from "@tanstack/react-query";
import { fetchConsoleStatus } from "@/lib/api-client";
import { isUnauthorized, useSession } from "@/lib/session-context";

/** The console's own status refresh cycle (ADR-023/025): the same 15 s the controller's cache
 * and the old server-rendered page both used. TanStack Query is the right tool here over a bare
 * `fetch` wrapper precisely for this: `refetchInterval` gives the poll, and `isPending`/`isError`
 * /`data` already distinguish "first load", "a refresh failed but we still have the last good
 * snapshot" and "never loaded" the way the console's own stale/unavailable states need, without
 * this app re-implementing that state machine by hand. */
const STATUS_POLL_MS = 15_000;

export function useConsoleStatus() {
	const { state, reportUnauthorized } = useSession();
	return useQuery<ConsoleSnapshot>({
		queryKey: ["console-status"],
		queryFn: async () => {
			try {
				return await fetchConsoleStatus();
			} catch (error) {
				if (isUnauthorized(error)) {
					reportUnauthorized();
				}
				throw error;
			}
		},
		// Never polls before the session is actually confirmed signed-in: there is nothing to show
		// yet (the overview page only ever renders behind `ProtectedLayout`), and polling anyway
		// would spend a request per interval that could only ever come back 401.
		enabled: state.status === "signed-in",
		refetchInterval: STATUS_POLL_MS,
		refetchIntervalInBackground: false,
		// A snapshot that is merely stale is still shown (the server already marks it as such); a
		// query error here means the request itself failed (network, 401, 5xx outside the
		// documented 503 shape), which the overview page renders as its own distinct banner.
		retry: false,
	});
}
