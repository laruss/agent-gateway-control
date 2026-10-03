import type {
	CustomHttpMethod,
	CustomHttpsDefinition,
	CustomParamSlot,
	CustomToolParam,
	CustomToolSecretSlot,
} from "@agent-gateway/contracts";
import { CUSTOM_HTTP_METHODS, CUSTOM_PARAM_SLOTS } from "@agent-gateway/contracts";
import { Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { TagListInput } from "@/components/tag-list-input";
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
import { clientSideDefinitionProblems, customHttpMethodWrites } from "./custom-tool-validation.ts";

const EMPTY_DEFINITION: CustomHttpsDefinition = {
	host: "",
	pathTemplate: "/",
	method: "GET",
	parameters: [],
	secretSlots: [],
	idempotency: null,
	responseLimits: {
		maxResponseBytes: 65_536,
		allowedContentTypes: ["application/json"],
		timeoutMs: 10_000,
		includeBodyPreview: true,
	},
};

export type CustomToolFormValue = Readonly<{
	entryId: string;
	name: string;
	description: string;
	httpsDefinition: CustomHttpsDefinition;
}>;

export type CustomToolDialogProps = Readonly<{
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mode: "create" | "edit";
	initial?: CustomToolFormValue;
	onSubmit: (value: CustomToolFormValue) => Promise<Readonly<{ problems: Readonly<string[]> }>>;
	onSaved: () => void;
}>;

function newParam(): CustomToolParam {
	return { name: "", slot: "query", slotName: "", type: "string", minLength: 0, maxLength: 200 };
}

function newSecret(): CustomToolSecretSlot {
	return { alias: "", slot: "header", slotName: "" };
}

function ParamEditor({
	parameters,
	onChange,
	disabled,
}: Readonly<{
	parameters: Readonly<CustomToolParam[]>;
	onChange: (next: CustomToolParam[]) => void;
	disabled: boolean;
}>): React.ReactElement {
	function update(index: number, patch: Partial<CustomToolParam>) {
		onChange(
			parameters.map((param, i) =>
				i === index ? ({ ...param, ...patch } as CustomToolParam) : param,
			),
		);
	}
	function setType(index: number, type: CustomToolParam["type"]) {
		const current = parameters[index];
		if (current === undefined) {
			return;
		}
		const base = { name: current.name, slot: current.slot, slotName: current.slotName };
		const next: CustomToolParam =
			type === "string"
				? { ...base, type: "string", minLength: 0, maxLength: 200 }
				: type === "number"
					? { ...base, type: "number" }
					: type === "boolean"
						? { ...base, type: "boolean" }
						: { ...base, type: "enum", values: [""] };
		onChange(parameters.map((param, i) => (i === index ? next : param)));
	}
	return (
		<div className="flex flex-col gap-3">
			{parameters.map((param, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id of their own yet
				<div key={index} className="flex flex-col gap-2 rounded-lg border border-input p-3">
					<div className="grid grid-cols-4 gap-2">
						<div className="flex flex-col gap-1">
							<Label className="text-xs">Name</Label>
							<Input
								value={param.name}
								onChange={(e) => update(index, { name: e.target.value })}
								placeholder="amount"
								disabled={disabled}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label className="text-xs">Slot</Label>
							<Select
								value={param.slot}
								onValueChange={(value) => update(index, { slot: value as CustomParamSlot })}
								disabled={disabled}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CUSTOM_PARAM_SLOTS.map((slot) => (
										<SelectItem key={slot} value={slot}>
											{slot}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1">
							<Label className="text-xs">Slot name</Label>
							<Input
								value={param.slotName}
								onChange={(e) => update(index, { slotName: e.target.value })}
								placeholder="x-recipient"
								disabled={disabled}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label className="text-xs">Type</Label>
							<Select
								value={param.type}
								onValueChange={(value) => setType(index, value as CustomToolParam["type"])}
								disabled={disabled}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="string">string</SelectItem>
									<SelectItem value="number">number</SelectItem>
									<SelectItem value="boolean">boolean</SelectItem>
									<SelectItem value="enum">enum</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</div>
					{param.type === "string" && (
						<div className="grid grid-cols-2 gap-2">
							<div className="flex flex-col gap-1">
								<Label className="text-xs">Min length</Label>
								<Input
									type="number"
									value={param.minLength}
									onChange={(e) => update(index, { minLength: Number(e.target.value) })}
									disabled={disabled}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label className="text-xs">Max length</Label>
								<Input
									type="number"
									value={param.maxLength}
									onChange={(e) => update(index, { maxLength: Number(e.target.value) })}
									disabled={disabled}
								/>
							</div>
						</div>
					)}
					{param.type === "number" && (
						<div className="grid grid-cols-2 gap-2">
							<div className="flex flex-col gap-1">
								<Label className="text-xs">Minimum (optional)</Label>
								<Input
									type="number"
									value={param.minimum ?? ""}
									onChange={(e) =>
										update(index, {
											minimum: e.target.value.length === 0 ? undefined : Number(e.target.value),
										})
									}
									disabled={disabled}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label className="text-xs">Maximum (optional)</Label>
								<Input
									type="number"
									value={param.maximum ?? ""}
									onChange={(e) =>
										update(index, {
											maximum: e.target.value.length === 0 ? undefined : Number(e.target.value),
										})
									}
									disabled={disabled}
								/>
							</div>
						</div>
					)}
					{param.type === "enum" && (
						<div className="flex flex-col gap-1">
							<Label className="text-xs">Values (comma-separated)</Label>
							<Input
								value={param.values.join(",")}
								onChange={(e) =>
									update(index, {
										values: e.target.value
											.split(",")
											.map((v) => v.trim())
											.filter((v) => v.length > 0),
									})
								}
								disabled={disabled}
							/>
						</div>
					)}
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="w-fit text-destructive"
						disabled={disabled}
						onClick={() => onChange(parameters.filter((_, i) => i !== index))}
					>
						<Trash2 /> Remove parameter
					</Button>
				</div>
			))}
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="w-fit"
				disabled={disabled}
				onClick={() => onChange([...parameters, newParam()])}
			>
				<Plus /> Add parameter
			</Button>
		</div>
	);
}

function SecretEditor({
	secretSlots,
	onChange,
	disabled,
}: Readonly<{
	secretSlots: Readonly<CustomToolSecretSlot[]>;
	onChange: (next: CustomToolSecretSlot[]) => void;
	disabled: boolean;
}>): React.ReactElement {
	function update(index: number, patch: Partial<CustomToolSecretSlot>) {
		onChange(secretSlots.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)));
	}
	return (
		<div className="flex flex-col gap-2">
			{secretSlots.map((slot, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id of their own yet
				<div key={index} className="grid grid-cols-4 items-end gap-2">
					<div className="flex flex-col gap-1">
						<Label className="text-xs">Alias</Label>
						<Input
							value={slot.alias}
							onChange={(e) => update(index, { alias: e.target.value })}
							placeholder="payment_api_key"
							className="font-mono"
							disabled={disabled}
						/>
					</div>
					<div className="flex flex-col gap-1">
						<Label className="text-xs">Slot</Label>
						<Select
							value={slot.slot}
							onValueChange={(value) => update(index, { slot: value as CustomParamSlot })}
							disabled={disabled}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{CUSTOM_PARAM_SLOTS.filter((s) => s !== "path").map((s) => (
									<SelectItem key={s} value={s}>
										{s}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-1">
						<Label className="text-xs">Slot name</Label>
						<Input
							value={slot.slotName}
							onChange={(e) => update(index, { slotName: e.target.value })}
							placeholder="x-api-key"
							disabled={disabled}
						/>
					</div>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="text-destructive"
						disabled={disabled}
						onClick={() => onChange(secretSlots.filter((_, i) => i !== index))}
					>
						<Trash2 />
					</Button>
				</div>
			))}
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="w-fit"
				disabled={disabled}
				onClick={() => onChange([...secretSlots, newSecret()])}
			>
				<Plus /> Add secret alias
			</Button>
		</div>
	);
}

/**
 * Create/edit dialog for a `custom_https` catalog entry (ADR-027): every field the definition
 * needs, client-side validation mirroring the contract (`customHttpsDefinitionProblems`, run
 * directly — not reimplemented) gating a "Review" step that shows exactly what will be sent before
 * the actual create/edit request goes out. `mode: "edit"` locks the entry id (immutable once
 * created) and `name`/`description` stay editable for every kind, but only a `custom_https` entry's
 * own `httpsDefinition` may change here — a built-in never reaches this dialog at all (the entry
 * detail page offers only a metadata-only edit for one, `builtin-edit-dialog.tsx`).
 */
export function CustomToolDialog({
	open,
	onOpenChange,
	mode,
	initial,
	onSubmit,
	onSaved,
}: CustomToolDialogProps): React.ReactElement {
	const [entryId, setEntryId] = React.useState(initial?.entryId ?? "");
	const [name, setName] = React.useState(initial?.name ?? "");
	const [description, setDescription] = React.useState(initial?.description ?? "");
	const [definition, setDefinition] = React.useState<CustomHttpsDefinition>(
		initial?.httpsDefinition ?? EMPTY_DEFINITION,
	);
	const [phase, setPhase] = React.useState<"edit" | "review">("edit");
	const [submitting, setSubmitting] = React.useState(false);
	const [serverProblems, setServerProblems] = React.useState<Readonly<string[]>>([]);

	function reset() {
		setEntryId(initial?.entryId ?? "");
		setName(initial?.name ?? "");
		setDescription(initial?.description ?? "");
		setDefinition(initial?.httpsDefinition ?? EMPTY_DEFINITION);
		setPhase("edit");
		setServerProblems([]);
	}

	function handleOpenChange(next: boolean) {
		if (!next && submitting) {
			return;
		}
		onOpenChange(next);
		if (!next) {
			reset();
		}
	}

	const writes = customHttpMethodWrites(definition.method);
	const clientProblems = clientSideDefinitionProblems(definition);
	const basicsReady =
		entryId.trim().length > 0 && name.trim().length > 0 && description.trim().length > 0;
	const canReview = basicsReady && clientProblems.length === 0;

	async function confirm() {
		setSubmitting(true);
		setServerProblems([]);
		try {
			const result = await onSubmit({ entryId, name, description, httpsDefinition: definition });
			if (result.problems.length > 0) {
				setServerProblems(result.problems);
				return;
			}
			handleOpenChange(false);
			onSaved();
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="flex max-h-[90dvh] max-w-2xl flex-col overflow-y-auto">
				<DialogHeader>
					<DialogTitle>
						{mode === "create" ? "New custom HTTPS tool" : `Edit '${entryId}'`}
					</DialogTitle>
					<DialogDescription>
						A fixed destination and method, typed parameters mapped into encoded slots — never
						free-form script or shell interpolation. Every call runs through the broker's egress
						guard and always requires a human's approval.
					</DialogDescription>
				</DialogHeader>
				{phase === "edit" && (
					<div className="flex flex-col gap-4">
						<div className="grid grid-cols-2 gap-4">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="custom-tool-id">Entry id</Label>
								<Input
									id="custom-tool-id"
									value={entryId}
									onChange={(e) => setEntryId(e.target.value)}
									placeholder="ticketing-create"
									className="font-mono"
									disabled={mode === "edit" || submitting}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="custom-tool-name">Name</Label>
								<Input
									id="custom-tool-name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									disabled={submitting}
								/>
							</div>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="custom-tool-description">Description</Label>
							<Textarea
								id="custom-tool-description"
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								rows={2}
								disabled={submitting}
							/>
						</div>
						<div className="grid grid-cols-3 gap-4">
							<div className="col-span-2 flex flex-col gap-1.5">
								<Label htmlFor="custom-tool-host">Destination host</Label>
								<Input
									id="custom-tool-host"
									value={definition.host}
									onChange={(e) => setDefinition({ ...definition, host: e.target.value })}
									placeholder="api.example.com"
									className="font-mono"
									disabled={submitting}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="custom-tool-method">Method</Label>
								<Select
									value={definition.method}
									onValueChange={(value) =>
										setDefinition({
											...definition,
											method: value as CustomHttpMethod,
											idempotency:
												value === "GET"
													? null
													: (definition.idempotency ?? { headerName: "Idempotency-Key" }),
										})
									}
									disabled={submitting}
								>
									<SelectTrigger id="custom-tool-method">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{CUSTOM_HTTP_METHODS.map((method) => (
											<SelectItem key={method} value={method}>
												{method}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="custom-tool-path">Path template</Label>
							<Input
								id="custom-tool-path"
								value={definition.pathTemplate}
								onChange={(e) => setDefinition({ ...definition, pathTemplate: e.target.value })}
								placeholder="/tickets/{id}"
								className="font-mono"
								disabled={submitting}
							/>
							<p className="text-xs text-muted-foreground">
								Placeholders in curly braces (e.g. <code>{"{id}"}</code>) must each match exactly
								one path-slot parameter below.
							</p>
						</div>
						{writes && (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="custom-tool-idempotency">Idempotency header name</Label>
								<Input
									id="custom-tool-idempotency"
									value={definition.idempotency?.headerName ?? ""}
									onChange={(e) =>
										setDefinition({ ...definition, idempotency: { headerName: e.target.value } })
									}
									placeholder="Idempotency-Key"
									className="font-mono"
									disabled={submitting}
								/>
							</div>
						)}
						<div className="flex flex-col gap-2">
							<Label>Parameters</Label>
							<ParamEditor
								parameters={definition.parameters}
								onChange={(parameters) => setDefinition({ ...definition, parameters })}
								disabled={submitting}
							/>
						</div>
						<div className="flex flex-col gap-2">
							<Label>Secret aliases</Label>
							<p className="text-xs text-muted-foreground">
								A name only — setting its value is CLI-only (<code>gateway tools secret set</code>).
							</p>
							<SecretEditor
								secretSlots={definition.secretSlots}
								onChange={(secretSlots) => setDefinition({ ...definition, secretSlots })}
								disabled={submitting}
							/>
						</div>
						<div className="grid grid-cols-2 gap-4">
							<div className="flex flex-col gap-1.5">
								<Label>Allowed response content types</Label>
								<TagListInput
									value={definition.responseLimits.allowedContentTypes}
									onChange={(allowedContentTypes) =>
										setDefinition({
											...definition,
											responseLimits: { ...definition.responseLimits, allowedContentTypes },
										})
									}
									placeholder="application/json"
									disabled={submitting}
								/>
							</div>
							<div className="flex flex-col gap-3">
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="custom-tool-max-bytes">Max response bytes</Label>
									<Input
										id="custom-tool-max-bytes"
										type="number"
										value={definition.responseLimits.maxResponseBytes}
										onChange={(e) =>
											setDefinition({
												...definition,
												responseLimits: {
													...definition.responseLimits,
													maxResponseBytes: Number(e.target.value),
												},
											})
										}
										disabled={submitting}
									/>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="custom-tool-timeout">Timeout (ms)</Label>
									<Input
										id="custom-tool-timeout"
										type="number"
										value={definition.responseLimits.timeoutMs}
										onChange={(e) =>
											setDefinition({
												...definition,
												responseLimits: {
													...definition.responseLimits,
													timeoutMs: Number(e.target.value),
												},
											})
										}
										disabled={submitting}
									/>
								</div>
							</div>
						</div>
						<div className="flex items-center gap-3">
							<Switch
								id="custom-tool-body-preview"
								checked={definition.responseLimits.includeBodyPreview}
								onCheckedChange={(checked) =>
									setDefinition({
										...definition,
										responseLimits: { ...definition.responseLimits, includeBodyPreview: checked },
									})
								}
								disabled={submitting}
							/>
							<Label htmlFor="custom-tool-body-preview">
								Show a response body preview in the approval receipt
							</Label>
						</div>
						{clientProblems.length > 0 && (
							<ul className="list-inside list-disc text-sm text-destructive">
								{clientProblems.map((problem) => (
									<li key={problem}>{problem}</li>
								))}
							</ul>
						)}
					</div>
				)}
				{phase === "review" && (
					<div className="flex flex-col gap-3 text-sm">
						<p>
							<span className="font-medium">{name}</span>{" "}
							<span className="text-muted-foreground">({entryId})</span>
						</p>
						<p className="text-muted-foreground">{description}</p>
						<p className="font-mono">
							{definition.method} https://{definition.host}
							{definition.pathTemplate}
						</p>
						<p>
							{definition.parameters.length} parameter(s), {definition.secretSlots.length} secret
							alias(es)
							{definition.idempotency !== null &&
								`, idempotency header '${definition.idempotency.headerName}'`}
						</p>
						<p className="text-muted-foreground">
							Response limits: {definition.responseLimits.maxResponseBytes} bytes max,{" "}
							{definition.responseLimits.timeoutMs} ms timeout,{" "}
							{definition.responseLimits.allowedContentTypes.join(", ")}
						</p>
						{serverProblems.length > 0 && (
							<ul className="list-inside list-disc text-destructive">
								{serverProblems.map((problem) => (
									<li key={problem}>{problem}</li>
								))}
							</ul>
						)}
					</div>
				)}
				<DialogFooter>
					{phase === "edit" ? (
						<>
							<Button variant="outline" onClick={() => handleOpenChange(false)}>
								Cancel
							</Button>
							<Button disabled={!canReview} onClick={() => setPhase("review")}>
								Review
							</Button>
						</>
					) : (
						<>
							<Button variant="outline" onClick={() => setPhase("edit")} disabled={submitting}>
								Back
							</Button>
							<Button onClick={() => void confirm()} disabled={submitting}>
								{submitting ? "Saving…" : mode === "create" ? "Create" : "Save"}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
