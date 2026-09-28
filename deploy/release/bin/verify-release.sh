#!/bin/sh
# Verifies a downloaded release before anything from it runs:
#
#   verify-release.sh <version> [dir]
#
# In <dir> (default: the current directory), with the release's assets downloaded
# (`gh release download v<version> -R laruss/agent-gateway-control`):
#   1. SHA256SUMS matches every asset;
#   2. GitHub's attestations prove the archive and SHA256SUMS were built by this repository's
#      release workflow from the tag v<version> (needs the gh CLI);
#   3. every image in images.lock carries a provenance attestation from that workflow.
set -eu
version="${1:?usage: verify-release.sh <version> [dir]}"
dir="${2:-.}"
repo=laruss/agent-gateway-control
workflow="$repo/.github/workflows/release.yml"
cd "$dir"
sha256sum --check --strict SHA256SUMS
for file in "agent-gateway-home-server-v$version.tar.gz" SHA256SUMS; do
	gh attestation verify "$file" --repo "$repo" --signer-workflow "$workflow" \
		--source-ref "refs/tags/v$version" >/dev/null
	echo "$file: attested by $workflow at v$version"
done
for ref in $(jq -r '.images | to_entries[] | select(.key != "postgres") | .value' images.lock); do
	gh attestation verify "oci://$ref" --repo "$repo" --signer-workflow "$workflow" \
		--source-ref "refs/tags/v$version" >/dev/null
	echo "$ref: attested"
done
echo "release v$version verified"
