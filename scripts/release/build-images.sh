#!/usr/bin/env bash
# Builds the release images reproducibly and pushes them to a registry:
#
#   build-images.sh <version> <registry prefix> <out file> [<context dir>]
#
# e.g. build-images.sh 0.1.0 localhost:5000/laruss images.env. Writes `gateway=<ref>` and
# `worker-codex=<ref>` (by digest) to <out file>. Timestamps come from SOURCE_DATE_EPOCH (the
# commit time) and are rewritten in every layer; no provenance or SBOM is attached by BuildKit,
# so the digest depends only on the inputs (the release workflow attests them separately).
# Set BUILDER to use a given buildx builder, NO_CACHE=1 to build from scratch, and
# PLATFORM (default linux/amd64).
set -euo pipefail
version="${1:?usage: build-images.sh <version> <registry prefix> <out file> [<context>]}"
prefix="${2:?registry prefix}"
out="${3:?out file}"
context="${4:-$(cd "$(dirname "$0")/../.." && pwd)}"
commit="${GATEWAY_COMMIT:-$(git -C "$context" rev-parse HEAD)}"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$context" log -1 --format=%ct)}"
platform="${PLATFORM:-linux/amd64}"
builder=(${BUILDER:+--builder "$BUILDER"})
cache=()
[[ "${NO_CACHE:-}" == 1 ]] && cache=(--no-cache)
: >"$out"
for target in gateway worker-codex; do
	repository="$prefix/agent-gateway"
	[[ "$target" == gateway ]] || repository="$prefix/agent-gateway-$target"
	metadata="$(mktemp)"
	docker buildx build "${builder[@]}" "${cache[@]}" \
		--file "$context/deploy/images/Dockerfile" --target "$target" --platform "$platform" \
		--build-arg "GATEWAY_VERSION=$version" --build-arg "GATEWAY_COMMIT=$commit" \
		--build-arg SOURCE_DATE_EPOCH \
		--provenance=false --sbom=false \
		--output "type=image,name=$repository:$version,push=true,rewrite-timestamp=true,oci-mediatypes=true" \
		--metadata-file "$metadata" "$context"
	digest="$(jq -r '."containerimage.digest"' "$metadata")"
	rm -f "$metadata"
	echo "$target=$repository@$digest" >>"$out"
done
cat "$out"
