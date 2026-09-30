#!/bin/sh
# Prepares $MATTERMOST_HOME for a first install: a random database password, the database URL
# Mattermost reads, and mattermost.env. Existing files are kept. Run it with sudo on the Docker
# host, as the user who runs `docker compose` (that user reads the URL file).
#
#   sudo MATTERMOST_HOME=/srv/mattermost ./init-mattermost.sh
set -eu
home=${MATTERMOST_HOME:-/srv/mattermost}
operator=${SUDO_USER:?run it with sudo, as the user who runs docker compose}
umask 077
install -d -m 0755 "$home"
install -d -m 0711 "$home/secrets"
install -d -m 0700 -o 70 -g 70 "$home/secrets/postgres"
password_file="$home/secrets/postgres/postgres_password"
if [ ! -s "$password_file" ]; then
	# 32 random bytes as hex: no characters that need escaping in a URL.
	od -An -N32 -tx1 /dev/urandom | tr -d ' \n' >"$password_file"
	chown 70:70 "$password_file"
	chmod 0600 "$password_file"
fi
# Compose reads this file on the client side and hands it to Mattermost's environment.
url_file="$home/secrets/database.env"
if [ ! -s "$url_file" ]; then
	printf 'MM_SQLSETTINGS_DATASOURCE=postgres://mattermost:%s@postgres:5432/mattermost?sslmode=disable&connect_timeout=10\n' \
		"$(cat "$password_file")" >"$url_file"
	chown "$operator" "$url_file"
	chmod 0600 "$url_file"
fi
if [ ! -e "$home/mattermost.env" ]; then
	sed "s#^MATTERMOST_HOME=.*#MATTERMOST_HOME=$home#" "$(dirname -- "$0")/mattermost.env.example" >"$home/mattermost.env"
	chmod 0644 "$home/mattermost.env"
fi
echo "prepared $home"
