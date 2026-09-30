#!/bin/sh
# Configures the home server's VM once its Docker Engine runs (docs/operations/home-server.md):
#
#   sudo LAN_ADDRESS=192.168.18.254/24 LAN_GATEWAY=192.168.18.1 MDNS_NAME=mattermost.local \
#     ./setup-guest.sh <release bundle directory>
#
# - a fixed LAN address on the bridged interface (lima0), outside the router's DHCP pool, for
#   routers that cannot reserve one;
# - the Mattermost name announced over mDNS (avahi), for LANs without a DNS server of their own;
# - the Gateway's egress firewall (the bundle's bin/egress-firewall.sh), loaded at every boot
#   before Docker starts.
# Safe to run again; each part is replaced, not added twice.
set -eu
bundle=${1:?usage: setup-guest.sh <release bundle directory>}
: "${LAN_ADDRESS:?set LAN_ADDRESS, e.g. 192.168.18.254/24}"
: "${LAN_GATEWAY:?set LAN_GATEWAY, e.g. 192.168.18.1}"
: "${MDNS_NAME:?set MDNS_NAME, e.g. mattermost.local}"
[ "$(id -u)" = 0 ] || { echo "run it with sudo" >&2; exit 1; }
address=${LAN_ADDRESS%/*}

# The LAN address: netplan merges this over cloud-init's DHCP settings for lima0.
cat >/etc/netplan/60-lan-address.yaml <<NETPLAN
network:
  version: 2
  ethernets:
    lima0:
      dhcp4: false
      addresses: [$LAN_ADDRESS]
      routes:
        - to: default
          via: $LAN_GATEWAY
          metric: 100
      nameservers:
        addresses: [$LAN_GATEWAY]
NETPLAN
chmod 0600 /etc/netplan/60-lan-address.yaml
netplan apply

# The Mattermost name over mDNS, pointing at the LAN address.
DEBIAN_FRONTEND=noninteractive apt-get install -y avahi-daemon avahi-utils >/dev/null
cat >/etc/systemd/system/agw-mdns-alias.service <<UNIT
[Unit]
Description=Announce $MDNS_NAME for Mattermost over mDNS
After=avahi-daemon.service network-online.target
Requires=avahi-daemon.service
Wants=network-online.target

[Service]
ExecStart=/usr/bin/avahi-publish --address --no-reverse $MDNS_NAME $address
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

# The egress firewall, from the release bundle, before Docker creates the bridge.
install -m 0755 "$bundle/bin/egress-firewall.sh" /usr/local/sbin/agw-egress-firewall
cat >/etc/systemd/system/agw-egress-firewall.service <<'UNIT'
[Unit]
Description=Agent Gateway egress firewall (nftables table agent_gateway_egress)
Wants=network-online.target
After=network-online.target nftables.service
Before=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/agw-egress-firewall

[Install]
WantedBy=multi-user.target docker.service
UNIT
systemctl daemon-reload
systemctl enable --now avahi-daemon agw-mdns-alias agw-egress-firewall
systemctl restart agw-mdns-alias agw-egress-firewall
echo "LAN address $LAN_ADDRESS, mDNS $MDNS_NAME, egress firewall loaded"
