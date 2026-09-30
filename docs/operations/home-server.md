# The home server on an Apple silicon Mac

How the Gateway runs 24/7 on a Mac mini: one Linux VM holds Docker, Mattermost and the Gateway;
macOS only boots the VM and takes backups off it. The release bundle carries everything here in
`home-server/`. On a Linux host, skip the VM and follow the bundle's `INSTALL.md` directly.

```text
Mac (macOS, launchd)
├── Lima VM "agw" (Ubuntu 24.04 arm64, vz, starts at boot)       LAN address of its own
│   ├── Docker Engine
│   ├── Mattermost stack: Caddy (TLS, :80/:443) → Mattermost (amd64, Rosetta) → PostgreSQL
│   ├── Gateway stack (native arm64), joined to Mattermost's `agent-mm` network
│   └── nftables: the egress firewall; avahi: the Mattermost name over mDNS
└── io.agent-gateway.backup (LaunchDaemon): daily encrypted archive, copied to ~/agw-backups
```

## Why this shape

- **A VM, not Docker Desktop:** the worker sandbox needs a kernel with seccomp, AppArmor and
  user namespaces under the operator's control, and the VM must run without a login.
  [Lima](https://lima-vm.io) with Apple's Virtualization framework starts it from a
  LaunchDaemon at boot.
- **Bridged networking:** the VM has its own LAN address (socket_vmnet, bridged to `en0`), so
  Caddy is served directly. Lima's port forwarder is not used for anything: in Lima 2.2 it can
  stall after days of uptime.
- **Native Gateway, emulated Mattermost:** the Gateway's images are built for arm64; Mattermost
  publishes amd64 images only, which Rosetta runs inside the VM.
- **A fixed address and mDNS:** home routers often cannot reserve an address or serve local
  names. The VM takes an address outside the router's DHCP pool and announces the Mattermost
  name over mDNS (`mattermost.local`), which macOS, iOS and Windows resolve on their own.

## Prepare the Mac (once)

1. **Power:** no sleep (`sudo pmset -a sleep 0`) and restart after a power loss
   (`sudo pmset -a autorestart 1`). With FileVault on, the disk waits for its password after
   every restart; turn it off on a dedicated host, or unlock it over SSH after each boot.
2. **Rosetta**, for Mattermost's image: `softwareupdate --install-rosetta` (accept Apple's
   license yourself).
3. **Lima:** `brew install lima` (2.2 or later).
4. **socket_vmnet**, installed as root outside Homebrew as Lima requires, from its release
   archive by checksum:

   ```bash
   curl -fsSLO https://github.com/lima-vm/socket_vmnet/releases/download/v1.2.2/socket_vmnet-1.2.2-arm64.tar.gz
   echo "c7bf62308fbcfdc29bdfb8373c9b1951f7ac2396446e4390919796a94972e6dc  socket_vmnet-1.2.2-arm64.tar.gz" | shasum -a 256 -c
   sudo tar Cxzf / socket_vmnet-1.2.2-arm64.tar.gz ./opt/socket_vmnet
   limactl sudoers >etc_sudoers.d_lima
   sudo install -o root -m 0444 etc_sudoers.d_lima /etc/sudoers.d/lima   # Lima reads it back
   ```

   `~/.lima/_config/networks.yaml` bridges `bridged` to `en0`; change `interface` if the Mac's
   wired port is another one.

## The VM

```bash
limactl create --name=agw home-server/lima/agent-gateway.yaml
limactl start agw
limactl autostart enable --condition=boot agw    # as yourself, not under sudo; asks for it
```

The template pins Ubuntu's cloud image by digest and Docker Engine by exact package versions,
and puts the operator in the `docker` group. It has 8 vCPUs, 16 GiB and a 200 GiB disk (sparse);
change them with `limactl edit agw`. Then, inside the VM (`limactl shell agw`), with a bundle
unpacked at `/srv/agent-gateway/releases/<bundle>` and linked as `/srv/agent-gateway/current`:

```bash
sudo install -d -m 0755 /srv/home-server
sudo cp -R /srv/agent-gateway/current/home-server/. /srv/home-server/
sudo LAN_ADDRESS=192.168.18.254/24 LAN_GATEWAY=192.168.18.1 MDNS_NAME=mattermost.local \
  /srv/home-server/guest/setup-guest.sh /srv/agent-gateway/current
```

