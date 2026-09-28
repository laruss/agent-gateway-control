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

const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The release this build is: `GATEWAY_VERSION` (`X.Y.Z`), or {@link DEVELOPMENT_VERSION} when
 * unset. Schema certificates name releases by it. Any other value is refused, so a mistyped
 * version never matches another release's certificate.
 */
export function releaseVersion(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	const version = env.GATEWAY_VERSION?.trim() || DEVELOPMENT_VERSION;
	if (!RELEASE_VERSION.test(version)) {
		throw new Error(`GATEWAY_VERSION '${version}' is not a release version (X.Y.Z)`);
	}
	return version;
}
