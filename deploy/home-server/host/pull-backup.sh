#!/bin/bash
# Runs the VM's backup and copies the archive off the VM, onto the Mac
# (docs/operations/home-server.md). launchd runs it daily (io.agent-gateway.backup.plist):
#
#   deploy/home-server/host/pull-backup.sh
#
# The archive is encrypted in the VM; this side only moves it, checks that it arrived whole,
# and keeps the newest $BACKUP_KEEP (default 30) in $BACKUP_HOST_DIR (default ~/agw-backups).
# Exits non-zero when a step fails, so launchd's log and the missing archive both show it.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
instance="${LIMA_INSTANCE:-agw}"
dir="${BACKUP_HOST_DIR:-$HOME/agw-backups}"
keep="${BACKUP_KEEP:-30}"
mkdir -p -m 0700 "$dir"
# One run at a time (macOS has no flock): the lock is a directory, removed on exit.
mkdir "$dir/.lock" 2>/dev/null || { echo "another backup is running ($dir/.lock)" >&2; exit 1; }
trap 'rmdir "$dir/.lock"' EXIT

echo "$(date -u +%FT%TZ) backup of $instance"
archive="$(limactl shell "$instance" sudo /srv/home-server/guest/backup.sh | tail -1)"
[[ "$archive" == /srv/backups/home-server-*.tar.age ]] || { echo "unexpected archive: $archive" >&2; exit 1; }
remote_sum="$(limactl shell "$instance" sudo sha256sum "$archive" | cut -d' ' -f1)"
name="$(basename "$archive")"
limactl shell "$instance" sudo cat "$archive" >"$dir/$name.partial"
[[ "$(shasum -a 256 "$dir/$name.partial" | cut -d' ' -f1)" == "$remote_sum" ]] ||
	{ rm -f "$dir/$name.partial"; echo "$name: checksum mismatch" >&2; exit 1; }
mv "$dir/$name.partial" "$dir/$name"
chmod 0600 "$dir/$name"
ls -1t "$dir"/home-server-*.tar.age | tail -n +"$((keep + 1))" | while read -r old; do rm -f "$old"; done
echo "$(date -u +%FT%TZ) stored $dir/$name ($(du -h "$dir/$name" | cut -f1))"
