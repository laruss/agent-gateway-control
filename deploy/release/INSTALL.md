# Installing Agent Gateway

This bundle installs the Gateway on one Docker host from the release's images, without a
source checkout. Upgrades are in [UPGRADE.md](UPGRADE.md), rollbacks in
[ROLLBACK.md](ROLLBACK.md), and the database changes of this release in
[MIGRATIONS.md](MIGRATIONS.md).

## What you need

- A Linux host, `linux/amd64` or `linux/arm64`, with Docker Engine 27 or later and Compose
  v2.30 or later; Docker pulls the host's platform from each image. On macOS, run them in a
  Linux VM: the worker's sandbox needs the VM's seccomp and, where it has one, AppArmor.
- `curl`, `jq` and `sha256sum`; the [GitHub CLI](https://cli.github.com) (`gh`) to verify the
  attestations.
- A running Mattermost (a supported ESR) on a Docker network the Gateway joins
  (`MATTERMOST_NETWORK`, default `agent-mm`). The Mattermost stack is not part of this bundle.
  Before the Gateway's bootstrap, create by hand: a system admin, the team and channels named in
  `organization.yaml`, and the owners' accounts.
- For each runtime your agents use, its worker: Codex from the release image, Claude Code from
  your own build ([runtimes/claude-code/README.md](runtimes/claude-code/README.md)), each with
  its provider's login. Grok, Kiro, OpenCode and Hermes are not part of this release: their
  CLIs cannot confine their tools per run yet.

## 1. Download and verify

Verify the archive with the `gh` you trust before running anything from it:

```bash
version=X.Y.Z
repo=laruss/agent-gateway-control
mkdir -p /srv/agent-gateway/releases && cd /srv/agent-gateway/releases
gh release download "v$version" -R "$repo" -D "download-v$version"
cd "download-v$version"
for file in "agent-gateway-home-server-v$version.tar.gz" SHA256SUMS; do
  gh attestation verify "$file" --repo "$repo" \
    --signer-workflow "$repo/.github/workflows/release.yml" --source-ref "refs/tags/v$version"
done
sha256sum --check --strict SHA256SUMS       # the other assets match the attested checksums
tar -xzf "agent-gateway-home-server-v$version.tar.gz" -C ..
cd "../agent-gateway-home-server-v$version"
bin/verify-release.sh                       # the bundle's files, the images' attestations and platforms
```

The attestations prove that the archive, `SHA256SUMS` and every image in `images.lock` were
built by this repository's release workflow from the tag `v$version`. Continue only if every
check passes.

`compose.yaml` runs every image by digest (see `images.lock`); no tag is ever pulled.

## 2. Prepare the Gateway's home

State lives in `$GATEWAY_HOME` (default `/srv/agent-gateway`), outside every release
directory: upgrades and rollbacks switch the release directory and keep the state.

```bash
export GATEWAY_HOME=/srv/agent-gateway
sudo GATEWAY_HOME="$GATEWAY_HOME" bin/init-home.sh   # directories, owners, the database password and URL
sudo cp -R config.example/. "$GATEWAY_HOME/config/"
sudo "$EDITOR" "$GATEWAY_HOME/gateway.env" "$GATEWAY_HOME/config/organization.yaml"
```

`sudo` drops your environment: pass `GATEWAY_HOME` to it explicitly, as above.

- `gateway.env`: `MATTERMOST_URL` (as the controller reaches it on the shared network),
  `MATTERMOST_NETWORK`, and `COMPOSE_PROFILES` (the workers and connectors to run).
- `config/`: `organization.yaml`, `agents/*.yaml` and their prompts. Give each agent a runtime
  you run a worker for; change or disable the example agents on other runtimes. `operator.yaml`
  is one of them: a read-only agent that answers "what's going on" in Mattermost from the
  Gateway's own state (`permissions.observe_system`, [ADR-023](../../docs/adr/023-console-and-operator.md)).
  Leave it enabled to keep it, or disable it like any other example agent.
- `secrets/`: one directory per service ([secrets.example/README.md](secrets.example/README.md)).
  Each service mounts only its own, read-only.

Keep `GATEWAY_HOME` set in your shell for the commands below; `bin/agw` reads it.

## 3. Database, roles and configuration

```bash
bin/agw up -d --wait gateway-postgres
bin/agw run --rm gateway-cli gateway db migrate
# One limited role per worker, its connection URL written into the worker's secrets:
bin/agw run --rm gateway-cli gateway db create-role gateway_worker_codex /secrets/worker-codex/database_url
bin/agw run --rm gateway-cli gateway db grant-worker gateway_worker_codex codex
bin/agw run --rm gateway-cli gateway config validate /config --root /config
bin/agw run --rm gateway-cli gateway config apply /config --root /config
```

This first apply is also the first entry of the configuration's revision history
(`gateway config history`). `config apply` keeps working (a documented, deprecated alias); from
here on `config diff` then `config import --expected-revision <id>` is the safer way to change
configuration, since it refuses to commit over a change made since you last looked. See
[docs/operations/backups.md](../../docs/operations/backups.md#a-database-backup-is-not-a-configuration-export)
for how a `config export` relates to a database backup.

The tool runner gets a role the same way (`db create-role`, then
`db grant-tool-runner gateway_tool_runner finance`). The Gmail connector writes the events it
ingests and uses the owner's connection: copy `secrets/controller/database_url` into
`secrets/gmail/`.

## 4. Mattermost bots

Create a personal access token for the system admin, then:

```bash
bin/agw run --rm -e MATTERMOST_ADMIN_TOKEN gateway-cli gateway mattermost bootstrap
bin/agw run --rm gateway-cli gateway mattermost reconcile
```

Bootstrap creates a bot per agent and the listener, writes their tokens and the routing key
into `secrets/controller/`, and prints no secret. Revoke the admin token afterwards.

## 5. Runtime logins

Codex: `bin/agw run --rm gateway-worker-codex codex login --device-auth`, or an API key in
`secrets/worker-codex/codex_api_key` with `CODEX_API_KEY_FILE=/run/secrets/codex_api_key` in
`gateway.env`. Then check the runtime (this spends a few real turns):

```bash
bin/agw run --rm gateway-worker-codex gateway runtime doctor codex
```

The doctor must pass on this host: it proves the sandbox works under the worker's security
settings.

### Gmail (optional)

Put the OAuth client of type "Desktop app" into `secrets/gmail/gmail_oauth_client_id` and
`gmail_oauth_client_secret`, and copy the controller's database URL next to them, each mode
0600 and owned by the services' user:

```bash
sudo install -m 0600 -o 10001 -g 10001 "$GATEWAY_HOME/secrets/controller/database_url" \
  "$GATEWAY_HOME/secrets/gmail/database_url"
```

Then authorize the mailbox:

```bash
bin/gmail-authorize.sh            # --pubsub with Pub/Sub notifications
```

It prints Google's consent address. Google sends the browser back to
`http://127.0.0.1:8765` on the Docker host; from another machine, forward the port first
(`ssh -L 8765:127.0.0.1:8765 <host>`). The refresh token lands in
`secrets/gmail/gmail_refresh_token`. Add `gmail` to `COMPOSE_PROFILES`.

## 6. Start

```bash
bin/agw up -d --wait
bin/agw ps
bin/agw run --rm gateway-cli gateway doctor
```

Then mention an agent in Mattermost; its bot answers in the thread.

## Security settings

Every container:
- runs as the unprivileged user `10001` (the services refuse root);
- has a read-only root filesystem, no capabilities and `no-new-privileges`;
- has CPU, memory and process limits (edit them in `$GATEWAY_HOME/compose.override.yaml`,
  see `compose.override.example.yaml`).

The PostgreSQL container keeps the few capabilities its entrypoint needs to prepare its data
directory.

The runtime workers use `seccomp/worker-sandbox.json` and, on AppArmor hosts (Ubuntu, Debian),
`apparmor/agent-gateway-worker`: Docker's default profiles plus only what bubblewrap needs to
confine the commands a runtime runs (namespaces and mounts inside its own user namespace).
`init-home.sh` installs the AppArmor profile into `/etc/apparmor.d` and loads it; a worker whose
profile is not loaded does not start. They mount only their own secrets and
volumes, and they are not on the Mattermost network. No container gets the Docker socket, and
no port is published.

The containers run as uid `10001` (PostgreSQL as `70`), and the secret files belong to those
ids: keep them free of host accounts, which could otherwise read the secrets. The services'
metrics are reachable by the other containers on `agent-control`; they hold counts and agent
ids, no content.

**Egress.** Workers, the Gmail connector and the tool runner reach the internet through the
`egress` network, whose bridge is named `agw-egress`. The Mattermost network is closed to
them, but its public URL, the host's own services and your LAN are not until the host's
firewall closes them. `bin/egress-firewall.sh` (as root, needs `nft`) loads an nftables table
that rejects everything from `agw-egress` except the public internet and the DNS resolvers
Docker uses; load it at every boot, before the stack starts (a systemd unit that runs it
`Before=docker.service`). Check it from a worker, with your router's address in place of
`192.168.1.1`: the first line must say `open`, the second `closed`.

```bash
bin/agw run --rm --entrypoint bun gateway-worker-codex -e '
  for (const url of ["https://example.com", "http://192.168.1.1"]) {
    try { await fetch(url, { signal: AbortSignal.timeout(5000) }); console.log(url, "open"); }
    catch { console.log(url, "closed"); }
  }'
```

Still require authentication on every service the host exposes.

## Monitoring

Every service answers `/health/ready` and `/metrics` inside its container (ports 8080–8083);
Compose uses the readiness endpoint as the health check. To scrape from the host, publish the
ports on loopback in an override file. Watch from outside the Gateway as well: the exit codes of
`bin/agw run --rm gateway-cli gateway health` and `gateway backup check` (see the backup
section of the operations docs).

## The owner's console (optional)

A read-only status page for one owner, off by default
([ADR-023](../../docs/adr/023-console-and-operator.md), full guide in
[docs/operations/console.md](../../docs/operations/console.md)):

```bash
bin/agw run --rm gateway-cli gateway console password set   # hidden entry, confirmed twice
```

Then set `CONSOLE_ENABLED=true` in `gateway.env` and apply it with `bin/agw up -d
gateway-controller` (a `gateway.env` change needs the container recreated; `restart` alone does
not re-read it — `restart` stays correct for rotating the password afterwards, since the
controller re-reads the hash file at start either way). It refuses to start if this is on with
no password hash set. The listener publishes no host port and binds only the controller's own
network alias, so nothing reaches it without a reverse proxy already wired to it — on the home
server kit, Caddy at `https://gateway.local` (`docs/operations/home-server.md`). On another
Docker host, put your own reverse proxy in front of it the same way, or reach it only from
inside the Gateway's own network for now.

## Backups

`backup-gateway-db.sh` (in the image, and in `bin/`) writes a dump and a manifest into
`$GATEWAY_HOME/backups`, and `gateway backup check` verifies the newest one:

```bash
bin/agw run --rm gateway-cli backup-gateway-db.sh /backups
bin/agw run --rm -e BACKUP_DIR=/backups gateway-cli gateway backup check --record
```

Copy `$GATEWAY_HOME` (config, secrets, backups) and the release directories off the host,
encrypted.
