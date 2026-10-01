import { AlertCircle } from "lucide-react";
import * as React from "react";
import { Navigate, useLocation } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, type SignInOutcome } from "@/lib/api-client";
import { useSession } from "@/lib/session-context";

function errorMessage(outcome: Exclude<SignInOutcome, { kind: "ok" }>): string {
	switch (outcome.kind) {
		case "invalid":
			return "Wrong password.";
		case "rate-limited":
			return outcome.retryAfterSeconds === null
				? "Too many attempts. Try again shortly."
				: `Too many attempts. Try again in ${outcome.retryAfterSeconds}s.`;
		case "busy":
			return "The console is busy verifying another sign-in. Try again in a moment.";
		case "forbidden":
			return "This page's origin does not match the console's configured origin.";
	}
}

export function SignInPage(): React.ReactElement {
	const { state, signIn } = useSession();
	const location = useLocation();
	const [password, setPassword] = React.useState("");
	const [error, setError] = React.useState<string | null>(null);
	const [submitting, setSubmitting] = React.useState(false);

	if (state.status === "signed-in") {
		const from = (location.state as { from?: string } | null)?.from ?? "/";
		return <Navigate to={from} replace />;
	}

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setSubmitting(true);
		setError(null);
		try {
			const outcome = await signIn(password);
			if (outcome.kind !== "ok") {
				setError(errorMessage(outcome));
			}
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : "Sign-in failed unexpectedly.");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<div className="flex min-h-svh items-center justify-center p-4">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle>Agent Gateway Console</CardTitle>
					<CardDescription>Sign in with the console password.</CardDescription>
				</CardHeader>
				<CardContent>
					<form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
						<div className="flex flex-col gap-2">
							<Label htmlFor="password">Password</Label>
							<Input
								id="password"
								name="password"
								type="password"
								autoComplete="current-password"
								autoFocus
								required
								value={password}
								onChange={(event) => setPassword(event.target.value)}
							/>
						</div>
						{error !== null && (
							<Alert variant="destructive">
								<AlertCircle />
								<AlertTitle>Sign-in failed</AlertTitle>
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						)}
						<Button type="submit" disabled={submitting || password.length === 0}>
							{submitting ? "Signing in…" : "Sign in"}
						</Button>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
