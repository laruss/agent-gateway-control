#!/bin/bash
# Backs up the whole home server into one encrypted archive (docs/operations/home-server.md):
#
#   sudo /srv/home-server/guest/backup.sh      # prints the archive's path
#
# The archive, $BACKUP_DIR/home-server-<UTC time>.tar.age, holds:
#   gateway/     the Gateway database (dump and manifest, checked with `gateway backup check`),
#                $GATEWAY_HOME without its backups, and the Codex login volume
#   mattermost/  Mattermost's database dump, its config and data volumes, $MATTERMOST_HOME and
#                Caddy's certificate authority
#   release/     the release bundle in use
# encrypted with age to the recipients in $BACKUP_RECIPIENTS: only the holder of a matching
# identity can read it, and that identity never lives on this host. The host's launchd job
# (host/pull-backup.sh) runs this and copies the archive off the VM. Settings come from
# /etc/agent-gateway/backup.env.
set -euo pipefail
[[ -r /etc/agent-gateway/backup.env ]] && source /etc/agent-gateway/backup.env
gateway_home="${GATEWAY_HOME:-/srv/agent-gateway}"
release="${GATEWAY_RELEASE:-$gateway_home/current}"
mattermost_home="${MATTERMOST_HOME:-/srv/mattermost}"
mattermost_project="${MATTERMOST_PROJECT:-agent-gateway-mattermost}"
backup_dir="${BACKUP_DIR:-/srv/backups}"
recipients="${BACKUP_RECIPIENTS:-/etc/agent-gateway/backup-recipients.txt}"
keep="${BACKUP_KEEP:-7}"
# Any small image with tar: the pinned Caddy image is already on the host.
tar_image="${BACKUP_TAR_IMAGE:-docker.io/library/caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b}"

[[ "$(id -u)" == 0 ]] || { echo "run it with sudo" >&2; exit 1; }
[[ -s "$recipients" ]] || { echo "no age recipients in $recipients" >&2; exit 1; }
command -v age >/dev/null || { echo "age is not installed (apt-get install age)" >&2; exit 1; }
install -d -m 0700 "$backup_dir"
exec 9>"$backup_dir/.lock"
flock -n 9 || { echo "another backup is running" >&2; exit 1; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d "$backup_dir/.work.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/gateway" "$work/mattermost" "$work/release"

# A named volume as a tar file, read-only.
volume_tar() {
	docker run --rm --network none -v "$1:/volume:ro" --entrypoint tar "$tar_image" \
		-C /volume -cf - . >"$2"
}

# The Gateway database, verified before it is archived.
export GATEWAY_HOME="$gateway_home"
"$release/bin/agw" run --rm -T gateway-cli backup-gateway-db.sh /backups >/dev/null
"$release/bin/agw" run --rm -T -e BACKUP_DIR=/backups gateway-cli \
	gateway backup check --record >"$work/gateway/backup-check.json"
manifest="$(ls -1t "$gateway_home"/backups/gateway-*.manifest.json | head -1)"
cp "$manifest" "${manifest%.manifest.json}.dump" "$work/gateway/"
# The dumps are in every archive; three stay in $GATEWAY_HOME/backups for `backup check`.
ls -1t "$gateway_home"/backups/gateway-*.manifest.json | tail -n +4 | while read -r old; do
	rm -f "$old" "${old%.manifest.json}.dump"
done
tar -C "$gateway_home" --exclude=./backups -cf "$work/gateway/home.tar" .
docker volume inspect agent-gateway-codex-home >/dev/null 2>&1 &&
	volume_tar agent-gateway-codex-home "$work/gateway/codex-home.tar"

# Mattermost: the database, then the files that must agree with it.
docker exec "$mattermost_project-postgres-1" \
	pg_dump -U mattermost -d mattermost --format=custom >"$work/mattermost/mattermost.dump"
for volume in mattermost-config mattermost-data caddy-data; do
	volume_tar "${mattermost_project}_$volume" "$work/mattermost/$volume.tar"
done
tar -C "$mattermost_home" -cf "$work/mattermost/home.tar" .

cp -a "$(readlink -f "$release")" "$work/release/"
(cd "$work" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum >SHA256SUMS)

archive="$backup_dir/home-server-$stamp.tar.age"
tar -C "$work" -cf - . | age --encrypt --recipients-file "$recipients" >"$archive.partial"
mv "$archive.partial" "$archive"
chmod 0600 "$archive"
# Only the newest $keep archives stay on the VM; the Mac keeps its own copies longer.
ls -1t "$backup_dir"/home-server-*.tar.age | tail -n +"$((keep + 1))" | xargs -r rm -f
echo "$archive"
