# Rolling back Agent Gateway

A rollback runs the previous release again. Two separate things decide whether that goes
cleanly, and they are checked separately:

- **Database certification** — is the previous release's schema certified for the database as
  it is now? The database is **not** migrated back: an older release never changes a newer
  schema. `gateway db status` and each release's `MIGRATIONS.md` ("Rollback without a restore")
  say whether it is.
- **Config and queued-input compatibility** — does the previous release's configuration schema
  and queued-job schema still accept everything currently active or queued? A permission or a
  turn input schema version a release introduces can be rejected outright by an older release
  even when the database itself is fully certified. This is not a migration, and `db status`
  says nothing about it: [docs/operations/releases.md](../../docs/operations/releases.md#the-v2-compatibility-rule)
  explains the rule; from 0.3.0 back to 0.2.1 it is `permissions.observe_system` and
  `AgentTurnInput.schemaVersion: 2` (ADR-023), and the section below is its procedure.

Complete the compatibility procedure below first when it applies, *then* the database-only
steps.

## Config and queued-input compatibility (0.3.0 back to 0.2.1, ADR-023)

0.2.1 (and every release before 0.3.0) rejects `permissions.observe_system` in a configuration
outright, and refuses a version 2 run job (`AgentTurnInput.schemaVersion: 2`, carrying
`systemStatus`) the same way. Do this with 0.3.0's own tools, while it is still running, before
touching the release directory:

**(a) Stop new version 2 turns from being scheduled.** Either delete the `observe_system: true`
line from `config/agents/operator.yaml` and re-validate and re-apply:

```bash
bin/agw run --rm gateway-cli gateway config validate /config --root /config
bin/agw run --rm gateway-cli gateway config apply /config --root /config
```

or, to drop the agent entirely rather than keep it without the permission:

```bash
bin/agw run --rm gateway-cli gateway agents disable operator
```

which takes effect immediately and needs no config apply. Either way, do this before anything
else here.

**(b) Settle or cancel outstanding observer work.** Check every agent that had
`observe_system` on (the operator, by default):

```bash
bin/agw run --rm gateway-cli gateway runs list --agent operator
bin/agw run --rm gateway-cli gateway runs cancel <run-id>   # for anything still queued or running
```

Confirm no queued, running or retrying run remains for it. `runs cancel` pauses the agent as
well (its own note says so); that is expected here. Note the id of anything you cancel.

**(c) Check the dead letter queues** for anything of the observing agent's own work:

```bash
bin/agw run --rm gateway-cli gateway dlq list
```

A dead-lettered job whose payload is a version 2 run must not be redriven while 0.2.1 is what's
running: `gateway dlq redrive` would hand it to a release that rejects it the same way a live
one is rejected. There is no command to discard a single dead-lettered job — `dlq list` is the
only other thing to do with one; leave it. It stays visible in `dlq list` (and keeps its
`dlq:<queue>` alert firing) until you redrive it after upgrading forward again, past 0.3.0.

**(d) Make sure the configuration on disk, not only what is currently active, carries nothing
0.2.1 does not know.** Step (a) already changed what is stored as the active configuration
version (validated by 0.3.0's own schema, which still accepts the file either way); 0.2.1 does
not re-validate an already-stored configuration just by starting and reading it. What 0.2.1's
schema *does* reject is an `observe_system` key anywhere in a configuration you hand its own
`config validate` or `config apply` — so make sure `config/agents/operator.yaml` on disk no
longer has that line (or the whole file, if you disabled the agent in step (a)) before you ever
run one of those commands under 0.2.1.

**(e) Historical version 2 context snapshots need no cleanup.** Runs already completed under
0.3.0 keep their stored turn input (including `schemaVersion: 2` and `systemStatus`) under the
normal retention policy (`docs/operations/observability.md`, "Retention"); 0.2.1 never reads or
re-validates them, so there is nothing to delete or rewrite here.

**(f) If you are also reverting the home-server kit itself** (not only the Gateway release),
set `CONSOLE_ENABLED=false` in `gateway.env` and remove the `gateway.local` site block from
`home-server/mattermost/Caddyfile` (and its mDNS alias from `setup-guest.sh`, if you re-run
guest setup from an older bundle). This is cleanup, not a requirement: a Caddy route to a
console that is not there just returns `502`, harmless either way.

Once (a)-(d) are done, continue with the database-only steps below.

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

# 3. Give the limited roles the previous release's queue grants (grant-worker and
#    grant-tool-runner, as at install, with the previous release's CLI), then start it: its
#    compose.yaml pins its own images by digest.
agent-gateway-home-server-v$old/bin/agw run --rm gateway-cli gateway db grant-worker gateway_worker_codex codex
agent-gateway-home-server-v$old/bin/agw up -d --wait --remove-orphans
agent-gateway-home-server-v$old/bin/agw run --rm gateway-cli gateway doctor
```

If you rebuilt an operator image (Claude Code) for the new release, set
`CLAUDE_CODE_WORKER_IMAGE` back to the previous digest before step 3.

Work that arrived meanwhile is processed once: events are deduplicated in the database, and
the queues and the outbox survive the switch. The Mattermost listener catches up on missed posts
by itself; run `gateway mattermost reconcile` to check the bots.

From 0.3.0 back to 0.2.1, step 2 reports `"compatible": true` on its own: 0.3.0 ships no
migration (its head is still `0017_channel_grant_checks`, the same as 0.2.0 and 0.2.1), so the
database side of this rollback is the ordinary case. It is the config and queued-input section
above that needs doing first, not this one.

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

A restore also takes the config and queued-input compatibility question out of your hands: the
restored database is from before the 0.3.0 upgrade, so it never had `observe_system` or a
version 2 job in it to begin with. The "Config and queued-input compatibility" section above
does not apply when you are restoring.
