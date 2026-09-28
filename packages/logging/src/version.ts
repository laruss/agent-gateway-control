/** Reported when a build sets no `GATEWAY_VERSION`: a development checkout. */
export const DEVELOPMENT_VERSION = "0.0.0";

/**
 * The running build's version: `GATEWAY_VERSION` (set by release images), with `+<commit>`
 * from `GATEWAY_COMMIT` (its first 12 characters) when set.
 */
export function serviceVersion(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	const version = env.GATEWAY_VERSION?.trim() || DEVELOPMENT_VERSION;
	const commit = env.GATEWAY_COMMIT?.trim().slice(0, 12);
	return commit ? `${version}+${commit}` : version;
}
