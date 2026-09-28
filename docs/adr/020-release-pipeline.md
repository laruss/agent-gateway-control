# ADR-020. Release pipeline: reproducible images, a verified bundle, certified schemas

- Status: Accepted
- Date: 2026-09-28

## Context

The Gateway ran only from a checkout (`bun run dev`). The home server must install it from a
GitHub Release, without building from source, and must be able to go back to the previous
release. Before this decision:
- no image existed; ADR-019 left container hardening and per-run containment to the release;
- `pendingMigrationCount` compared counts: an older build on a newer database saw nothing
  pending and started;
- the controller migrated the pg-boss schema on start, under whatever else was running;
- nothing proved the production dependency set: the monorepo installs everything.

The repository is public, so GitHub's artifact attestations are available. The runtime CLIs
have different licenses: Codex (Apache-2.0), OpenCode and Hermes (MIT), and Grok Build
(Apache-2.0) may be redistributed; Claude Code and the Kiro CLI may not.

## Decision

### Images

- **Two release images,** both on `oven/bun:1.4.0-slim` pinned by digest:
  - `agent-gateway`: the controller, the CLI, the Gmail connector, the tool runner and the
    mock worker, with the PostgreSQL client tools for backups;
  - `agent-gateway-worker-codex`: the same plus the Codex CLI and the bubblewrap Codex builds
    from its vendored sources.

  Each service still runs in its own container, with its own credentials and mounts; sharing
  image bytes does not share processes or secrets (ADR-002).
- **The sources run directly under Bun,** as in development, with the monorepo layout kept, so
  migrations resolve from `packages/db/migrations`. A test walks every import reachable from
  the services' entrypoints and fails on a package missing from its `dependencies`: the images
  install `bun install --production`.
- **Claude Code is built by the operator.** The bundle carries a recipe
  (`runtimes/claude-code/Dockerfile`): the release's gateway image plus the pinned Claude Code
  binary, checked by SHA-256. The operator downloads it under Anthropic's terms and pushes the
  image to their own registry.
- **Grok, Kiro, OpenCode and Hermes are not released.** Their CLIs cannot confine their tools
  (ADR-015), and per-run containment, which ADR-019 made a release gate, does not exist yet.
  Web-only use does not lift the gate: web fetch reaches the host's private network.
- **linux/amd64 only.** It is the one platform tested natively, and it matches Mattermost's
  image. arm64 builds serve local development; an arm64 release needs its own native
  qualification.
- **Pinned inputs:**
  - the base image and the Dockerfile frontend by digest;
  - Debian packages by exact version from a fixed `snapshot.debian.org` date (signatures still
    verified);
  - JavaScript dependencies by `bun.lock`, without install scripts;
  - the Codex archive, its bubblewrap and its license files by SHA-256.

  `WORKER_RUNTIME_VERSION` is baked into each worker image: any other CLI version makes the
  runtime unavailable.
- **Reproducible.** Builds use `SOURCE_DATE_EPOCH` (the commit time) and rewritten layer
  timestamps; every file gets the commit's time; apt's logs and caches are removed; BuildKit
  attaches no provenance or SBOM. CI builds the images twice, on independent builders without
  cache, and fails if the digests differ.
- **Version.** The SemVer tag is the authority. `GATEWAY_VERSION` and `GATEWAY_COMMIT` are build
  arguments and OCI labels; an image without them fails to build. Every service reports
  `X.Y.Z+<commit>` in `gateway_build_info` and its logs; `gateway version` prints it.

### Hardening

Every container of the Compose stack:
- runs as uid `10001`, and the services refuse root;
- has a read-only root filesystem, `cap_drop: [ALL]`, `no-new-privileges`, `init`, and CPU,
  memory and PID limits;
- gets writable tmpfs or named volumes only where it writes;
- mounts only its own secrets directory, read-only (the CLI writes the controller's during
  bootstrap).

PostgreSQL keeps the five capabilities its entrypoint needs to prepare the data directory.

- **The Codex sandbox inside the container.** bubblewrap needs an unprivileged user namespace.
  Docker's default seccomp profile refuses it (without `CAP_SYS_ADMIN`), so the workers use
  `seccomp/worker-sandbox.json`: the default profile of a pinned moby revision plus `clone`,
  `unshare`, `setns`, `mount`, `umount2` and `pivot_root`. On AppArmor hosts Docker's default
  profile denies every mount, so the workers get `agent-gateway-worker`: that profile with
  `mount` and `pivot_root` allowed; without capabilities, a mount succeeds only inside the user
  namespace bubblewrap creates. No capability, no privileged mode, no unconfined profile. Codex's own bubblewrap build is used: a container does not let bubblewrap
  mount `/proc`, and Codex falls back to a sandbox without it only with its own build. The install test
  proves it under the stack's settings:
  - a command runs and writes the workspace;
  - it cannot read the login, write elsewhere or open a socket.
- **Networks:**
  - `agent-control` (internal): the database and the services;
  - `agent-mm` (external, shared with the Mattermost stack): the controller and the CLI only;
  - `egress`: workers, the Gmail connector and the tool runner.

  Bridges do not stop a worker reaching Mattermost's public URL or the LAN; the install guide
  requires host firewall rules for the `egress` subnet.
- **No port is published.** Health checks run inside the containers; an override file
  publishes metrics on loopback.

### Schema compatibility

