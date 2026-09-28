#!/usr/bin/env bash
# Writes images.lock: every image of a release by digest, and what each runtime image carries.
#
#   write-images-lock.sh <version> <commit> <gateway ref> <worker-codex ref> > images.lock
#
# A ref is <repository>@sha256:<digest>. PostgreSQL is pinned here too: Compose runs nothing by
# tag.
set -euo pipefail
version="${1:?version}" commit="${2:?commit}" gateway="${3:?gateway ref}" codex="${4:?worker-codex ref}"
for ref in "$gateway" "$codex"; do
	[[ "$ref" =~ @sha256:[0-9a-f]{64}$ ]] || {
		echo "not pinned by digest: $ref" >&2
		exit 2
	}
done
jq -n --arg version "$version" --arg commit "$commit" --arg gateway "$gateway" --arg codex "$codex" '{
	format: 1,
	release: $version,
	commit: $commit,
	platform: "linux/amd64",
	images: {
		gateway: $gateway,
		"worker-codex": $codex,
		postgres: "docker.io/library/postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"
	},
	runtimes: {
		codex: {
			image: "worker-codex",
			version: "codex-cli/0.156.1",
			license: "Apache-2.0",
			source: "https://github.com/openai/codex/releases/tag/rust-v0.156.1"
		},
		"claude-code": {
			image: null,
			version: "claude-code/2.1.283",
			license: "proprietary: built by the operator (runtimes/claude-code)",
			source: "https://www.npmjs.com/package/@anthropic-ai/claude-code"
		}
	}
}'
