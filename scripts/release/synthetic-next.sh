#!/usr/bin/env bash
# Turns a copy of the source tree into a synthetic next release, for the upgrade and rollback
# test before any later release exists:
#
#   synthetic-next.sh <tree> <current version> <next version> <pg-boss schema>
#
# It records <current version> as published at today's last migration and <pg-boss schema>
# (scripts/release/pgboss-schema.sh), adds one expand
# migration (a new nullable column), and gives <next version> a changelog section. Never run it
# on the real checkout.
set -euo pipefail
tree="${1:?tree}" current="${2:?current version}" next="${3:?next version}" pgboss="${4:?pg-boss schema}"
migrations="$tree/packages/db/migrations"
head="$(jq -r '.entries[-1].tag' "$migrations/meta/_journal.json")"
tag="9999_synthetic_next_release"
echo 'ALTER TABLE "agents" ADD COLUMN "synthetic_next_release_note" text;' >"$migrations/$tag.sql"
jq --arg tag "$tag" '.entries += [.entries[-1] + {idx: (.entries[-1].idx + 1), when: (.entries[-1].when + 1000), tag: $tag}]' \
	"$migrations/meta/_journal.json" >"$migrations/meta/_journal.json.new"
mv "$migrations/meta/_journal.json.new" "$migrations/meta/_journal.json"
jq --arg tag "$tag" --arg current "$current" --arg head "$head" --argjson pgboss "$pgboss" '
	.migrations[$tag] = "expand"
	| .releases = ([.releases[] | select(.version != $current)]
		+ [{version: $current, head: $head, pgboss_schema: $pgboss}])' \
	"$migrations/compatibility.json" >"$migrations/compatibility.json.new"
mv "$migrations/compatibility.json.new" "$migrations/compatibility.json"
printf '# Changelog\n\n## [%s]\n\n### Added\n\n- A synthetic expand migration for the rollback test.\n\n' "$next" |
	cat - <(tail -n +2 "$tree/CHANGELOG.md") >"$tree/CHANGELOG.md.new"
mv "$tree/CHANGELOG.md.new" "$tree/CHANGELOG.md"
