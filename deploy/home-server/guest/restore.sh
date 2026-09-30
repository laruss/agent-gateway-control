#!/bin/bash
# Restores the whole home server from a decrypted backup archive (guest/backup.sh) into a VM
# prepared like the original: Docker running, and nothing of the stacks yet
# (docs/operations/home-server.md, "Restore").
#
#   ... | sudo /path/to/restore.sh [--rehearsal] -      # the plaintext archive on stdin
#
# The archive is the plaintext tar: decrypt it with `age -d -i <identity>` on the machine that
# holds the key and stream it in, so no plaintext copy of the secrets lands on a disk (a file
# path works too; delete that file afterwards). It refuses a VM that already has either stack. It restores, in order: the release bundle,
# $MATTERMOST_HOME and $GATEWAY_HOME with their secrets, Mattermost's database and files and
# Caddy's certificate authority, the Gateway's database and roles, and the Codex login. Then it
# starts both stacks and checks them.
#
# --rehearsal starts no runtime worker, connector or tool runner: a copy must not use the real
# runtime logins (a refreshed token would log the original out) or act on the outside world.
# Mattermost's push and email notifications are turned off (the copy has the real users), and
# the copy is marked as one ($GATEWAY_HOME/.rehearsal), which the failure drills require.
# Everything else, Mattermost included, runs, on this VM only.
set -euo pipefail
rehearsal=false
if [[ "${1:-}" == "--rehearsal" ]]; then
	rehearsal=true
	shift
fi
archive="${1:?usage: restore.sh [--rehearsal] <archive.tar | ->}"
gateway_home="${GATEWAY_HOME:-/srv/agent-gateway}"
mattermost_home="${MATTERMOST_HOME:-/srv/mattermost}"
mattermost_project="${MATTERMOST_PROJECT:-agent-gateway-mattermost}"
kit="${HOME_SERVER_KIT:-/srv/home-server}"
tar_image="${BACKUP_TAR_IMAGE:-docker.io/library/caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b}"
[[ "$(id -u)" == 0 ]] || { echo "run it with sudo" >&2; exit 1; }
operator="${SUDO_USER:?run it with sudo, as the user who runs docker compose}"
started=$(date +%s)
step() { printf '\n== %s (%ss)\n' "$*" "$(($(date +%s) - started))"; }
quiet() { grep -v " Container \| Network \| Volume " || true; }

if docker volume ls -q | grep -qE "^(agent-gateway-|${mattermost_project}_)" ||
	[[ -n "$(docker ps -aq --filter "name=agent-gateway")" ]]; then
	echo "this VM already has a Gateway or Mattermost stack: restore only into an empty one" >&2
	exit 1
fi
# Private to root (mktemp makes it 0700): the unpacked archive holds every secret.
work="$(mktemp -d /var/tmp/restore.XXXXXX)"
trap 'rm -rf "$work"' EXIT
step "unpack and verify"
tar -C "$work" -xf "$archive"
(cd "$work" && sha256sum --check --strict --quiet SHA256SUMS)
bundle="$(find "$work/release" -mindepth 1 -maxdepth 1 -type d | head -1)"
[[ -n "$bundle" ]] || { echo "the archive holds no release" >&2; exit 1; }
(cd "$bundle" && sha256sum --check --strict --quiet SHA256SUMS)

step "release and home directories"
name="$(basename "$bundle")"
install -d -m 0755 "$gateway_home/releases" "$mattermost_home"
rm -rf "$gateway_home/releases/$name"
cp -a "$bundle" "$gateway_home/releases/$name"
tar -C "$gateway_home" -xpf "$work/gateway/home.tar"
ln -sfn "releases/$name" "$gateway_home/current"
tar -C "$mattermost_home" -xpf "$work/mattermost/home.tar"
chown "$operator" "$mattermost_home/secrets/database.env"
install -d -m 0755 "$kit"
cp -R "$gateway_home/current/home-server/." "$kit/"
if [[ "$rehearsal" == true ]]; then
	sed -i 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=/' "$gateway_home/gateway.env"
	grep -qx 'COMPOSE_PROFILES=' "$gateway_home/gateway.env" ||
		echo 'COMPOSE_PROFILES=' >>"$gateway_home/gateway.env"
	# An override could still add a service: none may run on this copy.
	rm -f "$gateway_home/compose.override.yaml"
	touch "$gateway_home/.rehearsal"
fi

# A named volume filled from its tar, created empty first: its name, its Compose project and its
# key in that project's Compose file (labelled as Compose labels its own, so the stack adopts it).
volume_restore() {
	docker volume create --label "com.docker.compose.project=$2" \
		--label "com.docker.compose.volume=$3" "$1" >/dev/null
	docker run --rm --network none -i -v "$1:/volume" --entrypoint tar "$tar_image" -C /volume -xf - <"$4"
}

