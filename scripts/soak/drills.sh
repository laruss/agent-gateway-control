#!/bin/bash
# Failure drills for a restored copy of the home server (never the original): each drill
# breaks one thing while an agent works, and checks the Gateway recovers with every mention
# answered exactly once (docs/operations/home-server.md, "Failure drills").
#
#   sudo scripts/soak/drills.sh [drill ...]     # all but the two that fail the agent by default
#
# Runs inside the rehearsal VM after guest/restore.sh --rehearsal. It creates a drill user in
# the copy's Mattermost, puts every agent on the mock runtime (no model, no real logins) and
# prints one line per drill: PASS or FAIL with what was seen. Exits 1 when a drill fails.
set -uo pipefail
[[ "$(id -u)" == 0 ]] || { echo "run it with sudo" >&2; exit 1; }
operator="${SUDO_USER:?run it with sudo, as the user who runs docker compose}"
export GATEWAY_HOME="${GATEWAY_HOME:-/srv/agent-gateway}"
# Only on a copy restored with --rehearsal: the drills stop workers, change the configuration
# and break services on purpose.
[[ -e "$GATEWAY_HOME/.rehearsal" ]] || {
	echo "not a rehearsal copy ($GATEWAY_HOME/.rehearsal missing): drills never run on the original" >&2
	exit 1
}
agw() { sudo -u "$operator" GATEWAY_HOME="$GATEWAY_HOME" "$GATEWAY_HOME/current/bin/agw" "$@"; }
quiet() { grep -v " Container \| Network \| Volume " || true; }
mm() { docker exec agent-gateway-mattermost-mattermost-1 /mattermost/bin/mmctl --local "$@"; }
sql() { docker exec -i agent-gateway-gateway-postgres-1 psql -U gateway -d gateway -At -c "$1"; }
host="${MATTERMOST_HOST:-mattermost.local}"
channel="${DRILL_CHANNEL:-tasks}"
agent="${DRILL_AGENT:-director}"
failed=0

api() {
	curl -sS --fail-with-body -k --resolve "$host:443:127.0.0.1" -X "$1" "https://$host/api/v4/$2" \
		-H "authorization: Bearer $token" -H "content-type: application/json" ${3:+--data "$3"}
}

say() {
	api POST posts "$(jq -nc --arg c "$channel_id" --arg m "$1" '{channel_id: $c, message: $m}')" | jq -r .id
}

# Replies by Gateway bots in the thread of a post.
replies() {
	api GET "posts/$1/thread" | jq --arg root "$1" --arg me "$user_id" \
		'[.posts[] | select(.id != $root and .user_id != $me and .props.from_bot == "true")] | length'
}

runs() {
	sql "select count(*) from agent_runs r join events e on e.id = r.trigger_event_id
	      where e.subject like 'channel/%/post/$1'"
}

run_status() {
	sql "select string_agg(r.status, ',' order by r.queued_at) from agent_runs r
	      join events e on e.id = r.trigger_event_id where e.subject like 'channel/%/post/$1'"
}

# Waits until `check` prints `want`, up to `seconds`.
until_equals() {
	local want="$1" seconds="$2" got=""
	shift 2
	for _ in $(seq "$seconds"); do
		got="$("$@" 2>/dev/null)"
		[[ "$got" == "$want" ]] && return 0
		sleep 1
	done
	echo "$got"
	return 1
}

report() {
	if [[ "$2" == ok ]]; then
		printf 'PASS  %-24s %s\n' "$1" "$3"
	else
		printf 'FAIL  %-24s %s\n' "$1" "$3"
		failed=1
	fi
}

# A mention is answered once: one run, one bot reply, within `seconds`.
answered_once() {
	local post="$1" seconds="${2:-90}"
	until_equals 1 "$seconds" replies "$post" >/dev/null || return 1
	sleep 3
	[[ "$(replies "$post")" == 1 && "$(runs "$post")" == 1 ]]
}

# Drops the pending inbox entries of `[mock:slow]` posts (drills only: they never finish).
drop_slow() {
	sql "update agent_inbox i set status = 'dead' from events e
	      where e.id = i.event_id and i.status = 'pending' and e.payload->>'message' like '%[mock:slow]%'" >/dev/null
}

