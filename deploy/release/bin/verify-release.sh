#!/bin/sh
# Verifies an unpacked release bundle, after its archive was verified (INSTALL.md, step 1):
#
#   bin/verify-release.sh
#
#   1. every file of the bundle matches its SHA256SUMS;
#   2. every image in images.lock carries a build provenance attestation from this repository's
#      release workflow at the bundle's tag (needs the gh CLI).
set -eu
cd "$(dirname -- "$0")/.."
repo=laruss/agent-gateway-control
workflow="$repo/.github/workflows/release.yml"
version=$(jq -r .release images.lock)
sha256sum --check --strict --quiet SHA256SUMS
echo "bundle files: match SHA256SUMS"
for ref in $(jq -r '.images | to_entries[] | select(.key != "postgres") | .value' images.lock); do
	gh attestation verify "oci://$ref" --repo "$repo" --signer-workflow "$workflow" \
		--source-ref "refs/tags/v$version" >/dev/null
	echo "$ref: attested by $workflow at v$version"
done
echo "release v$version verified"
