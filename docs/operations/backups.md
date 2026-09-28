# Backups of the Gateway database

The Gateway does not make, encrypt or ship backups itself: the deployment owns that. It ships a
reference producer, `scripts/backup-gateway-db.sh`, and a verifier, `gateway backup check`, so a
backup that is missing, stale, damaged or unrestorable is noticed before it is needed.

What a complete backup of a Gateway deployment covers (the database is only one part):
- the Gateway PostgreSQL database (this page);
- the configuration directory (`organization.yaml`, `agents/`, `prompts/`) and the image lock;
- secret files, encrypted and stored apart from the database backup;
- Mattermost: its own database, `config/` and `data/`, taken together so they agree;
- persistent workspaces and artifacts, where unfinished work matters.

A database backup holds message content, mail bodies, approval parameters and audit history.
Encrypt it at rest and keep an off-host copy.

## Making a backup

```bash
DATABASE_URL_FILE=/run/secrets/gateway_backup_database_url \
scripts/backup-gateway-db.sh /srv/backups/gateway
```

It writes two files:

| File | Content |
|------|---------|
| `gateway-<UTC time>.dump` | `pg_dump --format=custom` of the database |
| `gateway-<UTC time>.manifest.json` | what the dump is, written only after the dump is complete |

The manifest (`agent-gateway-backup/1`):

| Field | Meaning |
|-------|---------|
| `database` | the database's name |
| `system_identifier` | the server's `pg_control_system()` identifier; `null` when the role may not read it |
| `completed_at` | when the dump finished (UTC) |
| `schema_version` | applied migrations: their number and the latest hash |
| `pg_dump_version` | the `pg_dump` that made the dump |
| `dump_file`, `size_bytes`, `sha256` | the dump, its size and checksum |

A dump without a manifest is incomplete and never counts. A migration applied while the
dump ran makes the script fail (exit 3) instead of writing a manifest that describes another
schema. A password in the URL is passed to
the tools through `PGPASSWORD`, never on their command line; the script refuses a
`?password=` query parameter. When the host's client tools are
older than the server, run them in the database container:
`PG_DUMP="docker exec -i -e PGPASSWORD <container> pg_dump"` (and `PSQL` likewise).

Schedule it (daily at least), then copy the pair off the host, encrypted. Any producer that
writes the same two files works with the check.

## Checking a backup

```bash
BACKUP_DIR=/srv/backups/gateway gateway backup check [--max-age-hours 26] [--restore-test] [--record]
```

It picks the manifest with the latest `completed_at` (invalid manifests are named and
ignored) and prints its checks as JSON; the exit code is 1 when one fails.

| Check | Fails when |
|-------|-----------|
| `directory` | the directory does not exist |
| `manifest` | no valid manifest is there |
| `age` | the backup is older than `--max-age-hours` (`BACKUP_MAX_AGE_HOURS`, default 26), or completed in the future |
| `dump`, `checksum` | the dump is missing, its size or SHA-256 differs from the manifest |
| `identity` | the backup is of another database or server than `DATABASE_URL`, or the reachable live database cannot be queried. Passes as skipped when the live database is unreachable; not run without `DATABASE_URL` |
| `schema` | the backup has more migrations than the live database, or as many but another latest migration |
| `pg_restore` | `pg_restore` is missing or older than the `pg_dump` that made the dump |
| `toc` | `pg_restore --list` cannot read the archive |

`toc` proves the archive is readable, not that it restores. `--restore-test` restores it:

- into `BACKUP_RESTORE_DATABASE_URL` (or `_FILE`), an isolated database on a server with no
  controller, worker or connector attached. The check **drops every schema in it** first;
- before emptying it, it proves the scratch database is not the live one: a probe table
  created there must not be visible through `DATABASE_URL`, asked of a primary (a standby may
  lag, so `DATABASE_URL` must not reach one). An aliased host, a proxy or an
  unreadable server identity cannot fool this; without a reachable `DATABASE_URL` the restore
  test refuses to run. The scratch URL may carry only the `sslmode` and `password` query
  parameters, so the probe and `pg_restore` connect to the same database;
- the restore runs `pg_restore --no-owner --no-privileges --exit-on-error`;
- afterwards it checks the restored database: the migrations match the manifest, the controls
  row exists, and `events`, `agent_runs`, `approval_requests`, `tool_actions` and `audit_log`
  exist and can be counted.

Run the restore test regularly (weekly), not only before an upgrade.

`--record` stores the result in the Gateway database (`maintenance_status`, task `backup`).
The controller then raises the `maintenance:backup` alert while the last recorded check failed,
or when no check passed within its maximum age, which also catches a check that stopped
running. The alert is resolved by the next passing check. Recording needs the live database:
when the database itself is down, only the exit code tells, so have the scheduler or external
monitoring watch it too.

`PG_RESTORE` names another `pg_restore` executable.
