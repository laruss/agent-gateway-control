# ADR-021. The home server: a Lima VM on an Apple silicon Mac

- Status: Accepted
- Date: 2026-09-30

## Context

The Gateway's first home is a Mac mini (Apple M4 Pro), running unattended around the clock. The
release (ADR-020) needs a Linux Docker host: the worker sandbox relies on seccomp, AppArmor and
unprivileged user namespaces, which Docker Desktop's managed VM does not let the operator
control, and Docker Desktop starts only at a login. Mattermost publishes amd64 images only. The
home router cannot reserve DHCP addresses or serve local names.

## Decision

- **Linux VM under Lima** (Apple's Virtualization framework), Ubuntu 24.04 arm64, Docker Engine
  from Docker's repository by exact versions, the cloud image by digest. `limactl autostart
  --condition=boot` starts it from a LaunchDaemon, without a login.
- **Both stacks run in the VM:** Mattermost (its own PostgreSQL, Caddy) and the Gateway, joined
  by the `agent-mm` network. The Gateway runs natively (arm64 release images); Mattermost runs
  through Rosetta, with plugins off.
- **Bridged networking** (socket_vmnet on the Mac's wired interface): the VM has its own LAN
  address and serves Caddy directly. Lima forwards no port: its forwarder can stall after days
  of uptime (Lima 2.2).
- **A fixed address outside the router's DHCP pool and the Mattermost name over mDNS**
  (`mattermost.local`, avahi in the VM), since the router does neither.
- **TLS from Caddy's own certificate authority** (`local_certs`); each client trusts its root
  once. The authority is part of the backup.
- **The egress firewall** is an nftables table on the Gateway's `agw-egress` bridge, now named
  in the release's Compose file: only the public internet and the host's DNS resolvers stay
  reachable. A systemd unit loads it before Docker.
- **Backups leave the VM daily:** the VM writes one archive of both databases, the Gateway's
  home and secrets, the Codex login, Mattermost's files, Caddy's authority and the release in
  use, encrypted with age to a key kept off the server; a LaunchDaemon on the Mac copies it out
  and keeps 30.
- **The home server kit ships in the release bundle** (`home-server/`), so the server is set up
  from a release, like the Gateway.

## Consequences

- The server has one more layer to watch (the VM), and a restart of macOS restarts everything.
- Mattermost runs emulated: slower to start and not a vendor-supported platform; its data and
  database are ordinary, so moving it to an amd64 host later is a restore.
- Android may not resolve `.local` names in every app; a LAN DNS entry or a hosts file is the
  fallback.
- The Mac holds only encrypted archives; with FileVault off, nothing else of the server's
  state should live on the Mac's disk.
