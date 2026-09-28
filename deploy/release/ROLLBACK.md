# Rolling back Agent Gateway

A rollback runs the previous release again. The database is **not** migrated back: an older
release never changes a newer schema. What decides the way back is whether the newer release's
migration certified the previous release (see its `MIGRATIONS.md`, "Rollback without a
restore").

## Without a restore (the previous release is certified)

```bash
old=A.B.C   # the previous release, still unpacked under releases/
new=X.Y.Z
cd /srv/agent-gateway/releases

# 1. Stop the new release's services (the database keeps running).
agent-gateway-home-server-v$new/bin/agw stop gateway-controller gateway-worker-codex \
  gateway-worker-claude-code gateway-worker-mock gateway-connector-gmail gateway-tool-runner

# 2. Check that the previous release may run on the database as it is now.
agent-gateway-home-server-v$old/bin/agw run --rm gateway-cli gateway db status
#    "compatible": true  -> continue; false -> restore instead (below).

# 3. Start the previous release: its compose.yaml pins its own images by digest.
agent-gateway-home-server-v$old/bin/agw up -d --wait --remove-orphans
agent-gateway-home-server-v$old/bin/agw run --rm gateway-cli gateway doctor
```

If you rebuilt an operator image (Claude Code) for the new release, set
`CLAUDE_CODE_WORKER_IMAGE` back to the previous digest before step 3.

Work that arrived meanwhile is processed once: events are deduplicated in the database, and
the queues and the outbox survive the switch. The Mattermost listener catches up on missed posts
by itself; run `gateway mattermost reconcile` to check the bots.

## With a restore (the previous release is not certified)

A contract migration, or a failed migration, leaves the database in a shape the previous
release refuses. Restore the backup taken before the upgrade (UPGRADE.md, step 3):

1. Stop every Gateway service (`bin/agw stop`), including the database.
2. Restore the pre-upgrade dump into a fresh database volume, following the operations docs
   (backups): verify it first with `gateway backup check --restore-test`.
3. Start the previous release as above.

A restore takes the database back in time; the outside world does not go back with it. Posts
the agents made, mail and provider actions (payments) after the backup remain real, while their
records are gone. Before starting agents again, check the provider consoles and Mattermost for
what happened after the backup, and record anything that must not be repeated (for example
with `gateway tools settle`).
