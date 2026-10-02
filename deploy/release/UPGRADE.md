# Upgrading Agent Gateway

An upgrade replaces the release directory the stack runs from; `$GATEWAY_HOME` (config,
secrets, backups) and the volumes stay. It is planned downtime: the services stop, the database
is migrated, the new release starts. Queued work waits in the database meanwhile and is picked
up afterwards; nothing is lost or run twice.

Read the new release's `RELEASE_NOTES.md` and `MIGRATIONS.md` first: they say which runtime
versions changed and whether the previous release can still run after the migration (the
rollback without a restore, see ROLLBACK.md).

## Steps

```bash
old=A.B.C   # the release running now
new=X.Y.Z
# 1. Download and verify the new release next to the current one (INSTALL.md, step 1).
cd /srv/agent-gateway/releases/agent-gateway-home-server-v$new

# 2. Stop every Gateway service; the database keeps running. Do not use kill-all to drain:
#    it cancels pending approvals and actions.
../agent-gateway-home-server-v$old/bin/agw stop gateway-controller gateway-worker-codex \
  gateway-worker-claude-code gateway-worker-mock gateway-connector-gmail gateway-tool-runner

# 3. Back up and verify the backup (the way back if a restore is ever needed), still with the
#    running release's CLI: the new one does not run on the old schema.
../agent-gateway-home-server-v$old/bin/agw run --rm gateway-cli backup-gateway-db.sh /backups
../agent-gateway-home-server-v$old/bin/agw run --rm -e BACKUP_DIR=/backups gateway-cli \
  gateway backup check --record

# 4. Refresh the host setup (reloads the workers' AppArmor profile; keeps existing files),
#    pull the new images and migrate. `db migrate` refuses while a service or a CLI session
#    command runs (not `doctor`, `health` or the `db`/`version` commands); finish those first.
#    Then give the limited roles the new release's queues.
sudo GATEWAY_HOME="$GATEWAY_HOME" bin/init-home.sh
bin/agw pull
bin/agw run --rm gateway-cli gateway db migrate
bin/agw run --rm gateway-cli gateway db grant-worker gateway_worker_codex codex
#    ... and every other limited role you created (grant-worker for each worker's role,
#    grant-tool-runner for the tool runner's), with the same arguments as at install.
bin/agw run --rm gateway-cli gateway db status

# 5. Rebuild operator-built images (Claude Code) on the new gateway image, if you use them
#    (runtimes/claude-code/README.md), and set CLAUDE_CODE_WORKER_IMAGE to the new digest.

# 6. Start the new release and check it.
bin/agw up -d --wait --remove-orphans
bin/agw run --rm gateway-cli gateway doctor
```

Then post a mention in Mattermost and check the reply. If anything fails, go to ROLLBACK.md.

## Upgrading to 0.3.0

0.3.0 ships no new migration: its head is still `0017_channel_grant_checks`, the same as
0.2.0 and 0.2.1. Still run `gateway db migrate` at step 4 above — it certifies 0.3.0 against the
schema (and is a no-op otherwise), the same as every upgrade.

0.3.0 adds the owner's console and the `operator` example agent
([ADR-023](../../docs/adr/023-console-and-operator.md)), both optional and off unless you turn
them on:

