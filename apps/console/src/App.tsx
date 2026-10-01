import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SessionProvider } from "@/lib/session-context";
import { OverviewPage } from "@/routes/overview-page";
import { PlaceholderPage } from "@/routes/placeholder-page";
import { ProtectedLayout } from "@/routes/protected-layout";
import { SignInPage } from "@/routes/sign-in-page";

const queryClient = new QueryClient({
	defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

export function App(): React.ReactElement {
	return (
		<QueryClientProvider client={queryClient}>
			<SessionProvider>
				<TooltipProvider>
					<BrowserRouter>
						<Routes>
							<Route path="/sign-in" element={<SignInPage />} />
							<Route element={<ProtectedLayout />}>
								<Route path="/" element={<OverviewPage />} />
								<Route
									path="/agents"
									element={
										<PlaceholderPage
											title="Agents"
											description="Manage the Gateway's agents from here."
										/>
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