- **A migration has a kind,** recorded in `packages/db/migrations/compatibility.json`:
  - `expand` keeps the previous release working;
  - `contract` breaks it;
  - `pre-release` marks the history before the first release.

  The manifest also lists the published releases and the last migration each shipped. The
  release workflow refuses a tag the manifest does not list with the current head.
- **The database records who may run on it.** `gateway db migrate` of release N:
  1. applies N's migrations, then the pg-boss schema and the queues;
  2. certifies N, and every listed release whose later migrations are all `expand`.

  A certificate binds the release to the fingerprint of the whole applied history and the
  pg-boss schema version (`schema_certifications`). pg-boss refuses a schema of another
  version whatever the Gateway certifies, so each listed release records its `pgboss_schema`,
  and one on another version is not certified.
- **A service asks one question at start:** does the database certify my release for this
  exact history, and does that history begin with my own migrations, unchanged?
  - The answer comes from `gateway_schema_state()`, a security-definer function every role may
    call: it returns only migration hashes and version numbers.
  - A development build (`0.0.0`) runs only on exactly its own history.
  - The controller, the workers, the Gmail connector, the tool runner and the CLI's session
    commands all refuse otherwise. `gateway doctor` and `kill-all` still work.
- **N−1 needs no knowledge of N.** It reads N's certificate. An older `db migrate` refuses a
  database with migrations it does not ship: a rollback never migrates down.
- **Certificates come last.** An interrupted migration leaves the release uncertified, and its
  services refuse to start until `db migrate` completes.
- **Services never migrate.** pg-boss runs with `migrate: false` in the controller (it
  supervises) and in every client; the queue schema changes only in `db migrate`. The pg-boss
  version stays fixed across a rollback window: its own schema check cannot be certified away.
- **The deployment lock.** Every service holds an advisory lock shared for its lifetime.
  `db migrate` takes it exclusively and refuses while any service is connected. The CLI's
  session commands hold it shared too, except the read-only `doctor` and `health`. Upgrades are
  therefore planned downtime, enforced: stop, back up, migrate, start. A service that loses its
  lock connection exits, and its restart policy brings it back; a heartbeat every 15 seconds
  notices a silently dropped connection.
- **Roles.** `gateway db create-role` creates a login role and writes its connection URL into a
  secret file; the server receives a SCRAM verifier, never the password.

### The release

- **`package.yml`** runs on every push to `main`, on every pull request, and from the release
  workflow:
  1. builds the images into a local registry and checks that they reproduce;
  2. scans SBOMs (SPDX, Syft) and assembles the bundle;
  3. builds a synthetic next release with an expand migration;
  4. on a second runner **without the checkout**, runs `install-test.sh` (install, bootstrap a
     throwaway Mattermost, smoke mention, versions, hardening, Codex sandbox) with a real
     upgrade to the next release and a rollback without a restore, asserting that no mention
     is answered twice.
- **`release.yml`** runs on a tag `vX.Y.Z` on `main`:
  1. validates the tag, the changelog section and the manifest entry;
  2. runs CI, e2e, the security scans and `package.yml` on the tagged commit;
  3. copies the tested images to GHCR with their digests unchanged;
  4. attests them (build provenance and SBOM, pushed to the registry);
  5. assembles the bundle for the GHCR references and attests the archive, `SHA256SUMS`,
     `images.lock` and `compose.yaml`;
  6. checks anonymous pulls, then publishes the release from a draft whose assets were
     verified.

  Nothing deploys: installing is the operator's step. No cosign: GitHub attestations are
  signed and verified with `gh attestation verify` (`verify-release.sh`).
- **The bundle:**
  - the Compose stack with every image by digest, and `images.lock`;
  - the helpers: `agw`, `init-home.sh`, `verify-release.sh`, `gmail-authorize.sh`, the backup
    script;
  - the seccomp profile and the Claude Code recipe;
  - the example configuration with its prompts, the schemas and the secrets layout;
  - `INSTALL.md`, `UPGRADE.md`, `ROLLBACK.md`, `MIGRATIONS.md` (generated from the manifest)
    and `RELEASE_NOTES.md` (the changelog section);
  - the SBOMs and `SHA256SUMS`.

  The archive is reproducible (sorted, fixed owners and times, gzip without a timestamp).
- **State lives outside the release directories** (`$GATEWAY_HOME`), with a fixed Compose
  project name and named volumes: an upgrade or a rollback runs another release directory's
  `bin/agw` against the same containers and volumes.
- Mattermost, TLS and the reverse proxy are a separate stack with its own lifecycle; the
  Gateway joins its network.

## Consequences

- A clean host installs from the release with Docker, `curl`, `jq` and `gh`; the install test
  proves it on every change.
- A rollback by one release needs no restore after expand-only migrations; after a contract it
  needs the pre-upgrade backup, which the runbooks take and verify first.
- Contract migrations must wait one release after the code stops using the old shape.
- Every upgrade is downtime of the Gateway services: seconds to minutes, with no work lost.
- Operators who use Claude Code rebuild its worker image for every release.
- Agents on Grok, Kiro, OpenCode or Hermes need a later release with per-run containment.
- The first push of a GHCR package is private; the maintainer makes each package public once
  (the release workflow fails until then).
- Known gaps:
  - The database owner is PostgreSQL's superuser in the stack. Separating a non-login owner
    from the controller's runtime role needs row-level security policies for the controller.
  - Worker egress to the LAN is closed by host firewall rules, not by the stack.
  - Claude Code's Bash sandbox may not start in the container (it mounts `/proc`); its agents
    without `tests.run` are unaffected, and the doctor shows it.
