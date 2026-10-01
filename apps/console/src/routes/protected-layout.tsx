import type * as React from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session-context";

/**
 * Every page but sign-in lives behind this: while the session check is still in flight, nothing
 * is shown but a loading skeleton (never a flash of the sidebar or a page's own content before
 * the Gateway has said who, if anyone, is signed in); once it resolves, an unauthenticated
 * visitor is sent to `/sign-in`, keeping the page they asked for (its path and query, as one
 * string) as `state.from` — `SignInPage` reads it back to return here once signed in.
 */
export function ProtectedLayout(): React.ReactElement {
	const { state } = useSession();
	const location = useLocation();

	if (state.status === "loading") {
		return (
			<div className="flex min-h-svh flex-col gap-4 p-6">
				<Skeleton className="h-8 w-48" />
				<Skeleton className="h-32 w-full" />
				<Skeleton className="h-64 w-full" />
			</div>
		);
	}

	if (state.status === "signed-out") {
		const from = `${location.pathname}${location.search}`;
		return <Navigate to="/sign-in" state={{ from }} replace />;
	}

	return (
		<SidebarProvider>
			<AppSidebar />
			<SidebarInset>
				<header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
					<SidebarTrigger />
					<span className="font-medium">Agent Gateway Console</span>
				</header>
				<main className="flex-1 overflow-auto p-4 md:p-6">
					<Outlet />
				</main>
			</SidebarInset>
		</SidebarProvider>
	);
}
