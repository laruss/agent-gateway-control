#!/bin/sh
# Prepares $GATEWAY_HOME for a first install: the directory layout, a random database password
# and the controller's database URL. Existing files are kept. Run it as root (it sets the
# owners the containers expect) on the Docker host.
set -eu
home=${GATEWAY_HOME:-/srv/agent-gateway}
umask 077
install -d -m 0755 "$home"
install -d -m 0750 "$home/config" "$home/backups"
install -d -m 0711 "$home/secrets"
for dir in controller worker-codex worker-claude-code worker-mock gmail tool-runner; do
	install -d -m 0700 -o 10001 -g 10001 "$home/secrets/$dir"
done
install -d -m 0700 -o 70 -g 70 "$home/secrets/postgres"
chown 10001:10001 "$home/backups"
password_file="$home/secrets/postgres/postgres_password"
if [ ! -s "$password_file" ]; then
	# 32 random bytes as hex: no characters that need escaping in a URL.
	od -An -N32 -tx1 /dev/urandom | tr -d ' \n' >"$password_file"
	chown 70:70 "$password_file"
	chmod 0600 "$password_file"
fi
url_file="$home/secrets/controller/database_url"
if [ ! -s "$url_file" ]; then
	printf 'postgres://gateway:%s@gateway-postgres:5432/gateway\n' "$(cat "$password_file")" >"$url_file"
	chown 10001:10001 "$url_file"
	chmod 0600 "$url_file"
fi
if [ ! -e "$home/gateway.env" ]; then
	sed "s#^GATEWAY_HOME=.*#GATEWAY_HOME=$home#" "$(dirname -- "$0")/../gateway.env.example" >"$home/gateway.env"
	chmod 0644 "$home/gateway.env"
fi
echo "prepared $home"
