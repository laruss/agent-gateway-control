import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SessionProvider } from "@/lib/session-context";
import { OverviewPage } from "@/routes/overview-page";
import { PlaceholderPage } from "@/routes/placeholder-page";
import { ProtectedLayout } from "@/routes/protected-layout";
import { SignInPage } from "@/routes/sign-in-page";

// The Agents hub is its own chunk (shadcn's tabs/select/dialog/scroll-area and this page's own
// several tab components add up): code-split, loaded only once a visitor actually opens it,
// rather than widening every other page's initial load.
const AgentsListPage = React.lazy(() =>
	import("@/routes/agents-list-page").then((m) => ({ default: m.AgentsListPage })),
);
const AgentDetailPage = React.lazy(() =>
	import("@/routes/agent-detail-page").then((m) => ({ default: m.AgentDetailPage })),
);

function LazyPageFallback(): React.ReactElement {
	return <div className="h-96 w-full animate-pulse rounded-lg bg-muted" />;
}

const queryClient = new QueryClient({
	defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

export function App(): React.ReactElement {
	return (
		<QueryClientProvider client={queryClient}>
			<SessionProvider>
				<TooltipProvider>
					<Toaster />
					<BrowserRouter>
						<Routes>
							<Route path="/sign-in" element={<SignInPage />} />
							<Route element={<ProtectedLayout />}>
								<Route path="/" element={<OverviewPage />} />
								<Route
									path="/agents"
									element={
										<React.Suspense fallback={<LazyPageFallback />}>
											<AgentsListPage />
										</React.Suspense>
									}
								/>
								<Route
									path="/agents/:agentId"
									element={
										<React.Suspense fallback={<LazyPageFallback />}>
											<AgentDetailPage />
										</React.Suspense>
									}
								/>
								<Route
									path="/skills"
									element={
										<PlaceholderPage
											title="Skills"
											description="Manage the Gateway's skills from here."
										/>
									}
								/>
								<Route
									path="/tools"
									element={
										<PlaceholderPage
											title="Instruments & utils"
											description="Manage the Gateway's tools and utilities from here."
										/>
									}
								/>
								<Route path="*" element={<Navigate to="/" replace />} />
							</Route>
						</Routes>
					</BrowserRouter>
				</TooltipProvider>
			</SessionProvider>
		</QueryClientProvider>
	);
}
