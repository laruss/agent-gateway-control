#!/bin/sh
# Configures the home server's VM once its Docker Engine runs (docs/operations/home-server.md):
#
#   sudo LAN_ADDRESS=192.168.18.254/24 LAN_GATEWAY=192.168.18.1 MDNS_NAME=mattermost.local \
#     ./setup-guest.sh <release bundle directory>
#
# - a fixed LAN address on the bridged interface (lima0), outside the router's DHCP pool, for
#   routers that cannot reserve one;
# - the Mattermost name and the Gateway console's name (ADR-023), both announced over mDNS
#   (avahi), for LANs without a DNS server of their own; GATEWAY_MDNS_NAME defaults to
#   gateway.local and does not need to be set;
# - the Gateway's egress firewall (the bundle's bin/egress-firewall.sh), loaded at every boot
#   before Docker starts.
# Safe to run again; each part is replaced, not added twice.
set -eu
bundle=${1:?usage: setup-guest.sh <release bundle directory>}
: "${LAN_ADDRESS:?set LAN_ADDRESS, e.g. 192.168.18.254/24}"
: "${LAN_GATEWAY:?set LAN_GATEWAY, e.g. 192.168.18.1}"
: "${MDNS_NAME:?set MDNS_NAME, e.g. mattermost.local}"
: "${GATEWAY_MDNS_NAME:=gateway.local}"
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

# The Mattermost name and the Gateway console's name over mDNS, both pointing at the LAN
# address. avahi-publish takes one address record per instance, so each name gets its own unit;
# rewriting both files completely on every run keeps this idempotent and keeps the two names
# independent (one is never dropped or overwritten to add the other).
DEBIAN_FRONTEND=noninteractive apt-get install -y avahi-daemon avahi-utils >/dev/null
publish_alias() {
	# $1: unit file suffix (unique per name); $2: the mDNS name; $3: unit description.
	unit_suffix=$1
	mdns_name=$2
	description=$3
	cat >"/etc/systemd/system/agw-mdns-alias${unit_suffix}.service" <<UNIT
[Unit]
Description=$description
After=avahi-daemon.service network-online.target
Requires=avahi-daemon.service
Wants=network-online.target

[Service]
ExecStart=/usr/bin/avahi-publish --address --no-reverse $mdns_name $address
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
}
publish_alias "" "$MDNS_NAME" "Announce $MDNS_NAME for Mattermost over mDNS"
publish_alias "-gateway" "$GATEWAY_MDNS_NAME" "Announce $GATEWAY_MDNS_NAME for the Gateway console over mDNS"

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
systemctl enable --now avahi-daemon agw-mdns-alias agw-mdns-alias-gateway agw-egress-firewall
systemctl restart agw-egress-firewall
# `netplan apply` above makes avahi-daemon restart on its own, a moment later: an avahi-publish
# started in that moment attaches to the daemon on its way out and then stays running without
# a record. Restart the daemon here, wait for it, then (re)start the aliases, and check each name
# resolves before reporting success.
systemctl restart avahi-daemon
for _ in $(seq 1 20); do
	avahi-daemon --check 2>/dev/null && break
	sleep 0.5
done
systemctl restart agw-mdns-alias agw-mdns-alias-gateway
for name in "$MDNS_NAME" "$GATEWAY_MDNS_NAME"; do
	resolved=
	for _ in $(seq 1 15); do
		resolved=$(timeout 3 avahi-resolve -4 -n "$name" 2>/dev/null | awk '{print $2}') || true
		[ "$resolved" = "$address" ] && break
		sleep 1
	done
	[ "$resolved" = "$address" ] || {
		echo "$name does not resolve to $address over mDNS; check: journalctl -u avahi-daemon" >&2
		exit 1
	}
done
echo "LAN address $LAN_ADDRESS, mDNS $MDNS_NAME and $GATEWAY_MDNS_NAME, egress firewall loaded"
