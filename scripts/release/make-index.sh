#!/usr/bin/env bash
# Joins the per-platform images of a release into one OCI index per image:
#
#   make-index.sh <version> <out images.json> <platform>=<images.env> [<platform>=<images.env> ...]
#
# e.g. make-index.sh 0.1.0 images.json linux/amd64=amd64.env linux/arm64=arm64.env, where each
# images.env is what build-images.sh wrote on that platform's runner. The first platform's
# repositories receive everything: the other platforms' manifests are copied there, digests
# unchanged, and the index is pushed as <repository>:<version>. The index is written from the
# manifests' digests alone, so the same platform images always give the same index digest.
# Writes <out images.json>:
#
#   {"gateway": {"ref": "<repository>@sha256:<index>",
#                "platforms": {"linux/amd64": "sha256:...", "linux/arm64": "sha256:..."}}, ...}
#
# The registries are local build registries, reached over plain HTTP. Needs curl, jq, skopeo.
set -euo pipefail
version="${1:?usage: make-index.sh <version> <out images.json> <platform>=<images.env> ...}"
out="${2:?out images.json}"
shift 2
[[ $# -ge 1 ]] || {
	echo "no platform images given" >&2
	exit 2
}
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

target_env="${1#*=}"
result='{}'
while IFS== read -r -u 3 name target_ref; do
	target_repository="${target_ref%@*}"
	registry="${target_repository%%/*}"
	path="${target_repository#*/}"
	descriptors='[]'
	platforms='{}'
	for spec in "$@"; do
		platform="${spec%%=*}"
		ref="$(grep "^$name=" "${spec#*=}" | cut -d= -f2)"
		[[ "$ref" =~ @sha256:[0-9a-f]{64}$ ]] || {
			echo "$platform: $name is not pinned by digest: $ref" >&2
			exit 2
		}
		digest="${ref#*@}"
		if [[ "${ref%@*}" != "$target_repository" ]]; then
			skopeo copy --quiet --preserve-digests --src-tls-verify=false --dest-tls-verify=false \
				"docker://$ref" "docker://$target_repository:$version-${platform#linux/}"
		fi
		headers="$(curl -fsSI \
			-H "accept: application/vnd.oci.image.manifest.v1+json" \
			"http://$registry/v2/$path/manifests/$digest" | tr -d '\r')"
		[[ "$(awk -F': ' 'tolower($1) == "docker-content-digest" { print $2 }' <<<"$headers")" == "$digest" ]] || {
			echo "$platform: $name is not $digest in $target_repository" >&2
			exit 1
		}
		media_type="$(awk -F': ' 'tolower($1) == "content-type" { print $2 }' <<<"$headers")"
		size="$(awk -F': ' 'tolower($1) == "content-length" { print $2 }' <<<"$headers")"
		descriptors="$(jq -c --arg m "$media_type" --arg d "$digest" --argjson s "$size" \
			--arg os "${platform%%/*}" --arg arch "${platform#*/}" \
			'. + [{mediaType: $m, digest: $d, size: $s, platform: {architecture: $arch, os: $os}}]' \
			<<<"$descriptors")"
		platforms="$(jq -c --arg p "$platform" --arg d "$digest" '. + {($p): $d}' <<<"$platforms")"
	done
	jq -cj '{schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: .}' \
		<<<"$descriptors" >"$work/$name.json"
	index="sha256:$(sha256sum "$work/$name.json" | cut -d' ' -f1)"
	pushed="$(curl -fsS -X PUT -o /dev/null -D - \
		-H "content-type: application/vnd.oci.image.index.v1+json" \
		--data-binary "@$work/$name.json" \
		"http://$registry/v2/$path/manifests/$version" | tr -d '\r' |
		awk -F': ' 'tolower($1) == "docker-content-digest" { print $2 }')"
	[[ "$pushed" == "$index" ]] || {
		echo "$name: the registry stored the index as $pushed, not $index" >&2
		exit 1
	}
	result="$(jq -c --arg n "$name" --arg r "$target_repository@$index" --argjson p "$platforms" \
		'. + {($n): {ref: $r, platforms: $p}}' <<<"$result")"
done 3<"$target_env"
jq . <<<"$result" | tee "$out"