setup() {
	echo "== setup: drill user, mock runtimes"
	local password
	password="$(openssl rand -hex 16)"
	mm user create --email drill-human@example.invalid --username drill-human --password "$password" >/dev/null 2>&1 || true
	mm team users add home drill-human >/dev/null 2>&1 || true
	mm channel users add "home:$channel" drill-human >/dev/null 2>&1 || true
	# mmctl prints one object or a list of them, depending on the command.
	first='if type == "array" then .[0] else . end'
	token="$(mm token generate drill-human drills --json | jq -r "$first | .token")"
	user_id="$(mm user search drill-human --json 2>/dev/null | jq -r "$first | .id")"
	channel_id="$(sql "select mattermost_id from mattermost_directory where kind = 'channel' and name = '$channel'")"
	sed -i 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=mock/' "$GATEWAY_HOME/gateway.env"
	# The mock worker's own limited role, as for any worker.
	if [[ ! -s "$GATEWAY_HOME/secrets/worker-mock/database_url" ]]; then
		agw run --rm -T gateway-cli gateway db create-role gateway_worker_mock /secrets/worker-mock/database_url 2>&1 | quiet >/dev/null
	fi
	agw run --rm -T gateway-cli gateway db grant-worker gateway_worker_mock mock 2>&1 | quiet >/dev/null
	agw run --rm -T gateway-cli gateway config apply /config --root /config --mock-runtimes 2>&1 | quiet >/dev/null
	agw up -d --wait 2>&1 | quiet >/dev/null
	# An agent left busy or paused by an earlier interrupted drill works again.
	local stuck
	stuck="$(sql "select id from agent_runs where agent_id = '$agent' and status in ('queued', 'running')")"
	for run in $stuck; do
		agw run --rm -T gateway-cli gateway runs cancel "$run" 2>&1 | quiet >/dev/null
	done
	drop_slow
	agw run --rm -T gateway-cli gateway agents resume "$agent" 2>&1 | quiet >/dev/null || true
	local warmup
	warmup="$(say "@$agent warm-up")"
	answered_once "$warmup" 120 || { echo "the copy does not answer; stopping" >&2; exit 1; }
}

drill_controller_restart() {
	local post
	post="$(say "@$agent [mock:reply] during a controller restart")"
	docker restart agent-gateway-gateway-controller-1 >/dev/null ||
		{ report controller-restart fail "could not restart the controller"; return; }
	if answered_once "$post" 120; then report controller-restart ok "one reply after the restart"; else report controller-restart fail "replies=$(replies "$post") runs=$(runs "$post")"; fi
}

drill_database_restart() {
	docker stop -t 60 agent-gateway-gateway-postgres-1 >/dev/null ||
		{ report database-restart fail "could not stop the database"; return; }
	local post
	post="$(say "@$agent [mock:reply] while the database is down")"
	sleep 10
	docker start agent-gateway-gateway-postgres-1 >/dev/null ||
		{ report database-restart fail "could not start the database"; return; }
	# The services lose the deployment lock and exit; their restart policy brings them back.
	if answered_once "$post" 180; then report database-restart ok "caught up once the database was back"; else report database-restart fail "replies=$(replies "$post") runs=$(runs "$post")"; fi
}

drill_worker_kill() {
	local post
	post="$(say "@$agent [mock:slow] a long task")"
	until_equals running 60 run_status "$post" >/dev/null
	docker kill agent-gateway-gateway-worker-mock-1 >/dev/null ||
		{ report worker-kill fail "could not kill the worker"; return; }
	agw up -d --wait gateway-worker-mock 2>&1 | quiet >/dev/null
	# The killed attempt's lease expires and the run is retried or ends; never twice at once.
	sleep 20
	local status run
	status="$(run_status "$post")"
	# The slow turn would hold the agent until its timeout: an operator cancels it.
	run="$(sql "select r.id from agent_runs r join events e on e.id = r.trigger_event_id
	             where e.subject like 'channel/%/post/$post' order by r.queued_at desc limit 1")"
	agw run --rm -T gateway-cli gateway runs cancel "$run" 2>&1 | quiet >/dev/null
	# A cancelled run's work goes back to the inbox (nothing is lost); this endless one is
	# dropped by hand, then the paused agent is resumed.
	drop_slow
	agw run --rm -T gateway-cli gateway agents resume "$agent" 2>&1 | quiet >/dev/null
	local after
	after="$(say "@$agent [mock:reply] after the cancelled run")"
	if [[ "$(runs "$post")" == 1 && "$status" != *","* ]] && answered_once "$after" 120; then
		report worker-kill ok "one run ($status), cancelled, the agent works again"
	else
		report worker-kill fail "runs=$(runs "$post") status=$status after=$(replies "$after")"
	fi
}

