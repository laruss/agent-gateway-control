#!/usr/bin/env bash
# Prints the queue schema version of the pg-boss this checkout installed (after `bun install`):
# the version `gateway db migrate` creates, recorded per release in compatibility.json.
set -euo pipefail
root="$(cd "${1:-$(dirname "$0")/../..}" && pwd)"
mapfile -t manifests < <(find "$root/node_modules/.bun" -maxdepth 4 -path '*/pg-boss@*/node_modules/pg-boss/package.json')
if [[ "${#manifests[@]}" != 1 ]]; then
	echo "expected one installed pg-boss under $root, found ${#manifests[@]}" >&2
	exit 2
fi
jq -er '.pgboss.schema' "${manifests[0]}"
