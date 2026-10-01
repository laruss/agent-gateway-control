import { X } from "lucide-react";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

/**
 * A bounded list of short tokens (tool patterns, channel names) edited as tags: type one, press
 * Enter or `,` to add it, click its badge's own `x` to remove it. `validate` is a quick,
 * client-side shape check only (the matching server-side schema is the one that actually decides
 * what commits); a rejected entry is never added, and its message is shown inline until the next
 * edit.
 */
export function TagListInput({
	value,
	onChange,
	placeholder,
	validate,
	disabled = false,
}: Readonly<{
	value: Readonly<string[]>;
	onChange: (next: string[]) => void;
	placeholder?: string;
	validate?: (candidate: string) => string | null;
	disabled?: boolean;
}>): React.ReactElement {
	const [draft, setDraft] = React.useState("");
	const [error, setError] = React.useState<string | null>(null);

	function commitDraft() {
		const candidate = draft.trim();
		if (candidate.length === 0) {
			return;
		}
		if (value.includes(candidate)) {
			setDraft("");
			setError(null);
			return;
		}
		const problem = validate?.(candidate) ?? null;
		if (problem !== null) {
			setError(problem);
			return;
		}
		onChange([...value, candidate]);
		setDraft("");
		setError(null);
	}

	function removeAt(index: number) {
		onChange(value.filter((_, i) => i !== index));
	}

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-input p-1.5">
				{value.map((tag, index) => (
					<Badge key={tag} variant="secondary" className="gap-1 font-mono">
						{tag}
						{!disabled && (
							<button
								type="button"
								aria-label={`remove ${tag}`}
								onClick={() => removeAt(index)}
								className="rounded-full hover:bg-muted-foreground/20"
							>
								<X className="size-3" />
							</button>
						)}
					</Badge>
				))}
				{!disabled && (
					<Input
						value={draft}
						placeholder={placeholder}
						onChange={(event) => {
							setDraft(event.target.value);
							setError(null);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === ",") {
								event.preventDefault();
								commitDraft();
							}
						}}
						onBlur={commitDraft}
						className="h-6 w-40 flex-1 border-none p-0 shadow-none focus-visible:ring-0"
					/>
				)}
			</div>
			{error !== null && <p className="text-xs text-destructive">{error}</p>}
		</div>
	);
}
