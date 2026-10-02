import {
	AgentDisplayNameSchema,
	AgentIdSchema,
	RolePromptSchema,
	type RuntimeAdapterId,
} from "@agent-gateway/contracts";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, createAgent } from "@/lib/api-client";

/** The Runtime adapter `Select`'s own sentinel for "leave it unset": `requestAgentCreate` then
 * defaults the whole runtime from the deployment's Codex settings, never an empty string it would
 * otherwise have to parse as a real adapter id. */
const DEFAULT_RUNTIME = "__default__";

export type NewAgentDialogProps = Readonly<{
	open: boolean;
	onOpenChange: (open: boolean) => void;
	knownChannels: Readonly<string[]>;
	/** Adapters with a fresh, ready worker on this deployment — never the full static list: an
	 * unqualified one is exactly what `requestAgentCreate` itself would refuse. */
	knownRuntimeAdapters: Readonly<RuntimeAdapterId[]>;
	onCreated: (agentId: string) => void;
}>;

/**
 * "New agent" dialog (ADR-026): id, display name, allowed channels and the role prompt text,
 * plus an optional runtime adapter/model — everything `requestAgentCreate` needs beyond what it
 * already defaults itself (the bot username, which is always the agent id; its wake rule, a
 * mention in any of its own channels; concurrency; its private memory namespace). Creating an
 * agent here never creates a worker container and never touches Mattermost directly: it commits
 * the agent's configuration and queues a `create` operation for the controller's own provisioner,
 * which the agent page's progress view (`lifecycle-panel.tsx`) then follows.
 */
export function NewAgentDialog({
	open,
	onOpenChange,
	knownChannels,
	knownRuntimeAdapters,
	onCreated,
}: NewAgentDialogProps): React.ReactElement {
	const [id, setId] = React.useState("");
	const [displayName, setDisplayName] = React.useState("");
	const [channels, setChannels] = React.useState<Readonly<string[]>>([]);
	const [rolePrompt, setRolePrompt] = React.useState("");
	const [adapter, setAdapter] = React.useState(DEFAULT_RUNTIME);
	const [model, setModel] = React.useState("");
	const [idempotencyKey, setIdempotencyKey] = React.useState(() => crypto.randomUUID());
	const [submitting, setSubmitting] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	function reset() {
		setId("");
		setDisplayName("");
		setChannels([]);
		setRolePrompt("");
		setAdapter(DEFAULT_RUNTIME);
		setModel("");
		setIdempotencyKey(crypto.randomUUID());
		setError(null);
	}

	function handleOpenChange(next: boolean) {
		onOpenChange(next);
		if (!next) {
			reset();
		}
	}

	function toggleChannel(channel: string, allowed: boolean) {
		setChannels((current) =>
			allowed ? [...current, channel] : current.filter((c) => c !== channel),
		);
	}

	const idProblem =
		id.length === 0 || AgentIdSchema.safeParse(id).success
			? null
			: "lowercase letters, digits, inner '-' only";
	const displayNameProblem =
		displayName.length === 0 || AgentDisplayNameSchema.safeParse(displayName).success
			? null
			: "1-64 characters";
	const rolePromptReady = RolePromptSchema.safeParse(rolePrompt).success;
	const canSubmit =
		id.length > 0 &&
		idProblem === null &&
		displayName.length > 0 &&
		displayNameProblem === null &&
		rolePromptReady &&
		!submitting;

	async function submit() {
		if (!canSubmit) {
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const result = await createAgent({
				idempotencyKey,
				id,
				displayName,
				allowedChannels: [...channels],
				rolePrompt,
				...(adapter === DEFAULT_RUNTIME && model.trim().length === 0
					? {}
					: {
							runtime: {
								...(adapter === DEFAULT_RUNTIME ? {} : { adapter: adapter as RuntimeAdapterId }),
								...(model.trim().length === 0 ? {} : { model: model.trim() }),
							},
						}),
			});
			if (result.kind === "conflict") {
				setError(
					"The active configuration changed since this page was loaded. Close this dialog, reload the list and try again.",
				);
				return;
			}
			if (result.kind === "invalid") {
				setError(result.problems.join("; "));
				return;
			}
			toast.success(`Created '${result.agentId}'; its bot is being provisioned now.`);
			onCreated(result.agentId);
			handleOpenChange(false);
		} catch (caught) {
			setError(caught instanceof ApiError ? caught.message : "Could not create the agent.");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
				<DialogHeader>
					<DialogTitle>New agent</DialogTitle>
					<DialogDescription>
						Commits its configuration and starts the lifecycle provisioner: no bootstrap run, no
						worker container of its own.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="new-agent-id">Agent id</Label>
						<Input
							id="new-agent-id"
							value={id}
							onChange={(event) => setId(event.target.value)}
							placeholder="data-analyst"
							className="font-mono"
							disabled={submitting}
						/>
						{idProblem !== null && <p className="text-sm text-destructive">{idProblem}</p>}
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="new-agent-display-name">Display name</Label>
						<Input
							id="new-agent-display-name"
							value={displayName}
							onChange={(event) => setDisplayName(event.target.value)}
							placeholder="Data Analyst"
							disabled={submitting}
						/>
						{displayNameProblem !== null && (
							<p className="text-sm text-destructive">{displayNameProblem}</p>
						)}
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="new-agent-role-prompt">Role prompt</Label>
						<Textarea
							id="new-agent-role-prompt"
							value={rolePrompt}
							onChange={(event) => setRolePrompt(event.target.value)}
							rows={6}
							placeholder="You are ..."
							disabled={submitting}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label>Channels</Label>
						<div className="grid max-h-40 gap-2 overflow-y-auto">
							{knownChannels.map((channel) => (
								<div key={channel} className="flex items-center gap-3">
									<Switch
										id={`new-agent-channel-${channel}`}
										checked={channels.includes(channel)}
										onCheckedChange={(checked) => toggleChannel(channel, checked)}
										disabled={submitting}
									/>
									<Label htmlFor={`new-agent-channel-${channel}`} className="font-mono">
										{channel}
									</Label>
								</div>
							))}
							{knownChannels.length === 0 && (
								<p className="text-sm text-muted-foreground">
									No channels are configured for the organization.
								</p>
							)}
						</div>
					</div>
					<div className="grid grid-cols-2 gap-4">
						<div className="flex flex-col gap-1.5">
							<Label>Runtime adapter</Label>
							<Select value={adapter} onValueChange={setAdapter} disabled={submitting}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={DEFAULT_RUNTIME}>(deployment default)</SelectItem>
									{knownRuntimeAdapters.map((value) => (
										<SelectItem key={value} value={value}>
											{value}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="new-agent-model">Model</Label>
							<Input
								id="new-agent-model"
								value={model}
								onChange={(event) => setModel(event.target.value)}
								placeholder="(adapter default)"
								disabled={submitting}
							/>
						</div>
					</div>
					{error !== null && <p className="text-sm text-destructive">{error}</p>}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
						Cancel
					</Button>
					<Button onClick={() => void submit()} disabled={!canSubmit}>
						{submitting ? "Creating…" : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
