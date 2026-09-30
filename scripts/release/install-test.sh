#!/usr/bin/env bash
# The release install test: installs a release bundle the way INSTALL.md describes, on a host
# with nothing but Docker, curl and jq (no checkout), and proves it works.
#
#   install-test.sh <bundle.tar.gz> [<next bundle.tar.gz>]
#
# With one bundle: install, bootstrap a throwaway Mattermost, smoke-test a mention on the mock
# runtime, and check every service's version, the containers' hardening and the Codex sandbox.
# Also validates the home server's Caddyfile (both site blocks, under the pinned Caddy image)
# and the owner's console wiring (ADR-023) in the rendered Compose config: no host port, the
# controller's console environment, and no worker or connector on the controller's network or
# holding its secrets. With a second bundle (the next release, whose migrations are
# expand-only): upgrade to it, smoke-test, roll back to the first bundle without a restore, and
# smoke-test again; no mention is answered twice.
#
# Needs root (or sudo) for the ownership of $GATEWAY_HOME, and the images of the bundles'
# images.lock reachable (a registry). Leaves the stacks running on failure for inspection;
# `install-test.sh --down` removes them.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="${INSTALL_TEST_DIR:-/tmp/agent-gateway-install-test}"
export GATEWAY_HOME="$work/home"
mm_url="http://127.0.0.1:8065"
sudo_cmd=()
[[ "$(id -u)" == 0 ]] || sudo_cmd=(sudo)

log() { printf '\n== %s\n' "$*"; }
fail() {
	printf 'FAILED: %s\n' "$*" >&2
	exit 1
}

mm_compose() { docker compose -f "$here/mattermost-test.compose.yaml" "$@"; }