drill_mattermost_network() {
	docker network disconnect agent-mm agent-gateway-gateway-controller-1 ||
		{ report mattermost-network fail "could not disconnect the controller"; return; }
	local post
	post="$(say "@$agent [mock:reply] while Mattermost is unreachable")"
	sleep 15
	docker network connect agent-mm agent-gateway-gateway-controller-1 ||
		{ report mattermost-network fail "could not reconnect the controller"; return; }
	if answered_once "$post" 180; then report mattermost-network ok "backlog caught up, one reply"; else report mattermost-network fail "replies=$(replies "$post") runs=$(runs "$post")"; fi
}

drill_duplicates() {
	local before after
	before="$(sql 'select count(*) from events')"
	# A full resync after reconnects reads every managed channel again: nothing is stored twice.
	docker restart agent-gateway-gateway-controller-1 >/dev/null
	sleep 20
	after="$(sql 'select count(*) from events')"
	local dupes
	dupes="$(sql "select count(*) from (select subject from events where type in ('mattermost.post.created','mattermost.agent.mentioned','mattermost.thread.reply') group by source, subject having count(*) > 1) d")"
	if [[ "$dupes" == 0 ]]; then report duplicate-events ok "events $before -> $after, no post stored twice"; else report duplicate-events fail "$dupes posts stored twice"; fi
}

drill_provider_flaky() {
	local retry
	retry="$(say "@$agent [mock:flaky] the provider fails once")"
	if answered_once "$retry" 120; then report provider-flaky ok "retried, one reply"; else report provider-flaky fail "replies=$(replies "$retry") status=$(run_status "$retry")"; fi
}

# Leaves the agent FAILED, as a run that cannot succeed must: run it last.
drill_provider_permanent() {
	local permanent
	permanent="$(say "@$agent [mock:permanent] the provider refuses")"
	until_equals failed 120 run_status "$permanent" >/dev/null
	local noticed
	noticed="$(replies "$permanent")"
	if [[ "$(run_status "$permanent")" == failed && -n "$noticed" && "$noticed" -le 1 ]]; then report provider-permanent ok "failed once, at most one notice"; else report provider-permanent fail "status=$(run_status "$permanent") replies=$(replies "$permanent")"; fi
}

drill_invalid_once() {
	local once
	once="$(say "@$agent [mock:invalid-once] a malformed answer, then a good one")"
	if answered_once "$once" 120; then report invalid-once ok "repaired, one reply"; else report invalid-once fail "replies=$(replies "$once") status=$(run_status "$once")"; fi
}

# Leaves the agent FAILED, as a run that cannot succeed must: run it last.
drill_invalid_always() {
	local always
	always="$(say "@$agent [mock:invalid] only malformed answers")"
	until_equals failed 120 run_status "$always" >/dev/null
	if [[ "$(run_status "$always")" == failed ]]; then report invalid-always ok "failed after the repair, nothing unauthorized posted"; else report invalid-always fail "status=$(run_status "$always")"; fi
}

drill_cascade() {
	local other="${DRILL_OTHER_AGENT:-finance}" post
	# Handing over needs another enabled agent in the channel; without one the turn's authority
	# refuses the hand-over, as it must, and there is nothing to drill.
	local present
	present="$(sql "select count(*) from agents where id = '$other' and enabled
	                 and config->'mattermost'->'allowed_channels' ? '$channel'")"
	if [[ "$present" != 1 ]]; then
		printf 'SKIP  %-24s %s\n' cascade "no enabled @$other in ~$channel (set DRILL_OTHER_AGENT)"
		return
	fi
	post="$(say "@$agent [mock:mention $other] hand this over")"
	sleep 30
	local agents
	agents="$(sql "select string_agg(r.agent_id || ':' || r.status, ',' order by r.queued_at) from agent_runs r
	               where r.correlation_id = (select correlation_id from events where subject like 'channel/%/post/$post' limit 1)")"
	# Exactly one run of each, both succeeded.
	if [[ "$agents" == "$agent:succeeded,$other:succeeded" ]]; then report cascade ok "$agents"; else report cascade fail "$agents"; fi
}

setup
drills=("$@")
# One drill that leaves the agent FAILED at most, and last; the other runs on another fresh
# restore (docs/operations/home-server.md).
[[ ${#drills[@]} -gt 0 ]] || drills=(controller_restart database_restart mattermost_network duplicates provider_flaky invalid_once cascade worker_kill)
for drill in "${drills[@]}"; do
	"drill_$drill"
done
exit "$failed"
