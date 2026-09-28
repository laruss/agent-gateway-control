# Installing Agent Gateway

This bundle installs the Gateway on one Docker host from the release's images, without a
source checkout. Upgrades are in [UPGRADE.md](UPGRADE.md), rollbacks in
[ROLLBACK.md](ROLLBACK.md), and the database changes of this release in
[MIGRATIONS.md](MIGRATIONS.md).

## What you need

- A Linux host, `linux/amd64`, with Docker Engine 27 or later and Compose v2.30 or later. The
  images are built for amd64 only; check with `docker info --format '{{.Architecture}}'`
  (`x86_64`).
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

```bash
version=X.Y.Z
mkdir -p /srv/agent-gateway/releases && cd /srv/agent-gateway/releases
gh release download "v$version" -R laruss/agent-gateway-control -D "download-v$version"
cd "download-v$version"
sha256sum --check --strict SHA256SUMS           # every asset is what the release lists
sh verify-release.sh "$version"                 # GitHub attestations of the archive and images
tar -xzf "agent-gateway-home-server-v$version.tar.gz" -C ..
cd "../agent-gateway-home-server-v$version"
sha256sum --check --strict SHA256SUMS           # every file of the bundle
```

`verify-release.sh` checks that the archive, `SHA256SUMS` and every image in `images.lock` were
built by this repository's release workflow from the tag `v$version`. Continue only if every
check passes.

`compose.yaml` runs every image by digest (see `images.lock`); no tag is ever pulled.

## 2. Prepare the Gateway's home

State lives in `$GATEWAY_HOME` (default `/srv/agent-gateway`), outside every release
directory: upgrades and rollbacks switch the release directory and keep the state.

```bash
sudo bin/init-home.sh                 # directories, owners, the database password and URL
sudo cp -R config.example/. /srv/agent-gateway/config/
sudo "$EDITOR" /srv/agent-gateway/gateway.env /srv/agent-gateway/config/organization.yaml
```

- `gateway.env`: `MATTERMOST_URL` (as the controller reaches it on the shared network),
  `MATTERMOST_NETWORK`, and `COMPOSE_PROFILES` (the workers and connectors to run).
- `config/`: `organization.yaml`, `agents/*.yaml` and their prompts. Give each agent a runtime
  you run a worker for; change or disable the example agents on other runtimes.
- `secrets/`: one directory per service ([secrets.example/README.md](secrets.example/README.md)).
  Each service mounts only its own, read-only.

Set `GATEWAY_HOME` in your shell if you chose another path; `bin/agw` reads it.

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

The Gmail connector and the tool runner get their roles the same way (`db create-role`, then
`db grant-tool-runner` for the tool runner; see `gateway --help`).

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

The runtime workers use `seccomp/worker-sandbox.json`: Docker's default profile plus the calls
bubblewrap needs to confine the commands a runtime runs. They mount only their own secrets and
volumes, and they are not on the Mattermost network. No container gets the Docker socket, and
no port is published.

**Egress.** Workers, the Gmail connector and the tool runner reach the internet through the
`egress` network. The Mattermost network is closed to them, but its public URL, the host's
own services and your LAN are not: block those from the `egress` bridge with the host
firewall (for example `DOCKER-USER` rules for its subnet), and require authentication on
every service the host exposes.

## Monitoring

Every service answers `/health/ready` and `/metrics` inside its container (ports 8080–8083);
Compose uses the readiness endpoint as the health check. To scrape from the host, publish the
ports on loopback in an override file. Watch from outside the Gateway as well: the exit codes of
`bin/agw run --rm gateway-cli gateway health` and `gateway backup check` (see the backup
section of the operations docs).

## Backups

`backup-gateway-db.sh` (in the image, and in `bin/`) writes a dump and a manifest into
`$GATEWAY_HOME/backups`, and `gateway backup check` verifies the newest one:

```bash
bin/agw run --rm gateway-cli backup-gateway-db.sh /backups
bin/agw run --rm -e BACKUP_DIR=/backups gateway-cli gateway backup check --record
```

Copy `$GATEWAY_HOME` (config, secrets, backups) and the release directories off the host,
encrypted.
