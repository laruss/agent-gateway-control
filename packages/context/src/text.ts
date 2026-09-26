/** Marks text cut short by a context budget. */
export const TRUNCATION_MARK = " […]";

/**
 * Cuts `text` to at most `max` characters, marking the cut. Never splits a surrogate pair, so the
 * result stays well-formed Unicode.
 */
export function truncate(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	let end = Math.max(0, max - TRUNCATION_MARK.length);
	const code = text.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) {
		end -= 1;
	}
	return `${text.slice(0, end)}${TRUNCATION_MARK}`;
}
