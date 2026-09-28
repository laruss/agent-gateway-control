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

# 3. Back up and verify the backup (the way back if a restore is ever needed).
bin/agw run --rm gateway-cli backup-gateway-db.sh /backups
bin/agw run --rm -e BACKUP_DIR=/backups gateway-cli gateway backup check --record

# 4. Pull the new images and migrate. `db migrate` refuses while a service is still connected.
bin/agw pull
bin/agw run --rm gateway-cli gateway db migrate
bin/agw run --rm gateway-cli gateway db status

# 5. Rebuild operator-built images (Claude Code) on the new gateway image, if you use them
#    (runtimes/claude-code/README.md), and set CLAUDE_CODE_WORKER_IMAGE to the new digest.

# 6. Start the new release and check it.
bin/agw up -d --wait --remove-orphans
bin/agw run --rm gateway-cli gateway doctor
```

Then post a mention in Mattermost and check the reply. If anything fails, go to ROLLBACK.md.

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
- A PostgreSQL major upgrade is never part of a Gateway release; it gets its own procedure.
