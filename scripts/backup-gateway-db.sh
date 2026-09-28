#!/usr/bin/env bash
# Backs up the Gateway database in the format `gateway backup check` verifies:
#   <dir>/gateway-<UTC time>.dump            pg_dump custom format
#   <dir>/gateway-<UTC time>.manifest.json   written last, only after the dump is complete
#
# Usage: DATABASE_URL=postgres://user@host:5432/gateway scripts/backup-gateway-db.sh <dir>
#
# Settings:
#   DATABASE_URL or DATABASE_URL_FILE  the database; a password in it is passed to the tools by
#                                      environment (PGPASSWORD), never on their command line.
#                                      A ~/.pgpass file (PGPASSFILE) works as well.
#   PG_DUMP, PSQL                      the commands to run (default: pg_dump, psql on the PATH),
#                                      e.g. "docker exec -i -e PGPASSWORD <container> pg_dump"
#                                      when the host's client tools are older than the server.
#
# The backup contains message content and approval parameters: encrypt it and copy it off the
# host (see docs/operations/backups.md). This script does neither.
set -euo pipefail

dir="${1:?usage: backup-gateway-db.sh <dir>}"
if [[ -n "${DATABASE_URL_FILE:-}" ]]; then
	url="$(<"$DATABASE_URL_FILE")"
else
	url="${DATABASE_URL:?DATABASE_URL or DATABASE_URL_FILE is required}"
fi
read -r -a pg_dump <<<"${PG_DUMP:-pg_dump}"
read -r -a psql <<<"${PSQL:-psql}"

# A password in the query string would reach the tools' command line: refuse it.
query_string="${url#*\?}"
[[ "$query_string" == "$url" ]] && query_string=""
query_string="${query_string//\\/\\\\}"
if [[ "$(printf '%b' "${query_string//%/\\x}" | tr '[:upper:]' '[:lower:]')" =~ (^|&)password= ]]; then
	echo "put the password in the URL's user info or a ~/.pgpass file, not in '?password='" >&2
	exit 2
fi

# Move a password out of the URL into PGPASSWORD (percent-decoded).
if [[ "$url" =~ ^([a-z]+://[^:/@]*):([^@/]*)@(.*)$ ]]; then
	password="${BASH_REMATCH[2]}"
	# Decode only %XX: a literal backslash stays one.
	password="${password//\\/\\\\}"
	PGPASSWORD="$(printf '%b' "${password//%/\\x}")"
	export PGPASSWORD
	url="${BASH_REMATCH[1]}@${BASH_REMATCH[3]}"
fi

mkdir -p "$dir"
umask 077

query() {
	"${psql[@]}" -X -A -t -q -v ON_ERROR_STOP=1 -d "$url" -c "$1"
}

sha256() {
	if command -v sha256sum >/dev/null; then
		sha256sum "$1" | cut -d' ' -f1
	else
		shasum -a 256 "$1" | cut -d' ' -f1
	fi
}

json_string() {
	local value="${1//\\/\\\\}"
	printf '"%s"' "${value//\"/\\\"}"
}

database="$(query "select current_database()")"
# pg_control_system() may be closed to the role: the identifier is then null.
system_identifier="$(query "select system_identifier::text from pg_control_system()" 2>/dev/null || true)"
migrations="$(query "select count(*) from drizzle.__drizzle_migrations")"
latest_hash="$(query "select hash from drizzle.__drizzle_migrations order by created_at desc, id desc limit 1")"
pg_dump_version="$("${pg_dump[@]}" --version)"

name="gateway-$(date -u +%Y%m%dT%H%M%SZ)"
partial="$dir/.$name.dump.partial"
trap 'rm -f "$partial" "$dir/.$name.manifest.partial"' EXIT

"${pg_dump[@]}" --format=custom --no-password --dbname "$url" >"$partial"
# A migration applied during the dump would leave the manifest describing another schema than
# the archive holds: refuse, and let the next scheduled run take a consistent backup.
if [[ "$(query "select count(*) from drizzle.__drizzle_migrations")" != "$migrations" ||
	"$(query "select hash from drizzle.__drizzle_migrations order by created_at desc, id desc limit 1")" != "$latest_hash" ]]; then
	echo "the schema changed while the backup ran; run it again" >&2
	exit 3
fi
size_bytes="$(wc -c <"$partial" | tr -d ' ')"
checksum="$(sha256 "$partial")"
mv "$partial" "$dir/$name.dump"
completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

{
	printf '{\n'
	printf '  "format": "agent-gateway-backup/1",\n'
	printf '  "database": %s,\n' "$(json_string "$database")"
	if [[ "$system_identifier" =~ ^[0-9]+$ ]]; then
		printf '  "system_identifier": "%s",\n' "$system_identifier"
	else
		printf '  "system_identifier": null,\n'
	fi
	printf '  "completed_at": "%s",\n' "$completed_at"
	if [[ -n "$latest_hash" ]]; then
		printf '  "schema_version": { "migrations": %s, "latest_hash": %s },\n' "$migrations" "$(json_string "$latest_hash")"
	else
		printf '  "schema_version": { "migrations": %s, "latest_hash": null },\n' "$migrations"
	fi
	printf '  "pg_dump_version": %s,\n' "$(json_string "$pg_dump_version")"
	printf '  "dump_file": "%s.dump",\n' "$name"
	printf '  "size_bytes": %s,\n' "$size_bytes"
	printf '  "sha256": "%s"\n' "$checksum"
	printf '}\n'
} >"$dir/.$name.manifest.partial"
mv "$dir/.$name.manifest.partial" "$dir/$name.manifest.json"
echo "$dir/$name.dump"
