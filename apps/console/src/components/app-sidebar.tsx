import { Bot, LayoutDashboard, LogOut, Puzzle, Wrench } from "lucide-react";
import * as React from "react";
import { NavLink, useLocation } from "react-router";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useSession } from "@/lib/session-context";

const NAV_ITEMS = [
	{ to: "/", label: "Overview", icon: LayoutDashboard },
	{ to: "/agents", label: "Agents", icon: Bot },
	{ to: "/skills", label: "Skills", icon: Puzzle },
	{ to: "/tools", label: "Instruments & utils", icon: Wrench },
] as const;

export function AppSidebar(): React.ReactElement {
	const location = useLocation();
	const { signOut } = useSession();
	const [signingOut, setSigningOut] = React.useState(false);

	async function handleSignOut() {
		setSigningOut(true);
		try {
			await signOut();
		} finally {
			setSigningOut(false);
		}
	}

	return (
		<Sidebar collapsible="icon">
			<SidebarHeader>
				<div className="flex items-center gap-2 px-2 py-1">
					<span className="font-semibold">Agent Gateway</span>
				</div>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupLabel>Console</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu>
							{NAV_ITEMS.map((item) => (
								<SidebarMenuItem key={item.to}>
									<SidebarMenuButton
										asChild
										isActive={location.pathname === item.to}
										tooltip={item.label}
									>
										<NavLink to={item.to} end={item.to === "/"}>
											<item.icon />
											<span>{item.label}</span>
										</NavLink>
									</SidebarMenuButton>
								</SidebarMenuItem>
							))}
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							onClick={() => void handleSignOut()}
							disabled={signingOut}
							tooltip="Sign out"
						>
							<LogOut />
							<span>{signingOut ? "Signing out…" : "Sign out"}</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>
		</Sidebar>
	);
}
