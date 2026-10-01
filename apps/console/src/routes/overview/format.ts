// Shared formatting for the overview page: the same conventions the Gateway's own status
// surfaces use elsewhere (`fmt`, the em-dash for "nothing to show"), so a number or a missing
// value reads the same way it always has.

export const DASH = "—";

export function fmt(value: number): string {
	return value.toLocaleString("en-US");
}

export function numOrDash(value: number | null): string {
	return value === null ? DASH : fmt(value);
}

export function orDash(value: string | null): string {
	return value === null ? DASH : value;
}

export function formatTimestamp(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
