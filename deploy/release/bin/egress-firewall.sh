#!/bin/sh
# Closes the Gateway's egress bridge (agw-egress) to everything but the public internet:
# private, shared, loopback, link-local and multicast addresses, and the host itself. The DNS
# resolvers Docker forwards the containers' queries to stay reachable on port 53. Run it as
# root on the Docker host; it replaces its own nftables table and touches no other rules.
#
#   bin/egress-firewall.sh          # load the rules
#   bin/egress-firewall.sh --print  # show them without loading
#
# Load it at every boot (the home server's systemd unit does), and again when the host's
# resolvers change. The rules match the bridge by name, so they hold before Docker creates it.
set -eu
bridge=agw-egress
table=agent_gateway_egress

# Docker hands the containers the host's resolvers; with systemd-resolved, its upstream ones.
resolv=/etc/resolv.conf
[ -r /run/systemd/resolve/resolv.conf ] && resolv=/run/systemd/resolve/resolv.conf
resolvers4=$(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ && $2 !~ /^127\./ { print $2 }' "$resolv" | paste -sd, -)
resolvers6=$(awk '$1 == "nameserver" && $2 ~ /:/ && $2 != "::1" { sub(/%.*/, "", $2); print $2 }' "$resolv" | paste -sd, -)

rules() {
	cat <<EOF
table inet $table
delete table inet $table
table inet $table {
	set blocked4 {
		type ipv4_addr
		flags interval
		elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16,
			172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3 }
	}
	set blocked6 {
		type ipv6_addr
		flags interval
		elements = { ::/127, ::ffff:0:0/96, 64:ff9b:1::/48, fc00::/7, fe80::/10, ff00::/8 }
	}
EOF
	[ -n "$resolvers4" ] && printf '\tset resolvers4 { type ipv4_addr; elements = { %s } }\n' "$resolvers4"
	[ -n "$resolvers6" ] && printf '\tset resolvers6 { type ipv6_addr; elements = { %s } }\n' "$resolvers6"
	cat <<EOF
	chain forward {
		type filter hook forward priority filter - 10; policy accept;
		iifname "$bridge" ct state established,related accept
EOF
	[ -n "$resolvers4" ] && printf '\t\tiifname "%s" ip daddr @resolvers4 meta l4proto { tcp, udp } th dport 53 accept\n' "$bridge"
	[ -n "$resolvers6" ] && printf '\t\tiifname "%s" ip6 daddr @resolvers6 meta l4proto { tcp, udp } th dport 53 accept\n' "$bridge"
	cat <<EOF
		iifname "$bridge" ip daddr @blocked4 counter reject with icmpx admin-prohibited
		iifname "$bridge" ip6 daddr @blocked6 counter reject with icmpx admin-prohibited
	}
	chain input {
		type filter hook input priority filter - 10; policy accept;
		iifname "$bridge" ct state established,related accept
		iifname "$bridge" counter reject with icmpx admin-prohibited
	}
}
EOF
}

if [ "${1:-}" = --print ]; then
	rules
	exit 0
fi
rules | nft -f -
echo "loaded nftables table inet $table for $bridge"
