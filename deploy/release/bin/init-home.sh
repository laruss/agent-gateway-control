#!/bin/sh
# Prepares $GATEWAY_HOME for a first install: the directory layout, a random database password
# and the controller's database URL. Existing files are kept. Run it as root (it sets the
# owners the containers expect) on the Docker host.
set -eu
home=${GATEWAY_HOME:-/srv/agent-gateway}
umask 077
install -d -m 0755 "$home"
# The configuration holds no secret; the CLI container (uid 10001) reads it.
install -d -m 0755 "$home/config"
install -d -m 0700 -o 10001 -g 10001 "$home/backups"
install -d -m 0711 "$home/secrets"
for dir in controller worker-codex worker-claude-code worker-mock gmail tool-runner; do
	install -d -m 0700 -o 10001 -g 10001 "$home/secrets/$dir"
done
# ADR-026: the lifecycle provisioner's own writable directory, distinct from secrets/controller
# (operator-managed, read-only to the controller) — it generates and writes lifecycle-created
# agents' bot tokens here itself, at /run/bot-secrets.
install -d -m 0700 -o 10001 -g 10001 "$home/secrets/controller-bots"
# ADR-027: a custom HTTPS tool's own named secrets, file per alias — `gateway tools secret set`
# (uid 10001, through the CLI's /secrets mount) is the only writer; the tool runner mounts this
# read-only at /run/custom-tool-secrets.
install -d -m 0700 -o 10001 -g 10001 "$home/secrets/custom-tools"
install -d -m 0700 -o 70 -g 70 "$home/secrets/postgres"
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
# On an AppArmor host, the workers' profile (see apparmor/agent-gateway-worker), installed so it
# is loaded again at boot.
# Where the kernel mediates user namespaces (Ubuntu 23.10 and later), the profile also allows
# bubblewrap to create one; older parsers do not know the rule.
if [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = Y ]; then
	profile="$(dirname -- "$0")/../apparmor/agent-gateway-worker"
	if [ -e /sys/kernel/security/apparmor/features/namespaces/userns_create ]; then
		sed 's/^  # @userns@$/  userns,/' "$profile" >/etc/apparmor.d/agent-gateway-worker
	else
		sed '/^  # @userns@$/d' "$profile" >/etc/apparmor.d/agent-gateway-worker
	fi
	chmod 0644 /etc/apparmor.d/agent-gateway-worker
	apparmor_parser -r /etc/apparmor.d/agent-gateway-worker
	echo "loaded the AppArmor profile agent-gateway-worker"
fi
echo "prepared $home"
