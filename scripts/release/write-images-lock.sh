#!/usr/bin/env bash
# Writes images.lock: every image of a release by digest, and what each runtime image carries.
#
#   write-images-lock.sh <version> <commit> <images.json> > images.lock
#
# <images.json> is what make-index.sh wrote. Each release image is an index by digest
# (`images`), with the digest of every platform's manifest in it (`manifests`); a verifier
# checks that the index lists exactly these. PostgreSQL is pinned here too: Compose runs
# nothing by tag.
set -euo pipefail
version="${1:?version}" commit="${2:?commit}" images="${3:?images.json}"
platforms='["linux/amd64","linux/arm64"]'
jq -e --argjson platforms "$platforms" '
	(keys == ["gateway", "worker-codex"])
	and all(.[]; (.ref | test("@sha256:[0-9a-f]{64}$"))
		and (.platforms | keys == $platforms)
		and all(.platforms[]; test("^sha256:[0-9a-f]{64}$")))' "$images" >/dev/null || {
	echo "$images: every image needs an index by digest and a manifest for each of $platforms" >&2
	exit 2
}
jq --arg version "$version" --arg commit "$commit" --argjson platforms "$platforms" '{
	format: 2,
	release: $version,
	commit: $commit,
	platforms: $platforms,
	images: {
		gateway: .gateway.ref,
		"worker-codex": ."worker-codex".ref,
		postgres: "docker.io/library/postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"
	},
	manifests: {
		gateway: .gateway.platforms,
		"worker-codex": ."worker-codex".platforms
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
}' "$images"