`setup-guest.sh` fixes the LAN address (pick one outside the router's DHCP pool), announces
the name over mDNS and loads the Gateway's egress firewall at every boot, before Docker. It is
safe to run again.

## Mattermost

```bash
cd /srv/home-server/mattermost
sudo MATTERMOST_HOME=/srv/mattermost ./init-mattermost.sh    # random database password
docker compose --env-file /srv/mattermost/mattermost.env up -d
```

- Mattermost 11.7 ESR, its own PostgreSQL, Caddy with its own certificate authority
  (`local_certs`); plugins are off, open sign-up is off.
- **Trust Caddy's root certificate** on every client. Copy it out of the VM:

  ```bash
  docker run --rm -v agent-gateway-mattermost_caddy-data:/data:ro --entrypoint cat \
    caddy:2.11.4-alpine /data/caddy/pki/authorities/local/root.crt >caddy-root.crt
  ```

  - macOS: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain caddy-root.crt`;
  - iOS: send it by AirDrop, install the profile (Settings, "Profile downloaded"), then turn
    on full trust in Settings → General → About → Certificate Trust Settings.

  The root lives in the `caddy-data` volume, which the backup includes: losing it means every
  client must trust a new one.
- Open `https://mattermost.local` and create the first account: it becomes the system admin.
  Then create the team, the channels named in `organization.yaml` and the owners' accounts.
- `mmctl` works inside the container without a token (local mode):
  `docker exec agent-gateway-mattermost-mattermost-1 /mattermost/bin/mmctl --local <command>`.

## The Gateway

Follow the bundle's `INSTALL.md` inside the VM, with `GATEWAY_HOME=/srv/agent-gateway` and
`MATTERMOST_URL=http://mattermost:8065` (the shared `agent-mm` network). The egress firewall
is already loaded by `setup-guest.sh`.

## Backups

The VM makes one encrypted archive of everything (`guest/backup.sh`); the Mac copies it off
the VM daily (`host/pull-backup.sh`, from a LaunchDaemon). The archive holds both databases,
`$GATEWAY_HOME` with its secrets, the Codex login, Mattermost's config and files, Caddy's
certificate authority and the release in use. It is encrypted with
[age](https://age-encryption.org) to a key whose private half never lives on the server.

1. On another machine (your laptop), make the key and keep the identity file safe (a password
   manager): it is the only way to read a backup.

   ```bash
   age-keygen -o agw-backup-identity.txt     # prints the public key, age1...
   ```

2. In the VM:

   ```bash
   sudo apt-get install -y age
   sudo install -d -m 0755 /etc/agent-gateway
   echo 'age1...' | sudo tee /etc/agent-gateway/backup-recipients.txt
   sudo /srv/home-server/guest/backup.sh      # a first archive, by hand
   ```

3. On the Mac: copy `home-server/` to `~/agent-gateway/home-server`, fill in the plist and
   install it.

   ```bash
   sed -e "s#@USER@#$USER#g" -e "s#@HOME@#$HOME#g" \
     ~/agent-gateway/home-server/host/io.agent-gateway.backup.plist >io.agent-gateway.backup.plist
   sudo install -m 0644 io.agent-gateway.backup.plist /Library/LaunchDaemons/
   sudo launchctl bootstrap system /Library/LaunchDaemons/io.agent-gateway.backup.plist
   sudo launchctl kickstart system/io.agent-gateway.backup    # run it now once
   ```

The VM keeps its newest 7 archives, the Mac its newest 30 in `~/agw-backups` (with
`backup.log`). Copy `~/agw-backups` to a disk that is not the Mac's, too.

## Restore

`guest/restore.sh` rebuilds both stacks from one archive into a VM with Docker and nothing else:
the release, both home directories with their secrets, Mattermost's database, files and Caddy's
authority, the Gateway's database with its worker roles (made again from their stored URLs
before the dump, whose policies name them), and the Codex login. It checks the schema, runs the
doctor and prints the row counts.

Decrypt on the machine that holds the key and stream the archive in, so no plaintext copy lands
on the Mac's disk:

```bash
ssh <mac> 'cat ~/agw-backups/home-server-<time>.tar.age' | age -d -i agw-backup-identity.txt |
  ssh <mac> 'limactl shell <vm> sudo tee /var/tmp/backup.tar >/dev/null'
limactl shell <vm> sudo /srv/.../restore.sh [--rehearsal] /var/tmp/backup.tar
```

For a real restore, prepare the VM as in "The VM" first (the LAN address, mDNS and the egress
firewall), then restore without `--rehearsal`. The copy has the same bot tokens, so stop the
original first.

**Rehearse it** regularly in a second VM without a LAN address (`limactl create
--name=agw-restore --set '.networks = [] | .memory = "6GiB" | .disk = "60GiB"'`). `--rehearsal`
starts no runtime worker, connector or tool runner: a copy must not use the real runtime logins
(a refreshed token would log the original out) or act on the outside world. Compare the row
counts with the original. The first rehearsal (2026-09-30) restored in under a minute plus the
image pulls.

## Failure drills

`scripts/soak/drills.sh` runs on a restored copy (never the original), on the mock runtime: each
drill breaks one thing while an agent works and checks every mention is answered exactly once.

| Drill | What breaks |
|-------|-------------|
| `controller_restart` | the controller restarts while a mention is routed |
| `database_restart` | PostgreSQL stops cleanly for a while; the services lose the deployment lock and come back |
| `mattermost_network` | the controller loses the Mattermost network; the backlog is caught up |
| `duplicates` | a full resync reads every channel again; no post is stored twice |
| `provider_flaky` | the runtime fails once, then answers |
| `invalid_once` | the model's answer is malformed once, then repaired |
| `cascade` | the agent hands work to another agent (needs a second enabled agent in the channel) |
| `worker_kill` | the worker is killed during a long turn; the operator cancels it and resumes the agent |
| `provider_permanent`, `invalid_always` | runs that cannot succeed; each leaves the agent FAILED, so each gets a pass of its own |

Run each pass on a fresh restore of the newest backup (restore, then
`sudo drills.sh [drill ...]`): that repeats the restore rehearsal too. The first drills
(2026-09-30) found that a worker kept running a cancelled turn until its deadline (fixed in
0.2.1).

## Checks after a restart

```bash
sudo launchctl print system/io.lima-vm.daemon.agw | grep state   # running
limactl list                                                      # agw Running
limactl shell agw docker ps --format '{{.Names}} {{.Status}}'     # all healthy
```
