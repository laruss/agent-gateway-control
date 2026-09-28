# Releases

How a release is built, tested and published, and how to cut one. The design is
[ADR-020](../adr/020-release-pipeline.md). Operators install from the bundle's `INSTALL.md`
(source: [deploy/release/INSTALL.md](../../deploy/release/INSTALL.md)); upgrades and rollbacks
are in the bundle's `UPGRADE.md` and `ROLLBACK.md`.

## What a release contains

| Asset | What it is |
|-------|------------|
| `agent-gateway-home-server-vX.Y.Z.tar.gz` | The bundle: Compose stack, helpers, runbooks, example configuration, SBOMs |
| `compose.yaml`, `images.lock` | The stack and its images by digest, readable before download |
| `RELEASE_NOTES.md`, `MIGRATIONS.md` | The changelog section; the migrations and which earlier releases stay certified |
| `agent-gateway.spdx.json`, `agent-gateway-worker-codex.spdx.json` | SBOMs of the images (SPDX 2.3) |
| `SHA256SUMS` | Checksums of every asset |

Images: `ghcr.io/laruss/agent-gateway` and `ghcr.io/laruss/agent-gateway-worker-codex`, tagged
`X.Y.Z` and always used by digest. Each has a build provenance and an SBOM attestation.

## The workflows

- `package.yml` runs on every push to `main` and every pull request. It:
  - builds the images twice, on independent builders without cache, and compares the digests;
  - writes the SBOMs and assembles a candidate bundle (version `0.0.1`);
  - builds a synthetic next release with one expand migration;
  - runs the install test on a runner without the checkout.
- `release.yml` runs on a tag `vX.Y.Z`. It validates the tag, reruns `ci`, `e2e`, `security`
  and `package` on the tagged commit, then copies the tested images to GHCR, attests them,
  assembles and attests the bundle and publishes the release. It deploys nothing.

## One-time repository setup

Before the first release, in the repository settings:
- enable **immutable releases**: a published release's assets and tag can no longer change;
- add a **tag ruleset** for `v*`: only maintainers may create tags, and nobody may update or
  delete them;
- optionally require a reviewer on the `release` environment, which the publish job uses.

After the first release's workflow has pushed the images, make both GHCR packages public
(package settings, "Change visibility"), then rerun the failed publish job. The workflow checks
anonymous pulls before it publishes anything.

## Cutting a release

1. Pick the version: SemVer. Until 1.0.0, a minor bump may break configuration, and a patch
   never does.
2. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and start a new,
   empty `[Unreleased]` section.
3. In `packages/db/migrations/compatibility.json`, add the release with the last migration it
   ships:

   ```json
   "releases": [{ "version": "X.Y.Z", "head": "<last migration tag>", "pgboss_schema": 42 }]
   ```

   `pgboss_schema` is what `scripts/release/pgboss-schema.sh` prints for the locked pg-boss;
   the release workflow checks both values.

4. Check each new migration's kind. `expand` only if the previous release keeps working on the
   migrated schema, reading and writing. A `contract` means no rollback without a restore:
   ship it one release after the code stopped using the old shape.
5. If a runtime CLI changes, update its pins in `deploy/images/Dockerfile` (version, SHA-256,
   `WORKER_RUNTIME_VERSION`), in `scripts/release/write-images-lock.sh` and, for Claude Code,
   in `deploy/release/runtimes/claude-code/Dockerfile`. Then run the live suite and the doctor
   against the new version.
6. Merge to `main`, wait for `package`, then tag the merge commit and push the tag:

   ```bash
   git tag -a vX.Y.Z -m "Agent Gateway X.Y.Z" && git push origin vX.Y.Z
   ```

7. Watch `release`. After it publishes, verify the release as an operator would:

   ```bash
   gh release download vX.Y.Z -R laruss/agent-gateway-control -D /tmp/vX.Y.Z
   # then INSTALL.md, step 1: attestations of the archive and SHA256SUMS, the checksums,
   # and bin/verify-release.sh in the unpacked bundle
   ```

A failed release is fixed with a new patch version; a published version is never rebuilt or
retagged.

## Local rehearsal

Build and test the images without GitHub (Docker with buildx, on any architecture):

```bash
docker run -d --name registry -p 127.0.0.1:5000:5000 registry:3
docker buildx create --name local --driver docker-container --driver-opt network=host
BUILDER=local PLATFORM=linux/arm64 scripts/release/build-images.sh 0.0.1 localhost:5000/laruss images.env
```

`scripts/release/assemble-bundle.sh` needs GNU tar, and `scripts/release/install-test.sh` needs
a Linux Docker host with root, for example a `docker:dind` container sharing the registry's
network. Set `CANDIDATE=1` to assemble a bundle for a version the changelog does not list yet.

## Updating pinned inputs

- **Base image:** the `oven/bun` digest in `deploy/images/Dockerfile`; the Bun version must match
  `packageManager` in `package.json`.
- **Debian packages:** move `DEBIAN_SNAPSHOT` to a newer snapshot and update the exact versions
  it installs (`apt-cache policy <package>` in the snapshot).
- **Seccomp profile:** `bun scripts/generate-seccomp-profile.ts` rewrites
  `deploy/images/seccomp/worker-sandbox.json` from the pinned moby revision; change the
  revision and its checksum in the script to follow Docker's default profile.
- **Actions and tools:** every action is pinned by commit SHA, and Syft by version and SHA-256.