step "Mattermost: database, files, certificate authority"
export MATTERMOST_HOME="$mattermost_home"
mm_compose() {
	sudo -u "$operator" docker compose --project-name "$mattermost_project" \
		--env-file "$mattermost_home/mattermost.env" -f "$kit/mattermost/compose.yaml" "$@"
}
for volume in mattermost-config mattermost-data caddy-data; do
	volume_restore "${mattermost_project}_$volume" "$mattermost_project" "$volume" \
		"$work/mattermost/$volume.tar"
done
mm_compose up -d --wait postgres 2>&1 | quiet
docker exec -i "$mattermost_project-postgres-1" \
	pg_restore -U mattermost -d mattermost --no-owner --exit-on-error <"$work/mattermost/mattermost.dump"
mm_compose up -d --wait 2>&1 | quiet
if [[ "$rehearsal" == true ]]; then
	for setting in EmailSettings.SendPushNotifications EmailSettings.SendEmailNotifications \
		ServiceSettings.EnableOutgoingWebhooks; do
		docker exec "$mattermost_project-mattermost-1" /mattermost/bin/mmctl --local config set "$setting" false >/dev/null
	done
fi

step "Gateway: database, roles, Codex login"
export GATEWAY_HOME="$gateway_home"
agw="$gateway_home/current/bin/agw"
if [[ -f "$work/gateway/codex-home.tar" ]]; then
	volume_restore agent-gateway-codex-home agent-gateway codex-home "$work/gateway/codex-home.tar"
else
	echo "no Codex login in the backup"
fi
GATEWAY_HOME="$gateway_home" "$gateway_home/current/bin/init-home.sh" | tail -1
sudo -u "$operator" GATEWAY_HOME="$gateway_home" "$agw" up -d --wait gateway-postgres 2>&1 | quiet
dump="$(ls "$work"/gateway/gateway-*.dump | head -1)"
gw_psql() { docker exec -i agent-gateway-gateway-postgres-1 psql -U gateway -d gateway -v ON_ERROR_STOP=1 -q "$@"; }
# The limited roles live in the cluster, not the database, and the dump's grants and policies
# name them: each is made first (without a login), then given a new password by
# `db create-role`, which sends a SCRAM verifier and rewrites the service's URL. The dump's
# privileges are restored as they were: the revocations from PUBLIC of the tool broker's
# functions among them.
for role in $(docker exec -i agent-gateway-gateway-postgres-1 pg_restore -f - --schema-only <"$dump" |
	sed -nE -e 's/^(GRANT|CREATE POLICY) .* TO ([a-z_][a-z0-9_]*)( .*|;)$/\2/p' \
		-e 's/^REVOKE .* FROM ([a-z_][a-z0-9_]*);$/\1/p' |
	grep -vx -e gateway -e public | sort -u); do
	gw_psql -v role="$role" <<'SQL'
select format('create role %I nologin', :'role') where not exists (select from pg_roles where rolname = :'role') \gexec
SQL
done
docker exec -i agent-gateway-gateway-postgres-1 \
	pg_restore -U gateway -d gateway --no-owner --exit-on-error <"$dump"
for url_file in "$gateway_home"/secrets/*/database_url; do
	service="$(basename "$(dirname "$url_file")")"
	role="$(sed -nE 's#^postgres://([^:@]+).*#\1#p' "$url_file")"
	# The owner's URL (controller, Gmail) needs no role of its own.
	if [[ -z "$role" || "$role" == gateway ]]; then
		continue
	fi
	sudo -u "$operator" GATEWAY_HOME="$gateway_home" "$agw" run --rm -T gateway-cli \
		gateway db create-role "$role" "/secrets/$service/database_url" 2>&1 | quiet
	case "$service" in
	worker-*)
		sudo -u "$operator" GATEWAY_HOME="$gateway_home" "$agw" run --rm -T gateway-cli \
			gateway db grant-worker "$role" "${service#worker-}" 2>&1 | quiet
		;;
	*)
		echo "role $role ($service): grant it again as at install (e.g. db grant-tool-runner $role <namespace>)"
		;;
	esac
done

step "start and check"
sudo -u "$operator" GATEWAY_HOME="$gateway_home" "$agw" up -d --wait 2>&1 | quiet
sudo -u "$operator" GATEWAY_HOME="$gateway_home" "$agw" run --rm -T gateway-cli gateway db status 2>&1 | quiet
# In a rehearsal the runtimes have no worker on purpose: the doctor names them, and that is all.
{ sudo -u "$operator" GATEWAY_HOME="$gateway_home" "$agw" run --rm -T gateway-cli gateway doctor 2>&1 || true; } |
	quiet | jq -c '{failing: [.. | objects | select(has("ok") and has("name")) | select(.ok == false) | .name]}'
docker exec agent-gateway-gateway-postgres-1 psql -U gateway -d gateway -At \
	-c "select 'events', count(*) from events union all select 'runs', count(*) from agent_runs"
docker exec "$mattermost_project-mattermost-1" /mattermost/bin/mmctl --local system status 2>&1 | tail -1
step "restored"
