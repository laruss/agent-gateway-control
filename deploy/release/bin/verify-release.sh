#!/bin/sh
# Verifies an unpacked release bundle, after its archive was verified (INSTALL.md, step 1):
#
#   bin/verify-release.sh
#
#   1. every file of the bundle matches its SHA256SUMS;
#   2. every image in images.lock carries a build provenance attestation from this repository's
#      release workflow at the bundle's tag (needs the gh CLI);
#   3. every image's index lists exactly the platform manifests images.lock names (needs Docker).
set -eu
cd "$(dirname -- "$0")/.."
repo=laruss/agent-gateway-control
workflow="$repo/.github/workflows/release.yml"
version=$(jq -r .release images.lock)
sha256sum --check --strict --quiet SHA256SUMS
echo "bundle files: match SHA256SUMS"
for name in $(jq -r '.manifests | keys[]' images.lock); do
	ref=$(jq -r --arg n "$name" '.images[$n]' images.lock)
	gh attestation verify "oci://$ref" --repo "$repo" --signer-workflow "$workflow" \
		--source-ref "refs/tags/v$version" >/dev/null
	echo "$ref: attested by $workflow at v$version"
	docker manifest inspect "$ref" |
		jq -e --slurpfile lock images.lock --arg n "$name" \
			'[.manifests[] | {key: (.platform.os + "/" + .platform.architecture), value: .digest}]
				| from_entries == $lock[0].manifests[$n]' >/dev/null || {
		echo "$ref: the index does not list exactly the manifests in images.lock" >&2
		exit 1
	}
	echo "$ref: platforms $(jq -r --arg n "$name" '.manifests[$n] | keys | join(", ")' images.lock)"
done
echo "release v$version verified"
