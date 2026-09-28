#!/usr/bin/env bash
# Assembles the release bundle from this checkout and an images.lock:
#
#   scripts/release/assemble-bundle.sh <version> <images.lock> <sbom dir> <out dir>
#
# Writes to <out dir>:
#   agent-gateway-home-server-v<version>.tar.gz   the bundle (one directory, see INSTALL.md)
#   compose.yaml, images.lock, RELEASE_NOTES.md, MIGRATIONS.md, *.spdx.json
#                                                 the same files, for reading before download
#   SHA256SUMS                                    checksums of everything above
#
# The archive is reproducible: sorted entries, fixed owners and modes, timestamps from
# SOURCE_DATE_EPOCH (default: the commit time) and gzip without a name or time. Needs GNU tar,
# jq and bun.
set -euo pipefail

version="${1:?usage: assemble-bundle.sh <version> <images.lock> <sbom dir> <out dir>}"
lock="${2:?images.lock}"
sbom_dir="${3:?sbom dir}"
out="${4:?out dir}"
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
	echo "not a release version: $version" >&2
	exit 2
}
root="$(cd "$(dirname "$0")/../.." && pwd)"
epoch="${SOURCE_DATE_EPOCH:-$(git -C "$root" log -1 --format=%ct)}"
name="agent-gateway-home-server-v$version"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
bundle="$work/$name"
mkdir -p "$bundle" "$out"

[[ "$(jq -r .release "$lock")" == "$version" ]] || {
	echo "images.lock is for release $(jq -r .release "$lock"), not $version" >&2
	exit 2
}
image() {
	local ref
	ref="$(jq -er --arg key "$1" '.images[$key]' "$lock")"
	[[ "$ref" =~ @sha256:[0-9a-f]{64}$ ]] || {
		echo "images.lock: $1 is not pinned by digest: $ref" >&2
		exit 2
	}
	printf '%s' "$ref"
}

# The stack, with every image pinned by digest.
sed -e "s#@VERSION@#$version#g" \
	-e "s#@GATEWAY_IMAGE@#$(image gateway)#g" \
	-e "s#@WORKER_CODEX_IMAGE@#$(image worker-codex)#g" \
	-e "s#@POSTGRES_IMAGE@#$(image postgres)#g" \
	"$root/deploy/release/compose.yaml" >"$bundle/compose.yaml"
if grep -n '@[A-Z_]*@' "$bundle/compose.yaml"; then
	echo "compose.yaml has unfilled placeholders" >&2
	exit 2
fi
cp "$lock" "$bundle/images.lock"

# Operating files and documents.
cp -R "$root/deploy/release/bin" "$bundle/bin"
cp "$root/scripts/backup-gateway-db.sh" "$bundle/bin/"
cp -R "$root/deploy/release/runtimes" "$bundle/runtimes"
cp -R "$root/deploy/release/secrets.example" "$bundle/secrets.example"
cp "$root/deploy/release/gateway.env.example" "$root/deploy/release/compose.override.example.yaml" \
	"$root/deploy/release/INSTALL.md" "$root/deploy/release/UPGRADE.md" \
	"$root/deploy/release/ROLLBACK.md" "$bundle/"
mkdir -p "$bundle/seccomp" "$bundle/apparmor"
cp "$root/deploy/images/seccomp/worker-sandbox.json" "$bundle/seccomp/"
cp "$root/deploy/images/apparmor/agent-gateway-worker" "$bundle/apparmor/"
cp "$root/LICENSE" "$bundle/LICENSE"

# The example configuration, with its prompts where `--root /config` finds them.
mkdir -p "$bundle/config.example/prompts" "$bundle/schemas"
cp -R "$root/config/examples/." "$bundle/config.example/"
cp -R "$root/prompts/examples" "$bundle/config.example/prompts/examples"
cp "$root/config/schemas/organization.schema.json" "$root/config/schemas/agent.schema.json" \
	"$bundle/schemas/"

# Release notes: this version's section of the changelog.
awk -v version="$version" '
	$0 ~ "^## \\[" version "\\]" { printing = 1; print "# Agent Gateway " version; next }
	printing && /^## \[/ { exit }
	printing { print }
' "$root/CHANGELOG.md" >"$bundle/RELEASE_NOTES.md"
if [[ "$(wc -l <"$bundle/RELEASE_NOTES.md")" -lt 3 ]]; then
	# A candidate built before its release (CI) carries the unreleased changes.
	if [[ "${CANDIDATE:-}" != 1 ]]; then
		echo "CHANGELOG.md has no section for $version" >&2
		exit 2
	fi
	awk -v version="$version" '
		/^## \[Unreleased\]/ { printing = 1; print "# Agent Gateway " version " (candidate)"; next }
		printing && /^## \[/ { exit }
		printing { print }
	' "$root/CHANGELOG.md" >"$bundle/RELEASE_NOTES.md"
fi
(cd "$root" && bun scripts/release/migrations-report.ts "$version" "$(scripts/release/pgboss-schema.sh)") \
	>"$bundle/MIGRATIONS.md"

mkdir -p "$bundle/sbom"
cp "$sbom_dir"/*.spdx.json "$bundle/sbom/"

(cd "$bundle" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z |
	xargs -0 sha256sum >SHA256SUMS)

# Directories 0755, executables 0755, other files 0644; owned by root.
find "$bundle" -type d -exec chmod 0755 {} +
find "$bundle" -type f -exec chmod 0644 {} +
chmod 0755 "$bundle"/bin/*
tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner \
	--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
	-C "$work" -cf - "$name" | gzip -9n >"$out/$name.tar.gz"

cp "$bundle/compose.yaml" "$bundle/images.lock" "$bundle/RELEASE_NOTES.md" \
	"$bundle/MIGRATIONS.md" "$out/"
cp "$bundle"/sbom/*.spdx.json "$out/"
(cd "$out" && find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%P\0' | LC_ALL=C sort -z |
	xargs -0 sha256sum >SHA256SUMS)
echo "$out/$name.tar.gz"