if [[ "${1:-}" == "--down" ]]; then
	for release in "$work"/releases/*/; do
		[[ -x "$release/bin/agw" ]] && "$release/bin/agw" --profile '*' down --volumes --remove-orphans || true
	done
	mm_compose down --volumes --remove-orphans || true
	"${sudo_cmd[@]}" rm -rf "$work"
	exit 0
fi

first="${1:?usage: install-test.sh <bundle.tar.gz> [<next bundle.tar.gz>]}"
next="${2:-}"

# Unpacks a bundle into $work/releases/<version> after checking its own SHA256SUMS; prints the
# directory.
unpack() {
	local bundle="$1" dir
	mkdir -p "$work/releases"
	dir="$work/releases/$(basename "$bundle" .tar.gz)"
	rm -rf "$dir"
	tar -xzf "$bundle" -C "$work/releases"
	(cd "$dir" && sha256sum --check --strict --quiet SHA256SUMS) || fail "$bundle: SHA256SUMS"
	printf '%s' "$dir"
}

# --- Mattermost, as the operator prepares it before bootstrap ----------------------------------
mm_api() {
	local method="$1" path="$2" token="$3" body="${4:-}"
	curl -sS --fail-with-body -X "$method" "$mm_url/api/v4/$path" \
		-H "content-type: application/json" \
		${token:+-H "authorization: Bearer $token"} \
		${body:+--data "$body"}
}
mm_user() {
	local username="$1" password="$2"
	mm_api POST users "${admin_token:-}" \
		"$(jq -nc --arg u "$username" --arg p "$password" '{username: $u, password: $p, email: ($u + "@example.test")}')" \
		| jq -r .id
}
mm_login() {
	curl -sS --fail-with-body -D - -o /dev/null -X POST "$mm_url/api/v4/users/login" \
		-H "content-type: application/json" \
		--data "$(jq -nc --arg u "$1" --arg p "$2" '{login_id: $u, password: $p}')" |
		tr -d '\r' | awk 'tolower($1) == "token:" { print $2 }'
}

setup_mattermost() {
	log "Mattermost"
	mm_compose up -d --wait mattermost-postgres
	mm_compose up -d mattermost
	for _ in $(seq 1 120); do
		curl -sf "$mm_url/api/v4/system/ping" >/dev/null && break
		sleep 2
	done
	curl -sf "$mm_url/api/v4/system/ping" >/dev/null || fail "Mattermost did not start"
	password="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')Aa1!"
	# The first account on a fresh server becomes its system admin.
	admin_id="$(mm_user sysadmin "$password")"
	session="$(mm_login sysadmin "$password")"
	admin_token="$(mm_api POST "users/$admin_id/tokens" "$session" '{"description":"install test"}' | jq -r .token)"
	team_id="$(mm_api POST teams "$admin_token" '{"name":"autonomous-lab","display_name":"Autonomous Lab","type":"O"}' | jq -r .id)"
	declare -gA channel_ids=()
	for name in hq research engineering finance mail approvals gateway-alerts; do
		channel_ids[$name]="$(mm_api POST channels "$admin_token" \
			"$(jq -nc --arg t "$team_id" --arg n "$name" '{team_id: $t, name: $n, display_name: $n, type: "O"}')" | jq -r .id)"
	done
	for username in owner human; do
		local id
		id="$(mm_user "$username" "$password")"
		mm_api POST "teams/$team_id/members" "$admin_token" "$(jq -nc --arg t "$team_id" --arg u "$id" '{team_id: $t, user_id: $u}')" >/dev/null
		for channel in "${channel_ids[@]}"; do
			mm_api POST "channels/$channel/members" "$admin_token" "$(jq -nc --arg u "$id" '{user_id: $u}')" >/dev/null
		done
	done
	human_token="$(mm_login human "$password")"
}

# --- The Gateway, as INSTALL.md installs it ---------------------------------------------------
install_release() {
	local release="$1"
	log "install $(basename "$release")"
	"${sudo_cmd[@]}" env GATEWAY_HOME="$GATEWAY_HOME" "$release/bin/init-home.sh"
	"${sudo_cmd[@]}" sed -i "s#^COMPOSE_PROFILES=.*#COMPOSE_PROFILES=mock,tools#" "$GATEWAY_HOME/gateway.env"
	"${sudo_cmd[@]}" cp -R "$release/config.example/." "$GATEWAY_HOME/config/"
	agw="$release/bin/agw"
	"$agw" pull --quiet
	"$agw" up -d --wait gateway-postgres
	cli gateway db migrate
	cli gateway db create-role gateway_worker_mock /secrets/worker-mock/database_url
	cli gateway db grant-worker gateway_worker_mock mock
	cli gateway db create-role gateway_worker_codex /secrets/worker-codex/database_url
	cli gateway db grant-worker gateway_worker_codex codex
	cli gateway db create-role gateway_tool_runner /secrets/tool-runner/database_url
	cli gateway db grant-tool-runner gateway_tool_runner finance
	cli gateway config validate /config --root /config
	cli gateway config apply /config --root /config --mock-runtimes
	"$agw" run --rm -e MATTERMOST_ADMIN_TOKEN="$admin_token" gateway-cli gateway mattermost bootstrap
	cli gateway mattermost reconcile
	# The Codex worker runs without a login here: its probe fails, so it never becomes ready,
	# but it starts under its security profiles and reports its version.
	start_services
}

cli() { "$agw" run --rm gateway-cli "$@"; }

# The owner's console (ADR-023), from the rendered Compose config (every profile, so the
# workers behind COMPOSE_PROFILES this install doesn't run are checked too): no host port for
# it, the controller has its console environment, and no worker or connector service can reach
# or read it.
check_console_compose() {
	log "console compose config"
	local rendered
	rendered="$("$agw" --profile '*' config --format json)"
	jq -e '(.services["gateway-controller"].ports // []) | length == 0' <<<"$rendered" >/dev/null ||
		fail "gateway-controller publishes a host port"
	jq -e '.services["gateway-controller"].environment.CONSOLE_ENABLED == "false"' <<<"$rendered" >/dev/null ||
		fail "gateway-controller is missing CONSOLE_ENABLED"
	jq -e '.services["gateway-controller"].environment.CONSOLE_HOST == "0.0.0.0"' <<<"$rendered" >/dev/null ||
		fail "gateway-controller's CONSOLE_HOST is not 0.0.0.0"
	jq -e '.services["gateway-controller"].environment.CONSOLE_PORT == "8084"' <<<"$rendered" >/dev/null ||
		fail "gateway-controller's CONSOLE_PORT is not 8084"
	local service
	for service in gateway-worker-mock gateway-worker-codex gateway-worker-claude-code \
		gateway-tool-runner gateway-connector-gmail; do
		jq -e --arg s "$service" \
			'(.services[$s].networks // {}) | has("agent-mm") | not' <<<"$rendered" >/dev/null ||
			fail "$service is on agent-mm, the controller's console network"
		jq -e --arg s "$service" \
			'[(.services[$s].volumes // [])[].source] | map(endswith("/secrets/controller")) | any | not' \
			<<<"$rendered" >/dev/null ||
			fail "$service mounts the controller's secrets (holds the console password hash)"
	done
}

# The home server's Caddy: both site blocks (Mattermost and the Gateway's console, ADR-023)
# parse under the pinned image.
check_caddyfile() {
	local release="$1" image
	log "Caddyfile ($(basename "$release"))"
	image="$(grep -m1 -oE 'docker\.io/library/caddy:[^ ]+' \
		"$release/home-server/mattermost/compose.yaml")"
	[[ -n "$image" ]] || fail "no pinned Caddy image in home-server/mattermost/compose.yaml"
	docker run --rm -v "$release/home-server/mattermost/Caddyfile:/etc/caddy/Caddyfile:ro" \
		-e MATTERMOST_HOST=mattermost.local -e GATEWAY_HOST=gateway.local \
		"$image" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile ||
		fail "Caddyfile did not validate"
}

# UPGRADE.md, step 2: every Gateway service stops, the database keeps running.
stop_services() {
	"$agw" --profile codex stop gateway-controller gateway-worker-codex gateway-worker-mock \
		gateway-tool-runner
}
start_services() {
	"$agw" up -d --wait --remove-orphans
	"$agw" --profile codex up -d gateway-worker-codex
}
# UPGRADE.md, step 4: the limited roles get the new release's queues.
regrant() {
	cli gateway db grant-worker gateway_worker_mock mock
	cli gateway db grant-worker gateway_worker_codex codex
	cli gateway db grant-tool-runner gateway_tool_runner finance
}

# Every running service reports the release's version, in its metrics and its logs.
check_versions() {
	local expected="$1" service port
	log "versions ($expected)"
	for service in gateway-controller:8080 gateway-worker-mock:8081 gateway-tool-runner:8083 gateway-worker-codex:8081; do
		port="${service#*:}"
		service="${service%%:*}"
		for _ in $(seq 1 30); do
			"$agw" exec -T "$service" bun -e "
				const text = await (await fetch('http://127.0.0.1:$port/metrics')).text();
				const line = text.split('\n').find((l) => l.startsWith('gateway_build_info'));
				console.log(line);
				if (!line?.includes('version=\"$expected+')) process.exit(1);" 2>/dev/null && continue 2
			sleep 2
		done
		fail "$service version"
	done
	cli gateway version | jq -e --arg v "$expected" '.release == $v' >/dev/null || fail "CLI version"
}

# The containers run as the Gateway user, on a read-only root filesystem, without capabilities.
check_hardening() {
	log "hardening"
	local id inspect
	for id in $("$agw" --profile codex ps -q gateway-controller gateway-worker-mock gateway-tool-runner gateway-worker-codex); do
		inspect="$(docker inspect "$id")"
		jq -e '.[0].Config.User == "10001:10001"' <<<"$inspect" >/dev/null || fail "user of $id"
		jq -e '.[0].HostConfig.ReadonlyRootfs == true' <<<"$inspect" >/dev/null || fail "rootfs of $id"
		jq -e '.[0].HostConfig.CapDrop == ["ALL"] and (.[0].HostConfig.CapAdd // []) == []' <<<"$inspect" >/dev/null ||
			fail "capabilities of $id"
		jq -e '.[0].HostConfig.SecurityOpt | index("no-new-privileges:true")' <<<"$inspect" >/dev/null ||
			fail "no-new-privileges of $id"
		jq -e '.[0].HostConfig.PidsLimit > 0 and .[0].HostConfig.Memory > 0' <<<"$inspect" >/dev/null ||
			fail "limits of $id"
	done
	# The worker holds no Mattermost secret and cannot reach Mattermost.
	if "$agw" exec -T gateway-worker-mock sh -c 'ls /run/secrets' | grep -q '^mm_'; then
		fail "a worker sees bot tokens"
	fi
	if "$agw" exec -T gateway-worker-mock bun -e "await fetch('http://mattermost:8065/api/v4/system/ping', { signal: AbortSignal.timeout(3000) })" 2>/dev/null; then
		fail "a worker reaches Mattermost"
	fi
}

# The Codex worker's sandbox, under the stack's own security settings: a command runs, writes
# only the workspace, and reads neither the login nor the network.
check_codex_sandbox() {
	log "Codex sandbox"
	local result
	result="$("$agw" --profile codex run --rm --no-deps -T gateway-worker-codex bash -c '
		set -u
		ws=/var/lib/agent-gateway/workspaces/sandbox-check; mkdir -p -m 0700 "$ws"; cd "$ws"
		echo secret > "$CODEX_HOME/login-check"
		policy="permissions.check.filesystem={\":minimal\"=\"read\", \":slash_tmp\"=\"deny\", \":tmpdir\"=\"deny\", \"$CODEX_HOME\"=\"deny\", \":workspace_roots\"={\".\"=\"write\"}, \"$ws\"=\"write\"}"
		run() { codex sandbox -c default_permissions=\"check\" -c "$policy" -- "$@" 2>&1; }
		# Controls: without the sandbox the same write and connection succeed, so their absence
		# below is the sandbox and not the setup.
		echo control > /var/lib/agent-gateway/workspaces/escaped && echo CONTROL-WRITE
		rm -f /var/lib/agent-gateway/workspaces/escaped
		bash -c "exec 3<>/dev/tcp/1.1.1.1/443" 2>/dev/null && echo CONTROL-NETWORK
		run sh -c "echo inside > $ws/written; echo ran"
		run cat "$CODEX_HOME/login-check" && echo LOGIN-READ
		# Outside the workspace, in a directory the worker itself may write.
		run sh -c "echo x > /var/lib/agent-gateway/workspaces/escaped"
		[ -e /var/lib/agent-gateway/workspaces/escaped ] && echo ESCAPED
		rm -f /var/lib/agent-gateway/workspaces/escaped
		run bash -c "exec 3<>/dev/tcp/1.1.1.1/443 && echo NETWORK-OPEN"
		[ "$(cat "$ws/written")" = inside ] && echo WORKSPACE-OK
		rm -rf "$ws" "$CODEX_HOME/login-check"')" || true
	printf '%s\n' "$result"
	grep -q '^CONTROL-WRITE$' <<<"$result" || fail "the control write failed"
	grep -q '^CONTROL-NETWORK$' <<<"$result" || fail "the control connection failed: no egress"
	grep -q '^ran$' <<<"$result" || fail "a sandboxed command did not run"
	grep -q '^WORKSPACE-OK$' <<<"$result" || fail "the sandbox did not write the workspace"
	! grep -qE 'LOGIN-READ|ESCAPED|NETWORK-OPEN' <<<"$result" || fail "the sandbox leaked"
}

# A human mentions @director in #hq; the director's bot answers in the thread, once.
smoke() {
	local label="$1" root reply
	log "smoke mention ($label)"
	root="$(mm_api POST posts "$human_token" \
		"$(jq -nc --arg c "${channel_ids[hq]}" --arg m "@director install check $label" '{channel_id: $c, message: $m}')" | jq -r .id)"
	smoke_roots+=("$root")
	for _ in $(seq 1 90); do
		reply="$(mm_api GET "posts/$root/thread" "$human_token" |
			jq -r --arg root "$root" '[.posts[] | select(.id != $root and .props.from_bot == "true")] | length')"
		[[ "$reply" -ge 1 ]] && break
		sleep 2
	done
	[[ "$reply" -ge 1 ]] || fail "no reply to the $label mention"
	# Every check passes but Codex's: its worker has no login here, and says so.
	{ cli gateway doctor || true; } | jq -e '[.. | objects | select(.ok == false) | .name] == ["runtime:codex"]' >/dev/null ||
		fail "gateway doctor after $label"
}

# No mention got a second answer: across upgrades, rollbacks and restarts each root has one.
check_no_duplicates() {
	log "no duplicate replies"
	local root count
	for root in "${smoke_roots[@]}"; do
		count="$(mm_api GET "posts/$root/thread" "$human_token" |
			jq -r --arg root "$root" '[.posts[] | select(.id != $root and .props.from_bot == "true")] | length')"
		[[ "$count" == 1 ]] || fail "post $root has $count replies"
	done
}

smoke_roots=()
mkdir -p "$work"
setup_mattermost
first_release="$(unpack "$first")"
first_version="$(jq -r .release "$first_release/images.lock")"
check_caddyfile "$first_release"
install_release "$first_release"
check_versions "$first_version"
check_hardening
check_console_compose
log "migrate refused while services run"
if refusal="$(cli gateway db migrate 2>&1)"; then
	fail "db migrate ran under live services"
fi
grep -q "stop them before migrating" <<<"$refusal" || fail "db migrate failed for another reason: $refusal"
check_codex_sandbox
smoke "$first_version"

if [[ -n "$next" ]]; then
	next_release="$(unpack "$next")"
	next_version="$(jq -r .release "$next_release/images.lock")"
	check_caddyfile "$next_release"

	log "upgrade $first_version -> $next_version (UPGRADE.md)"
	stop_services
	# Step 3: the pre-upgrade backup, with the running release's CLI, verified and recorded.
	cli backup-gateway-db.sh /backups
	"$agw" run --rm -e BACKUP_DIR=/backups gateway-cli gateway backup check --record ||
		fail "the pre-upgrade backup does not pass its check"
	"${sudo_cmd[@]}" sh -c "ls '$GATEWAY_HOME'/backups/gateway-*.dump '$GATEWAY_HOME'/backups/gateway-*.manifest.json" >/dev/null ||
		fail "the pre-upgrade backup files are missing"
	agw="$next_release/bin/agw"
	"${sudo_cmd[@]}" env GATEWAY_HOME="$GATEWAY_HOME" "$next_release/bin/init-home.sh"
	"$agw" pull --quiet
	cli gateway db migrate
	regrant
	cli gateway db status | jq -e '.compatible' >/dev/null || fail "status after upgrade"
	start_services
	check_versions "$next_version"
	check_console_compose
	smoke "$next_version"

	log "rollback $next_version -> $first_version (ROLLBACK.md)"
	stop_services
	agw="$first_release/bin/agw"
	cli gateway db status | tee /dev/stderr | jq -e '.compatible' >/dev/null ||
		fail "the previous release is not certified for the upgraded database"
	regrant
	start_services
	check_versions "$first_version"
	smoke "$first_version-after-rollback"
fi

check_no_duplicates
log "install test passed"
