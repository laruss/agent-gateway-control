import type * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The Agents, Skills and Instruments & utils hubs: navigation and the page shell exist now, but
 * the data behind them is later work (this step only ports the status overview). An honest
 * "not available yet" state, never fabricated rows pretending the hub already has content.
 */
export function PlaceholderPage({
	title,
	description,
}: Readonly<{ title: string; description: string }>): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
				<CardDescription>{description}</CardDescription>
			</CardHeader>
			<CardContent>
				<p className="text-sm text-muted-foreground">Not available yet.</p>
			</CardContent>
		</Card>
	);
}
