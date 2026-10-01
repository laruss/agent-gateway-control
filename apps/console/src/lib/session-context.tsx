import * as React from "react";
import {
	ApiError,
	signIn as apiSignIn,
	signOut as apiSignOut,
	checkSession,
	type SignInOutcome,
} from "@/lib/api-client";

// ---------------------------------------------------------------------------
// Session state for the whole app (ADR-025): "loading" while recovering a possible session from
// the `__Host-gw_session` cookie on first load, "signed-out" otherwise, "signed-in" once
// `GET /api/session` or a successful sign-in says so. Any API call elsewhere in the app that
// hits a 401 reports it here (`reportUnauthorized`) so the whole app falls back to the sign-in
// screen together, instead of each query tracking its own copy of "am I still signed in".
// ---------------------------------------------------------------------------

type SessionState =
	| Readonly<{ status: "loading" }>
	| Readonly<{ status: "signed-out" }>
	| Readonly<{ status: "signed-in"; expiresAt: string }>;

type SessionContextValue = Readonly<{
	state: SessionState;
	signIn: (password: string) => Promise<SignInOutcome>;
	signOut: () => Promise<void>;
	/** Called by any other part of the app whose own request came back `401`. */
	reportUnauthorized: () => void;
}>;

const SessionContext = React.createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }): React.ReactElement {
	const [state, setState] = React.useState<SessionState>({ status: "loading" });

	React.useEffect(() => {
		let cancelled = false;
		checkSession()
			.then((check) => {
				if (cancelled) {
					return;
				}
				setState(
					check.authenticated
						? { status: "signed-in", expiresAt: check.expiresAt }
						: { status: "signed-out" },
				);
			})
			.catch(() => {
				if (!cancelled) {
					setState({ status: "signed-out" });
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const signIn = React.useCallback(async (password: string): Promise<SignInOutcome> => {
		const outcome = await apiSignIn(password);
		if (outcome.kind === "ok") {
			setState({ status: "signed-in", expiresAt: outcome.expiresAt });
		}
		return outcome;
	}, []);

	const signOut = React.useCallback(async (): Promise<void> => {
		try {
			await apiSignOut();
		} finally {
			setState({ status: "signed-out" });
		}
	}, []);

	const reportUnauthorized = React.useCallback(() => {
		setState((current) => (current.status === "signed-in" ? { status: "signed-out" } : current));
	}, []);

	const value = React.useMemo<SessionContextValue>(
		() => ({ state, signIn, signOut, reportUnauthorized }),
		[state, signIn, signOut, reportUnauthorized],
	);

	return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
	const value = React.useContext(SessionContext);
	if (value === null) {
		throw new Error("useSession must be used within a SessionProvider");
	}
	return value;
}

/** True when `error` is the specific, expected "this session is no longer valid" case, as
 * opposed to any other transport or server failure a query should still surface as an error. */
export function isUnauthorized(error: unknown): error is ApiError {
	return error instanceof ApiError && error.kind === "unauthorized";
}