- **The console** ([docs/operations/console.md](../../docs/operations/console.md)): on the home
  server kit, an existing 0.2.x install needs Caddy brought up to date first — re-copy the new
  bundle's `home-server/.` over `/srv/home-server/`, re-run `setup-guest.sh` with the same
  `LAN_ADDRESS`, `LAN_GATEWAY` and `MDNS_NAME` values used at install (it now also publishes a
  second mDNS alias, for `gateway.local`), and recreate the Mattermost stack so its Caddy picks up
  the new `Caddyfile` — all three exactly as
  [home-server.md](../../docs/operations/home-server.md#mattermost) has them:

  ```bash
  sudo cp -R /srv/agent-gateway/current/home-server/. /srv/home-server/
  sudo LAN_ADDRESS=<same as at install> LAN_GATEWAY=<same as at install> \
    MDNS_NAME=<same as at install> /srv/home-server/guest/setup-guest.sh /srv/agent-gateway/current
  cd /srv/home-server/mattermost && docker compose --env-file /srv/mattermost/mattermost.env up -d
  ```

  Then set a password (`gateway console password set`), set `CONSOLE_ENABLED=true` in
  `gateway.env`, and apply it with `bin/agw up -d gateway-controller` — a `gateway.env` change
  needs the container recreated; `restart` alone does not re-read it (it stays correct for
  rotating the password afterwards, since the controller re-reads the hash file at start either
  way). Skip all of this and nothing changes.
- **The operator agent**, on an existing install that does not already have it: copy
  `config.example/agents/operator.yaml` and `config.example/prompts/examples/agents/operator.md`
  into your live `config/` (the same layout, `config/agents/operator.yaml` and
  `config/prompts/examples/agents/operator.md`), then:

  ```bash
  bin/agw run --rm gateway-cli gateway config validate /config --root /config
  bin/agw run --rm gateway-cli gateway config apply /config --root /config
  bin/agw run --rm -e MATTERMOST_ADMIN_TOKEN gateway-cli gateway mattermost bootstrap
  bin/agw run --rm gateway-cli gateway mattermost reconcile
  ```

  Bootstrap needs a temporary system admin token, the same way the first install's does
  (INSTALL.md, step 4); revoke it afterwards. This creates the operator's bot, adds it to `hq`
  (or whichever channel `operator.yaml` names) and writes its token into
  `secrets/controller/`.

Rolling back from 0.3.0 to 0.2.1 needs an extra check beyond the database: see ROLLBACK.md and
[docs/operations/releases.md](../../docs/operations/releases.md#the-v2-compatibility-rule).

## Upgrading to 0.5.0

0.5.0 adds migrations `0022_console_sessions` and `0023_console_csrf_derived`, both expand: the
steps above apply unchanged. The console ([ADR-025](../../docs/adr/025-management-console.md))
becomes a management UI:

- Sign-in is a page with a session cookie instead of the browser's HTTP Basic dialog. The
  existing password hash is reused; every browser signs in once more after the upgrade.
- `CONSOLE_ORIGIN` (default `https://gateway.local`) must equal the address the console is
  opened at. On the home server kit the default is right; set it in `gateway.env` only if the
  console is served elsewhere.
- With `CONSOLE_ENABLED=true` the controller also needs `GATEWAY_ROUTING_KEY` (the home server
  kit's `init-home.sh` already created `secrets/controller/gateway_routing_key`).
- Edits made in the console's Agents hub are configuration revisions with source `console`
  (`gateway config history`), the same as `config import`.

## Upgrading past 0.3.0: configuration history

Starting with the release after 0.3.0, configuration is also kept as immutable snapshots and an
append-only revision journal in PostgreSQL (`config_snapshots`, `config_revisions`; ADR-024), on
top of the `organization.yaml`/`agents/*.yaml` files `config apply` has always read.
`config_versions`/`agents` (what 0.3.0 and earlier read and write) keep their exact shape and
meaning, so nothing about the upgrade steps above changes. The first time this is true for a
given database, do this once, right after step 6:

```bash
bin/agw run --rm gateway-cli gateway config history
#   the first entry is a "backfill" revision: the configuration already running, given a place
#   in the journal it never had before. Keep it as the baseline, not a change to review.
bin/agw run --rm gateway-cli gateway config export /backups/config-bootstrap
#   a portable copy of exactly that configuration (docs/operations/backups.md distinguishes this
#   from the database backup step 3 already took). Keep it next to the backup, or wherever
#   bootstrap artifacts live.
```

From here on, day-to-day configuration changes are `gateway config diff <dir> --root <dir>`
(read-only preview) followed by `gateway config import <dir> --root <dir> --expected-revision
<id>` (the id `config history` or the refused import itself names) rather than editing `/config`
and re-running `config apply`. `config apply` keeps working — a documented, deprecated alias —
for any script that still calls it.

If a database already has configuration history by the time you read this (every upgrade past
the first one), `gateway config history`'s latest entry is an ordinary revision of its own, not a
`backfill`: there is nothing to bootstrap, and this section does not apply. `gateway doctor`'s
`config_history` check (and the controller's own log) tell you which case you are in — see
ROLLBACK.md for the one case a `backfill` revision can still show up again, after this.

## Rules the releases follow

- `gateway db migrate` is the only thing that changes the schema. Services never migrate; they
  refuse to start against a schema they are not certified for, and while a migration runs.
- A release's migrations are **expand** (new tables, nullable columns, functions: the previous
  release keeps working) or **contract** (removals and renames, which break it).
  `MIGRATIONS.md` lists them. A contract is shipped only in a release after the one that
  stopped needing the old shape, so a rollback by one release works without a restore whenever
  MIGRATIONS.md says so.
- Releases are upgraded one at a time, in order. Skipping a release is allowed when every
  release in between is expand-only; otherwise upgrade through each.
- A release that changes pg-boss's queue schema certifies no earlier release: pg-boss refuses
  a schema of another version. MIGRATIONS.md says so.
- A PostgreSQL major upgrade is never part of a Gateway release; it gets its own procedure.
